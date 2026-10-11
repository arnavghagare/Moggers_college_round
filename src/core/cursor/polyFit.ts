import type { Point } from '../../shared/types';

/**
 * Second-order polynomial mapping from a 2D input (for example head yaw and
 * pitch) to a 2D screen offset, fitted by regularised least squares.
 *
 * This is the standard technique for pointer and gaze calibration with a
 * 3 x 3 grid of targets. Compared with scaling each axis separately it also
 * captures cross-coupling (turning the head changes the measured pitch a
 * little) and the non-linear response near the extremes.
 */
export interface PolyFit {
  /** Input values at the centre target. */
  neutral: [number, number];
  /** Input range used to normalise each axis. */
  scale: [number, number];
  /** Coefficients for [1, u, v, u*v, u^2, v^2], producing the x offset (-1..1). */
  cx: number[];
  /** Same, producing the y offset (-1..1). */
  cy: number[];
}

export interface FitSample {
  /** Raw input pair. */
  a: number;
  b: number;
  /** Target offset: (0, 0) is the screen centre, +/-1 the edges. */
  x: number;
  y: number;
}

const TERMS = 6;
const RIDGE = 1e-3;

const basis = (u: number, v: number): number[] => [1, u, v, u * v, u * u, v * v];

/** Solve A w = b by Gaussian elimination with partial pivoting. Returns null if singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const w = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = M[r][n];
    for (let c = r + 1; c < n; c++) sum -= M[r][c] * w[c];
    w[r] = sum / M[r][r];
  }
  return w.every(Number.isFinite) ? w : null;
}

function regress(rows: number[][], targets: number[]): number[] | null {
  const A = Array.from({ length: TERMS }, () => new Array<number>(TERMS).fill(0));
  const b = new Array<number>(TERMS).fill(0);
  for (let i = 0; i < rows.length; i++) {
    for (let r = 0; r < TERMS; r++) {
      b[r] += rows[i][r] * targets[i];
      for (let c = 0; c < TERMS; c++) A[r][c] += rows[i][r] * rows[i][c];
    }
  }
  // A small ridge term keeps the fit stable with only a few more points than coefficients.
  for (let r = 1; r < TERMS; r++) A[r][r] += RIDGE;
  return solve(A, b);
}

/**
 * Fit the mapping.
 * @param neutral input at the centre target; the fit is expressed relative to it so recentring is a simple shift.
 */
export function fitPoly(samples: FitSample[], neutral: [number, number]): PolyFit | null {
  if (samples.length < TERMS + 1) return null;
  const scale: [number, number] = [
    Math.max(...samples.map((s) => Math.abs(s.a - neutral[0]))),
    Math.max(...samples.map((s) => Math.abs(s.b - neutral[1]))),
  ];
  if (!(scale[0] > 1e-9) || !(scale[1] > 1e-9)) return null;
  const rows = samples.map((s) => basis((s.a - neutral[0]) / scale[0], (s.b - neutral[1]) / scale[1]));
  const cx = regress(rows, samples.map((s) => s.x));
  const cy = regress(rows, samples.map((s) => s.y));
  if (!cx || !cy) return null;
  return { neutral, scale, cx, cy };
}

export function evalPoly(fit: PolyFit, a: number, b: number): Point {
  const t = basis((a - fit.neutral[0]) / fit.scale[0], (b - fit.neutral[1]) / fit.scale[1]);
  let x = 0;
  let y = 0;
  for (let i = 0; i < TERMS; i++) {
    x += fit.cx[i] * t[i];
    y += fit.cy[i] * t[i];
  }
  return { x, y };
}

/**
 * Leave-one-out error: each target is predicted by a fit that never saw it.
 * Returned as a fraction of the screen (0.03 = 3% of the screen width / height),
 * which is an honest estimate of how far off the pointer will land.
 */
export function leaveOneOutError(samples: FitSample[], neutral: [number, number]): number | null {
  if (samples.length < TERMS + 2) return null;
  let total = 0;
  for (let i = 0; i < samples.length; i++) {
    const fit = fitPoly(samples.filter((_, j) => j !== i), neutral);
    if (!fit) return null;
    const p = evalPoly(fit, samples[i].a, samples[i].b);
    // Offsets span 2 units across the screen.
    total += Math.hypot(p.x - samples[i].x, p.y - samples[i].y) / 2;
  }
  return total / samples.length;
}

export function isPolyFit(value: unknown): value is PolyFit {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const pair = (x: unknown): boolean => Array.isArray(x) && x.length === 2 && x.every((n) => typeof n === 'number' && Number.isFinite(n));
  const coef = (x: unknown): boolean => Array.isArray(x) && x.length === TERMS && x.every((n) => typeof n === 'number' && Number.isFinite(n));
  return pair(v.neutral) && pair(v.scale) && (v.scale as number[]).every((n) => n > 0) && coef(v.cx) && coef(v.cy);
}
