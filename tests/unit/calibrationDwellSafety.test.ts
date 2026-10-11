import { describe, expect, it } from 'vitest';
import { DwellDetector, type DwellEvent } from '../../src/core/dwell';
import { SafetyController } from '../../src/core/safety';
import { PerfGovernor, PresenceMonitor, rateFaceQuality, rateLighting } from '../../src/core/tracking';

const FRAME = 33;

describe('dwell clicking', () => {
  const config = { dwellMs: 1000, radiusPx: 30, armDelayMs: 150 };
  const KEY = { el: 'button' };

  function run(d: DwellDetector, from: number, to: number, x: number, y: number, key: unknown = KEY, ok = true): DwellEvent[] {
    const events: DwellEvent[] = [];
    for (let t = from; t <= to; t += FRAME) events.push(...d.update(t, x, y, key, ok).events);
    return events;
  }
  const types = (events: DwellEvent[]) => events.map((e) => e.type);

  it('fires after the cursor rests on a target for the dwell time', () => {
    const d = new DwellDetector(config);
    expect(types(run(d, 0, 1000, 100, 100))).toEqual(['start']);
    expect(types(run(d, 1033, 1300, 100, 100))).toEqual(['fire']);
  });

  it('reports rising progress for the countdown ring', () => {
    const d = new DwellDetector(config);
    run(d, 0, 400, 100, 100);
    const a = d.update(433, 100, 100, KEY, true).state.progress;
    const b = d.update(800, 100, 100, KEY, true).state.progress;
    expect(a).toBeGreaterThan(0.1);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(1);
  });

  it('never fires while the cursor keeps moving across targets', () => {
    const d = new DwellDetector(config);
    const events: DwellEvent[] = [];
    for (let t = 0; t < 10000; t += FRAME) events.push(...d.update(t, 100 + t * 0.2, 100, { el: Math.floor(t / 300) }, true).events);
    expect(types(events)).not.toContain('fire');
  });

  it('cancels when the cursor moves away', () => {
    const d = new DwellDetector(config);
    run(d, 0, 600, 100, 100);
    const moved = d.update(633, 200, 100, KEY, true).events;
    expect(moved).toEqual([expect.objectContaining({ type: 'cancel', reason: 'moved' })]);
    expect(types(run(d, 666, 900, 200, 100))).not.toContain('fire');
  });

  it('tolerates small movement inside the radius', () => {
    const d = new DwellDetector(config);
    const events: DwellEvent[] = [];
    for (let t = 0; t <= 1300; t += FRAME) events.push(...d.update(t, 100 + Math.sin(t / 50) * 12, 100, KEY, true).events);
    expect(types(events)).toEqual(['start', 'fire']);
  });

  it('cancels when tracking confidence falls', () => {
    const d = new DwellDetector(config);
    run(d, 0, 600, 100, 100);
    const lost = d.update(633, 100, 100, KEY, false).events;
    expect(lost).toEqual([expect.objectContaining({ type: 'cancel', reason: 'tracking' })]);
    // Recovering does not resume the old countdown: it starts again.
    expect(types(run(d, 666, 1200, 100, 100))).toEqual(['start']);
  });

  it('restarts when the target under the cursor changes', () => {
    const d = new DwellDetector(config);
    run(d, 0, 800, 100, 100, { el: 'a' });
    const changed = d.update(833, 100, 100, { el: 'b' }, true).events;
    expect(changed).toEqual([expect.objectContaining({ type: 'cancel', reason: 'target-changed' })]);
  });

  it('does not dwell where there is no target', () => {
    const d = new DwellDetector(config);
    expect(run(d, 0, 5000, 100, 100, null)).toEqual([]);
  });

  it('does not click again until the cursor has left the spot', () => {
    const d = new DwellDetector(config);
    expect(types(run(d, 0, 1300, 100, 100))).toContain('fire');
    expect(run(d, 1333, 8000, 100, 100)).toEqual([]);
    run(d, 8033, 8100, 300, 300, null);
    expect(types(run(d, 8133, 9600, 100, 100))).toEqual(['start', 'fire']);
  });

  it('can be cancelled on request, and stays cancelled until the cursor moves', () => {
    const d = new DwellDetector(config);
    run(d, 0, 700, 100, 100);
    expect(d.cancel(733)).toEqual([expect.objectContaining({ type: 'cancel', reason: 'manual' })]);
    expect(run(d, 766, 4000, 100, 100)).toEqual([]);
  });

  it('ignores a brief pass over a target (arm delay)', () => {
    const d = new DwellDetector(config);
    expect(run(d, 0, 100, 100, 100)).toEqual([]);
    expect(run(d, 133, 200, 400, 400, null)).toEqual([]);
  });

  it('uses the configured dwell duration', () => {
    const d = new DwellDetector({ ...config, dwellMs: 2500 });
    expect(types(run(d, 0, 2000, 100, 100))).toEqual(['start']);
    expect(types(run(d, 2033, 2800, 100, 100))).toEqual(['fire']);
  });
});

