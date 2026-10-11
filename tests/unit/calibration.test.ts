import { describe, expect, it } from 'vitest';
import { CALIBRATION_STEPS, CalibrationSession } from '../../src/core/calibration';
import { headOffset, recenterCalibration, type HeadSample } from '../../src/core/cursor/headMapper';
import { evalPoly, fitPoly, isPolyFit, leaveOneOutError, type FitSample } from '../../src/core/cursor/polyFit';
import { sanitizeSettings } from '../../src/shared/settings';
import type { Point } from '../../src/shared/types';

const FRAME = 33;

/**
 * A plausible person: yaw and pitch respond to where they point, with the
 * imperfections a real head has - the two axes leak into each other, the
 * response flattens toward the extremes, and neutral is not zero.
 */
function headFor(target: Point): HeadSample {
  const u = (target.x - 0.5) * 2;
  const v = (target.y - 0.5) * 2;
  const yaw = 2 + 17 * u - 2.2 * u * Math.abs(u) + 1.4 * v;
  const pitch = -3 - 12 * v + 1.6 * v * Math.abs(v) + 1.1 * u + 0.9 * u * u;
  return { yaw, pitch, x: 0.5 + 0.07 * u + 0.004 * v, y: 0.5 + 0.05 * v - 0.003 * u };
}

const tremor = (s: HeadSample, t: number): HeadSample => ({
  yaw: s.yaw + Math.sin(t / 40) * 0.25,
  pitch: s.pitch + Math.cos(t / 55) * 0.25,
  x: s.x + Math.sin(t / 70) * 0.0008,
  y: s.y + Math.cos(t / 60) * 0.0008,
});

const targetOf = (id: string | null): Point => CALIBRATION_STEPS.find((s) => s.id === id)?.target ?? { x: 0.5, y: 0.5 };

function run(sampleFor: (step: string | null, t: number) => HeadSample | null, limitMs = 90000) {
  let t = 0;
  const session = new CalibrationSession(t);
  while (session.active && t < limitMs) {
    t += FRAME;
    session.update(t, sampleFor(session.status(t).step, t));
  }
  return { session, t };
}

const POSE = { source: 'pose' as const, invertX: false, invertY: false };
const toScreen = (o: Point): Point => ({ x: 0.5 + o.x / 2, y: 0.5 + o.y / 2 });

describe('polynomial fit', () => {
  const grid: FitSample[] = [];
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) grid.push({ a: 3 + 10 * x + 1.5 * y, b: -2 + 6 * y + 0.8 * x * x, x, y });

  it('recovers a known non-linear, coupled mapping', () => {
    const fit = fitPoly(grid, [3, -2])!;
    expect(isPolyFit(fit)).toBe(true);
    for (const s of grid) {
      const p = evalPoly(fit, s.a, s.b);
      expect(p.x).toBeCloseTo(s.x, 1);
      expect(p.y).toBeCloseTo(s.y, 1);
    }
  });

  it('maps the neutral input to the centre', () => {
    const fit = fitPoly(grid, [3, -2])!;
    const p = evalPoly(fit, 3, -2);
    expect(Math.abs(p.x)).toBeLessThan(0.05);
    expect(Math.abs(p.y)).toBeLessThan(0.05);
  });

  it('needs more points than coefficients and a real range', () => {
    expect(fitPoly(grid.slice(0, 5), [3, -2])).toBeNull();
    expect(fitPoly(grid.map((s) => ({ ...s, a: 3 })), [3, -2])).toBeNull();
  });

  it('reports a small leave-one-out error for clean data and a larger one for noisy data', () => {
    const clean = leaveOneOutError(grid, [3, -2])!;
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const noisy = leaveOneOutError(grid.map((s) => ({ ...s, a: s.a + rnd() * 3, b: s.b + rnd() * 2 })), [3, -2])!;
    expect(clean).toBeLessThan(0.08);
    expect(noisy).toBeGreaterThan(clean * 1.5);
  });

  it('validates stored fits', () => {
    expect(isPolyFit({ neutral: [0, 0], scale: [1, 1], cx: [0, 1, 0, 0, 0, 0], cy: [0, 0, 1, 0, 0, 0] })).toBe(true);
    expect(isPolyFit({ neutral: [0, 0], scale: [0, 1], cx: [0, 1, 0, 0, 0, 0], cy: [0, 0, 1, 0, 0, 0] })).toBe(false);
    expect(isPolyFit({ neutral: [0, 0], scale: [1, 1], cx: [0, 1], cy: [0, 0, 1, 0, 0, 0] })).toBe(false);
    expect(isPolyFit({ neutral: [0, NaN], scale: [1, 1], cx: [0, 1, 0, 0, 0, 0], cy: [0, 0, 1, 0, 0, 0] })).toBe(false);
    expect(isPolyFit(null)).toBe(false);
  });
});

