import type { AxisCalibration, CalibrationStatus, HeadCalibration, Point } from '../shared/types';
import { DEFAULT_RANGE, MIN_RANGE, axisValid, type HeadSample } from './cursor/headMapper';
import { fitPoly, leaveOneOutError, type FitSample } from './cursor/polyFit';
import { clamp01, mad, median } from './math';

export type CalibrationStepId =
  | 'center'
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'right'
  | 'bottom-right'
  | 'bottom'
  | 'bottom-left'
  | 'left';

export interface CalibrationStep {
  id: CalibrationStepId;
  /** Where the on-screen target is drawn (normalized). */
  target: Point;
  instruction: string;
}

const L = 0.07;
const R = 0.93;
const T = 0.09;
const B = 0.91;

/**
 * A 3 x 3 grid, visited in a loop around the edge so each move is short.
 * Nine points are enough to fit a second-order mapping with data to spare
 * for measuring its accuracy.
 */
export const CALIBRATION_STEPS: CalibrationStep[] = [
  { id: 'center', target: { x: 0.5, y: 0.5 }, instruction: 'Face the centre dot and hold still.' },
  { id: 'top-left', target: { x: L, y: T }, instruction: 'Point your nose at the TOP LEFT dot and hold.' },
  { id: 'top', target: { x: 0.5, y: T }, instruction: 'Now the TOP dot.' },
  { id: 'top-right', target: { x: R, y: T }, instruction: 'TOP RIGHT.' },
  { id: 'right', target: { x: R, y: 0.5 }, instruction: 'RIGHT.' },
  { id: 'bottom-right', target: { x: R, y: B }, instruction: 'BOTTOM RIGHT.' },
  { id: 'bottom', target: { x: 0.5, y: B }, instruction: 'BOTTOM.' },
  { id: 'bottom-left', target: { x: L, y: B }, instruction: 'BOTTOM LEFT.' },
  { id: 'left', target: { x: L, y: 0.5 }, instruction: 'Last one: LEFT.' },
];

export interface CalibrationOptions {
  /** Time to read the instruction and move before sampling starts. */
  prepareMs: number;
  /** A steady reading must span this long. */
  windowMs: number;
  minSamples: number;
  stepTimeoutMs: number;
}

export const DEFAULT_CALIBRATION_OPTIONS: CalibrationOptions = {
  prepareMs: 1100,
  windowMs: 650,
  minSamples: 7,
  stepTimeoutMs: 8000,
};

/** Largest spread allowed inside a window for it to count as "holding still". */
const STEADY = { yaw: 2.5, pitch: 2.5, x: 0.018, y: 0.018 };

interface Timed extends HeadSample {
  t: number;
}

const spread = (values: number[]): number => Math.max(...values) - Math.min(...values);
const offset = (target: Point): Point => ({ x: (target.x - 0.5) * 2, y: (target.y - 0.5) * 2 });

/**
 * Guided 9-point head-pointer calibration.
 *
 * At each target the session waits for a steady window of samples, rejecting
 * frames where the face is missing or moving, and times out with a clear
 * message rather than accepting a poor reading. The nine readings are then
 * fitted with a second-order polynomial for each pointer source, and the
 * leave-one-out error of that fit is reported as the measured accuracy.
 * A full run takes roughly 17 seconds.
 */
export class CalibrationSession {
  private stepIndex = 0;
  private stepStart: number;
  private window: Timed[] = [];
  private readonly readings: Partial<Record<CalibrationStepId, HeadSample>> = {};
  private noise: number[] = [];
  private phase: CalibrationStatus['phase'] = 'prepare';
  private message = CALIBRATION_STEPS[0].instruction;
  private hint = '';
  private readonly startedAt: number;
  private endedAt: number | null = null;
  private outcome: HeadCalibration | null = null;

  constructor(
    now: number,
    private readonly opts: CalibrationOptions = DEFAULT_CALIBRATION_OPTIONS,
  ) {
    this.startedAt = now;
    this.stepStart = now;
  }

  get active(): boolean {
    return this.phase === 'prepare' || this.phase === 'collect';
  }

  get result(): HeadCalibration | null {
    return this.outcome;
  }

  get failed(): boolean {
    return this.phase === 'failed';
  }

