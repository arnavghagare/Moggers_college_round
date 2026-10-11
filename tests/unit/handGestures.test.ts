import { beforeEach, describe, expect, it } from 'vitest';
import { HandGestureEngine, type GestureEvent } from '../../src/core/gestures/handGestureEngine';
import { defaultGestureConfigs, type GestureConfig } from '../../src/core/gestures/registry';
import type { HandObservation } from '../../src/core/hand/features';
import { POSES, TEST_ASPECT } from '../helpers/synthetic';

const FRAME = 33;

class Rig {
  t = 1000;
  config: Record<string, GestureConfig> = defaultGestureConfigs();
  engine = new HandGestureEngine(this.config);
  events: GestureEvent[] = [];
  steering = false;

  /** Feed the same observation(s) for `ms` milliseconds. */
  hold(obs: HandObservation | HandObservation[] | null, ms: number): GestureEvent[] {
    const batch: GestureEvent[] = [];
    const list = obs === null ? [] : Array.isArray(obs) ? obs : [obs];
    for (let elapsed = 0; elapsed < ms; elapsed += FRAME) {
      this.t += FRAME;
      const r = this.engine.update(this.t, list, TEST_ASPECT, { handSteering: this.steering });
      batch.push(...r.events);
    }
    this.events.push(...batch);
    return batch;
  }

  /** Move a pose linearly between two positions over `ms`. */
  sweep(make: (x: number, y: number, scale: number) => HandObservation | HandObservation[], from: [number, number, number?], to: [number, number, number?], ms: number): GestureEvent[] {
    const batch: GestureEvent[] = [];
    const steps = Math.max(1, Math.round(ms / FRAME));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      this.t += FRAME;
      const obs = make(
        from[0] + (to[0] - from[0]) * k,
        from[1] + (to[1] - from[1]) * k,
        (from[2] ?? 0.02) + ((to[2] ?? 0.02) - (from[2] ?? 0.02)) * k,
      );
      const r = this.engine.update(this.t, Array.isArray(obs) ? obs : [obs], TEST_ASPECT, { handSteering: this.steering });
      batch.push(...r.events);
    }
    this.events.push(...batch);
    return batch;
  }

  pose(): string | null {
    const r = this.engine.update(this.t, [], TEST_ASPECT, { handSteering: this.steering });
    void r;
    return null;
  }
}

const ids = (events: GestureEvent[], phase?: GestureEvent['phase']) =>
  events.filter((e) => !phase || e.phase === phase).map((e) => `${e.id}:${e.phase}`);
const triggers = (events: GestureEvent[]) => events.filter((e) => e.phase === 'trigger').map((e) => e.id);

let rig: Rig;
beforeEach(() => {
  rig = new Rig();
});

describe('activation and release', () => {
  it('activates a pose only after its minimum duration', () => {
    // three_fingers needs 350 ms.
    expect(rig.hold(POSES.three(), 200)).toHaveLength(0);
    const later = rig.hold(POSES.three(), 300);
    expect(ids(later)).toEqual(['three_fingers:start', 'three_fingers:trigger']);
  });

  it('ignores a pose seen for a single frame', () => {
    rig.hold(POSES.open(), 400);
    const blip = rig.hold(POSES.three(), FRAME);
    const after = rig.hold(POSES.open(), 400);
    expect(triggers([...blip, ...after])).not.toContain('three_fingers');
  });

  it('does not trigger again while the pose is held', () => {
    rig.hold(POSES.three(), 600);
    expect(rig.hold(POSES.three(), 3000)).toHaveLength(0);
    expect(triggers(rig.events)).toEqual(['three_fingers']);
  });

  it('emits end when the pose is released', () => {
    rig.hold(POSES.fist(), 400);
    const released = rig.hold(POSES.open(), 400);
    expect(ids(released)).toContain('fist:end');
    expect(ids(released)).toContain('open_palm:start');
  });

  it('survives one bad frame without releasing (hysteresis grace)', () => {
    rig.hold(POSES.fist(), 400);
    const noisy = rig.hold(POSES.open(), FRAME);
    const back = rig.hold(POSES.fist(), 300);
    expect(ids([...noisy, ...back])).not.toContain('fist:end');
  });

  it('enforces the cooldown between activations', () => {
    rig.hold(POSES.three(), 600);
    rig.hold(POSES.open(), 300);
    // Second activation 0.9 s after the first: inside the 1.5 s cooldown.
    const again = rig.hold(POSES.three(), 600);
    expect(ids(again)).toContain('three_fingers:start');
    expect(triggers(again)).not.toContain('three_fingers');
    rig.hold(POSES.open(), 1500);
    expect(triggers(rig.hold(POSES.three(), 600))).toContain('three_fingers');
  });

  it('does not recognise a disabled gesture', () => {
    rig.config.three_fingers.enabled = false;
    rig.engine.setConfig(rig.config);
    const events = rig.hold(POSES.three(), 1000);
    expect(events.map((e) => e.id)).not.toContain('three_fingers');
  });

  it('respects a raised activation threshold', () => {
    rig.config.two_fingers.threshold = 1.01;
    rig.engine.setConfig(rig.config);
    expect(rig.hold(POSES.two(), 800).map((e) => e.id)).not.toContain('two_fingers');
  });
});

