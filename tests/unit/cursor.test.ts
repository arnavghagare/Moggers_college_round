import { describe, expect, it } from 'vitest';
import {
  axisOffset,
  axisValid,
  defaultCalibration,
  headOffset,
  nudgeCalibration,
  recenterCalibration,
} from '../../src/core/cursor/headMapper';
import { CursorController, PointerPipeline, handOffset, type PointerConfig } from '../../src/core/cursor/pointer';
import { HeadPoseEstimator, JitterMeter, poseFromLandmarks, poseFromMatrix } from '../../src/core/face/pose';
import { OneEuroFilter, smoothingToParams } from '../../src/core/oneEuro';
import { TEST_ASPECT, makeFace } from '../helpers/synthetic';

/** Deterministic pseudo-random noise in [-1, 1]. */
function noise(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return (s / 4294967296) * 2 - 1;
  };
}

const variance = (xs: number[]): number => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
};

describe('One Euro filter', () => {
  it('strongly reduces jitter on a steady signal', () => {
    const f = new OneEuroFilter(smoothingToParams(0.6));
    const rnd = noise(7);
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 300; i++) {
      const v = 0.5 + rnd() * 0.01;
      raw.push(v);
      out.push(f.filter(v, i * 33));
    }
    expect(variance(out.slice(60))).toBeLessThan(variance(raw.slice(60)) * 0.1);
  });

  it('follows fast movement with little lag', () => {
    const f = new OneEuroFilter(smoothingToParams(0.6));
    let out = 0;
    // 2 screens per second for half a second.
    for (let i = 0; i <= 15; i++) out = f.filter((i * 33 * 2) / 1000, i * 33);
    const truth = (15 * 33 * 2) / 1000;
    expect(truth - out).toBeLessThan(0.1);
  });

  it('smooths more when the smoothing setting is higher', () => {
    const run = (s: number): number => {
      const f = new OneEuroFilter(smoothingToParams(s));
      const rnd = noise(3);
      const out: number[] = [];
      for (let i = 0; i < 200; i++) out.push(f.filter(rnd() * 0.01, i * 33));
      return variance(out.slice(50));
    };
    expect(run(0.9)).toBeLessThan(run(0.5));
    expect(run(0.5)).toBeLessThan(run(0.1));
  });

  it('ignores repeated timestamps instead of producing NaN', () => {
    const f = new OneEuroFilter(smoothingToParams(0.5));
    f.filter(1, 100);
    expect(f.filter(5, 100)).toBe(1);
    expect(Number.isFinite(f.filter(2, 133))).toBe(true);
  });

  it('starts fresh after reset', () => {
    const f = new OneEuroFilter(smoothingToParams(0.9));
    f.filter(0, 0);
    f.filter(0, 33);
    f.reset();
    expect(f.filter(10, 66)).toBe(10);
  });
});