  cancel(now: number): void {
    if (!this.active) return;
    this.phase = 'failed';
    this.message = 'Calibration cancelled. Your previous calibration is unchanged.';
    this.endedAt = now;
  }

  /** Feed one tracking frame. Pass `null` when no face is visible. */
  update(t: number, sample: HeadSample | null): void {
    if (!this.active) return;
    const step = CALIBRATION_STEPS[this.stepIndex];
    const elapsed = t - this.stepStart;
    // The first step gets a little longer: the user is still finding the dot.
    const prepare = this.stepIndex === 0 ? this.opts.prepareMs + 500 : this.opts.prepareMs;

    if (elapsed < prepare) {
      this.phase = 'prepare';
      this.message = step.instruction;
      return;
    }
    this.phase = 'collect';

    if (elapsed > prepare + this.opts.stepTimeoutMs) {
      this.phase = 'failed';
      this.endedAt = t;
      this.message =
        `Could not get a steady reading for the "${step.id}" dot. ` +
        'Make sure your face is well lit and fully in view, then try again.';
      return;
    }

    if (!sample) {
      // A gap in tracking invalidates the window: readings must be continuous.
      this.window = [];
      this.hint = 'Face not visible. Move back into view of the camera.';
      return;
    }

    this.window.push({ ...sample, t });
    while (this.window.length > 0 && t - this.window[0].t > this.opts.windowMs) this.window.shift();

    const span = t - this.window[0].t;
    if (span < this.opts.windowMs * 0.9 || this.window.length < this.opts.minSamples) {
      this.hint = 'Hold still...';
      return;
    }

    const steady =
      spread(this.window.map((s) => s.yaw)) <= STEADY.yaw &&
      spread(this.window.map((s) => s.pitch)) <= STEADY.pitch &&
      spread(this.window.map((s) => s.x)) <= STEADY.x &&
      spread(this.window.map((s) => s.y)) <= STEADY.y;
    if (!steady) {
      this.hint = 'Still moving. Hold your head steady for a moment.';
      return;
    }

    this.readings[step.id] = {
      yaw: median(this.window.map((s) => s.yaw)),
      pitch: median(this.window.map((s) => s.pitch)),
      x: median(this.window.map((s) => s.x)),
      y: median(this.window.map((s) => s.y)),
    };
    this.noise.push(mad(this.window.map((s) => s.yaw)), mad(this.window.map((s) => s.pitch)));
    this.window = [];
    this.hint = '';
    this.stepIndex += 1;
    this.stepStart = t;

    if (this.stepIndex >= CALIBRATION_STEPS.length) this.finish(t);
    else {
      this.phase = 'prepare';
      this.message = CALIBRATION_STEPS[this.stepIndex].instruction;
    }
  }

