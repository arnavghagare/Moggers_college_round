import { beforeEach, describe, expect, it } from 'vitest';
import type { FaceObservation } from '../../src/core/face/pose';
import { HandsfreeCore, type CoreSink } from '../../src/core/handsfreeCore';
import type { HandObservation } from '../../src/core/hand/features';
import type { BrowserCommand, PageAction, PageActionParams } from '../../src/shared/messages';
import { DEFAULT_SETTINGS, applyPatch, type DeepPartial, type Settings } from '../../src/shared/settings';
import { CALIBRATION_STEPS } from '../../src/core/calibration';
import { POSES, TEST_ASPECT, makeFace } from '../helpers/synthetic';

const FRAME = 33;

/**
 * Drives the whole core with mocked landmarks and transcripts and records
 * everything it sends out. No camera, microphone or browser is involved.
 */
class Harness {
  t = 1000;
  settings: Settings;
  core: HandsfreeCore;
  cursor = { x: 0.5, y: 0.5, show: false, ok: false };
  cursorTrail: Array<{ x: number; y: number }> = [];
  page: Array<{ action: PageAction; params?: PageActionParams }> = [];
  browser: Array<{ cmd: BrowserCommand; number?: number; text?: string }> = [];
  listening: boolean[] = [];
  exited = 0;
  private resultSeq = 0;

  constructor(patch: DeepPartial<Settings> = {}) {
    // Head steering plus hand gestures is an opt-in combination; most tests here use it.
    this.settings = applyPatch(applyPatch(DEFAULT_SETTINGS, { features: { handGestures: true } }), patch);
    const sink: CoreSink = {
      cursor: (x, y, show, ok) => {
        this.cursor = { x, y, show, ok };
        this.cursorTrail.push({ x, y });
      },
      page: (action, params) => {
        this.page.push({ action, params });
      },
      browser: (cmd, args) => {
        this.browser.push({ cmd, ...args });
      },
      patchSettings: (p) => this.configure(p),
      setListening: (on) => {
        this.listening.push(on);
      },
      exit: () => {
        this.exited += 1;
      },
    };
    this.core = new HandsfreeCore(this.settings, sink);
    this.core.ready(this.t);
  }

  configure(patch: DeepPartial<Settings>): void {
    this.settings = applyPatch(this.settings, patch);
    this.core.configure(this.settings, this.t);
  }

  /** Feed identical frames for `ms`. */
  run(ms: number, face: FaceObservation | null | undefined, hands: HandObservation[] | undefined = []): void {
    for (let e = 0; e < ms; e += FRAME) {
      this.t += FRAME;
      this.core.frame(this.t, { face, hands, aspect: TEST_ASPECT });
    }
  }

  /** Frames produced by a function of elapsed time. */
  animate(ms: number, make: (elapsed: number) => { face?: FaceObservation | null; hands?: HandObservation[] }): void {
    for (let e = FRAME; e <= ms; e += FRAME) {
      this.t += FRAME;
      const f = make(e);
      this.core.frame(this.t, { face: f.face === undefined ? makeFace() : f.face, hands: f.hands ?? [], aspect: TEST_ASPECT });
    }
  }

  /** Past the startup grace period, with a face in view. */
  activate(): this {
    this.run(this.settings.safety.graceMs + 700, makeFace());
    expect(this.core.phase).toBe('active');
    this.page = [];
    return this;
  }

  say(text: string, confidence: number | null = 0.92): void {
    this.t += 10;
    this.core.speechEvent({ kind: 'final', text, confidence, alternatives: [text] }, this.t, `s:${++this.resultSeq}`);
  }

  actions(): PageAction[] {
    return this.page.map((p) => p.action).filter((a) => a !== 'toast' && a !== 'cancelClick');
  }

  last(action: PageAction) {
    return [...this.page].reverse().find((p) => p.action === action);
  }

  status() {
    return this.core.status(this.t, 30);
  }
}

let h: Harness;
beforeEach(() => {
  h = new Harness();
});

describe('head-controlled cursor', () => {
  it('moves the cursor in the direction the head turns', () => {
    h.activate();
    const centre = { ...h.cursor };
    h.run(1500, makeFace({ yaw: 10 }));
    expect(h.cursor.x).toBeGreaterThan(centre.x + 0.15);
    expect(Math.abs(h.cursor.y - centre.y)).toBeLessThan(0.02);
    h.run(1500, makeFace({ yaw: -10 }));
    expect(h.cursor.x).toBeLessThan(centre.x - 0.15);
    h.run(1500, makeFace({ pitch: 8 }));
    expect(h.cursor.y).toBeLessThan(centre.y - 0.15);
  });

  it('shows the cursor during the grace period but does not allow dwell', () => {
    h.run(500, makeFace());
    expect(h.core.phase).toBe('grace');
    expect(h.cursor.show).toBe(true);
    expect(h.cursor.ok).toBe(false);
  });

  it('allows dwell once active and tracking', () => {
    h.activate();
    expect(h.cursor.ok).toBe(true);
  });

  it('applies the sensitivity setting to actual movement', () => {
    const travel = (sensitivity: number): number => {
      const x = new Harness({ cursor: { sensitivity, deadZone: 0 } }).activate();
      x.run(2000, makeFace({ yaw: 5 }));
      return x.cursor.x - 0.5;
    };
    const low = travel(0.5);
    const high = travel(2);
    expect(high / low).toBeGreaterThan(3);
  });

  it('applies a stored calibration', () => {
    const narrow = new Harness({
      calibration: {
        pose: { x: { neutral: 0, pos: 6, neg: -6 }, y: { neutral: 0, pos: -5, neg: 5 } },
        position: { x: { neutral: 0.5, pos: 0.55, neg: 0.45 }, y: { neutral: 0.5, pos: 0.55, neg: 0.45 } },
        quality: 0.9,
        createdAt: 123,
      },
    }).activate();
    narrow.run(2000, makeFace({ yaw: 6 }));
    // With a +/-6 degree calibrated range, 6 degrees reaches the right edge.
    expect(narrow.cursor.x).toBeGreaterThan(0.95);
    expect(narrow.status().calibrated).toBe(true);
  });

  it('can use nose position instead of head rotation', () => {
    const x = new Harness({ cursor: { headSource: 'position' } }).activate();
    x.run(1500, makeFace({ x: 0.54 }));
    expect(x.cursor.x).toBeGreaterThan(0.6);
  });

  it('inverts an axis when asked', () => {
    const x = new Harness({ cursor: { invertX: true } }).activate();
    x.run(1500, makeFace({ yaw: 10 }));
    expect(x.cursor.x).toBeLessThan(0.4);
  });

  it('recentres on request without a jump', () => {
    h.activate();
    h.run(1500, makeFace({ yaw: 9 }));
    const before = h.cursorTrail.length;
    expect(h.core.execute('recenter', {}, 'voice', h.t).status).toBe('executed');
    h.run(1500, makeFace({ yaw: 9 }));
    expect(h.cursor.x).toBeCloseTo(0.5, 1);
    const steps = h.cursorTrail.slice(before).map((p, i, a) => (i ? Math.abs(p.x - a[i - 1].x) : 0));
    expect(Math.max(...steps)).toBeLessThan(0.06);
  });

  it('holds the cursor still while the head trembles slightly', () => {
    h.activate();
    h.run(1000, makeFace({ yaw: 4 }));
    const start = h.cursorTrail.length;
    h.animate(2000, (e) => ({ face: makeFace({ yaw: 4 + Math.sin(e / 30) * 0.08, pitch: Math.cos(e / 37) * 0.06 }) }));
    const xs = h.cursorTrail.slice(start).map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.004);
  });
});

