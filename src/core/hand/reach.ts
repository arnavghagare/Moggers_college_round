import type { Point } from '../../shared/types';

/**
 * Hand reach calibration: finding where the user's hand rests comfortably, so
 * that spot becomes the middle of the screen.
 *
 * It is measured, not taken from one frame: the hand has to be held steady
 * and tracked confidently for a run of samples. A calibration that could not
 * collect that run fails and says why; it never reports success by default.
 */

export interface ReachSample {
  /** Palm centre in the mirrored camera picture (0..1). */
  x: number;
  y: number;
  /** The model's confidence for this hand (0..1). */
  score: number;
}

export interface ReachStatus {
  phase: 'collecting' | 'done' | 'failed' | 'cancelled';
  /** 0..1 of the steady run needed. */
  progress: number;
  message: string;
  /** The resting position, once measured. */
  center: Point | null;
}

/** Samples below this confidence are not used. */
export const REACH_MIN_SCORE = 0.6;
/** Steady samples needed, and the least time they must cover. */
export const REACH_SAMPLES = 10;
export const REACH_HOLD_MS = 900;
/** The hand may wander this far (fraction of the picture) from the run's average and still count as steady. */
export const REACH_MAX_SPREAD = 0.04;
export const REACH_TIMEOUT_MS = 12000;
/**
 * Closer to the edge of the picture than this, the hand is partly out of frame
 * and tracking is at its worst. It is also the limit of what the reach setting can hold.
 */
const EDGE = 0.2;

interface Kept extends ReachSample {
  t: number;
}

export class HandReachCalibrator {
  private run: Kept[] = [];
  private result: ReachStatus | null = null;
  private seen = 0;
  private unsure = 0;
  private moved = 0;
  private nearEdge = 0;

  constructor(private readonly startedAt: number) {}

  get finished(): boolean {
    return this.result !== null;
  }

  cancel(): void {
    this.result ??= { phase: 'cancelled', progress: 0, message: 'Calibration cancelled. Nothing was changed.', center: null };
  }

  /** Feed the hand seen at time `t`, or null when no hand is in view. */
  push(t: number, sample: ReachSample | null): void {
    if (this.result) return;
    if (t - this.startedAt >= REACH_TIMEOUT_MS) {
      this.result = { phase: 'failed', progress: 0, message: this.failure(), center: null };
      return;
    }
    if (!sample) {
      this.run = [];
      return;
    }
    this.seen += 1;
    if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y) || sample.score < REACH_MIN_SCORE) {
      this.unsure += 1;
      this.run = [];
      return;
    }
    if (sample.x < EDGE || sample.x > 1 - EDGE || sample.y < EDGE || sample.y > 1 - EDGE) {
      this.nearEdge += 1;
      this.run = [];
      return;
    }
    this.run.push({ ...sample, t });
    const mean = this.mean();
    if (this.run.some((s) => Math.hypot(s.x - mean.x, s.y - mean.y) > REACH_MAX_SPREAD)) {
      // The hand moved: start the steady run again from where it is now.
      this.moved += 1;
      this.run = [this.run[this.run.length - 1]];
      return;
    }
    if (this.run.length >= REACH_SAMPLES && t - this.run[0].t >= REACH_HOLD_MS) {
      this.result = { phase: 'done', progress: 1, message: 'Saved. This spot is now the middle of the screen.', center: mean };
    }
  }

  status(): ReachStatus {
    if (this.result) return this.result;
    const progress = Math.min(1, this.run.length / REACH_SAMPLES);
    const message =
      this.seen === 0
        ? 'Hold your hand up where it is comfortable, palm toward the camera.'
        : this.run.length === 0
          ? 'Looking for a steady hand...'
          : 'Hold still...';
    return { phase: 'collecting', progress, message, center: null };
  }

  private mean(): Point {
    let x = 0;
    let y = 0;
    for (const s of this.run) {
      x += s.x;
      y += s.y;
    }
    return { x: x / this.run.length, y: y / this.run.length };
  }

  /** Say what to change, based on what actually went wrong most often. */
  private failure(): string {
    if (this.seen === 0) {
      return 'No hand was seen. Raise your hand into the picture, about an arm\'s length from the camera, and make sure the room is lit from the front.';
    }
    if (this.nearEdge >= Math.max(this.unsure, this.moved)) {
      return 'Your hand was at the edge of the picture. Bring it nearer the middle, or move back a little so the whole hand fits.';
    }
    if (this.unsure >= this.moved) {
      return 'Your hand was seen, but not clearly enough. Add light in front of you, keep the whole hand in the picture and try again.';
    }
    return 'Your hand kept moving. Rest your elbow and hold your hand still for about a second.';
  }
}