describe('pinch', () => {
  it('fires a tap on release, not on contact', () => {
    rig.hold(POSES.open(), 300);
    const down = rig.hold(POSES.pinch(), 200);
    expect(ids(down)).toContain('pinch:start');
    expect(triggers(down)).toHaveLength(0);
    const up = rig.hold(POSES.open(), 300);
    expect(triggers(up)).toContain('pinch');
  });

  it('turns a long pinch into a hold and does not also tap', () => {
    rig.hold(POSES.open(), 300);
    const held = rig.hold(POSES.pinch(), 800);
    expect(ids(held)).toContain('pinch_hold:start');
    const released = rig.hold(POSES.open(), 300);
    expect(ids(released)).toContain('pinch_hold:end');
    expect(triggers(released)).not.toContain('pinch');
  });

  it('wins over other poses when both are present (explicit priority)', () => {
    // An "OK" sign: pinching with the other three fingers extended.
    rig.hold(POSES.open(), 300);
    rig.hold(POSES.pinch(), 300);
    const starts = ids(rig.events, 'start');
    expect(starts[starts.length - 1]).toBe('pinch:start');
  });

  it('does not tap when the hand disappears mid-pinch', () => {
    rig.hold(POSES.open(), 300);
    rig.hold(POSES.pinch(), 200);
    const lost = rig.hold(null, 600);
    expect(triggers(lost)).not.toContain('pinch');
    expect(lost.find((e) => e.id === 'pinch' && e.phase === 'end')?.aborted).toBe(true);
  });

  it('marks a hold as aborted when the hand disappears', () => {
    rig.hold(POSES.pinch(), 900);
    const lost = rig.hold(null, 600);
    const end = lost.find((e) => e.id === 'pinch_hold' && e.phase === 'end');
    expect(end?.aborted).toBe(true);
  });

  it('applies the pinch cooldown to rapid repeated taps', () => {
    rig.config.pinch.cooldownMs = 2000;
    rig.engine.setConfig(rig.config);
    rig.hold(POSES.pinch(), 150);
    rig.hold(POSES.open(), 200);
    rig.hold(POSES.pinch(), 150);
    rig.hold(POSES.open(), 200);
    expect(triggers(rig.events).filter((id) => id === 'pinch')).toHaveLength(1);
  });

  it('tolerates a brief tracking flicker without ending the gesture', () => {
    rig.hold(POSES.fist(), 400);
    const flicker = rig.hold(null, 66);
    const back = rig.hold(POSES.fist(), 200);
    expect(ids([...flicker, ...back])).not.toContain('fist:end');
  });
});