describe('tracking loss', () => {
  it('holds the cursor and blocks dwell as soon as the face is lost', () => {
    h.activate();
    h.run(800, makeFace({ yaw: 8 }));
    const held = { x: h.cursor.x, y: h.cursor.y };
    h.run(600, null);
    expect(h.cursor.x).toBe(held.x);
    expect(h.cursor.y).toBe(held.y);
    expect(h.cursor.ok).toBe(false);
    expect(h.status().face.present).toBe(false);
    expect(h.status().face.quality).toBe('lost');
  });

  it('does not jump when tracking returns somewhere else', () => {
    h.activate();
    h.run(800, makeFace({ yaw: -10 }));
    h.run(700, null);
    const start = h.cursorTrail.length;
    const held = h.cursor.x;
    // The face comes back turned the other way.
    h.run(200, makeFace({ yaw: 12 }));
    expect(h.cursor.x).toBe(held);
    expect(h.cursor.ok).toBe(false);
    h.run(2500, makeFace({ yaw: 12 }));
    const xs = h.cursorTrail.slice(start).map((p) => p.x);
    const steps = xs.map((x, i) => (i ? Math.abs(x - xs[i - 1]) : 0));
    expect(Math.max(...steps)).toBeLessThan(0.06);
    expect(h.cursor.x).toBeGreaterThan(0.7);
    expect(h.cursor.ok).toBe(true);
  });

  it('pauses automatically after sustained loss and releases anything held', () => {
    h.activate();
    h.core.execute('drag_start', {}, 'voice', h.t);
    h.page = [];
    h.run(h.settings.safety.autoPauseMs + 300, null);
    expect(h.core.phase).toBe('suspended');
    expect(h.page.map((p) => p.action)).toContain('dragCancel');
    expect(h.page.map((p) => p.action)).toContain('cancelClick');
    expect(h.status().stats.autoPauses).toBe(1);
    expect(h.core.execute('click', {}, 'voice', h.t).status).toBe('blocked');
  });

  it('recovers through a new grace period when the face returns', () => {
    h.activate();
    h.run(h.settings.safety.autoPauseMs + 300, null);
    h.run(300, makeFace());
    expect(h.core.phase).toBe('grace');
    expect(h.core.execute('click', {}, 'voice', h.t).status).toBe('blocked');
    h.run(h.settings.safety.graceMs + 100, makeFace());
    expect(h.core.phase).toBe('active');
    expect(h.status().stats.recoveries).toBe(1);
  });

  it('stays suspended until told to resume when auto-resume is off', () => {
    const x = new Harness({ safety: { resumeAfterLoss: 'manual' } }).activate();
    x.run(x.settings.safety.autoPauseMs + 300, null);
    x.run(3000, makeFace());
    expect(x.core.phase).toBe('suspended');
    x.say('resume');
    expect(x.core.phase).toBe('grace');
  });

  it('reports measured loss rate', () => {
    h.activate();
    h.animate(4000, (e) => ({ face: Math.floor(e / 330) % 2 === 0 ? makeFace() : null }));
    expect(h.status().face.lossRate).toBeGreaterThan(0.3);
    expect(['poor', 'lost']).toContain(h.status().face.quality);
  });
});

describe('pause and resume', () => {
  it('stops cursor movement, dwell and every interaction while paused', () => {
    h.activate();
    h.say('pause handsfree');
    expect(h.core.phase).toBe('paused');
    const frozen = { x: h.cursor.x, y: h.cursor.y };
    h.page = [];
    h.browser = [];

    h.run(2000, makeFace({ yaw: 15 }), [POSES.pinch()]);
    h.run(300, makeFace({ yaw: 15 }), [POSES.open()]);
    for (const phrase of ['click', 'scroll down', 'go back', 'show numbers', 'click 3', 'start dictation', 'open new tab']) h.say(phrase);

    expect(h.cursor.x).toBe(frozen.x);
    expect(h.cursor.ok).toBe(false);
    expect(h.actions()).toEqual([]);
    expect(h.browser).toEqual([]);
  });

  it('resumes by voice, through the grace period', () => {
    h.activate();
    h.say('pause');
    h.say('resume handsfree');
    expect(h.core.phase).toBe('grace');
    h.run(h.settings.safety.graceMs + 100, makeFace());
    expect(h.core.phase).toBe('active');
    h.say('scroll down');
    expect(h.actions()).toContain('scrollBy');
  });

  it('"stop" pauses immediately', () => {
    h.activate();
    h.say('stop');
    expect(h.core.phase).toBe('paused');
  });

  it('pausing releases a drag and cancels a pending confirmation', () => {
    h.activate();
    h.core.execute('drag_start', {}, 'voice', h.t);
    h.say('close tab');
    expect(h.status().pending).not.toBeNull();
    h.page = [];
    h.say('pause');
    expect(h.page.map((p) => p.action)).toContain('dragCancel');
    expect(h.status().pending).toBeNull();
    expect(h.status().cursor.dragging).toBe(false);
  });

  it('a sustained hand raise toggles pause, also while paused', () => {
    h.activate();
    h.run(1600, makeFace(), [POSES.open({ y: 0.3 })]);
    expect(h.core.phase).toBe('paused');
    h.run(400, makeFace(), []);
    h.run(3000, makeFace(), [POSES.open({ y: 0.3 })]);
    expect(h.core.phase).toBe('grace');
  });
});

