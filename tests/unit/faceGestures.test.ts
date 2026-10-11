import { beforeEach, describe, expect, it } from 'vitest';
import type { FaceSignals } from '../../src/core/face/pose';
import { FaceGestureEngine } from '../../src/core/gestures/faceGestureEngine';
import { defaultGestureConfigs, type GestureConfig } from '../../src/core/gestures/registry';

const FRAME = 33;
const REST: FaceSignals = { blinkLeft: 0.05, blinkRight: 0.05, jawOpen: 0.02, smile: 0.05, browUp: 0.05 };

let t: number;
let config: Record<string, GestureConfig>;
let engine: FaceGestureEngine;
let fired: string[];

function hold(signals: Partial<FaceSignals> | null, ms: number): string[] {
  const batch: string[] = [];
  for (let elapsed = 0; elapsed < ms; elapsed += FRAME) {
    t += FRAME;
    const events = engine.update(t, signals === null ? null : { ...REST, ...signals });
    batch.push(...events.map((e) => e.id));
  }
  fired.push(...batch);
  return batch;
}

const CLOSED = { blinkLeft: 0.9, blinkRight: 0.9 };

beforeEach(() => {
  t = 1000;
  fired = [];
  config = defaultGestureConfigs();
  for (const id of ['blink_long', 'double_blink', 'wink_left', 'wink_right', 'brow_raise', 'mouth_open', 'smile']) {
    config[id].enabled = true;
  }
  engine = new FaceGestureEngine(config);
});

describe('blinks', () => {
  it('ignores natural blinks', () => {
    for (let i = 0; i < 6; i++) {
      hold(CLOSED, 150);
      hold({}, 2500);
    }
    expect(fired).toEqual([]);
  });

  it('fires a long blink once, while the eyes are still closed', () => {
    const during = hold(CLOSED, 1500);
    expect(during).toEqual(['blink_long']);
    expect(hold({}, 500)).toEqual([]);
  });

  it('recognises a double blink but not a single one', () => {
    hold(CLOSED, 130);
    hold({}, 150);
    hold(CLOSED, 130);
    expect(hold({}, 100)).toEqual(['double_blink']);
  });

  it('does not join two blinks that are far apart', () => {
    hold(CLOSED, 130);
    hold({}, 900);
    hold(CLOSED, 130);
    hold({}, 300);
    expect(fired).toEqual([]);
  });

  it('distinguishes a wink from a blink', () => {
    expect(hold({ blinkLeft: 0.9, blinkRight: 0.05 }, 600)).toEqual(['wink_left']);
    hold({}, 1500);
    expect(hold({ blinkLeft: 0.05, blinkRight: 0.9 }, 600)).toEqual(['wink_right']);
  });
});

describe('sustained expressions', () => {
  it('requires the expression to be held for the minimum duration', () => {
    expect(hold({ jawOpen: 0.8 }, 200)).toEqual([]);
    hold({}, 400);
    expect(hold({ jawOpen: 0.8 }, 500)).toEqual(['mouth_open']);
  });

  it('never fires from a single noisy frame', () => {
    for (let i = 0; i < 10; i++) {
      hold({ browUp: 0.95 }, FRAME);
      hold({}, 300);
    }
    expect(fired).toEqual([]);
  });

  it('does not repeat while the expression is held', () => {
    expect(hold({ smile: 0.9 }, 5000)).toEqual(['smile']);
  });

  it('needs a release below the release threshold before it can fire again', () => {
    hold({ jawOpen: 0.8 }, 500);
    // Dips to between release (0.3) and activation (0.55): still considered held.
    hold({ jawOpen: 0.4 }, 300);
    hold({ jawOpen: 0.8 }, 2000);
    expect(fired).toEqual(['mouth_open']);
  });

  it('enforces the refractory period after a release', () => {
    hold({ browUp: 0.9 }, 500);
    hold({}, 100);
    // Raised again 0.6 s after the first activation: inside the 1 s refractory period.
    hold({ browUp: 0.9 }, 450);
    expect(fired).toEqual(['brow_raise']);
    hold({}, 1200);
    hold({ browUp: 0.9 }, 500);
    expect(fired).toEqual(['brow_raise', 'brow_raise']);
  });

  it('does nothing for disabled gestures', () => {
    config.mouth_open.enabled = false;
    engine.setConfig(config);
    expect(hold({ jawOpen: 0.95 }, 2000)).toEqual([]);
  });

  it('clears pending state when the face is lost', () => {
    hold({ jawOpen: 0.8 }, 200);
    hold(null, 100);
    // Only 200 ms of continuous evidence after the gap: not enough.
    expect(hold({ jawOpen: 0.8 }, 200)).toEqual([]);
  });
});
