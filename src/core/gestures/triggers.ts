import type { GestureConfig } from './registry';

/**
 * Fires once when a score stays above the activation threshold for the
 * minimum duration. It re-arms only after the score has dropped below the
 * release threshold, so a held gesture never repeats.
 */
export class SustainTrigger {
  private since: number | null = null;
  private consumed = false;
  private lastFire = -Infinity;

  get held(): boolean {
    return this.since !== null;
  }

  update(score: number, t: number, cfg: GestureConfig): boolean {
    if (!cfg.enabled) {
      this.reset();
      return false;
    }
    if (score >= cfg.threshold) {
      this.since ??= t;
      if (!this.consumed && t - this.since >= cfg.minDurationMs) {
        // Reaching the duration during the cooldown uses the gesture up
        // rather than firing late, while the user is no longer expecting it.
        this.consumed = true;
        if (t - this.lastFire >= cfg.cooldownMs) {
          this.lastFire = t;
          return true;
        }
      }
    } else if (score < cfg.releaseThreshold) {
      this.since = null;
      this.consumed = false;
    }
    return false;
  }

  reset(): void {
    this.since = null;
    this.consumed = false;
  }
}

/** Simple per-key cooldown bookkeeping. */
export class Cooldowns {
  private readonly last = new Map<string, number>();

  ready(key: string, t: number, cooldownMs: number): boolean {
    const prev = this.last.get(key);
    return prev === undefined || t - prev >= cooldownMs;
  }

  mark(key: string, t: number): void {
    this.last.set(key, t);
  }

  /** Check and mark in one step. */
  take(key: string, t: number, cooldownMs: number): boolean {
    if (!this.ready(key, t, cooldownMs)) return false;
    this.mark(key, t);
    return true;
  }

  clear(): void {
    this.last.clear();
  }
}

const BLINK_MIN_MS = 40;
const BLINK_MAX_MS = 400;
const BLINK_GAP_MAX_MS = 450;

/**
 * Detects two short, deliberate blinks in quick succession. Single blinks and
 * long eye closures never fire.
 */
export class DoubleBlinkDetector {
  private closedSince: number | null = null;
  private firstBlinkEnd: number | null = null;
  private lastFire = -Infinity;

  update(closedScore: number, t: number, cfg: GestureConfig): boolean {
    if (!cfg.enabled) {
      this.reset();
      return false;
    }
    if (this.firstBlinkEnd !== null && this.closedSince === null && t - this.firstBlinkEnd > BLINK_GAP_MAX_MS) {
      this.firstBlinkEnd = null;
    }
    if (this.closedSince === null) {
      if (closedScore >= cfg.threshold) this.closedSince = t;
      return false;
    }
    if (closedScore >= cfg.releaseThreshold) return false;

    // Eyes just reopened.
    const duration = t - this.closedSince;
    this.closedSince = null;
    if (duration < BLINK_MIN_MS || duration > BLINK_MAX_MS) {
      this.firstBlinkEnd = null;
      return false;
    }
    if (this.firstBlinkEnd === null) {
      this.firstBlinkEnd = t;
      return false;
    }
    this.firstBlinkEnd = null;
    if (t - this.lastFire < cfg.cooldownMs) return false;
    this.lastFire = t;
    return true;
  }

  reset(): void {
    this.closedSince = null;
    this.firstBlinkEnd = null;
  }
}
