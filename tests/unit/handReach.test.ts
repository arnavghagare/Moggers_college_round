import { beforeEach, describe, expect, it } from 'vitest';
import { HandGestureEngine, type GestureEvent } from '../../src/core/gestures/handGestureEngine';
import { defaultGestureConfigs } from '../../src/core/gestures/registry';
import type { HandObservation } from '../../src/core/hand/features';
import { HandReachCalibrator, REACH_TIMEOUT_MS } from '../../src/core/hand/reach';
import { POSES, TEST_ASPECT } from '../helpers/synthetic';

/** Deterministic landmark fixtures. These check the logic, not how well a real camera tracks. */

const STEP = 110;

function feed(cal: HandReachCalibrator, ms: number, at: (elapsed: number) => { x: number; y: number; score: number } | null, from = 0): number {
  let t = from;
  for (let e = 0; e < ms && !cal.finished; e += STEP) {
    t += STEP;
    cal.push(t, at(e));
  }
  return t;
}

describe('hand reach calibration', () => {
  it('measures the resting position from a steady, confident run of samples', () => {
    const cal = new HandReachCalibrator(0);
    feed(cal, 3000, (e) => ({ x: 0.42 + Math.sin(e) * 0.004, y: 0.6 + Math.cos(e) * 0.004, score: 0.95 }));
    const s = cal.status();
    expect(s.phase).toBe('done');
    expect(s.center!.x).toBeCloseTo(0.42, 1);
    expect(s.center!.y).toBeCloseTo(0.6, 1);
  });

  it('does not finish from a single frame', () => {
    const cal = new HandReachCalibrator(0);
    cal.push(100, { x: 0.5, y: 0.5, score: 0.99 });
    expect(cal.status().phase).toBe('collecting');
    expect(cal.status().center).toBeNull();
  });

  it('fails, with advice, when no hand is ever seen', () => {
    const cal = new HandReachCalibrator(0);
    feed(cal, REACH_TIMEOUT_MS + 500, () => null);
    expect(cal.status().phase).toBe('failed');
    expect(cal.status().message).toMatch(/No hand was seen/);
    expect(cal.status().center).toBeNull();
  });

  it('rejects low-confidence samples (poor lighting) and says so', () => {
    const cal = new HandReachCalibrator(0);
    feed(cal, REACH_TIMEOUT_MS + 500, () => ({ x: 0.5, y: 0.5, score: 0.4 }));
    expect(cal.status().phase).toBe('failed');
    expect(cal.status().message).toMatch(/not clearly enough/);
  });

  it('rejects a hand that is partly out of the picture', () => {
    const cal = new HandReachCalibrator(0);
    feed(cal, REACH_TIMEOUT_MS + 500, () => ({ x: 0.04, y: 0.5, score: 0.95 }));
    expect(cal.status().phase).toBe('failed');
    expect(cal.status().message).toMatch(/edge of the picture/);
  });

  it('does not accept a hand that keeps moving', () => {
    const cal = new HandReachCalibrator(0);
    feed(cal, REACH_TIMEOUT_MS + 500, (e) => ({ x: 0.3 + ((e / STEP) % 4) * 0.1, y: 0.5, score: 0.95 }));
    expect(cal.status().phase).toBe('failed');
    expect(cal.status().message).toMatch(/kept moving/);
  });

  it('starts the steady run again after a sudden movement, then succeeds where the hand settles', () => {
    const cal = new HandReachCalibrator(0);
    const t = feed(cal, 600, () => ({ x: 0.3, y: 0.4, score: 0.95 }));
    expect(cal.finished).toBe(false);
    feed(cal, 3000, () => ({ x: 0.6, y: 0.6, score: 0.95 }), t);
    expect(cal.status().phase).toBe('done');
    expect(cal.status().center!.x).toBeCloseTo(0.6, 2);
  });

  it('loses its run when tracking drops out', () => {
    const cal = new HandReachCalibrator(0);
    let t = feed(cal, 700, () => ({ x: 0.5, y: 0.5, score: 0.95 }));
    t = feed(cal, 300, () => null, t);
    expect(cal.status().progress).toBe(0);
    feed(cal, 3000, () => ({ x: 0.5, y: 0.5, score: 0.95 }), t);
    expect(cal.status().phase).toBe('done');
  });

  it('can be cancelled without producing a result, and a new run can follow', () => {
    const cal = new HandReachCalibrator(0);
    feed(cal, 400, () => ({ x: 0.5, y: 0.5, score: 0.95 }));
    cal.cancel();
    expect(cal.status().phase).toBe('cancelled');
    expect(cal.status().center).toBeNull();
    // Further samples change nothing.
    feed(cal, 3000, () => ({ x: 0.5, y: 0.5, score: 0.95 }), 400);
    expect(cal.status().phase).toBe('cancelled');

    const again = new HandReachCalibrator(5000);
    feed(again, 3000, () => ({ x: 0.55, y: 0.5, score: 0.95 }), 5000);
    expect(again.status().phase).toBe('done');
  });
});

