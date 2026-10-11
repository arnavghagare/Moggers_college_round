import type { Landmark, Point } from '../shared/types';

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 0 at `lo`, 1 at `hi`, clamped. Works for descending ranges too. */
export const ramp = (v: number, lo: number, hi: number): number => clamp01((v - lo) / (hi - lo));

export const dist2 = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
export const dist3 = (a: Landmark, b: Landmark): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export const sub3 = (a: Landmark, b: Landmark): Landmark => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const cross3 = (a: Landmark, b: Landmark): Landmark => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const dot3 = (a: Landmark, b: Landmark): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const len3 = (a: Landmark): number => Math.hypot(a.x, a.y, a.z);

/** Interior angle at `b` in degrees (180 = straight). */
export function angleAt(a: Landmark, b: Landmark, c: Landmark): number {
  const u = sub3(a, b);
  const v = sub3(c, b);
  const denom = len3(u) * len3(v);
  if (denom < 1e-9) return 180;
  return (Math.acos(clamp(dot3(u, v) / denom, -1, 1)) * 180) / Math.PI;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation: a noise estimate that ignores outliers. */
export function mad(values: number[]): number {
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

export const radToDeg = (r: number): number => (r * 180) / Math.PI;