describe('safety controller', () => {
  const config = { graceMs: 3000, autoPauseMs: 5000, resumeAfterLoss: 'auto' as const };

  it('blocks interaction until tracking is ready and the grace period is over', () => {
    const s = new SafetyController(config);
    expect(s.check('click').allowed).toBe(false);
    s.start(0);
    expect(s.phase).toBe('grace');
    expect(s.check('click').allowed).toBe(false);
    expect(s.cursorLive).toBe(true);
    expect(s.graceRemaining(1000)).toBe(2000);
    expect(s.tick(2999, true)).toBeNull();
    expect(s.tick(3000, true)).toBe('grace-ended');
    expect(s.check('click').allowed).toBe(true);
    expect(s.interactive).toBe(true);
  });

  it('allows setup actions during the grace period', () => {
    const s = new SafetyController(config);
    s.start(0);
    expect(s.check('pause').allowed).toBe(true);
    expect(s.check('recenter').allowed).toBe(true);
    expect(s.check('go_back').allowed).toBe(false);
    expect(s.check('scroll_down').allowed).toBe(false);
  });

  it('while paused, allows only resume, confirm / cancel and system actions', () => {
    const s = new SafetyController(config);
    s.start(0);
    s.tick(3000, true);
    expect(s.pause()).toBe('paused');
    expect(s.interactive).toBe(false);
    expect(s.cursorLive).toBe(false);
    for (const blocked of ['click', 'double_click', 'drag_start', 'scroll_down', 'go_back', 'close_tab', 'click_number', 'type_text', 'start_dictation'] as const) {
      expect(s.check(blocked).allowed, blocked).toBe(false);
    }
    for (const allowed of ['resume', 'toggle_pause', 'cancel', 'stop_listening', 'exit', 'show_settings'] as const) {
      expect(s.check(allowed).allowed, allowed).toBe(true);
    }
  });

  it('re-enters the grace period on resume', () => {
    const s = new SafetyController(config);
    s.start(0);
    s.tick(3000, true);
    s.pause();
    expect(s.resume(10000)).toBe('resumed');
    expect(s.phase).toBe('grace');
    expect(s.check('click').allowed).toBe(false);
    s.tick(13000, true);
    expect(s.check('click').allowed).toBe(true);
  });

  it('stays paused however long tracking is fine', () => {
    const s = new SafetyController(config);
    s.start(0);
    s.tick(3000, true);
    s.pause();
    for (let t = 3100; t < 60000; t += 500) expect(s.tick(t, true)).toBeNull();
    expect(s.phase).toBe('paused');
  });

  it('pauses automatically after sustained tracking loss, not after a brief one', () => {
    const s = new SafetyController(config);
    s.start(0);
    s.tick(3000, true);
    expect(s.tick(4000, false)).toBeNull();
    expect(s.tick(6000, true)).toBeNull();
    expect(s.tick(7000, false)).toBeNull();
    expect(s.tick(11999, false)).toBeNull();
    expect(s.tick(12000, false)).toBe('auto-paused');
    expect(s.phase).toBe('suspended');
    expect(s.check('click').allowed).toBe(false);
  });

  it('recovers through a fresh grace period when tracking returns', () => {
    const s = new SafetyController(config);
    s.start(0);
    s.tick(3000, true);
    s.tick(3001, false);
    s.tick(8001, false);
    expect(s.tick(9000, true)).toBe('recovered');
    expect(s.phase).toBe('grace');
    expect(s.check('click').allowed).toBe(false);
  });

  it('waits for an explicit resume when configured to', () => {
    const s = new SafetyController({ ...config, resumeAfterLoss: 'manual' });
    s.start(0);
    s.tick(3000, true);
    s.tick(3001, false);
    s.tick(8001, false);
    expect(s.tick(20000, true)).toBeNull();
    expect(s.phase).toBe('suspended');
    expect(s.resume(20001)).toBe('resumed');
  });

  it('blocks everything interactive in the error state', () => {
    const s = new SafetyController(config);
    s.setError('camera');
    expect(s.check('click').allowed).toBe(false);
    expect(s.check('use_voice').allowed).toBe(true);
  });
});