describe('head pose', () => {
  it('reads yaw and pitch from the transformation matrix with user-centric signs', () => {
    const right = poseFromMatrix(makeFace({ yaw: 20 }).matrix!)!;
    expect(right.yaw).toBeCloseTo(20, 3);
    const up = poseFromMatrix(makeFace({ pitch: 12 }).matrix!)!;
    expect(up.pitch).toBeCloseTo(12, 3);
    expect(poseFromMatrix(makeFace({ yaw: -15 }).matrix!)!.yaw).toBeCloseTo(-15, 3);
  });

  it('rejects malformed matrices', () => {
    expect(poseFromMatrix([1, 2, 3])).toBeNull();
    expect(poseFromMatrix(new Array(16).fill(0))).toBeNull();
  });

  it('estimates pose from landmarks alone with the same signs', () => {
    const right = poseFromLandmarks(makeFace({ yaw: 20 }).landmarks, TEST_ASPECT);
    expect(right.yaw).toBeGreaterThan(10);
    const left = poseFromLandmarks(makeFace({ yaw: -20 }).landmarks, TEST_ASPECT);
    expect(left.yaw).toBeLessThan(-10);
    expect(poseFromLandmarks(makeFace({ pitch: 15 }).landmarks, TEST_ASPECT).pitch).toBeGreaterThan(5);
    expect(poseFromLandmarks(makeFace({ pitch: -15 }).landmarks, TEST_ASPECT).pitch).toBeLessThan(-5);
  });

  it('falls back to landmarks when no matrix is available', () => {
    const est = new HeadPoseEstimator();
    const f = est.update(makeFace({ yaw: 15, noMatrix: true }), TEST_ASPECT, 0);
    expect(f.pose.source).toBe('landmarks');
    expect(f.pose.yaw).toBeGreaterThan(5);
  });

  it('corrects a matrix whose yaw sign disagrees with the image', () => {
    const est = new HeadPoseEstimator();
    let yaw = 0;
    // Sweep the head left and right a few times with an inverted matrix.
    for (let i = 0; i < 200; i++) {
      const angle = 18 * Math.sin(i / 8);
      yaw = est.update(makeFace({ yaw: angle, flipMatrixYaw: true }), TEST_ASPECT, i * 33).pose.yaw;
      if (i > 150) expect(Math.sign(yaw) === Math.sign(angle) || Math.abs(angle) < 2).toBe(true);
    }
  });

  it('leaves a correct matrix alone', () => {
    const est = new HeadPoseEstimator();
    for (let i = 0; i < 120; i++) {
      const angle = 18 * Math.sin(i / 8);
      const yaw = est.update(makeFace({ yaw: angle }), TEST_ASPECT, i * 33).pose.yaw;
      expect(yaw).toBeCloseTo(angle, 3);
    }
  });

  it('reports nose position and face width', () => {
    const f = new HeadPoseEstimator().update(makeFace({ x: 0.4, y: 0.45 }), TEST_ASPECT, 0);
    expect(f.nose.x).toBeCloseTo(0.4, 5);
    expect(f.center.y).toBeCloseTo(0.45, 5);
    expect(f.width).toBeCloseTo(0.18, 5);
  });

  it('measures landmark jitter robustly', () => {
    const meter = new JitterMeter();
    const rnd = noise(11);
    for (let i = 0; i < 40; i++) meter.push({ x: 0.5 + rnd() * 0.001, y: 0.5 + rnd() * 0.001 });
    const quiet = meter.value;
    for (let i = 0; i < 40; i++) meter.push({ x: 0.5 + rnd() * 0.01, y: 0.5 + rnd() * 0.01 });
    expect(meter.value).toBeGreaterThan(quiet * 3);
  });
});

describe('calibrated axis mapping', () => {
  const axis = { neutral: 2, pos: 20, neg: -10 };

  it('maps neutral to 0 and the extremes to +/-1', () => {
    expect(axisOffset(2, axis)).toBe(0);
    expect(axisOffset(20, axis)).toBeCloseTo(1);
    expect(axisOffset(-10, axis)).toBeCloseTo(-1);
  });

  it('scales each side by its own range', () => {
    expect(axisOffset(11, axis)).toBeCloseTo(0.5);
    expect(axisOffset(-4, axis)).toBeCloseTo(-0.5);
  });

  it('works when the underlying signal runs the other way', () => {
    const reversed = { neutral: 0, pos: -15, neg: 15 };
    expect(axisOffset(-15, reversed)).toBeCloseTo(1);
    expect(axisOffset(7.5, reversed)).toBeCloseTo(-0.5);
  });

  it('validates that the two extremes are on opposite sides and large enough', () => {
    expect(axisValid({ neutral: 0, pos: 10, neg: -8 }, 4)).toBe(true);
    expect(axisValid({ neutral: 0, pos: 10, neg: 6 }, 4)).toBe(false);
    expect(axisValid({ neutral: 0, pos: 2, neg: -8 }, 4)).toBe(false);
  });

  it('maps head samples through the selected source, with optional inversion', () => {
    const cal = defaultCalibration({ yaw: 0, pitch: 0, x: 0.5, y: 0.5 });
    const turned = { yaw: 8, pitch: 5.5, x: 0.5, y: 0.5 };
    const pose = headOffset(turned, cal, { source: 'pose', invertX: false, invertY: false });
    expect(pose.x).toBeCloseTo(0.5);
    // Looking up moves the pointer up (negative v).
    expect(pose.y).toBeCloseTo(-0.5);
    const inverted = headOffset(turned, cal, { source: 'pose', invertX: true, invertY: true });
    expect(inverted.x).toBeCloseTo(-0.5);
    expect(inverted.y).toBeCloseTo(0.5);
    const position = headOffset({ ...turned, x: 0.535 }, cal, { source: 'position', invertX: false, invertY: false });
    expect(position.x).toBeCloseTo(0.5);
  });

  it('recentres without changing the ranges', () => {
    const cal = defaultCalibration({ yaw: 0, pitch: 0, x: 0.5, y: 0.5 });
    const moved = recenterCalibration(cal, { yaw: 6, pitch: -3, x: 0.55, y: 0.52 });
    const opts = { source: 'pose' as const, invertX: false, invertY: false };
    expect(headOffset({ yaw: 6, pitch: -3, x: 0, y: 0 }, moved, opts)).toEqual({ x: 0, y: 0 });
    expect(moved.pose.x.pos - moved.pose.x.neutral).toBeCloseTo(cal.pose.x.pos - cal.pose.x.neutral);
  });

  it('nudges neutral by an offset expressed in calibrated units', () => {
    const cal = defaultCalibration({ yaw: 0, pitch: 0, x: 0.5, y: 0.5 });
    const nudged = nudgeCalibration(cal, 'pose', 0.25, 0);
    const opts = { source: 'pose' as const, invertX: false, invertY: false };
    const before = headOffset({ yaw: 8, pitch: 0, x: 0, y: 0 }, cal, opts).x;
    const after = headOffset({ yaw: 8, pitch: 0, x: 0, y: 0 }, nudged, opts).x;
    expect(before - after).toBeCloseTo(0.25);
  });
});

