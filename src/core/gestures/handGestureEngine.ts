import type { Handedness, HandStatus, Point } from '../../shared/types';
import { computeHandFeatures, type HandFeatures, type HandObservation } from '../hand/features';
import { HandMotionTracker, SeparationTracker, type MotionState } from '../hand/motion';
import { scoreHandPoses, type PoseScores } from '../hand/poses';
import { clamp01, ramp } from '../math';
import { PoseTracker } from './poseTracker';
import type { GestureConfig, HandPoseId } from './registry';
import { Cooldowns, SustainTrigger } from './triggers';

export interface GestureEvent {
  id: string;
  /**
   * `start` / `end` bracket a held gesture. `trigger` is the single moment a
   * one-shot action should fire.
   */
  phase: 'start' | 'end' | 'trigger';
  hand: Handedness | 'both' | 'face';
  confidence: number;
  t: number;
  /** The gesture ended because tracking was lost, not because the user released it. */
  aborted?: boolean;
}

export interface TrackedHand {
  features: HandFeatures;
  scores: PoseScores;
  motion: MotionState;
  pose: HandPoseId | null;
  poseConfidence: number;
  candidate: HandPoseId | null;
  candidateConfidence: number;
  /** A pinch lasting long enough to count as a hold is in progress. */
  pinchHeld: boolean;
}

export interface HandFrameResult {
  hands: TrackedHand[];
  events: GestureEvent[];
}

export interface HandEngineOptions {
  /**
   * True while a hand is steering the cursor. Large hand movements are then
   * ordinary pointing, so stroke gestures (swipes, push, hand raise) are not
   * recognised.
   */
  handSteering: boolean;
}

/** A pinch longer than this without a hold gesture configured is treated as abandoned. */
const MAX_TAP_MS = 1000;
/** The fist must follow the open palm within this window to count as a grab. */
const GRAB_WINDOW_MS = 700;
/** A hand that disappears for less than this keeps its state (model flicker). */
const HAND_LOST_GRACE_MS = 180;
/** Change in palm separation (image heights) that maps to a two-hand score of 1. */
const TWO_HAND_FULL_CHANGE = 0.3;
const STROKE_LOCKOUT_MS = 700;
/**
 * A hand that has only just come into view is still settling: its first
 * frames are often blurred or half out of frame. A pinch seen this early is
 * not treated as a click.
 */
const ENTRY_GUARD_MS = 250;
/** A click pinch is made in place. A hand that travels further than this (image heights) while pinched was moving, not clicking. */
const PINCH_TAP_MAX_TRAVEL = 0.12;
/**
 * The model's left / right label sometimes flips for a few frames on the same
 * hand. A lone hand this close (image heights) to where the other-labelled
 * hand just was is that same hand, and keeps its label.
 */
const SAME_HAND_DISTANCE = 0.18;
/** A relabelling that lasts this long is taken as the model correcting itself. */
const FLIP_ACCEPT_MS = 600;

interface HandState {
  poses: PoseTracker;
  motion: HandMotionTracker;
  raise: SustainTrigger;
  firstSeen: number;
  lastSeen: number;
  lastOpenSeen: number;
  /** Since when the model has been calling this hand by the other label. */
  flipSince: number | null;
  pinchStart: number | null;
  /** The pinch was already closing as the hand came into view: too early to be a deliberate click. */
  pinchAtEntry: boolean;
  /** Where the palm was when the pinch closed. */
  pinchOrigin: Point | null;
  pinchHoldActive: boolean;
  strokeLockUntil: number;
  last: TrackedHand | null;
}

const newHandState = (t: number): HandState => ({
  poses: new PoseTracker(),
  motion: new HandMotionTracker(),
  raise: new SustainTrigger(),
  firstSeen: t,
  lastSeen: t,
  lastOpenSeen: -Infinity,
  flipSince: null,
  pinchStart: null,
  pinchAtEntry: false,
  pinchOrigin: null,
  pinchHoldActive: false,
  strokeLockUntil: 0,
  last: null,
});