describe('tracking quality and performance', () => {
  it('measures loss rate and loss duration', () => {
    const m = new PresenceMonitor();
    for (let t = 0; t < 2000; t += 100) m.push(t, true);
    expect(m.lossRate).toBe(0);
    for (let t = 2000; t < 3000; t += 100) m.push(t, false);
    expect(m.lostMs(3000)).toBe(1000);
    expect(m.lossRate).toBeCloseTo(1 / 3, 1);
    m.push(3000, true);
    expect(m.lostMs(3000)).toBe(0);
  });

  it('rates face tracking from measured loss, jitter and frame rate', () => {
    expect(rateFaceQuality({ present: true, lossRate: 0, jitter: 0.001, fps: 30 })).toBe('good');
    expect(rateFaceQuality({ present: true, lossRate: 0.15, jitter: 0.001, fps: 30 })).toBe('fair');
    expect(rateFaceQuality({ present: true, lossRate: 0, jitter: 0.008, fps: 30 })).toBe('poor');
    expect(rateFaceQuality({ present: true, lossRate: 0, jitter: 0.001, fps: 6 })).toBe('poor');
    expect(rateFaceQuality({ present: false, lossRate: 0, jitter: 0, fps: 30 })).toBe('lost');
  });

  it('rates lighting from measured brightness and gives guidance', () => {
    expect(rateLighting(120, 40).rating).toBe('ok');
    expect(rateLighting(20, 10).rating).toBe('dark');
    expect(rateLighting(55, 30).rating).toBe('dim');
    expect(rateLighting(240, 10).rating).toBe('bright');
    expect(rateLighting(20, 10).advice).not.toBe('');
    expect(rateLighting(NaN, 0).rating).toBe('unknown');
  });

  it('lowers the hand model rate when frames are too slow, and restores it', () => {
    const g = new PerfGovernor(40);
    let t = 0;
    for (let i = 0; i < 200; i++) g.record((t += 60), 30, 30);
    expect(g.snapshot.degraded).toBe(true);
    expect(g.snapshot.handEvery).toBeGreaterThan(1);
    for (let i = 0; i < 600; i++) g.record((t += 33), 6, 6);
    expect(g.snapshot.degraded).toBe(false);
  });

  it('skips the hand model on the right frames when degraded', () => {
    const g = new PerfGovernor(40);
    let t = 0;
    for (let i = 0; i < 100; i++) g.record((t += 60), 30, 30);
    const every = g.snapshot.handEvery;
    let runs = 0;
    for (let i = 0; i < every * 10; i++) {
      if (g.shouldRunHands()) runs += 1;
      g.record((t += 60), 30, null);
    }
    expect(runs).toBe(10);
  });

  it('reports measured frame rate', () => {
    const g = new PerfGovernor(40);
    for (let i = 1; i <= 120; i++) g.record(i * 40, 5, 5);
    expect(g.snapshot.fps).toBeCloseTo(25, 0);
  });
});