describe('gestures to actions', () => {
  it('pinch tap clicks on release, once', () => {
    h.activate();
    h.run(300, makeFace(), [POSES.open({ y: 0.7 })]);
    h.run(200, makeFace(), [POSES.pinch({ y: 0.7 })]);
    expect(h.actions()).not.toContain('click');
    h.run(300, makeFace(), [POSES.open({ y: 0.7 })]);
    expect(h.actions().filter((a) => a === 'click')).toHaveLength(1);
    expect(h.status().gestureLog.find((g) => g.id === 'pinch')).toMatchObject({ executed: true, action: 'Click' });
  });

  it('a pinch does not click during the grace period', () => {
    h.run(500, makeFace(), [POSES.open({ y: 0.7 })]);
    h.run(200, makeFace(), [POSES.pinch({ y: 0.7 })]);
    h.run(300, makeFace(), [POSES.open({ y: 0.7 })]);
    expect(h.actions()).not.toContain('click');
    const entry = h.status().gestureLog.find((g) => g.id === 'pinch');
    expect(entry).toMatchObject({ executed: false });
    expect(entry?.reason).toMatch(/Starting up/);
  });

  it('pinch and hold drags; releasing drops', () => {
    h.activate();
    h.run(900, makeFace(), [POSES.pinch({ y: 0.7 })]);
    expect(h.actions()).toContain('dragStart');
    expect(h.status().cursor.dragging).toBe(true);
    expect(h.cursor.ok).toBe(false);
    h.run(300, makeFace(), [POSES.open({ y: 0.7 })]);
    expect(h.actions()).toContain('dragEnd');
    expect(h.actions()).not.toContain('click');
  });

  it('cancels the drag when the hand is lost mid-drag', () => {
    h.activate();
    h.run(900, makeFace(), [POSES.pinch({ y: 0.7 })]);
    h.run(600, makeFace(), []);
    expect(h.actions()).toContain('dragCancel');
    expect(h.actions()).not.toContain('dragEnd');
    expect(h.status().cursor.dragging).toBe(false);
  });

  it('two fingers scroll in the direction the hand moves from where it started', () => {
    h.activate();
    h.run(400, makeFace(), [POSES.two({ y: 0.6 })]);
    h.page = [];
    h.run(600, makeFace(), [POSES.two({ y: 0.75 })]);
    const down = h.page.filter((p) => p.action === 'scrollBy');
    expect(down.length).toBeGreaterThan(5);
    expect(down.every((p) => (p.params?.dy ?? 0) > 0)).toBe(true);
    h.page = [];
    h.run(600, makeFace(), [POSES.two({ y: 0.45 })]);
    expect(h.page.filter((p) => p.action === 'scrollBy').every((p) => (p.params?.dy ?? 0) < 0)).toBe(true);
    // Releasing the gesture stops the scroll (after the short release debounce).
    h.run(400, makeFace(), [POSES.open({ y: 0.45 })]);
    h.page = [];
    h.run(400, makeFace(), [POSES.open({ y: 0.45 })]);
    expect(h.page.filter((p) => p.action === 'scrollBy')).toHaveLength(0);
  });

  it('swipes navigate in head mode', () => {
    h.activate();
    h.run(300, makeFace(), [POSES.open({ x: 0.7, y: 0.7 })]);
    h.animate(300, (e) => ({ hands: [POSES.open({ x: 0.7 - (0.4 * e) / 300, y: 0.7 })] }));
    expect(h.browser.map((b) => b.cmd)).toEqual(['back']);
  });

  it('uses the configured action mapping', () => {
    h.configure({ gestures: { three_fingers: { action: 'show_numbers' } } });
    h.activate();
    h.run(600, makeFace(), [POSES.three()]);
    expect(h.actions()).toContain('showHints');
  });

  it('ignores a gesture that is switched off', () => {
    h.configure({ gestures: { pinch: { enabled: false }, pinch_hold: { enabled: false } } });
    h.activate();
    h.run(200, makeFace(), [POSES.pinch()]);
    h.run(300, makeFace(), [POSES.open()]);
    expect(h.actions()).not.toContain('click');
  });

  it('ignores hand gestures entirely when the feature is off', () => {
    h.configure({ features: { handGestures: false } });
    h.activate();
    h.run(200, makeFace(), [POSES.pinch()]);
    h.run(300, makeFace(), [POSES.open()]);
    h.run(600, makeFace(), [POSES.three()]);
    expect(h.actions()).toEqual([]);
  });

  it('facial gestures act only when the feature and the gesture are both enabled', () => {
    const mouth = makeFace({ blendshapes: { jawOpen: 0.9, eyeBlinkLeft: 0, eyeBlinkRight: 0 } });
    h.activate();
    h.run(800, mouth);
    expect(h.actions()).not.toContain('click');

    h.configure({ features: { faceGestures: true }, gestures: { mouth_open: { enabled: true } } });
    h.run(500, makeFace());
    h.run(800, mouth);
    expect(h.actions().filter((a) => a === 'click')).toHaveLength(1);
  });

  it('natural blinks never click, even with blink gestures enabled', () => {
    h.configure({ features: { faceGestures: true }, gestures: { blink_long: { enabled: true }, double_blink: { enabled: true } } });
    h.activate();
    const blink = makeFace({ blendshapes: { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9, jawOpen: 0 } });
    for (let i = 0; i < 5; i++) {
      h.run(130, blink);
      h.run(2000, makeFace());
    }
    expect(h.actions()).not.toContain('click');
  });

  it('keeps a log of recognised gestures with confidence', () => {
    h.activate();
    h.run(600, makeFace(), [POSES.three()]);
    const entry = h.status().gestureLog[0];
    expect(entry).toMatchObject({ id: 'three_fingers', name: 'Three fingers' });
    expect(entry.confidence).toBeGreaterThan(0.65);
  });
});