/**
 * Recognises hand gestures from landmark observations.
 *
 * All timing state lives here: per-hand pose debouncing, pinch tap / hold,
 * stroke detection, two-hand tracking and cooldowns. The engine only reports
 * a gesture when its recogniser actually produced a result for the current
 * frames; configuration alone never produces an event.
 */
export class HandGestureEngine {
  private readonly hands = new Map<Handedness, HandState>();
  private readonly cooldowns = new Cooldowns();
  private readonly separation = new SeparationTracker();

  constructor(private config: Record<string, GestureConfig>) {}

  setConfig(config: Record<string, GestureConfig>): void {
    this.config = config;
  }

  reset(): void {
    this.hands.clear();
    this.cooldowns.clear();
    this.separation.clear();
  }

  private cfg(id: string): GestureConfig | undefined {
    return this.config[id];
  }

  private enabled(id: string): GestureConfig | null {
    const c = this.config[id];
    return c && c.enabled ? c : null;
  }

  update(t: number, observations: HandObservation[], aspect: number, opts: HandEngineOptions): HandFrameResult {
    const events: GestureEvent[] = [];
    const seen = new Set<Handedness>();
    const tracked: TrackedHand[] = [];

    // Keep the highest-scoring observation per handedness.
    const byHand = new Map<Handedness, HandObservation>();
    for (const seenAs of observations) {
      if (seenAs.landmarks.length !== 21) continue;
      const obs = this.keepLabel(t, seenAs, observations, aspect);
      const prev = byHand.get(obs.handedness);
      if (!prev || obs.score > prev.score) byHand.set(obs.handedness, obs);
    }

    for (const [handedness, obs] of byHand) {
      seen.add(handedness);
      let state = this.hands.get(handedness);
      if (!state) {
        state = newHandState(t);
        this.hands.set(handedness, state);
      }
      state.lastSeen = t;
      tracked.push(this.updateHand(t, state, obs, aspect, opts, byHand.size, events));
    }

    // Hands that left the frame: end their gestures as aborted.
    for (const [handedness, state] of this.hands) {
      if (seen.has(handedness)) continue;
      if (t - state.lastSeen < HAND_LOST_GRACE_MS) {
        if (state.last) tracked.push(state.last);
        continue;
      }
      for (const ev of state.poses.reset(t)) {
        if (ev.id === 'pinch' && state.pinchHoldActive) {
          events.push({ id: 'pinch_hold', phase: 'end', hand: handedness, confidence: 0, t, aborted: true });
        }
        events.push({ id: ev.id, phase: 'end', hand: handedness, confidence: 0, t, aborted: true });
      }
      this.hands.delete(handedness);
    }

    this.updateTwoHands(t, tracked, aspect, events);
    return { hands: tracked, events };
  }

  /**
   * Keep a hand's left / right label steady across a brief flip by the model.
   * Without this, one flipped frame makes the hand look like it left and a new
   * one arrived, which drops a pinch in progress.
   */
  private keepLabel(t: number, obs: HandObservation, all: HandObservation[], aspect: number): HandObservation {
    const own = this.hands.get(obs.handedness);
    if (own) {
      own.flipSince = null;
      return obs;
    }
    const other: Handedness = obs.handedness === 'Left' ? 'Right' : 'Left';
    const state = this.hands.get(other);
    // Two hands really in view, or nothing to be confused with.
    if (!state?.last || all.some((o) => o !== obs && o.handedness === other)) return obs;
    const was = state.last.features.wrist;
    const now = obs.landmarks[0];
    if (Math.hypot((now.x - was.x) * aspect, now.y - was.y) > SAME_HAND_DISTANCE) return obs;
    state.flipSince ??= t;
    if (t - state.flipSince >= FLIP_ACCEPT_MS) return obs;
    return { ...obs, handedness: other };
  }