const CONFIG: PointerConfig = { sensitivity: 1, smoothing: 0.5, deadZone: 0.006, acceleration: 0, dynamics: 'absolute' };

function settle(p: PointerPipeline, u: number, v: number, from = 0, frames = 90) {
  let out = { x: 0.5, y: 0.5 };
  for (let i = 0; i < frames; i++) out = p.update(u, v, from + i * 33);
  return out;
}

describe('pointer pipeline', () => {
  it('maps the neutral offset to the screen centre and +/-1 to the edges', () => {
    expect(settle(new PointerPipeline(CONFIG), 0, 0)).toEqual({ x: 0.5, y: 0.5 });
    const right = settle(new PointerPipeline({ ...CONFIG, deadZone: 0 }), 1, 0);
    expect(right.x).toBeCloseTo(1, 2);
    const up = settle(new PointerPipeline({ ...CONFIG, deadZone: 0 }), 0, -1);
    expect(up.y).toBeCloseTo(0, 2);
  });

  it('clamps to the screen', () => {
    const p = settle(new PointerPipeline(CONFIG), 3, -3);
    expect(p).toEqual({ x: 1, y: 0 });
  });

  it('scales movement with sensitivity', () => {
    const low = settle(new PointerPipeline({ ...CONFIG, deadZone: 0, sensitivity: 0.5 }), 0.4, 0).x - 0.5;
    const high = settle(new PointerPipeline({ ...CONFIG, deadZone: 0, sensitivity: 1.5 }), 0.4, 0).x - 0.5;
    expect(high / low).toBeCloseTo(3, 1);
  });

  it('holds the cursor perfectly still for tremor inside the dead zone', () => {
    const p = new PointerPipeline({ ...CONFIG, deadZone: 0.01, smoothing: 0 });
    const rnd = noise(5);
    const rest = settle(p, 0.3, 0.1);
    const positions = new Set<string>();
    for (let i = 0; i < 200; i++) {
      // +/-0.008 in offset units is +/-0.004 of the screen: inside the 0.01 radius.
      const out = p.update(0.3 + rnd() * 0.008, 0.1 + rnd() * 0.008, 3000 + i * 33);
      positions.add(`${out.x},${out.y}`);
    }
    expect(positions.size).toBe(1);
    expect([...positions][0]).toBe(`${rest.x},${rest.y}`);
  });

  it('moves once the input leaves the dead zone', () => {
    const p = new PointerPipeline({ ...CONFIG, deadZone: 0.01 });
    const rest = settle(p, 0, 0);
    const moved = settle(p, 0.2, 0, 3000);
    expect(moved.x).toBeGreaterThan(rest.x + 0.05);
  });

  it('with no dead zone, small movements pass through', () => {
    const p = new PointerPipeline({ ...CONFIG, deadZone: 0, smoothing: 0 });
    settle(p, 0, 0);
    const out = settle(p, 0.004, 0, 3000);
    expect(out.x).toBeGreaterThan(0.5);
  });

  it('absolute acceleration makes the centre more precise without losing the edges', () => {
    const linear = settle(new PointerPipeline({ ...CONFIG, deadZone: 0 }), 0.2, 0).x - 0.5;
    const curved = settle(new PointerPipeline({ ...CONFIG, deadZone: 0, acceleration: 1 }), 0.2, 0).x - 0.5;
    expect(curved).toBeLessThan(linear);
    const edge = settle(new PointerPipeline({ ...CONFIG, deadZone: 0, acceleration: 1 }), 1, 0).x;
    expect(edge).toBeCloseTo(1, 2);
  });

  it('relative mode: fast movement travels further than slow movement over the same input distance', () => {
    const travel = (frames: number): number => {
      const p = new PointerPipeline({ ...CONFIG, deadZone: 0, smoothing: 0, dynamics: 'relative', acceleration: 0.8 });
      p.syncTo({ x: 0.2, y: 0.5 });
      let out = { x: 0.2, y: 0.5 };
      for (let i = 0; i <= frames; i++) out = p.update((0.4 * i) / frames, 0, i * 33);
      return out.x - 0.2;
    };
    expect(travel(6)).toBeGreaterThan(travel(60) * 1.5);
  });

  it('relative mode: returning to neutral does not return the cursor (mouse-like)', () => {
    const p = new PointerPipeline({ ...CONFIG, deadZone: 0, smoothing: 0, dynamics: 'relative', acceleration: 0.8 });
    let out = { x: 0.5, y: 0.5 };
    for (let i = 0; i <= 5; i++) out = p.update(0.08 * i, 0, i * 33);
    for (let i = 0; i <= 80; i++) out = p.update(0.4 - 0.005 * i, 0, 200 + i * 33);
    expect(out.x).toBeGreaterThan(0.55);
  });
});