describe('hand-controlled cursor', () => {
  let x: Harness;
  beforeEach(() => {
    x = new Harness({ controlMode: 'hand' });
    x.run(x.settings.safety.graceMs + 200, undefined, [POSES.point({ x: 0.5, y: 0.5 })]);
    expect(x.core.phase).toBe('active');
    x.page = [];
  });

  it('follows a pointing hand', () => {
    x.run(1500, undefined, [POSES.point({ x: 0.7, y: 0.5 })]);
    expect(x.cursor.x).toBeGreaterThan(0.7);
    expect(x.cursor.ok).toBe(true);
    x.run(1500, undefined, [POSES.point({ x: 0.3, y: 0.4 })]);
    expect(x.cursor.x).toBeLessThan(0.3);
  });

  it('freezes on a fist and does not dwell while frozen', () => {
    x.run(1000, undefined, [POSES.point({ x: 0.7, y: 0.5 })]);
    const at = x.cursor.x;
    x.run(1000, undefined, [POSES.fist({ x: 0.3, y: 0.5 })]);
    expect(x.cursor.x).toBe(at);
    expect(x.cursor.ok).toBe(false);
    expect(x.status().cursor.frozen).toBe(true);
  });

  it('keeps the cursor still during a pinch so the click lands where aimed', () => {
    x.run(1000, undefined, [POSES.point({ x: 0.65, y: 0.5 })]);
    const at = { ...x.cursor };
    x.run(200, undefined, [POSES.pinch({ x: 0.69, y: 0.53 })]);
    expect(x.cursor.x).toBe(at.x);
    expect(x.cursor.y).toBe(at.y);
    x.run(200, undefined, [POSES.open({ x: 0.69, y: 0.53 })]);
    expect(x.actions()).toContain('click');
  });

  it('a missing hand is idle, not a tracking failure', () => {
    x.run(x.settings.safety.autoPauseMs + 2000, undefined, []);
    expect(x.core.phase).toBe('active');
    expect(x.cursor.ok).toBe(false);
  });

  it('glides instead of jumping when the hand reappears elsewhere', () => {
    x.run(800, undefined, [POSES.point({ x: 0.3, y: 0.5 })]);
    x.run(600, undefined, []);
    const start = x.cursorTrail.length;
    x.run(1500, undefined, [POSES.point({ x: 0.72, y: 0.5 })]);
    const xs = x.cursorTrail.slice(start).map((p) => p.x);
    const steps = xs.map((v, i) => (i ? Math.abs(v - xs[i - 1]) : 0));
    expect(Math.max(...steps)).toBeLessThan(0.06);
    expect(x.cursor.x).toBeGreaterThan(0.7);
  });

  it('does not read fast pointing movement as a swipe', () => {
    x.run(300, undefined, [POSES.open({ x: 0.7, y: 0.6 })]);
    x.animate(300, (e) => ({ face: undefined as never, hands: [POSES.open({ x: 0.7 - (0.4 * e) / 300, y: 0.6 })] }));
    expect(x.browser).toEqual([]);
  });
});

describe('control modes', () => {
  it('switches between head and hand control by voice', () => {
    h.activate();
    h.say('use hand control');
    expect(h.settings.controlMode).toBe('hand');
    h.run(100, makeFace(), [POSES.point()]);
    expect(h.core.cursorSource).toBe('hand');
    h.say('use head control');
    h.run(100, makeFace());
    expect(h.core.cursorSource).toBe('head');
  });

  it('"switch control mode" toggles', () => {
    h.activate();
    h.say('switch control mode');
    expect(h.settings.controlMode).toBe('hand');
    h.say('switch control mode');
    expect(h.settings.controlMode).toBe('head');
  });

  it('voice-only mode has no cursor and refuses pointer clicks with guidance', () => {
    const v = new Harness({ controlMode: 'voice' });
    for (let i = 0; i < 40; i++) v.core.tick((v.t += 100));
    expect(v.core.phase).toBe('active');
    expect(v.core.cursorSource).toBe('none');
    v.say('click');
    expect(v.actions()).not.toContain('click');
    expect(v.status().voice.lastMessage).toMatch(/show numbers/);
    v.say('scroll down');
    expect(v.actions()).toContain('scrollBy');
  });

  it('hybrid mode switches source only on request by default', () => {
    const x = new Harness({ controlMode: 'hybrid' }).activate();
    x.run(1500, makeFace(), [POSES.point({ x: 0.8 })]);
    expect(x.core.cursorSource).toBe('head');
    x.say('use hand control');
    x.run(100, makeFace(), [POSES.point({ x: 0.8 })]);
    expect(x.core.cursorSource).toBe('hand');
    expect(x.settings.controlMode).toBe('hybrid');
  });

  it('hybrid hand-priority lets a pointing hand take over and hands back to the head', () => {
    const x = new Harness({ controlMode: 'hybrid', hybridPolicy: 'handPriority' }).activate();
    x.run(800, makeFace(), [POSES.point({ x: 0.8 })]);
    expect(x.core.cursorSource).toBe('hand');
    x.run(1500, makeFace(), []);
    expect(x.core.cursorSource).toBe('head');
  });

  it('never jumps when the source changes', () => {
    const x = new Harness({ controlMode: 'hybrid' }).activate();
    x.run(1000, makeFace({ yaw: -10 }), [POSES.point({ x: 0.8 })]);
    const start = x.cursorTrail.length;
    x.say('use hand control');
    x.run(2000, makeFace({ yaw: -10 }), [POSES.point({ x: 0.8 })]);
    const xs = x.cursorTrail.slice(start).map((p) => p.x);
    const steps = xs.map((v, i) => (i ? Math.abs(v - xs[i - 1]) : 0));
    expect(Math.max(...steps)).toBeLessThan(0.06);
  });
});

