import type { AxisCalibration, HeadCalibration, Point, PolyFitData, SourceCalibration } from '../../shared/types';
import { clamp } from '../math';
import { evalPoly } from './polyFit';

/** One measurement of everything the head pointer can be driven by. */
export interface HeadSample {
  yaw: number;
  pitch: number;
  /** Nose tip in mirrored, normalized image coordinates. */
  x: number;
  y: number;
}

/** Default ranges used until the user calibrates. */
export const DEFAULT_RANGE = {
  yawDeg: 16,
  pitchDeg: 11,
  noseX: 0.07,
  noseY: 0.05,
};

/** Smallest measured range accepted from a calibration run. */
export const MIN_RANGE = {
  yawDeg: 4,
  pitchDeg: 3,
  noseX: 0.012,
  noseY: 0.01,
};

/**
 * Signed offset of `value` along a calibrated axis: 0 at neutral, +1 at the
 * right / bottom extreme and -1 at the left / top extreme. The two sides are
 * scaled independently because comfortable head range is rarely symmetric.
 * The mapping is derived from the measured extremes, so it does not depend on
 * the sign convention of the underlying signal.
 */
export function axisOffset(value: number, axis: AxisCalibration): number {
  const d = value - axis.neutral;
  const toPos = axis.pos - axis.neutral;
  const toNeg = axis.neg - axis.neutral;
  if (d === 0) return 0;
  if (toPos !== 0 && Math.sign(d) === Math.sign(toPos)) return d / toPos;
  if (toNeg !== 0) return -(d / toNeg);
  return 0;
}

export function axisValid(axis: AxisCalibration, minRange: number): boolean {
  const toPos = axis.pos - axis.neutral;
  const toNeg = axis.neg - axis.neutral;
  return Math.sign(toPos) === -Math.sign(toNeg) && Math.abs(toPos) >= minRange && Math.abs(toNeg) >= minRange;
}

/** A calibration with default ranges around the given neutral sample. */
export function defaultCalibration(neutral: HeadSample, createdAt = 0): HeadCalibration {
  return {
    pose: {
      x: { neutral: neutral.yaw, pos: neutral.yaw + DEFAULT_RANGE.yawDeg, neg: neutral.yaw - DEFAULT_RANGE.yawDeg },
      // Screen-down is the positive direction; pitch grows when looking up.
      y: {
        neutral: neutral.pitch,
        pos: neutral.pitch - DEFAULT_RANGE.pitchDeg,
        neg: neutral.pitch + DEFAULT_RANGE.pitchDeg,
      },
    },
    position: {
      x: { neutral: neutral.x, pos: neutral.x + DEFAULT_RANGE.noseX, neg: neutral.x - DEFAULT_RANGE.noseX },
      y: { neutral: neutral.y, pos: neutral.y + DEFAULT_RANGE.noseY, neg: neutral.y - DEFAULT_RANGE.noseY },
    },
    quality: 0,
    createdAt,
  };
}

const shiftAxis = (axis: AxisCalibration, neutral: number): AxisCalibration => {
  const delta = neutral - axis.neutral;
  return { neutral, pos: axis.pos + delta, neg: axis.neg + delta };
};

const moveFit = (fit: PolyFitData | undefined, a: number, b: number): PolyFitData | undefined =>
  fit ? { ...fit, neutral: [a, b] } : undefined;

/** Move the neutral point to `sample`, keeping the measured ranges. */
export function recenterCalibration(cal: HeadCalibration, sample: HeadSample): HeadCalibration {
  return {
    ...cal,
    fit: cal.fit && { pose: moveFit(cal.fit.pose, sample.yaw, sample.pitch), position: moveFit(cal.fit.position, sample.x, sample.y) },
    pose: { x: shiftAxis(cal.pose.x, sample.yaw), y: shiftAxis(cal.pose.y, sample.pitch) },
    position: { x: shiftAxis(cal.position.x, sample.x), y: shiftAxis(cal.position.y, sample.y) },
  };
}

/** Shift the neutral point by an offset expressed in calibrated units. */
export function nudgeCalibration(cal: HeadCalibration, source: 'pose' | 'position', du: number, dv: number): HeadCalibration {
  const s: SourceCalibration = cal[source];
  const nx = s.x.neutral + du * (du >= 0 ? s.x.pos - s.x.neutral : -(s.x.neg - s.x.neutral));
  const ny = s.y.neutral + dv * (dv >= 0 ? s.y.pos - s.y.neutral : -(s.y.neg - s.y.neutral));
  // Shift the fitted model by the same amount, using its linear terms to convert the offset back to input units.
  const f = cal.fit?.[source];
  const fit = f
    ? {
        ...cal.fit,
        [source]: {
          ...f,
          neutral: [
            f.neutral[0] + (Math.abs(f.cx[1]) > 0.05 ? (du / f.cx[1]) * f.scale[0] : 0),
            f.neutral[1] + (Math.abs(f.cy[2]) > 0.05 ? (dv / f.cy[2]) * f.scale[1] : 0),
          ] as [number, number],
        },
      }
    : cal.fit;
  return { ...cal, fit, [source]: { x: shiftAxis(s.x, nx), y: shiftAxis(s.y, ny) } };
}

export interface HeadMapOptions {
  source: 'pose' | 'position';
  invertX: boolean;
  invertY: boolean;
}

/**
 * Map a head sample to a pointer offset (u, v): (0, 0) is the screen centre
 * and +/-1 are the screen edges, before sensitivity is applied.
 */
export function headOffset(sample: HeadSample, cal: HeadCalibration, opts: HeadMapOptions): Point {
  const src = cal[opts.source];
  const xv = opts.source === 'pose' ? sample.yaw : sample.x;
  const yv = opts.source === 'pose' ? sample.pitch : sample.y;
  const fit = cal.fit?.[opts.source];
  let u: number;
  let v: number;
  if (fit) {
    // Fitted 9-point model. Clamped so extrapolation far outside the calibrated range cannot run away.
    const p = evalPoly(fit, xv, yv);
    u = clamp(p.x, -1.6, 1.6);
    v = clamp(p.y, -1.6, 1.6);
  } else {
    u = axisOffset(xv, src.x);
    v = axisOffset(yv, src.y);
  }
  return { x: opts.invertX ? -u : u, y: opts.invertY ? -v : v };
}