describe('cursor controller', () => {
  it('follows targets directly in normal operation', () => {
    const c = new CursorController();
    expect(c.follow({ x: 0.8, y: 0.2 }, 100)).toEqual({ x: 0.8, y: 0.2 });
  });

  it('holds still during the settling period, then glides without jumping', () => {
    const c = new CursorController();
    c.follow({ x: 0.2, y: 0.2 }, 0);
    c.beginSettle(33, 400);
    expect(c.follow({ x: 0.9, y: 0.9 }, 200)).toEqual({ x: 0.2, y: 0.2 });
    expect(c.isSettling(200)).toBe(true);

    let prev = c.position;
    let maxStep = 0;
    for (let t = 433; t < 2000; t += 33) {
      const p = c.follow({ x: 0.9, y: 0.9 }, t);
      maxStep = Math.max(maxStep, Math.hypot(p.x - prev.x, p.y - prev.y));
      prev = p;
    }
    expect(maxStep).toBeLessThan(0.06);
    expect(prev.x).toBeCloseTo(0.9, 5);
    expect(c.isGliding).toBe(false);
  });

  it('does not move while held', () => {
    const c = new CursorController();
    c.follow({ x: 0.3, y: 0.3 }, 0);
    expect(c.hold(500)).toEqual({ x: 0.3, y: 0.3 });
  });

  it('clamps targets to the screen', () => {
    expect(new CursorController().follow({ x: 1.4, y: -0.2 }, 10)).toEqual({ x: 1, y: 0 });
  });
});

describe('hand pointer mapping', () => {
  it('maps the central area of the frame to the whole screen', () => {
    expect(handOffset({ x: 0.5, y: 0.5 }, 0.6)).toEqual({ x: 0, y: 0 });
    expect(handOffset({ x: 0.8, y: 0.2 }, 0.6).x).toBeCloseTo(1);
    expect(handOffset({ x: 0.8, y: 0.2 }, 0.6).y).toBeCloseTo(-1);
  });

  it('a smaller active area means less hand travel for the same cursor travel', () => {
    expect(handOffset({ x: 0.6, y: 0.5 }, 0.4).x).toBeGreaterThan(handOffset({ x: 0.6, y: 0.5 }, 0.8).x);
  });
});