describe('voice commands', () => {
  beforeEach(() => {
    h.activate();
  });

  it('routes navigation commands to the browser', () => {
    for (const phrase of ['go back', 'go forward', 'reload page', 'open new tab', 'switch tab', 'switch to tab 3']) h.say(phrase);
    expect(h.browser).toEqual([
      { cmd: 'back' },
      { cmd: 'forward' },
      { cmd: 'reload' },
      { cmd: 'newTab' },
      { cmd: 'nextTab' },
      { cmd: 'switchTab', number: 3 },
    ]);
  });

  it('routes page commands to the page', () => {
    h.say('scroll down');
    expect(h.last('scrollBy')?.params?.dy).toBeGreaterThan(0);
    h.say('scroll up');
    expect(h.last('scrollBy')?.params?.dy).toBeLessThan(0);
    h.say('scroll to top');
    expect(h.last('scrollTo')?.params?.to).toBe('top');
    h.say('go to beginning');
    h.say('scroll to bottom');
    expect(h.last('scrollTo')?.params?.to).toBe('bottom');
    h.say('click');
    h.say('double click');
    h.say('right click');
    expect(h.actions().slice(-3)).toEqual(['click', 'doubleClick', 'rightClick']);
  });

  it('exposes the phrase, intent, confidence and outcome', () => {
    h.say('Scroll down.', 0.87);
    expect(h.status().voice).toMatchObject({
      lastPhrase: 'Scroll down.',
      lastIntent: 'Scroll down',
      lastConfidence: 0.87,
      lastStatus: 'executed',
    });
    h.say('what is the weather like');
    expect(h.status().voice.lastStatus).toBe('unknown');
    expect(h.status().stats.failedCommands).toBe(1);
    expect(h.actions()).toEqual(['scrollBy']);
  });

  it('asks for confirmation before closing a tab, and closes only on "confirm"', () => {
    h.say('close tab');
    expect(h.browser).toEqual([]);
    expect(h.status().pending?.prompt).toMatch(/Close tab/);
    expect(h.status().voice.lastStatus).toBe('pending');
    h.say('confirm');
    expect(h.browser).toEqual([{ cmd: 'closeTab' }]);
    expect(h.status().pending).toBeNull();
  });

  it('"cancel" drops the confirmation', () => {
    h.say('close tab');
    h.say('cancel');
    expect(h.browser).toEqual([]);
    expect(h.status().pending).toBeNull();
    h.say('confirm');
    expect(h.browser).toEqual([]);
  });

  it('a confirmation expires on its own', () => {
    h.say('close tab');
    h.run(10500, makeFace());
    expect(h.status().pending).toBeNull();
    h.say('confirm');
    expect(h.browser).toEqual([]);
  });

  it('confirms with a thumbs up and cancels with a thumbs down', () => {
    h.say('close tab');
    h.run(700, makeFace(), [POSES.thumbsUp()]);
    expect(h.browser).toEqual([{ cmd: 'closeTab' }]);
    h.run(1500, makeFace(), []);
    h.say('close tab');
    h.run(700, makeFace(), [POSES.thumbsDown()]);
    expect(h.browser).toHaveLength(1);
    expect(h.status().pending).toBeNull();
  });

  it('blocks pointer clicks while a confirmation is open', () => {
    h.say('close tab');
    h.say('click');
    expect(h.actions()).not.toContain('click');
  });

  it('rejects low-confidence speech and counts it as a failed command', () => {
    h.say('close tab', 0.2);
    expect(h.status().pending).toBeNull();
    expect(h.status().voice.lastStatus).toBe('rejected');
    expect(h.status().stats.failedCommands).toBe(1);
  });

  it('demands more confidence in a noisy room', () => {
    h.say('go back', 0.6);
    expect(h.browser).toHaveLength(1);
    h.core.speechEvent({ kind: 'level', level: 0.2, noiseFloor: 0.09 }, h.t);
    expect(h.status().voice.noisy).toBe(true);
    h.say('go back', 0.6);
    expect(h.browser).toHaveLength(1);
    h.say('go back', 0.9);
    expect(h.browser).toHaveLength(2);
  });

  it('drives the numbered labels', () => {
    h.say('show numbers');
    expect(h.last('showHints')?.params?.filter).toBe('all');
    h.say('click 7');
    expect(h.actions()).not.toContain('clickHint');
    h.core.agentMessage({ t: 'event', name: 'hints-shown', detail: '12' }, h.t);
    h.say('click 7');
    expect(h.last('clickHint')?.params?.number).toBe(7);
    h.say('12');
    expect(h.last('clickHint')?.params?.number).toBe(12);
    h.say('hide numbers');
    expect(h.actions()).toContain('hideHints');
  });

  it('turns Handsfree off only after confirmation', () => {
    h.say('turn off handsfree');
    expect(h.exited).toBe(0);
    h.say('confirm');
    expect(h.exited).toBe(1);
  });

  it('opens calibration and settings in the dashboard', () => {
    h.say('recalibrate');
    h.say('show settings');
    expect(h.browser).toEqual([
      { cmd: 'openDashboard', text: 'head?start=1' },
      { cmd: 'openDashboard', text: '' },
    ]);
  });
});

describe('listening control', () => {
  it('starts listening when ready and stops on "stop listening"', () => {
    expect(h.listening).toEqual([true]);
    h.activate();
    h.say('stop listening');
    expect(h.listening).toEqual([true, false]);
    expect(h.core.isListening).toBe(false);
    h.core.execute('toggle_listening', {}, 'keyboard', h.t);
    expect(h.listening).toEqual([true, false, true]);
  });

  it('does not listen at all when voice is switched off', () => {
    const x = new Harness({ features: { voice: false } });
    expect(x.listening).toEqual([]);
    x.configure({ features: { voice: true } });
    expect(x.listening).toEqual([true]);
    x.configure({ features: { voice: false } });
    expect(x.listening).toEqual([true, false]);
  });

  it('push-to-talk listens only after being asked, and times out', () => {
    const x = new Harness({ voice: { mode: 'push' } });
    expect(x.listening).toEqual([]);
    x.activate();
    x.core.execute('toggle_listening', {}, 'keyboard', x.t);
    expect(x.listening).toEqual([true]);
    x.run(9000, makeFace());
    expect(x.listening).toEqual([true, false]);
  });

  it('wake-word mode ignores speech that is not addressed to it', () => {
    const x = new Harness({ voice: { mode: 'wake' } }).activate();
    x.say('scroll down');
    expect(x.actions()).toEqual([]);
    expect(x.status().voice.lastPhrase).toBe('');
    x.say('computer scroll down');
    expect(x.actions()).toEqual(['scrollBy']);
  });

  it('reports recogniser errors with recovery guidance and stops on fatal ones', () => {
    h.activate();
    h.core.speechEvent({ kind: 'error', code: 'network' }, h.t);
    expect(h.status().voice.state).toBe('error');
    expect(h.status().voice.recovery).toMatch(/internet/);
    expect(h.core.isListening).toBe(true);
    h.core.speechEvent({ kind: 'error', code: 'not-allowed' }, h.t);
    expect(h.core.isListening).toBe(false);
    expect(h.status().voice.error).toMatch(/blocked/);
  });

  it('treats "no speech" as normal, not as an error', () => {
    h.core.speechEvent({ kind: 'state', state: 'listening' }, h.t);
    h.core.speechEvent({ kind: 'error', code: 'no-speech' }, h.t);
    expect(h.status().voice.state).toBe('listening');
    expect(h.status().voice.error).toBeNull();
  });
});