  private updateHand(
    t: number,
    state: HandState,
    obs: HandObservation,
    aspect: number,
    opts: HandEngineOptions,
    handCount: number,
    events: GestureEvent[],
  ): TrackedHand {
    const features = computeHandFeatures(obs, aspect);
    const scores = scoreHandPoses(features);
    const motion = state.motion.push(t, features.palmCenter, aspect, features.apparentSize, features.rollDeg);
    const hand = features.handedness;

    const openCfg = this.cfg('open_palm');
    const isOpen = scores.open_palm >= (openCfg?.threshold ?? 0.7);
    if (isOpen) state.lastOpenSeen = t;

    const update = state.poses.update(scores, t, (id) => this.cfg(id));

    for (const ev of update.events) {
      if (ev.phase === 'start') {
        events.push({ id: ev.id, phase: 'start', hand, confidence: ev.confidence, t });
        if (ev.id === 'pinch') {
          // A pinch acts on release (tap) or after a hold, never on first contact.
          // One made as the hand comes into view can still become a hold, but never a click.
          state.pinchStart = t;
          state.pinchAtEntry = t - state.firstSeen < ENTRY_GUARD_MS;
          state.pinchOrigin = { ...features.palmCenter };
          state.pinchHoldActive = false;
        } else {
          this.trigger(ev.id, hand, ev.confidence, t, events);
        }
        if (ev.id === 'fist' && t - state.lastOpenSeen <= GRAB_WINDOW_MS) {
          const grab = this.enabled('grab');
          if (grab && ev.confidence >= grab.threshold) this.trigger('grab', hand, ev.confidence, t, events);
        }
      } else {
        if (ev.id === 'pinch') this.endPinch(t, state, hand, ev.confidence, events, features.palmCenter, aspect);
        events.push({ id: ev.id, phase: 'end', hand, confidence: ev.confidence, t });
      }
    }

    // Pinch held long enough becomes a hold (for example a drag).
    if (update.active === 'pinch' && state.pinchStart !== null && !state.pinchHoldActive) {
      const hold = this.enabled('pinch_hold');
      if (hold && t - state.pinchStart >= hold.minDurationMs) {
        state.pinchHoldActive = true;
        events.push({ id: 'pinch_hold', phase: 'start', hand, confidence: update.activeConfidence, t });
        this.trigger('pinch_hold', hand, update.activeConfidence, t, events);
      }
    }

    if (!opts.handSteering) {
      this.detectStrokes(t, state, features, scores, hand, handCount, events);
    } else {
      state.raise.reset();
    }

    const result: TrackedHand = {
      features,
      scores,
      motion,
      pose: update.active,
      poseConfidence: update.activeConfidence,
      candidate: update.candidate,
      candidateConfidence: update.candidateConfidence,
      pinchHeld: state.pinchHoldActive,
    };
    state.last = result;
    return result;
  }

  private endPinch(
    t: number,
    state: HandState,
    hand: Handedness,
    confidence: number,
    events: GestureEvent[],
    palm: Point,
    aspect: number,
  ): void {
    const started = state.pinchStart;
    const origin = state.pinchOrigin;
    state.pinchStart = null;
    state.pinchOrigin = null;
    if (state.pinchHoldActive) {
      state.pinchHoldActive = false;
      events.push({ id: 'pinch_hold', phase: 'end', hand, confidence, t });
      return;
    }
    if (started === null || state.pinchAtEntry) return;
    const pinch = this.enabled('pinch');
    if (!pinch) return;
    const held = t - started;
    // A hand sweeping across the picture can look pinched on the way: only a pinch made in place is a click.
    const travelled = origin ? Math.hypot((palm.x - origin.x) * aspect, palm.y - origin.y) : 0;
    if (travelled > PINCH_TAP_MAX_TRAVEL) return;
    // With no hold gesture configured, a very long pinch is treated as a
    // change of mind rather than a click.
    if (held <= MAX_TAP_MS) this.trigger('pinch', hand, Math.max(confidence, pinch.threshold), t, events);
  }