const FRAME = 33;

class Rig {
  t = 1000;
  engine = new HandGestureEngine(defaultGestureConfigs());

  hold(obs: HandObservation | null, ms: number): GestureEvent[] {
    const batch: GestureEvent[] = [];
    for (let e = 0; e < ms; e += FRAME) {
      this.t += FRAME;
      batch.push(...this.engine.update(this.t, obs ? [obs] : [], TEST_ASPECT, { handSteering: true }).events);
    }
    return batch;
  }
}

const triggers = (events: GestureEvent[]): string[] => events.filter((e) => e.phase === 'trigger').map((e) => e.id);

describe('accidental click prevention', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = new Rig();
  });

  it('a hand that enters the picture already pinched does not click', () => {
    const events = [...rig.hold(POSES.pinch(), 200), ...rig.hold(POSES.open(), 300)];
    expect(triggers(events)).not.toContain('pinch');
  });

  it('a pinch made after the hand has settled still clicks', () => {
    rig.hold(POSES.open(), 400);
    const events = [...rig.hold(POSES.pinch(), 200), ...rig.hold(POSES.open(), 300)];
    expect(triggers(events)).toContain('pinch');
  });

  it('a hand that sweeps across while pinched does not click', () => {
    rig.hold(POSES.open({ x: 0.25 }), 400);
    const events: GestureEvent[] = [];
    // Pinched, travelling a third of the picture in under half a second.
    for (let i = 0; i <= 12; i++) events.push(...rig.hold(POSES.pinch({ x: 0.25 + i * 0.03 }), FRAME));
    events.push(...rig.hold(POSES.open({ x: 0.62 }), 300));
    expect(triggers(events)).not.toContain('pinch');
  });

  it('keeps a pinch alive when the model flips the left / right label for a few frames', () => {
    rig.hold(POSES.open({ handedness: 'Right' }), 400);
    const down = rig.hold(POSES.pinch({ handedness: 'Right' }), 150);
    // Same hand, same place, briefly reported as the other hand.
    const flipped = rig.hold({ ...POSES.pinch({ handedness: 'Right' }), handedness: 'Left' }, 100);
    const back = rig.hold(POSES.pinch({ handedness: 'Right' }), 100);
    const up = rig.hold(POSES.open({ handedness: 'Right' }), 300);
    const all = [...down, ...flipped, ...back, ...up];
    expect(all.filter((e) => e.id === 'pinch' && e.phase === 'start')).toHaveLength(1);
    expect(all.some((e) => e.aborted)).toBe(false);
    expect(all.every((e) => e.hand === 'Right')).toBe(true);
    expect(triggers(up)).toContain('pinch');
  });

  it('still tells two real hands apart', () => {
    const left = POSES.open({ handedness: 'Left', x: 0.25 });
    const right = POSES.open({ handedness: 'Right', x: 0.75 });
    let hands = 0;
    for (let i = 0; i < 12; i++) {
      rig.t += FRAME;
      hands = rig.engine.update(rig.t, [left, right], TEST_ASPECT, { handSteering: false }).hands.length;
    }
    expect(hands).toBe(2);
  });

  it('accepts a relabelling that lasts, as the model correcting itself', () => {
    rig.hold(POSES.open({ handedness: 'Right' }), 300);
    rig.hold({ ...POSES.open({ handedness: 'Right' }), handedness: 'Left' }, 1500);
    rig.t += FRAME;
    const r = rig.engine.update(rig.t, [{ ...POSES.open({ handedness: 'Right' }), handedness: 'Left' }], TEST_ASPECT, { handSteering: true });
    expect(r.hands.map((h) => h.features.handedness)).toEqual(['Left']);
  });
});