describe('dictation', () => {
  beforeEach(() => {
    h.activate();
  });

  it('types speech only between "start dictation" and "stop dictation"', () => {
    h.say('hello there');
    expect(h.actions()).not.toContain('insertText');

    h.say('start dictation');
    expect(h.status().voice.dictating).toBe(true);
    h.say('hello there');
    h.say('scroll down');
    expect(h.page.filter((p) => p.action === 'insertText').map((p) => p.params?.text)).toEqual(['hello there', 'scroll down']);
    expect(h.actions()).not.toContain('scrollBy');

    h.say('stop dictation');
    expect(h.status().voice.dictating).toBe(false);
    h.say('scroll down');
    expect(h.actions()).toContain('scrollBy');
    expect(h.page.filter((p) => p.action === 'insertText')).toHaveLength(2);
  });

  it('does not insert the same recognition result twice', () => {
    h.say('start dictation');
    const event = { kind: 'final' as const, text: 'only once', confidence: 0.9, alternatives: ['only once'] };
    h.core.speechEvent(event, h.t, 'dup:1');
    h.core.speechEvent(event, h.t, 'dup:1');
    expect(h.page.filter((p) => p.action === 'insertText')).toHaveLength(1);
  });

  it('shows interim speech without typing it', () => {
    h.say('start dictation');
    h.core.speechEvent({ kind: 'interim', text: 'hel' }, h.t);
    h.core.speechEvent({ kind: 'interim', text: 'hello wor' }, h.t);
    expect(h.status().voice.interim).toBe('hello wor');
    expect(h.core.hud(h.t, { cameraOn: true, fps: 30 }).interim).toBe('hello wor');
    expect(h.actions()).not.toContain('insertText');
  });

  it('applies spoken punctuation', () => {
    h.say('start dictation');
    h.say('see you soon comma thanks full stop');
    expect(h.last('insertText')?.params?.text).toBe('see you soon, thanks.');
  });

  it('"undo that" removes the latest phrase the page accepted', () => {
    h.say('start dictation');
    h.say('first');
    h.core.agentMessage({ t: 'event', name: 'text-inserted', requestId: h.last('insertText')!.params!.requestId }, h.t);
    h.say('second');
    h.core.agentMessage({ t: 'event', name: 'text-inserted', requestId: h.last('insertText')!.params!.requestId }, h.t);
    h.say('undo that');
    expect(h.last('undoText')?.params?.number).toBe(1);
    h.say('undo that');
    h.page = [];
    h.say('undo that');
    expect(h.actions()).not.toContain('undoText');
  });

  it('reports when no field is focused and does not keep the phrase', () => {
    h.say('start dictation');
    h.say('lost words');
    const id = h.last('insertText')!.params!.requestId;
    h.core.agentMessage({ t: 'event', name: 'text-failed', requestId: id, detail: 'No text field is focused.' }, h.t);
    expect(h.status().voice.lastMessage).toMatch(/No text field/);
    h.say('undo that');
    expect(h.actions()).not.toContain('undoText');
  });

  it('clearing the draft needs confirmation', () => {
    h.say('start dictation');
    for (const text of ['one', 'two']) {
      h.say(text);
      h.core.agentMessage({ t: 'event', name: 'text-inserted', requestId: h.last('insertText')!.params!.requestId }, h.t);
    }
    h.say('clear dictated draft');
    expect(h.actions()).not.toContain('undoText');
    h.say('confirm');
    expect(h.last('undoText')?.params?.number).toBe(2);
  });

  it('"type ..." inserts one phrase without entering dictation mode', () => {
    h.say('type Hello World');
    expect(h.last('insertText')?.params?.text).toBe('Hello World');
    expect(h.status().voice.dictating).toBe(false);
  });

  it('pausing by voice still works while dictating', () => {
    h.say('start dictation');
    h.say('pause handsfree');
    expect(h.core.phase).toBe('paused');
    expect(h.actions()).not.toContain('insertText');
  });
});

describe('page confirmations', () => {
  beforeEach(() => {
    h.activate();
  });

  it('a risky click waits for confirmation and proceeds on "confirm"', () => {
    h.core.agentMessage({ t: 'confirm-request', id: 'c1', prompt: 'Activate "Delete account"?' }, h.t);
    expect(h.status().pending).toMatchObject({ id: 'c1', prompt: 'Activate "Delete account"?' });
    expect(h.core.hud(h.t, { cameraOn: true, fps: 30 }).pending?.id).toBe('c1');
    h.say('confirm');
    expect(h.last('confirmed')?.params?.id).toBe('c1');
  });

  it('declines on "cancel" and on timeout', () => {
    h.core.agentMessage({ t: 'confirm-request', id: 'c1', prompt: 'x' }, h.t);
    h.say('cancel');
    expect(h.last('declined')?.params?.id).toBe('c1');
    h.core.agentMessage({ t: 'confirm-request', id: 'c2', prompt: 'x' }, h.t);
    h.run(10500, makeFace());
    expect(h.last('declined')?.params?.id).toBe('c2');
    expect(h.status().stats.confirmationsCanceled).toBe(2);
  });

  it('accepts an answer from the on-page buttons', () => {
    h.core.agentMessage({ t: 'confirm-request', id: 'c1', prompt: 'x' }, h.t);
    h.core.agentMessage({ t: 'confirm-answer', id: 'c1', ok: true }, h.t);
    expect(h.last('confirmed')?.params?.id).toBe('c1');
    h.core.agentMessage({ t: 'confirm-request', id: 'c2', prompt: 'x' }, h.t);
    h.core.agentMessage({ t: 'confirm-answer', id: 'stale', ok: true }, h.t);
    expect(h.status().pending?.id).toBe('c2');
  });

  it('drops a confirmation when the page changes', () => {
    h.core.agentMessage({ t: 'confirm-request', id: 'c1', prompt: 'x' }, h.t);
    h.core.targetChanged(1);
    expect(h.status().pending).toBeNull();
  });

  it('counts clicks and cancelled dwell clicks reported by the page', () => {
    h.core.agentMessage({ t: 'event', name: 'dwell-start' }, h.t);
    h.core.agentMessage({ t: 'event', name: 'dwell-cancel', detail: 'moved' }, h.t);
    h.core.agentMessage({ t: 'event', name: 'click', detail: 'Next' }, h.t);
    expect(h.status().stats).toMatchObject({ clicks: 1, canceledClicks: 1, dwellStarts: 1 });
  });
});

