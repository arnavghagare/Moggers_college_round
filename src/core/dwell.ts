export interface DwellConfig {
  dwellMs: number;
  /** The cursor must stay within this distance of where it came to rest. */
  radiusPx: number;
  /** Brief wait before the countdown starts, so passing over a target does nothing. */
  armDelayMs: number;
}

export type DwellCancelReason = 'moved' | 'tracking' | 'target-changed' | 'no-target' | 'manual';

export type DwellEvent =
  | { type: 'start'; x: number; y: number }
  | { type: 'cancel'; reason: DwellCancelReason; progress: number }
  | { type: 'fire'; x: number; y: number };

export interface DwellState {
  /** 0..1 while counting down, otherwise 0. */
  progress: number;
  counting: boolean;
  anchor: { x: number; y: number } | null;
}

/**
 * Dwell clicking: a click fires only when the cursor has rested on the same
 * target for the full dwell time.
 *
 * Safety properties (each covered by a unit test):
 * - Moving outside the radius cancels the countdown.
 * - Loss of tracking, pausing, or a manual cancel cancels the countdown.
 * - After a click the cursor must leave the spot before another dwell can
 *   start, so resting on a button never clicks it repeatedly.
 * - Merely moving over an element never clicks it.
 */
export class DwellDetector {
  private anchor: { x: number; y: number; t: number; key: unknown } | null = null;
  private started = false;
  /** Set after a click or cancel; the cursor must leave this spot to re-arm. */
  private spent: { x: number; y: number } | null = null;

  constructor(private config: DwellConfig) {}

  configure(config: DwellConfig): void {
    this.config = config;
  }

  /**
   * @param targetKey identity of the element under the cursor, or null when
   *   there is nothing to dwell on.
   * @param ok false while tracking is unreliable or interaction is not allowed.
   */
  update(t: number, x: number, y: number, targetKey: unknown, ok: boolean): { state: DwellState; events: DwellEvent[] } {
    const events: DwellEvent[] = [];

    if (!ok) {
      this.abort('tracking', t, events);
      return { state: this.idle(), events };
    }

    if (this.spent) {
      if (Math.hypot(x - this.spent.x, y - this.spent.y) <= this.config.radiusPx) {
        return { state: this.idle(), events };
      }
      this.spent = null;
    }

    if (targetKey === null || targetKey === undefined) {
      this.abort('no-target', t, events);
      return { state: this.idle(), events };
    }

    if (this.anchor) {
      const moved = Math.hypot(x - this.anchor.x, y - this.anchor.y) > this.config.radiusPx;
      const changed = this.anchor.key !== targetKey;
      if (moved || changed) this.abort(moved ? 'moved' : 'target-changed', t, events);
    }

    if (!this.anchor) {
      this.anchor = { x, y, t, key: targetKey };
      this.started = false;
      return { state: this.idle(), events };
    }

    const elapsed = t - this.anchor.t - this.config.armDelayMs;
    if (elapsed < 0) return { state: this.idle(), events };

    if (!this.started) {
      this.started = true;
      events.push({ type: 'start', x: this.anchor.x, y: this.anchor.y });
    }

    if (elapsed >= this.config.dwellMs) {
      const { x: ax, y: ay } = this.anchor;
      events.push({ type: 'fire', x: ax, y: ay });
      this.spent = { x: ax, y: ay };
      this.anchor = null;
      this.started = false;
      return { state: this.idle(), events };
    }

    return {
      state: {
        progress: elapsed / this.config.dwellMs,
        counting: true,
        anchor: { x: this.anchor.x, y: this.anchor.y },
      },
      events,
    };
  }

  /** Cancel the current countdown on request ("cancel click"). */
  cancel(t: number): DwellEvent[] {
    const events: DwellEvent[] = [];
    if (this.anchor) this.spent = { x: this.anchor.x, y: this.anchor.y };
    this.abort('manual', t, events);
    return events;
  }

  reset(): void {
    this.anchor = null;
    this.started = false;
    this.spent = null;
  }

  private abort(reason: DwellCancelReason, t: number, events: DwellEvent[]): void {
    if (this.anchor && this.started) {
      const elapsed = t - this.anchor.t - this.config.armDelayMs;
      events.push({ type: 'cancel', reason, progress: Math.min(1, Math.max(0, elapsed / this.config.dwellMs)) });
    }
    this.anchor = null;
    this.started = false;
  }

  private idle(): DwellState {
    return { progress: 0, counting: false, anchor: null };
  }
}