  private finish(t: number): void {
    this.endedAt = t;
    const r = this.readings as Record<CalibrationStepId, HeadSample>;
    const axis = (neutral: number, pos: number, neg: number): AxisCalibration => ({ neutral, pos, neg });

    // Per-axis ranges from the mid-edge targets: a sanity check, and a fallback mapping.
    const poseX = axis(r.center.yaw, r.right.yaw, r.left.yaw);
    const poseY = axis(r.center.pitch, r.bottom.pitch, r.top.pitch);
    const posX = axis(r.center.x, r.right.x, r.left.x);
    const posY = axis(r.center.y, r.bottom.y, r.top.y);

    const poseOk = axisValid(poseX, MIN_RANGE.yawDeg) && axisValid(poseY, MIN_RANGE.pitchDeg);
    const positionOk = axisValid(posX, MIN_RANGE.noseX) && axisValid(posY, MIN_RANGE.noseY);

    if (!poseOk && !positionOk) {
      this.phase = 'failed';
      this.message =
        'The head movements were too small or inconsistent to measure. ' +
        'Try again and turn a little further toward each dot.';
      return;
    }

    const samples = (pick: (s: HeadSample) => [number, number]): FitSample[] =>
      CALIBRATION_STEPS.map((step) => {
        const [a, b] = pick(r[step.id]);
        const o = offset(step.target);
        return { a, b, x: o.x, y: o.y };
      });
    const poseSamples = samples((s) => [s.yaw, s.pitch]);
    const positionSamples = samples((s) => [s.x, s.y]);
    const poseNeutral: [number, number] = [r.center.yaw, r.center.pitch];
    const positionNeutral: [number, number] = [r.center.x, r.center.y];

    const poseFit = poseOk ? fitPoly(poseSamples, poseNeutral) : null;
    const positionFit = positionOk ? fitPoly(positionSamples, positionNeutral) : null;
    const poseError = poseFit ? leaveOneOutError(poseSamples, poseNeutral) : null;
    const positionError = positionFit ? leaveOneOutError(positionSamples, positionNeutral) : null;

    // If only one signal calibrated cleanly, the other falls back to default
    // ranges around the measured neutral so it is still usable.
    const n = r.center;
    const fallbackPose = {
      x: axis(n.yaw, n.yaw + DEFAULT_RANGE.yawDeg, n.yaw - DEFAULT_RANGE.yawDeg),
      y: axis(n.pitch, n.pitch - DEFAULT_RANGE.pitchDeg, n.pitch + DEFAULT_RANGE.pitchDeg),
    };
    const fallbackPosition = {
      x: axis(n.x, n.x + DEFAULT_RANGE.noseX, n.x - DEFAULT_RANGE.noseX),
      y: axis(n.y, n.y + DEFAULT_RANGE.noseY, n.y - DEFAULT_RANGE.noseY),
    };

    // Quality is the measured accuracy, discounted if tracking was noisy relative to the range.
    const error = poseError ?? positionError;
    const yawRange = Math.min(Math.abs(poseX.pos - poseX.neutral), Math.abs(poseX.neg - poseX.neutral));
    const pitchRange = Math.min(Math.abs(poseY.pos - poseY.neutral), Math.abs(poseY.neg - poseY.neutral));
    const signalToNoise = Math.min(yawRange, pitchRange) / Math.max(median(this.noise), 0.02);
    const fromError = error === null ? 0.4 : clamp01(1 - error / 0.14);
    const quality = poseOk ? fromError * (0.6 + 0.4 * clamp01((signalToNoise - 6) / 40)) : Math.min(0.4, fromError);

    this.outcome = {
      pose: poseOk ? { x: poseX, y: poseY } : fallbackPose,
      position: positionOk ? { x: posX, y: posY } : fallbackPosition,
      fit: { pose: poseFit ?? undefined, position: positionFit ?? undefined },
      error: error ?? undefined,
      quality,
      createdAt: Date.now(),
    };
    this.phase = 'done';
    this.message = poseOk
      ? 'Calibration complete.'
      : 'Calibration complete, but head rotation was hard to measure. The "nose position" pointer source may work better for you.';
  }

  status(t: number): CalibrationStatus {
    const total = CALIBRATION_STEPS.length;
    const step = CALIBRATION_STEPS[Math.min(this.stepIndex, total - 1)];
    let progress = this.stepIndex / total;
    if (this.phase === 'collect' && this.window.length > 0) {
      progress += clamp01((t - this.window[0].t) / this.opts.windowMs) / total;
    }
    return {
      active: this.active,
      step: this.phase === 'done' || this.phase === 'failed' ? null : step.id,
      stepIndex: Math.min(this.stepIndex, total),
      totalSteps: total,
      phase: this.phase,
      progress: this.phase === 'done' ? 1 : clamp01(progress),
      message: this.active && this.phase === 'collect' && this.hint ? `${step.instruction} ${this.hint}` : this.message,
      quality: this.outcome ? this.outcome.quality : null,
      accuracy: this.outcome?.error ?? null,
      elapsedMs: (this.endedAt ?? t) - this.startedAt,
    };
  }
}

export const IDLE_CALIBRATION: CalibrationStatus = {
  active: false,
  step: null,
  stepIndex: 0,
  totalSteps: CALIBRATION_STEPS.length,
  phase: 'idle',
  progress: 0,
  message: '',
  quality: null,
  accuracy: null,
  elapsedMs: 0,
};

export function calibrationQualityLabel(quality: number): 'good' | 'usable' | 'weak' {
  return quality >= 0.7 ? 'good' : quality >= 0.45 ? 'usable' : 'weak';
}