describe('calibration through the core', () => {
  it('suspends the cursor and gestures while calibrating, then stores the result', () => {
    h.activate();
    expect(h.core.startCalibration(h.t).status).toBe('executed');
    // The user points at each of the nine dots in turn.
    const poseFor = (id: string | null) => {
      const target = CALIBRATION_STEPS.find((s) => s.id === id)?.target ?? { x: 0.5, y: 0.5 };
      return { yaw: (target.x - 0.5) * 2 * 17, pitch: -(target.y - 0.5) * 2 * 11 };
    };
    let guard = 0;
    while (h.core.calibrating && guard++ < 3000) {
      h.run(FRAME, makeFace(poseFor(h.status().calibration.step)), [POSES.pinch()]);
      if (h.core.calibrating) expect(h.cursor.show).toBe(false);
    }
    h.run(300, makeFace(), [POSES.open()]);
    expect(h.status().calibration.phase).toBe('done');
    expect(h.settings.calibration).not.toBeNull();
    expect(h.actions()).not.toContain('click');
    expect(h.status().calibration.elapsedMs).toBeLessThan(30000);

    expect(h.settings.calibration?.fit?.pose).toBeDefined();
    expect(h.status().calibration.accuracy).not.toBeNull();

    // Pointing at the right-hand dot now puts the cursor on it.
    h.run(2500, makeFace(poseFor('right')));
    expect(h.cursor.x).toBeCloseTo(0.93, 1);
    expect(h.cursor.y).toBeCloseTo(0.5, 1);
    h.run(2500, makeFace(poseFor('bottom-left')));
    expect(h.cursor.x).toBeCloseTo(0.07, 1);
    expect(h.cursor.y).toBeCloseTo(0.91, 1);
  });

  it('"cancel" stops a calibration and keeps the old one', () => {
    h.activate();
    h.core.startCalibration(h.t);
    h.run(500, makeFace());
    h.say('cancel');
    expect(h.core.calibrating).toBe(false);
    expect(h.settings.calibration).toBeNull();
  });

  it('is refused in voice-only mode', () => {
    const v = new Harness({ controlMode: 'voice' });
    expect(v.core.startCalibration(v.t).status).toBe('blocked');
  });
});

describe('posture drift', () => {
  it('flags a sustained off-centre resting position', () => {
    h.activate();
    h.run(50000, makeFace({ yaw: 9 }));
    expect(h.status().postureShifted).toBe(true);
  });

  it('does not flag normal movement around neutral', () => {
    h.activate();
    h.animate(50000, (e) => ({ face: makeFace({ yaw: 10 * Math.sin(e / 2000) }) }));
    expect(h.status().postureShifted).toBe(false);
  });

  it('automatic adaptation moves the pointer only slowly', () => {
    const x = new Harness({ drift: 'auto' }).activate();
    x.run(40000, makeFace({ yaw: 9 }));
    const start = x.cursorTrail.length;
    x.run(10000, makeFace({ yaw: 9 }));
    const xs = x.cursorTrail.slice(start).map((p) => p.x);
    // Moving back toward the centre, by no more than about 2% of the range per second.
    expect(xs[xs.length - 1]).toBeLessThan(xs[0]);
    expect(xs[0] - xs[xs.length - 1]).toBeLessThan(0.15);
  });

  it('can be switched off', () => {
    const x = new Harness({ drift: 'off' }).activate();
    x.run(50000, makeFace({ yaw: 9 }));
    expect(x.status().postureShifted).toBe(false);
  });
});

describe('shutdown', () => {
  it('releases everything and stops listening', () => {
    h.activate();
    h.core.execute('drag_start', {}, 'voice', h.t);
    h.say('start dictation');
    h.say('close tab');
    h.page = [];
    h.core.shutdown(h.t);
    expect(h.page.map((p) => p.action)).toEqual(expect.arrayContaining(['dragCancel', 'cancelClick']));
    expect(h.listening[h.listening.length - 1]).toBe(false);
    expect(h.status().pending).toBeNull();
    expect(h.status().voice.dictating).toBe(false);
  });
});

