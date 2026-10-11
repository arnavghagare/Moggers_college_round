import type { Point } from '../../shared/types';
import { clamp01 } from '../math';

interface Sample {
  t: number;
  /** Palm centre in units of image height (isotropic). */
  x: number;
  y: number;
  size: number;
  roll: number;
}

const HISTORY_MS = 700;
const VELOCITY_WINDOW_MS = 120;
const STABLE_WINDOW_MS = 300;
const STABLE_RADIUS = 0.02;
const STILL_SPEED = 0.12;

export type SwipeDirection = 'left' | 'right' | 'up' | 'down';

export interface MotionState {
  /** Velocity in image heights per second (y grows downward). */
  velocity: Point;
  speed: number;
  direction: SwipeDirection | 'still';
  /**
   * Relative change of apparent hand size per second. Positive means the hand
   * looks bigger, i.e. it is probably approaching the camera. This is an
   * inference from 2D size, not a depth measurement.
   */
  depthTrend: number;
  /** Degrees per second of in-plane wrist rotation. */
  rollRate: number;
  stable: boolean;
}

export interface SwipeResult {
  direction: SwipeDirection;
  /** 0..1, grows with the distance travelled. */
  score: number;
}

/** Travel (in image heights) that maps to a swipe score of 1. */
export const SWIPE_FULL_TRAVEL = 0.45;
const SWIPE_WINDOW_MS = 450;
/** Relative size growth that maps to a push score of 1. */
export const PUSH_FULL_GROWTH = 0.6;

/** Short motion history for one hand, with derived velocity and stroke detection. */
export class HandMotionTracker {
  private samples: Sample[] = [];

  push(t: number, palm: Point, aspect: number, size: number, roll: number): MotionState {
    this.samples.push({ t, x: palm.x * aspect, y: palm.y, size, roll });
    while (this.samples.length > 2 && t - this.samples[0].t > HISTORY_MS) this.samples.shift();
    return this.state();
  }

  clear(): void {
    this.samples = [];
  }

  private at(ageMs: number): Sample | null {
    const now = this.samples[this.samples.length - 1];
    if (!now) return null;
    let pick: Sample | null = null;
    for (const s of this.samples) {
      if (now.t - s.t >= ageMs) pick = s;
      else break;
    }
    return pick;
  }

  state(): MotionState {
    const now = this.samples[this.samples.length - 1];
    const ref = this.at(VELOCITY_WINDOW_MS) ?? this.samples[0];
    const still: MotionState = {
      velocity: { x: 0, y: 0 },
      speed: 0,
      direction: 'still',
      depthTrend: 0,
      rollRate: 0,
      stable: false,
    };
    if (!now || !ref || now === ref) return still;
    const dt = (now.t - ref.t) / 1000;
    if (dt <= 0) return still;

    const vx = (now.x - ref.x) / dt;
    const vy = (now.y - ref.y) / dt;
    const speed = Math.hypot(vx, vy);
    let direction: MotionState['direction'] = 'still';
    if (speed > STILL_SPEED) {
      direction = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 'right' : 'left') : vy > 0 ? 'down' : 'up';
    }

    let rollDelta = now.roll - ref.roll;
    if (rollDelta > 180) rollDelta -= 360;
    if (rollDelta < -180) rollDelta += 360;

    const stableRef = this.samples.filter((s) => now.t - s.t <= STABLE_WINDOW_MS);
    const spanned = now.t - this.samples[0].t >= STABLE_WINDOW_MS * 0.8;
    const stable =
      spanned && stableRef.every((s) => Math.hypot(s.x - now.x, s.y - now.y) < STABLE_RADIUS);

    return {
      velocity: { x: vx, y: vy },
      speed,
      direction,
      depthTrend: ref.size > 1e-6 ? (now.size - ref.size) / ref.size / dt : 0,
      rollRate: rollDelta / dt,
      stable,
    };
  }

  /**
   * A swipe is a mostly straight stroke: large travel along one axis within
   * the window, with little travel along the other.
   */
  detectSwipe(): SwipeResult | null {
    const now = this.samples[this.samples.length - 1];
    if (!now) return null;
    let best: SwipeResult | null = null;
    for (const s of this.samples) {
      if (now.t - s.t > SWIPE_WINDOW_MS || s === now) continue;
      const dx = now.x - s.x;
      const dy = now.y - s.y;
      const horizontal = Math.abs(dx) >= Math.abs(dy);
      const primary = horizontal ? Math.abs(dx) : Math.abs(dy);
      const secondary = horizontal ? Math.abs(dy) : Math.abs(dx);
      if (secondary > primary * 0.5) continue;
      const score = clamp01(primary / SWIPE_FULL_TRAVEL);
      if (!best || score > best.score) {
        best = {
          direction: horizontal ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up',
          score,
        };
      }
    }
    return best;
  }

  /** Apparent size growing quickly while the palm stays roughly in place. */
  detectPush(): number {
    const now = this.samples[this.samples.length - 1];
    if (!now) return 0;
    let best = 0;
    for (const s of this.samples) {
      if (now.t - s.t > SWIPE_WINDOW_MS || s === now || s.size < 1e-6) continue;
      const growth = (now.size - s.size) / s.size;
      const lateral = Math.hypot(now.x - s.x, now.y - s.y);
      if (lateral > 0.2) continue;
      best = Math.max(best, clamp01(growth / PUSH_FULL_GROWTH));
    }
    return best;
  }
}

/** Tracks the distance between two palms to detect spreading / squeezing. */
export class SeparationTracker {
  private samples: Array<{ t: number; d: number }> = [];

  push(t: number, a: Point, b: Point, aspect: number): void {
    this.samples.push({ t, d: Math.hypot((a.x - b.x) * aspect, a.y - b.y) });
    while (this.samples.length > 2 && t - this.samples[0].t > 600) this.samples.shift();
  }

  clear(): void {
    this.samples = [];
  }

  /** Signed change in separation over the window (image heights). */
  change(): number {
    const now = this.samples[this.samples.length - 1];
    if (!now) return 0;
    let best = 0;
    for (const s of this.samples) {
      const delta = now.d - s.d;
      if (Math.abs(delta) > Math.abs(best)) best = delta;
    }
    return best;
  }
}