describe('transitions and strokes', () => {
  it('recognises open hand to fist as a grab', () => {
    rig.hold(POSES.open(), 400);
    const closing = rig.hold(POSES.fist(), 400);
    expect(triggers(closing)).toContain('grab');
  });

  it('does not call a fist a grab without a preceding open hand', () => {
    rig.hold(POSES.point(), 600);
    rig.hold(null, 400);
    expect(triggers(rig.hold(POSES.fist(), 500))).not.toContain('grab');
  });

  it('detects swipes in all four directions', () => {
    const cases: Array<[string, [number, number], [number, number]]> = [
      ['swipe_right', [0.3, 0.6], [0.7, 0.6]],
      ['swipe_left', [0.7, 0.6], [0.3, 0.6]],
      ['swipe_up', [0.5, 0.8], [0.5, 0.4]],
      ['swipe_down', [0.5, 0.4], [0.5, 0.8]],
    ];
    for (const [id, from, to] of cases) {
      const r = new Rig();
      r.hold(POSES.open({ x: from[0], y: from[1] }), 300);
      const stroke = r.sweep((x, y) => POSES.open({ x, y }), from, to, 300);
      expect(triggers(stroke), id).toContain(id);
    }
  });

  it('fires one swipe per stroke and ignores the return movement', () => {
    rig.hold(POSES.open({ x: 0.3 }), 300);
    rig.sweep((x, y) => POSES.open({ x, y }), [0.3, 0.6], [0.7, 0.6], 300);
    rig.sweep((x, y) => POSES.open({ x, y }), [0.7, 0.6], [0.3, 0.6], 300);
    const swipes = triggers(rig.events).filter((id) => id.startsWith('swipe'));
    expect(swipes).toEqual(['swipe_right']);
  });

  it('ignores slow drifts', () => {
    rig.hold(POSES.open({ x: 0.3 }), 300);
    const drift = rig.sweep((x, y) => POSES.open({ x, y }), [0.3, 0.6], [0.7, 0.6], 3000);
    expect(triggers(drift).filter((id) => id.startsWith('swipe'))).toHaveLength(0);
  });

  it('ignores diagonal movement', () => {
    rig.hold(POSES.open({ x: 0.3, y: 0.3 }), 300);
    const diagonal = rig.sweep((x, y) => POSES.open({ x, y }), [0.3, 0.3], [0.6, 0.7], 300);
    expect(triggers(diagonal).filter((id) => id.startsWith('swipe'))).toHaveLength(0);
  });

  it('does not recognise swipes while the hand is steering the cursor', () => {
    rig.steering = true;
    rig.hold(POSES.open({ x: 0.3 }), 300);
    const stroke = rig.sweep((x, y) => POSES.open({ x, y }), [0.3, 0.6], [0.7, 0.6], 300);
    expect(triggers(stroke).filter((id) => id.startsWith('swipe'))).toHaveLength(0);
  });

  it('requires an open hand for a swipe', () => {
    rig.hold(POSES.fist({ x: 0.3 }), 300);
    const stroke = rig.sweep((x, y) => POSES.fist({ x, y }), [0.3, 0.6], [0.7, 0.6], 300);
    expect(triggers(stroke).filter((id) => id.startsWith('swipe'))).toHaveLength(0);
  });

  it('detects a sustained hand raise once', () => {
    const raised = rig.hold(POSES.open({ y: 0.3 }), 2500);
    expect(triggers(raised).filter((id) => id === 'hand_raise')).toHaveLength(1);
  });

  it('does not treat a hand held low as a raise', () => {
    expect(triggers(rig.hold(POSES.open({ y: 0.75 }), 2500))).not.toContain('hand_raise');
  });

  it('detects a push toward the camera when enabled', () => {
    rig.config.hand_push.enabled = true;
    rig.engine.setConfig(rig.config);
    rig.hold(POSES.open({ scale: 0.016 }), 300);
    const push = rig.sweep((x, y, s) => POSES.open({ x, y, scale: s }), [0.5, 0.6, 0.016], [0.5, 0.6, 0.026], 300);
    expect(triggers(push)).toContain('hand_push');
  });
});

describe('two hands', () => {
  const pair = (gap: number) => [
    POSES.open({ handedness: 'Left', x: 0.5 - gap / 2 }),
    POSES.open({ handedness: 'Right', x: 0.5 + gap / 2 }),
  ];

  it('tracks both hands independently', () => {
    const r = rig.engine.update(rig.t + FRAME, [POSES.fist({ handedness: 'Left', x: 0.3 }), POSES.open({ handedness: 'Right', x: 0.7 })], TEST_ASPECT, {
      handSteering: false,
    });
    expect(r.hands.map((h) => h.features.handedness).sort()).toEqual(['Left', 'Right']);
    expect(r.hands.find((h) => h.features.handedness === 'Left')!.features.states.index).toBe(false);
    expect(r.hands.find((h) => h.features.handedness === 'Right')!.features.states.index).toBe(true);
  });

  it('recognises hands moving apart and together', () => {
    rig.hold(pair(0.3), 300);
    const apart = rig.sweep((gap) => pair(gap), [0.3, 0], [0.6, 0], 350);
    expect(triggers(apart)).toContain('two_hand_spread');
    rig.hold(pair(0.6), 1200);
    const together = rig.sweep((gap) => pair(gap), [0.6, 0], [0.3, 0], 350);
    expect(triggers(together)).toContain('two_hand_squeeze');
  });

  it('does not report single-hand swipes while two hands are spreading', () => {
    rig.hold(pair(0.3), 300);
    rig.sweep((gap) => pair(gap), [0.3, 0], [0.7, 0], 350);
    expect(triggers(rig.events).filter((id) => id.startsWith('swipe'))).toHaveLength(0);
  });
});

describe('reported state', () => {
  it('exposes the stable pose, the raw candidate and confidence', () => {
    let last = rig.engine.update(rig.t, [POSES.two()], TEST_ASPECT, { handSteering: false });
    expect(last.hands[0].pose).toBeNull();
    expect(last.hands[0].candidate).toBe('two_fingers');
    for (let i = 0; i < 10; i++) {
      rig.t += FRAME;
      last = rig.engine.update(rig.t, [POSES.two()], TEST_ASPECT, { handSteering: false });
    }
    expect(last.hands[0].pose).toBe('two_fingers');
    expect(last.hands[0].poseConfidence).toBeGreaterThan(0.65);
  });

  it('reports nothing when no hand is visible', () => {
    const r = rig.engine.update(rig.t, [], TEST_ASPECT, { handSteering: false });
    expect(r.hands).toHaveLength(0);
    expect(r.events).toHaveLength(0);
  });
});