describe('things people ask for', () => {
  beforeEach(() => {
    h.activate();
  });

  it('opens a known site in a new tab and loads one in the current tab', () => {
    h.say('open youtube');
    h.say('go to wikipedia');
    expect(h.browser).toEqual([
      { cmd: 'openUrl', text: 'https://www.youtube.com/' },
      { cmd: 'navigate', text: 'https://www.wikipedia.org/' },
    ]);
  });

  it('understands a spoken address', () => {
    h.say('go to example dot com');
    expect(h.browser).toEqual([{ cmd: 'navigate', text: 'https://example.com/' }]);
  });

  it('searches instead of guessing an address for an unknown name', () => {
    h.say('open the best ramen recipe');
    expect(h.browser).toEqual([{ cmd: 'search', text: 'the best ramen recipe' }]);
  });

  it('clicks a control by name', () => {
    h.say('click sign in');
    expect(h.last('clickText')?.params?.text).toBe('sign in');
  });

  it('reports when nothing on the page has that name', () => {
    h.say('click unicorn');
    h.core.agentMessage({ t: 'event', name: 'target-missing', detail: 'Nothing in view is called "unicorn".' }, h.t);
    expect(h.status().voice.lastMessage).toMatch(/unicorn/);
    expect(h.status().stats.failedCommands).toBe(1);
  });

  it('controls media on the page', () => {
    for (const phrase of ['pause video', 'play video', 'mute video', 'unmute video']) h.say(phrase);
    expect(h.page.filter((p) => p.action === 'media').map((p) => p.params?.media)).toEqual(['pause', 'play', 'mute', 'unmute']);
    expect(h.core.phase).toBe('active');
  });

  it('scrolls continuously until told to stop, and by different amounts', () => {
    h.say('keep scrolling');
    expect(h.last('autoScroll')?.params?.dy).toBeGreaterThan(0);
    h.say('keep scrolling up');
    expect(h.last('autoScroll')?.params?.dy).toBeLessThan(0);
    h.say('stop scrolling');
    expect(h.actions()).toContain('stopScroll');
    h.say('scroll down a little');
    const small = h.last('scrollBy')!.params!.dy!;
    h.say('scroll down a lot');
    expect(h.last('scrollBy')!.params!.dy!).toBeGreaterThan(small * 5);
  });

  it('pausing stops continuous scrolling', () => {
    h.say('keep scrolling');
    h.page = [];
    h.say('stop');
    expect(h.page.map((p) => p.action)).toContain('stopScroll');
  });

  it('shows and hides the help sheet, even while paused', () => {
    h.say('what can I say');
    expect(h.actions()).toContain('showHelp');
    h.say('pause');
    h.say('hide help');
    expect(h.actions()).toContain('hideHelp');
  });

  it('none of the new page actions run while paused', () => {
    h.say('pause');
    h.page = [];
    h.browser = [];
    for (const phrase of ['open youtube', 'go to wikipedia', 'click sign in', 'play video', 'keep scrolling', 'duplicate tab']) h.say(phrase);
    expect(h.page.filter((p) => !['toast', 'cancelClick', 'stopScroll'].includes(p.action))).toEqual([]);
    expect(h.browser).toEqual([]);
  });

  it('moves between fields and duplicates a tab', () => {
    h.say('next field');
    expect(h.last('pressKey')?.params?.key).toBe('Tab');
    h.say('previous field');
    expect(h.last('pressKey')?.params?.key).toBe('ShiftTab');
    h.say('duplicate tab');
    expect(h.browser).toEqual([{ cmd: 'duplicateTab' }]);
  });
});

describe('voice mode', () => {
  const voice = (): Harness => {
    const v = new Harness({ controlMode: 'voice' });
    for (let i = 0; i < 40; i++) v.core.tick((v.t += 100));
    expect(v.core.phase).toBe('active');
    return v;
  };
  const hud = (v: Harness) => v.core.hud(v.t, { cameraOn: false, fps: 0 });

  it('keeps numbers on screen so anything is one word away', () => {
    const v = voice();
    expect(hud(v).autoHints).toBe(true);
    v.core.agentMessage({ t: 'event', name: 'hints-shown', detail: '9' }, v.t);
    v.say('4');
    expect(v.last('clickHint')?.params?.number).toBe(4);
  });

  it('stops showing numbers when asked and brings them back on request', () => {
    const v = voice();
    v.say('hide numbers');
    expect(hud(v).autoHints).toBe(false);
    v.say('show numbers');
    expect(hud(v).autoHints).toBe(true);
  });

  it('does not number the page while paused or while a confirmation is open', () => {
    const v = voice();
    v.say('close tab');
    expect(hud(v).autoHints).toBe(false);
    v.say('cancel');
    v.say('pause');
    expect(hud(v).autoHints).toBe(false);
  });

  it('head and hand modes only show numbers on request', () => {
    h.activate();
    expect(h.core.hud(h.t, { cameraOn: true, fps: 30 }).autoHints).toBe(false);
  });

  it('can be switched off in settings', () => {
    const v = new Harness({ controlMode: 'voice', hints: { autoInVoiceMode: false } });
    for (let i = 0; i < 40; i++) v.core.tick((v.t += 100));
    expect(hud(v).autoHints).toBe(false);
  });

  it('switches between the three modes by voice', () => {
    h.activate();
    h.say('use voice mode');
    expect(h.settings.controlMode).toBe('voice');
    h.say('use hand control');
    expect(h.settings.controlMode).toBe('hand');
    h.say('use head control');
    expect(h.settings.controlMode).toBe('head');
  });
});

describe('hand pointer centre', () => {
  it('maps the configured resting spot to the middle of the screen', () => {
    const x = new Harness({ controlMode: 'hand', cursor: { handCenterX: 0.7, handCenterY: 0.4, handAnchor: 'palm' } });
    x.run(x.settings.safety.graceMs + 200, undefined, [POSES.open({ x: 0.7, y: 0.4 })]);
    x.run(1500, undefined, [POSES.open({ x: 0.7, y: 0.4 })]);
    expect(x.cursor.x).toBeCloseTo(0.5, 1);
    expect(x.cursor.y).toBeCloseTo(0.5, 1);
  });
});

describe('the three modes are separate by default', () => {
  it('head mode ignores hands unless hand gestures are switched on', () => {
    const x = new Harness({ features: { handGestures: false } }).activate();
    x.run(200, makeFace(), [POSES.pinch()]);
    x.run(300, makeFace(), [POSES.open()]);
    expect(x.actions()).not.toContain('click');
  });

  it('hand mode always recognises gestures, whatever that switch says', () => {
    const x = new Harness({ controlMode: 'hand', features: { handGestures: false } });
    x.run(x.settings.safety.graceMs + 200, undefined, [POSES.point({ x: 0.5, y: 0.5 })]);
    x.page = [];
    x.run(200, undefined, [POSES.pinch({ x: 0.5, y: 0.5 })]);
    x.run(300, undefined, [POSES.open({ x: 0.5, y: 0.5 })]);
    expect(x.actions()).toContain('click');
  });

  it('ships with hand gestures off outside hand mode', () => {
    expect(DEFAULT_SETTINGS.features.handGestures).toBe(false);
    expect(DEFAULT_SETTINGS.controlMode).toBe('head');
  });
});
