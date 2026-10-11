import type { HandPoseId } from '../gestures/registry';
import { ramp } from '../math';
import type { HandFeatures } from './features';

export type PoseScores = Record<HandPoseId, number>;

/**
 * Score every static hand pose for one frame (0 = definitely not, 1 = clear).
 *
 * Scores are products of per-finger terms, so they degrade smoothly instead
 * of flipping on a single threshold, and mutually exclusive poses cannot both
 * score highly. Temporal debouncing happens later, in the pose tracker.
 */
export function scoreHandPoses(f: HandFeatures): PoseScores {
  const t = f.fingers.thumb.extension;
  const i = f.fingers.index.extension;
  const m = f.fingers.middle.extension;
  const r = f.fingers.ring.extension;
  const p = f.fingers.pinky.extension;

  const foldedMRP = Math.min(1 - m, 1 - r, 1 - p);
  const foldedAll = Math.min(1 - i, foldedMRP);

  // Thumb tip close to the index tip. The guard rejects a fist, where the
  // thumb also rests near the index fingertip but the finger is curled in.
  const closeness = 1 - ramp(f.pinchDistance, 0.22, 0.6);
  const notFist = ramp(f.indexReach, 0.45, 0.62);
  const pinch = closeness * notFist;

  // Thumb direction in the image: y grows downward, so "up" is negative y.
  const up = ramp(-f.thumbDirection.y, 0.45, 0.8);
  const down = ramp(f.thumbDirection.y, 0.45, 0.8);

  return {
    pinch,
    thumbs_up: t * foldedAll * up,
    thumbs_down: t * foldedAll * down,
    // A thumb pointing clearly up or down belongs to the thumb gestures.
    fist: foldedAll * (1 - t * Math.max(up, down)),
    three_fingers: Math.min(i, m, r) * (1 - p),
    two_fingers: Math.min(i, m) * Math.min(1 - r, 1 - p),
    point: i * foldedMRP,
    open_palm: Math.min(i, m, r, p) * (0.7 + 0.3 * t),
  };
}
