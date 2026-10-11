import { ACTIONS, type ActionId } from '../shared/actions';
import type { Phase } from '../shared/types';

export interface SafetyConfig {
  graceMs: number;
  autoPauseMs: number;
  resumeAfterLoss: 'auto' | 'manual';
}

export type SafetyVerdict = { allowed: true } | { allowed: false; reason: string };

export type SafetyEvent = 'paused' | 'resumed' | 'auto-paused' | 'recovered' | 'grace-ended';

/**
 * The single authority on whether Handsfree may interact with the page.
 *
 * Every action from every input (gesture, voice, dwell, keyboard) passes
 * through `check()`. Pausing is therefore real: while paused or suspended,
 * no pointer or page action is produced at all, only the small set of
 * actions needed to resume, confirm, or switch Handsfree off.
 */
export class SafetyController {
  private state: Phase = 'loading';
  private graceUntil = 0;
  private lostSince: number | null = null;
  private reason: string | null = null;

  constructor(private config: SafetyConfig) {}

  configure(config: SafetyConfig): void {
    this.config = config;
  }

  get phase(): Phase {
    return this.state;
  }

  get pausedReason(): string | null {
    return this.reason;
  }

  graceRemaining(t: number): number {
    return this.state === 'grace' ? Math.max(0, this.graceUntil - t) : 0;
  }

  /** True when pointer and page interaction is currently permitted. */
  get interactive(): boolean {
    return this.state === 'active';
  }

  /** True when the cursor may move (it moves during the grace period, but cannot activate anything). */
  get cursorLive(): boolean {
    return this.state === 'active' || this.state === 'grace';
  }

  /** Tracking and models are ready: begin the startup grace period. */
  start(t: number): void {
    if (this.state !== 'loading' && this.state !== 'error') return;
    this.enterGrace(t);
  }

  setLoading(): void {
    this.state = 'loading';
    this.reason = null;
    this.lostSince = null;
  }

  setError(reason: string): void {
    this.state = 'error';
    this.reason = reason;
  }

  pause(reason = 'Paused by you'): SafetyEvent | null {
    if (this.state === 'paused' || this.state === 'loading' || this.state === 'error') return null;
    this.state = 'paused';
    this.reason = reason;
    this.lostSince = null;
    return 'paused';
  }

  /** Resume from a user pause or an automatic suspension. Always re-enters the grace period. */
  resume(t: number): SafetyEvent | null {
    if (this.state !== 'paused' && this.state !== 'suspended') return null;
    this.enterGrace(t);
    return 'resumed';
  }

  /**
   * Advance time and report tracking health.
   * @param trackingOk whether the input that drives the cursor is currently tracked.
   *   Pass true when no camera tracking is needed (voice-only mode).
   */
  tick(t: number, trackingOk: boolean): SafetyEvent | null {
    if (this.state === 'grace' && t >= this.graceUntil) {
      this.state = 'active';
      return 'grace-ended';
    }

    if (this.state === 'active' || this.state === 'grace') {
      if (trackingOk) {
        this.lostSince = null;
      } else {
        this.lostSince ??= t;
        if (t - this.lostSince >= this.config.autoPauseMs) {
          this.state = 'suspended';
          this.reason = 'Tracking lost';
          return 'auto-paused';
        }
      }
      return null;
    }

    if (this.state === 'suspended' && trackingOk && this.config.resumeAfterLoss === 'auto') {
      this.enterGrace(t);
      return 'recovered';
    }
    return null;
  }

  check(action: ActionId): SafetyVerdict {
    const def = ACTIONS[action];
    switch (this.state) {
      case 'active':
        return { allowed: true };
      case 'grace':
        return def.allowedDuringGrace
          ? { allowed: true }
          : { allowed: false, reason: 'Starting up - interactions unlock in a moment' };
      case 'paused':
      case 'suspended':
        return def.allowedWhilePaused
          ? { allowed: true }
          : { allowed: false, reason: 'Handsfree is paused. Say "resume" to continue' };
      case 'loading':
        return def.allowedWhilePaused ? { allowed: true } : { allowed: false, reason: 'Handsfree is still starting' };
      case 'error':
        return def.allowedWhilePaused ? { allowed: true } : { allowed: false, reason: 'Handsfree has stopped because of an error' };
    }
  }

  private enterGrace(t: number): void {
    this.state = 'grace';
    this.graceUntil = t + this.config.graceMs;
    this.reason = null;
    this.lostSince = null;
  }
}
