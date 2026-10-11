import { ACTIONS, type ActionId } from '../shared/actions';
import { AWAITING_START, type Phase } from '../shared/types';

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
  /**
   * The user's own intent: true once they have asked for actions to run, false
   * after they paused. It survives restarts of tracking, so a mode switch or a
   * camera hiccup can never un-pause Handsfree behind the user's back.
   */
  private armed: boolean;
  private everArmed: boolean;

  /**
   * @param armed false to stay paused after starting up until the user says
   *   "start" (or resumes another way). Used whenever voice is available.
   */
  constructor(
    private config: SafetyConfig,
    armed = true,
  ) {
    this.armed = armed;
    this.everArmed = armed;
  }

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

  /** Paused only because the user has not yet said "start" since switching on. */
  get awaitingStart(): boolean {
    return !this.everArmed;
  }

  /** Tracking and models are ready: begin the startup grace period, unless the user wants it paused. */
  start(t: number): void {
    if (this.state !== 'loading' && this.state !== 'error') return;
    if (this.armed) {
      this.enterGrace(t);
      return;
    }
    this.state = 'paused';
    this.reason = this.everArmed ? 'Paused by you' : AWAITING_START;
    this.lostSince = null;
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
    if (this.state === 'paused') return null;
    this.armed = false;
    // Still starting, or stopped by an error: remember the wish, it applies as soon as tracking is ready.
    if (this.state === 'loading' || this.state === 'error') return 'paused';
    this.state = 'paused';
    this.reason = reason;
    this.lostSince = null;
    return 'paused';
  }

  /** Resume from a user pause or an automatic suspension. Always re-enters the grace period. */
  resume(t: number): SafetyEvent | null {
    if (this.state === 'loading' || this.state === 'error') {
      if (this.armed) return null;
      this.armed = this.everArmed = true;
      return 'resumed';
    }
    if (this.state !== 'paused' && this.state !== 'suspended') return null;
    this.armed = this.everArmed = true;
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
          : {
              allowed: false,
              reason:
                this.state === 'paused' && this.reason === AWAITING_START
                  ? 'Listening, but actions are paused. Say "start" to begin'
                  : 'Handsfree is paused. Say "resume" to continue',
            };
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
