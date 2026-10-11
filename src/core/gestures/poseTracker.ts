import { HAND_POSE_PRIORITY, type GestureConfig, type HandPoseId } from './registry';

export interface PoseEvent {
  id: HandPoseId;
  phase: 'start' | 'end';
  confidence: number;
  /** How long the pose was held (for `end`). */
  heldMs: number;
}

export interface PoseUpdate {
  events: PoseEvent[];
  active: HandPoseId | null;
  activeConfidence: number;
  activeSince: number;
  /** Best pose in this single frame, before debouncing. */
  candidate: HandPoseId | null;
  candidateConfidence: number;
}

/** A single noisy frame below the release threshold does not end a pose. */
const RELEASE_GRACE_MS = 90;
/** The pose that is already active is preferred over a marginally better one. */
const STICKINESS = 0.1;

/**
 * Turns per-frame pose scores into one stable pose per hand.
 *
 * - A pose activates only after it has been the best candidate, above its
 *   activation threshold, for its minimum duration.
 * - An active pose survives until it drops below its (lower) release
 *   threshold, so it does not flicker around a single boundary.
 * - Conflicts are resolved by explicit priority: a pinch beats everything,
 *   then the order in HAND_POSE_PRIORITY breaks near-ties.
 */
export class PoseTracker {
  private active: HandPoseId | null = null;
  private activeSince = 0;
  private activeConfidence = 0;
  private belowSince: number | null = null;
  private challenger: HandPoseId | null = null;
  private challengerSince = 0;

  update(
    scores: Record<HandPoseId, number>,
    t: number,
    config: (id: HandPoseId) => GestureConfig | undefined,
  ): PoseUpdate {
    const events: PoseEvent[] = [];
    const candidate = this.pickCandidate(scores, config);
    const candidateConfidence = candidate ? scores[candidate] : 0;

    if (this.active) {
      const cfg = config(this.active);
      const score = scores[this.active];
      this.activeConfidence = score;
      const released = !cfg || !cfg.enabled || score < cfg.releaseThreshold;
      if (released) {
        this.belowSince ??= t;
        if (!cfg || !cfg.enabled || t - this.belowSince >= RELEASE_GRACE_MS) {
          events.push({ id: this.active, phase: 'end', confidence: score, heldMs: t - this.activeSince });
          this.active = null;
          this.belowSince = null;
        }
      } else {
        this.belowSince = null;
      }
    }

    if (candidate && candidate !== this.active) {
      if (this.challenger !== candidate) {
        this.challenger = candidate;
        this.challengerSince = t;
      }
      const cfg = config(candidate)!;
      if (t - this.challengerSince >= cfg.minDurationMs) {
        if (this.active) {
          events.push({
            id: this.active,
            phase: 'end',
            confidence: scores[this.active],
            heldMs: t - this.activeSince,
          });
        }
        this.active = candidate;
        this.activeSince = t;
        this.activeConfidence = candidateConfidence;
        this.belowSince = null;
        this.challenger = null;
        events.push({ id: candidate, phase: 'start', confidence: candidateConfidence, heldMs: 0 });
      }
    } else {
      this.challenger = null;
    }

    return {
      events,
      active: this.active,
      activeConfidence: this.active ? this.activeConfidence : 0,
      activeSince: this.activeSince,
      candidate,
      candidateConfidence,
    };
  }

  /** The hand disappeared: end whatever was active. */
  reset(t: number): PoseEvent[] {
    const events: PoseEvent[] = [];
    if (this.active) {
      events.push({ id: this.active, phase: 'end', confidence: 0, heldMs: t - this.activeSince });
    }
    this.active = null;
    this.challenger = null;
    this.belowSince = null;
    return events;
  }

  private pickCandidate(
    scores: Record<HandPoseId, number>,
    config: (id: HandPoseId) => GestureConfig | undefined,
  ): HandPoseId | null {
    let best: HandPoseId | null = null;
    let bestScore = 0;
    for (const id of HAND_POSE_PRIORITY) {
      const cfg = config(id);
      if (!cfg || !cfg.enabled) continue;
      const raw = scores[id];
      // The currently active pose needs only its release threshold to stay in the running.
      const needed = id === this.active ? cfg.releaseThreshold : cfg.threshold;
      if (raw < needed) continue;
      // A deliberate pinch always wins, whatever the other fingers are doing.
      if (id === 'pinch') return id;
      const effective = raw + (id === this.active ? STICKINESS : 0);
      // Iterating in priority order: a later pose must be clearly better to win.
      if (best === null || effective > bestScore + STICKINESS) {
        best = id;
        bestScore = effective;
      }
    }
    return best;
  }
}