  private detectStrokes(
    t: number,
    state: HandState,
    features: HandFeatures,
    scores: PoseScores,
    hand: Handedness,
    handCount: number,
    events: GestureEvent[],
  ): void {
    // Hand raise: an open palm held in the top part of the frame.
    const raise = this.cfg('hand_raise');
    if (raise) {
      const raiseScore = scores.open_palm * ramp(features.wrist.y, 0.55, 0.4);
      if (state.raise.update(raiseScore, t, raise)) {
        events.push({ id: 'hand_raise', phase: 'trigger', hand, confidence: clamp01(raiseScore), t });
      }
    }

    // Swipes and pushes need an open hand; with two hands visible the
    // two-hand gestures take over (a spread would otherwise read as two swipes).
    if (scores.open_palm < 0.5 || handCount > 1 || t < state.strokeLockUntil) return;

    const swipe = state.motion.detectSwipe();
    if (swipe) {
      const id = `swipe_${swipe.direction}`;
      const cfg = this.enabled(id);
      if (cfg && swipe.score >= cfg.threshold && this.trigger(id, hand, swipe.score, t, events)) {
        // Block every stroke for a moment so the return movement is not read as the opposite swipe.
        state.strokeLockUntil = t + Math.max(STROKE_LOCKOUT_MS, cfg.cooldownMs);
        state.motion.clear();
        return;
      }
    }

    const push = this.enabled('hand_push');
    if (push) {
      const score = state.motion.detectPush();
      if (score >= push.threshold && this.trigger('hand_push', hand, score, t, events)) {
        state.strokeLockUntil = t + Math.max(STROKE_LOCKOUT_MS, push.cooldownMs);
        state.motion.clear();
      }
    }
  }

  private updateTwoHands(t: number, tracked: TrackedHand[], aspect: number, events: GestureEvent[]): void {
    const left = tracked.find((h) => h.features.handedness === 'Left');
    const right = tracked.find((h) => h.features.handedness === 'Right');
    if (!left || !right || left.scores.open_palm < 0.5 || right.scores.open_palm < 0.5) {
      this.separation.clear();
      return;
    }
    this.separation.push(t, left.features.palmCenter, right.features.palmCenter, aspect);
    const change = this.separation.change();
    const id = change > 0 ? 'two_hand_spread' : 'two_hand_squeeze';
    const cfg = this.enabled(id);
    if (!cfg) return;
    const score = clamp01(Math.abs(change) / TWO_HAND_FULL_CHANGE);
    // The two directions share one cooldown so the return movement does not fire the opposite gesture.
    if (score >= cfg.threshold && this.cooldowns.take('two_hand', t, cfg.cooldownMs)) {
      events.push({ id, phase: 'trigger', hand: 'both', confidence: score, t });
      this.separation.clear();
    }
  }

  /** Emit a one-shot trigger if the gesture is enabled and out of cooldown. */
  private trigger(id: string, hand: Handedness, confidence: number, t: number, events: GestureEvent[]): boolean {
    const cfg = this.enabled(id);
    if (!cfg) return false;
    if (!this.cooldowns.take(`${id}:${hand}`, t, cfg.cooldownMs)) return false;
    events.push({ id, phase: 'trigger', hand, confidence, t });
    return true;
  }
}

/** Convert a tracked hand to the compact status shown in the UI. */
export function toHandStatus(h: TrackedHand): HandStatus {
  const f = h.features;
  return {
    handedness: f.handedness,
    score: f.score,
    pose: h.pinchHeld ? 'pinch_hold' : h.pose,
    poseConfidence: h.poseConfidence,
    candidate: h.candidate,
    candidateConfidence: h.candidateConfidence,
    fingers: f.states,
    extension: [
      f.fingers.thumb.extension,
      f.fingers.index.extension,
      f.fingers.middle.extension,
      f.fingers.ring.extension,
      f.fingers.pinky.extension,
    ],
    pinchDistance: f.pinchDistance,
    palm: f.palmCenter,
    rollDeg: f.rollDeg,
    palmFacing: f.palmFacing,
    speed: h.motion.speed,
    direction: h.motion.direction,
    depthTrend: h.motion.depthTrend,
    stable: h.motion.stable,
  };
}
