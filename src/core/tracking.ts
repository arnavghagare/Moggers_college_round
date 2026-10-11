import type { Quality } from '../shared/types';

const WINDOW_MS = 5000;

/** Presence history for one tracked thing (face or hands): loss duration and loss rate. */
export class PresenceMonitor {
  private frames: Array<{ t: number; present: boolean }> = [];
  private lostAt: number | null = null;
  private everSeen = false;

  push(t: number, present: boolean): void {
    this.frames.push({ t, present });
    while (this.frames.length > 0 && t - this.frames[0].t > WINDOW_MS) this.frames.shift();
    if (present) {
      this.everSeen = true;
      this.lostAt = null;
    } else {
      this.lostAt ??= t;
    }
  }

  reset(): void {
    this.frames = [];
    this.lostAt = null;
    this.everSeen = false;
  }

  get seen(): boolean {
    return this.everSeen;
  }

  lostMs(t: number): number {
    return this.lostAt === null ? 0 : t - this.lostAt;
  }

  /** Fraction of recent frames in which the target was not detected. */
  get lossRate(): number {
    if (this.frames.length === 0) return 0;
    return this.frames.filter((f) => !f.present).length / this.frames.length;
  }
}

/**
 * Tracking quality from measured quantities only: whether the face is
 * detected now, how often it was lost recently, landmark jitter and frame rate.
 */
export function rateFaceQuality(input: {
  present: boolean;
  lossRate: number;
  jitter: number;
  fps: number;
}): Quality {
  if (!input.present) return 'lost';
  if (input.lossRate > 0.3 || input.jitter > 0.005 || input.fps < 8) return 'poor';
  if (input.lossRate > 0.08 || input.jitter > 0.0022 || input.fps < 15) return 'fair';
  return 'good';
}

export function rateHandQuality(input: { present: boolean; lossRate: number; score: number; fps: number }): Quality {
  if (!input.present) return 'lost';
  if (input.score < 0.6 || input.fps < 8) return 'poor';
  if (input.lossRate > 0.4 || input.score < 0.8 || input.fps < 15) return 'fair';
  return 'good';
}

export interface LightingReading {
  luma: number;
  contrast: number;
  rating: 'ok' | 'dim' | 'dark' | 'bright' | 'unknown';
  advice: string;
}

/**
 * Rate lighting from the mean brightness (0..255) and contrast (standard
 * deviation of brightness) of a downscaled camera frame.
 */
export function rateLighting(luma: number, contrast: number): LightingReading {
  if (!Number.isFinite(luma)) return { luma: 0, contrast: 0, rating: 'unknown', advice: '' };
  if (luma < 35) {
    return {
      luma,
      contrast,
      rating: 'dark',
      advice: 'The camera image is very dark. Turn on a light in front of you or face a window.',
    };
  }
  if (luma < 70) {
    return {
      luma,
      contrast,
      rating: 'dim',
      advice: 'The camera image is dim. Tracking will be steadier with more light on your face.',
    };
  }
  if (luma > 215) {
    return {
      luma,
      contrast,
      rating: 'bright',
      advice: 'The camera image is overexposed. Avoid a bright light or window directly behind or in front of you.',
    };
  }
  if (contrast < 12) {
    return { luma, contrast, rating: 'dim', advice: 'The camera image is very flat. Check that the lens is not covered.' };
  }
  return { luma, contrast, rating: 'ok', advice: '' };
}

export interface PerfSnapshot {
  fps: number;
  faceMs: number;
  handMs: number;
  frameMs: number;
  degraded: boolean;
  handEvery: number;
  droppedFrames: number;
}

const ema = (prev: number, next: number, k = 0.15): number => (prev === 0 ? next : prev + (next - prev) * k);

/**
 * Measures real per-frame processing cost and lowers the hand model's
 * frequency when a frame takes longer than the budget. The face model always
 * runs every frame because it drives the cursor.
 */
export class PerfGovernor {
  private faceMs = 0;
  private handMs = 0;
  private frameMs = 0;
  private fps = 0;
  private lastFrameT = 0;
  private dropped = 0;
  private handEvery = 1;
  private overSince: number | null = null;
  private underSince: number | null = null;
  private frameIndex = 0;

  constructor(private budgetMs = 40) {}

  setBudget(budgetMs: number): void {
    this.budgetMs = budgetMs;
  }

  /** Whether the hand model should run on this frame. */
  shouldRunHands(): boolean {
    return this.frameIndex % this.handEvery === 0;
  }

  noteDropped(): void {
    this.dropped += 1;
  }

  record(t: number, faceMs: number | null, handMs: number | null): void {
    this.frameIndex += 1;
    if (faceMs !== null) this.faceMs = ema(this.faceMs, faceMs);
    if (handMs !== null) this.handMs = ema(this.handMs, handMs);
    const total = (faceMs ?? 0) + (handMs ?? 0);
    this.frameMs = ema(this.frameMs, total);
    if (this.lastFrameT > 0 && t > this.lastFrameT) this.fps = ema(this.fps, 1000 / (t - this.lastFrameT), 0.1);
    this.lastFrameT = t;

    // Worst-case cost of a frame that runs both models.
    const cost = this.faceMs + this.handMs;
    if (cost > this.budgetMs) {
      this.underSince = null;
      this.overSince ??= t;
      if (t - this.overSince > 1500 && this.handEvery < 3) {
        this.handEvery += 1;
        this.overSince = t;
      }
    } else if (cost < this.budgetMs * 0.6) {
      this.overSince = null;
      this.underSince ??= t;
      if (t - this.underSince > 4000 && this.handEvery > 1) {
        this.handEvery -= 1;
        this.underSince = t;
      }
    } else {
      this.overSince = null;
      this.underSince = null;
    }
  }

  reset(): void {
    this.faceMs = this.handMs = this.frameMs = this.fps = 0;
    this.lastFrameT = 0;
    this.dropped = 0;
    this.handEvery = 1;
    this.overSince = this.underSince = null;
  }

  get snapshot(): PerfSnapshot {
    return {
      fps: this.fps,
      faceMs: this.faceMs,
      handMs: this.handMs,
      frameMs: this.frameMs,
      degraded: this.handEvery > 1,
      handEvery: this.handEvery,
      droppedFrames: this.dropped,
    };
  }
}