describe('9-point calibration', () => {
  it('uses a 3 x 3 grid with an instruction for every dot', () => {
    expect(CALIBRATION_STEPS).toHaveLength(9);
    expect(new Set(CALIBRATION_STEPS.map((s) => `${s.target.x},${s.target.y}`)).size).toBe(9);
    expect(CALIBRATION_STEPS[0].id).toBe('center');
    for (const s of CALIBRATION_STEPS) expect(s.instruction.length).toBeGreaterThan(5);
  });

  it('finishes in under 30 seconds and visits the dots in order', () => {
    const seen: string[] = [];
    const { session, t } = run((step, now) => {
      if (step && seen[seen.length - 1] !== step) seen.push(step);
      return tremor(headFor(targetOf(step)), now);
    });
    expect(session.result).not.toBeNull();
    expect(t).toBeLessThan(30000);
    expect(seen).toEqual(CALIBRATION_STEPS.map((s) => s.id));
    expect(session.status(t)).toMatchObject({ phase: 'done', progress: 1, stepIndex: 9, totalSteps: 9 });
  });

  it('lands on every calibrated dot', () => {
    const cal = run((step, now) => tremor(headFor(targetOf(step)), now)).session.result!;
    expect(cal.fit?.pose).toBeDefined();
    for (const step of CALIBRATION_STEPS) {
      const p = toScreen(headOffset(headFor(step.target), cal, POSE));
      expect(Math.hypot(p.x - step.target.x, p.y - step.target.y), step.id).toBeLessThan(0.03);
    }
  });

  it('is accurate between the dots too, and clearly better than scaling each axis separately', () => {
    const cal = run((step, now) => tremor(headFor(targetOf(step)), now)).session.result!;
    const axisOnly = { ...cal, fit: undefined };
    const probes: Point[] = [];
    for (const x of [0.2, 0.35, 0.65, 0.8]) for (const y of [0.2, 0.4, 0.6, 0.8]) probes.push({ x, y });
    const meanError = (c: typeof cal): number =>
      probes.reduce((sum, target) => {
        const p = toScreen(headOffset(headFor(target), c, POSE));
        return sum + Math.hypot(p.x - target.x, p.y - target.y);
      }, 0) / probes.length;
    const fitted = meanError(cal);
    const simple = meanError(axisOnly);
    expect(fitted).toBeLessThan(0.03);
    expect(fitted).toBeLessThan(simple * 0.6);
  });

  it('reports a measured accuracy and a quality derived from it', () => {
    const { session, t } = run((step, now) => tremor(headFor(targetOf(step)), now));
    const status = session.status(t);
    expect(status.accuracy).not.toBeNull();
    expect(status.accuracy!).toBeGreaterThan(0);
    expect(status.accuracy!).toBeLessThan(0.08);
    expect(session.result!.error).toBe(status.accuracy);
    expect(status.quality!).toBeGreaterThan(0.5);
  });

  it('also calibrates the nose-position source', () => {
    const cal = run((step, now) => tremor(headFor(targetOf(step)), now)).session.result!;
    expect(cal.fit?.position).toBeDefined();
    const p = toScreen(headOffset(headFor({ x: 0.93, y: 0.5 }), cal, { ...POSE, source: 'position' }));
    expect(p.x).toBeCloseTo(0.93, 1);
  });

  it('recentring moves the fitted model with the head', () => {
    const cal = run((step, now) => tremor(headFor(targetOf(step)), now)).session.result!;
    const shifted = { ...headFor({ x: 0.5, y: 0.5 }), yaw: 9, pitch: -7 };
    const moved = recenterCalibration(cal, shifted);
    const centre = toScreen(headOffset(shifted, moved, POSE));
    expect(centre.x).toBeCloseTo(0.5, 1);
    expect(centre.y).toBeCloseTo(0.5, 1);
  });

  it('survives being stored and loaded', () => {
    const cal = run((step, now) => tremor(headFor(targetOf(step)), now)).session.result!;
    const loaded = sanitizeSettings(JSON.parse(JSON.stringify({ calibration: cal }))).calibration!;
    expect(loaded.fit?.pose).toEqual(cal.fit?.pose);
    expect(loaded.error).toBe(cal.error);
    const broken = sanitizeSettings({ calibration: { ...cal, fit: { pose: { neutral: [0, 0], scale: [1, 1], cx: ['x'], cy: [] } } } }).calibration!;
    expect(broken.fit?.pose).toBeUndefined();
    expect(broken.pose).toEqual(cal.pose);
  });

  it('does not accept a reading while the head is moving', () => {
    let t = 0;
    const session = new CalibrationSession(t);
    while (t < 5000) {
      t += FRAME;
      session.update(t, { yaw: 20 * Math.sin(t / 150), pitch: 0, x: 0.5, y: 0.5 });
    }
    expect(session.status(t).stepIndex).toBe(0);
    expect(session.status(t).message).toMatch(/steady|still/i);
  });

  it('discards samples across a tracking gap', () => {
    let t = 0;
    const session = new CalibrationSession(t);
    while (t < 6000) {
      t += FRAME;
      session.update(t, Math.floor(t / 350) % 2 === 0 ? headFor({ x: 0.5, y: 0.5 }) : null);
    }
    expect(session.status(t).stepIndex).toBe(0);
  });

  it('times out with a clear message instead of accepting a bad reading', () => {
    const { session, t } = run(() => null);
    expect(session.failed).toBe(true);
    expect(session.result).toBeNull();
    expect(session.status(t).message).toMatch(/steady reading/);
  });

  it('fails when the head barely moves', () => {
    const { session, t } = run((_step, now) => tremor(headFor({ x: 0.5, y: 0.5 }), now));
    expect(session.failed).toBe(true);
    expect(session.status(t).message).toMatch(/too small/);
  });

  it('fails when left and right are on the same side', () => {
    const { session } = run((step, now) => {
      const target = targetOf(step);
      return tremor(headFor({ x: Math.max(target.x, 0.5), y: target.y }), now);
    });
    expect(session.failed).toBe(true);
  });

  it('can be cancelled, leaving no result', () => {
    const session = new CalibrationSession(0);
    session.update(500, headFor({ x: 0.5, y: 0.5 }));
    session.cancel(600);
    expect(session.active).toBe(false);
    expect(session.result).toBeNull();
    expect(session.status(700).message).toMatch(/cancelled/);
  });

  it('never reports less progress than the dots already completed', () => {
    let t = 0;
    let done = 0;
    const session = new CalibrationSession(t);
    while (session.active) {
      t += FRAME;
      const status = session.status(t);
      session.update(t, tremor(headFor(targetOf(status.step)), t));
      const now = session.status(t);
      expect(now.stepIndex).toBeGreaterThanOrEqual(done);
      expect(now.progress).toBeGreaterThanOrEqual(now.stepIndex / 9 - 1e-9);
      done = now.stepIndex;
    }
    expect(done).toBe(9);
  });
});
