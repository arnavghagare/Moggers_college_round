import type { Point } from '../../shared/types';
import { clamp, clamp01 } from '../math';
import { OneEuroFilter2D, smoothingToParams } from '../oneEuro';

export interface PointerConfig {
  sensitivity: number;
  smoothing: number;
  /** Radius of ignored movement, as a fraction of the screen. */
  deadZone: number;
  acceleration: number;
  dynamics: 'absolute' | 'relative';
}

/** Speed (screens / second) at which relative-mode acceleration is fully applied. */
const ACCEL_REFERENCE_SPEED = 0.6;

/**
 * Turns a raw pointer offset into a screen position.
 *
 *   offset -> One Euro filter -> dead zone -> absolute or relative mapping
 *
 * Offsets are (u, v) with (0, 0) at the screen centre and +/-1 at the edges.
 * Positions are normalized: (0, 0) is the top-left corner, (1, 1) bottom-right.
 */
export class PointerPipeline {
  private readonly filter: OneEuroFilter2D;
  /** Dead-zone anchor, in screen units relative to the centre. */
  private anchor: Point | null = null;
  private prevAnchor: Point | null = null;
  private prevT = 0;
  private position: Point = { x: 0.5, y: 0.5 };

  constructor(private config: PointerConfig) {
    this.filter = new OneEuroFilter2D(smoothingToParams(config.smoothing));
  }

  configure(config: PointerConfig): void {
    if (config.dynamics !== this.config.dynamics) this.prevAnchor = null;
    this.config = config;
    this.filter.setParams(smoothingToParams(config.smoothing));
  }

  /** Forget filter history, e.g. after tracking was lost. The next sample starts fresh. */
  reset(): void {
    this.filter.reset();
    this.anchor = null;
    this.prevAnchor = null;
  }

  /** Relative mode integrates movement, so it must be told where the cursor really is. */
  syncTo(position: Point): void {
    this.position = { x: clamp01(position.x), y: clamp01(position.y) };
  }

  update(u: number, v: number, t: number): Point {
    // Half a screen per unit: an offset of +/-1 reaches the edge.
    const f = this.filter.filter(u * 0.5, v * 0.5, t);

    // Dead zone as a "leash": the anchor only moves once the filtered input
    // has travelled further than the radius, then follows at that distance.
    // Tremor smaller than the radius leaves the cursor perfectly still.
    if (!this.anchor) {
      this.anchor = { ...f };
    } else {
      const dx = f.x - this.anchor.x;
      const dy = f.y - this.anchor.y;
      const d = Math.hypot(dx, dy);
      const r = this.config.deadZone;
      if (d > r && d > 0) {
        const k = (d - r) / d;
        this.anchor = { x: this.anchor.x + dx * k, y: this.anchor.y + dy * k };
      }
    }

    if (this.config.dynamics === 'absolute') {
      // Response curve: gain rises with distance from the centre, so the
      // middle of the screen is more precise and the edges stay reachable.
      const m = Math.hypot(this.anchor.x, this.anchor.y);
      const gain = m > 1e-6 ? Math.pow(Math.min(m / 0.5, 1.5), 0.8 * this.config.acceleration) : 1;
      const s = this.config.sensitivity * gain;
      this.position = { x: clamp01(0.5 + this.anchor.x * s), y: clamp01(0.5 + this.anchor.y * s) };
    } else {
      // Mouse-like: integrate movement, with gain that grows with speed.
      if (this.prevAnchor && t > this.prevT) {
        const dt = (t - this.prevT) / 1000;
        const dx = this.anchor.x - this.prevAnchor.x;
        const dy = this.anchor.y - this.prevAnchor.y;
        const speed = Math.hypot(dx, dy) / dt;
        const boost = clamp(speed / ACCEL_REFERENCE_SPEED, 0, 2.5);
        const gain = this.config.sensitivity * (0.7 + 2.2 * this.config.acceleration * boost);
        this.position = {
          x: clamp01(this.position.x + dx * gain),
          y: clamp01(this.position.y + dy * gain),
        };
      }
      this.prevAnchor = { ...this.anchor };
    }
    this.prevT = t;
    return this.position;
  }
}

/** Maximum cursor speed (screens / second) while gliding to a new target. */
const GLIDE_SPEED = 1.4;
const GLIDE_DONE = 0.004;

/**
 * Owns the on-screen cursor position. Sources feed it targets; it guarantees
 * the cursor never teleports: after tracking recovery, a source switch or a
 * recentre it holds still for a settling period and then glides to the new
 * target at a bounded speed.
 */
export class CursorController {
  private pos: Point = { x: 0.5, y: 0.5 };
  private settleUntil = 0;
  private gliding = false;
  private lastT = 0;

  get position(): Point {
    return this.pos;
  }

  isSettling(t: number): boolean {
    return t < this.settleUntil;
  }

  get isGliding(): boolean {
    return this.gliding;
  }

  /** Hold still until `t + ms`, then glide instead of jumping. */
  beginSettle(t: number, ms: number): void {
    this.settleUntil = Math.max(this.settleUntil, t + ms);
    this.gliding = true;
  }

  /** Glide (without a hold) to wherever the next targets point. */
  beginGlide(): void {
    this.gliding = true;
  }

  /** Advance the clock without moving (source frozen or missing). */
  hold(t: number): Point {
    this.lastT = t;
    return this.pos;
  }

  follow(target: Point, t: number): Point {
    // Cap the time step so a stalled frame can never turn into one large glide step.
    const dt = this.lastT > 0 ? Math.min(0.04, Math.max(0, (t - this.lastT) / 1000)) : 0;
    this.lastT = t;
    if (t < this.settleUntil) return this.pos;

    const tx = clamp01(target.x);
    const ty = clamp01(target.y);
    if (this.gliding) {
      const dx = tx - this.pos.x;
      const dy = ty - this.pos.y;
      const d = Math.hypot(dx, dy);
      const step = GLIDE_SPEED * dt;
      if (d <= Math.max(step, GLIDE_DONE)) {
        this.pos = { x: tx, y: ty };
        this.gliding = false;
      } else {
        this.pos = { x: this.pos.x + (dx / d) * step, y: this.pos.y + (dy / d) * step };
      }
    } else {
      this.pos = { x: tx, y: ty };
    }
    return this.pos;
  }
}

/**
 * Map a hand anchor point (mirrored, normalized image coordinates) to a
 * pointer offset. Only the central `area` fraction of the frame is used, so
 * the whole screen is reachable without stretching to the frame edges, where
 * hand tracking is least reliable.
 */
export function handOffset(point: Point, area: number, center: Point = { x: 0.5, y: 0.5 }): Point {
  const half = area / 2;
  return {
    x: clamp((point.x - center.x) / half, -1.2, 1.2),
    y: clamp((point.y - center.y) / half, -1.2, 1.2),
  };
}
