import type { Landmark, Point } from '../../shared/types';
import { clamp, median, radToDeg } from '../math';

/** MediaPipe Face Mesh landmark indices used here. */
export const FL = {
  NOSE_TIP: 1,
  FOREHEAD: 10,
  CHIN: 152,
  /** Face contour at the subject's right and left cheek. */
  EDGE_A: 234,
  EDGE_B: 454,
  EYE_OUTER_A: 33,
  EYE_OUTER_B: 263,
} as const;

/** One detected face, as delivered by the vision layer. */
export interface FaceObservation {
  /** Landmarks in mirrored, normalized image coordinates. */
  landmarks: Landmark[];
  /** Blendshape scores by name, when the model provides them. */
  blendshapes: Record<string, number> | null;
  /**
   * 4x4 facial transformation matrix (column-major, camera space of the
   * original unmirrored image), when the model provides it.
   */
  matrix: number[] | null;
}

export interface HeadPose {
  /** Degrees. Positive = the user turns toward their right (cursor moves right). */
  yaw: number;
  /** Degrees. Positive = the user looks up. */
  pitch: number;
  /** Degrees of sideways head tilt. */
  roll: number;
  source: 'matrix' | 'landmarks';
}

export interface FaceSignals {
  blinkLeft: number;
  blinkRight: number;
  jawOpen: number;
  smile: number;
  browUp: number;
}

export interface FaceFeatures {
  pose: HeadPose;
  /** Nose tip in mirrored, normalized image coordinates. */
  nose: Point;
  /** Centre of the face outline. */
  center: Point;
  /** Face width as a fraction of image width: a rough distance cue. */
  width: number;
  signals: FaceSignals | null;
}

/**
 * Head rotation from the facial transformation matrix.
 *
 * The matrix maps the canonical face model into camera space, where +X is
 * image-right, +Y is up and the camera looks down -Z. Its third column is the
 * direction the nose points; its second column is the top of the head.
 * Because the camera image is not mirrored, the user's right is image-left,
 * hence the sign flip on yaw and roll.
 */
export function poseFromMatrix(m: number[]): { yaw: number; pitch: number; roll: number } | null {
  if (m.length < 16) return null;
  const fx = m[8];
  const fy = m[9];
  const fz = m[10];
  const fLen = Math.hypot(fx, fy, fz);
  const ux = m[4];
  const uy = m[5];
  if (fLen < 1e-9 || !Number.isFinite(fLen)) return null;
  return {
    yaw: radToDeg(Math.atan2(-fx, fz)),
    pitch: radToDeg(Math.asin(clamp(fy / fLen, -1, 1))),
    roll: radToDeg(-Math.atan2(ux, uy)),
  };
}

/** Ratio of nose protrusion to half the face width, for the landmark-based estimate. */
const NOSE_DEPTH_RATIO = 1.2;

/**
 * Approximate head rotation from 2D landmarks alone. Less accurate than the
 * matrix, but its sign conventions follow directly from the mirrored image,
 * so it is also used to sanity-check the matrix-derived angles.
 */
export function poseFromLandmarks(lm: Landmark[], aspect: number): { yaw: number; pitch: number; roll: number } {
  const nose = lm[FL.NOSE_TIP];
  const a = lm[FL.EDGE_A];
  const b = lm[FL.EDGE_B];
  const top = lm[FL.FOREHEAD];
  const chin = lm[FL.CHIN];

  const halfWidth = (Math.hypot((a.x - b.x) * aspect, a.y - b.y) || 1e-6) / 2;
  const halfHeight = (Math.hypot((top.x - chin.x) * aspect, top.y - chin.y) || 1e-6) / 2;
  const midX = (a.x + b.x) / 2;
  const midY = (top.y + chin.y) / 2;

  // Mirrored image: turning right moves the nose right of the face outline.
  const yaw = radToDeg(Math.atan(((nose.x - midX) * aspect) / halfWidth / NOSE_DEPTH_RATIO));
  // Looking up moves the nose up (smaller y) relative to the outline.
  const pitch = radToDeg(Math.atan(-(nose.y - midY) / halfHeight / NOSE_DEPTH_RATIO));

  const e1 = lm[FL.EYE_OUTER_A];
  const e2 = lm[FL.EYE_OUTER_B];
  const [l, r] = e1.x < e2.x ? [e1, e2] : [e2, e1];
  const roll = radToDeg(Math.atan2(r.y - l.y, (r.x - l.x) * aspect));
  return { yaw, pitch, roll };
}

/**
 * Compares the direction of change of two estimates of the same angle and
 * reports whether they consistently disagree. Used to guard against a sign
 * convention mismatch in the matrix-derived pose.
 */
class SignGuard {
  private vote = 0;
  private sign = 1;
  private ref: { t: number; a: number; b: number } | null = null;

  update(t: number, a: number, b: number): number {
    if (!this.ref) {
      this.ref = { t, a, b };
      return this.sign;
    }
    if (t - this.ref.t < 150) return this.sign;
    const da = a - this.ref.a;
    const db = b - this.ref.b;
    this.ref = { t, a, b };
    // Only clear movements vote; noise would be a coin flip.
    if (Math.abs(da) > 1.5 && Math.abs(db) > 1.5) {
      this.vote = clamp(this.vote + Math.sign(da * db), -12, 12);
      if (this.vote <= -6) this.sign = -1;
      else if (this.vote >= 6) this.sign = 1;
    }
    return this.sign;
  }
}

const read = (shapes: Record<string, number>, name: string): number => shapes[name] ?? 0;

export function faceSignals(shapes: Record<string, number> | null): FaceSignals | null {
  if (!shapes) return null;
  return {
    blinkLeft: read(shapes, 'eyeBlinkLeft'),
    blinkRight: read(shapes, 'eyeBlinkRight'),
    jawOpen: read(shapes, 'jawOpen'),
    smile: (read(shapes, 'mouthSmileLeft') + read(shapes, 'mouthSmileRight')) / 2,
    browUp: Math.max(
      read(shapes, 'browInnerUp'),
      (read(shapes, 'browOuterUpLeft') + read(shapes, 'browOuterUpRight')) / 2,
    ),
  };
}

/** Produces head pose and face features from raw observations. */
export class HeadPoseEstimator {
  private readonly yawGuard = new SignGuard();
  private readonly pitchGuard = new SignGuard();

  update(obs: FaceObservation, aspect: number, t: number): FaceFeatures {
    const lm = obs.landmarks;
    const fromLandmarks = poseFromLandmarks(lm, aspect);
    const fromMatrix = obs.matrix ? poseFromMatrix(obs.matrix) : null;

    let pose: HeadPose;
    if (fromMatrix) {
      const yawSign = this.yawGuard.update(t, fromMatrix.yaw, fromLandmarks.yaw);
      const pitchSign = this.pitchGuard.update(t, fromMatrix.pitch, fromLandmarks.pitch);
      pose = {
        yaw: fromMatrix.yaw * yawSign,
        pitch: fromMatrix.pitch * pitchSign,
        roll: fromMatrix.roll,
        source: 'matrix',
      };
    } else {
      pose = { ...fromLandmarks, source: 'landmarks' };
    }

    const a = lm[FL.EDGE_A];
    const b = lm[FL.EDGE_B];
    const top = lm[FL.FOREHEAD];
    const chin = lm[FL.CHIN];
    return {
      pose,
      nose: { x: lm[FL.NOSE_TIP].x, y: lm[FL.NOSE_TIP].y },
      center: { x: (a.x + b.x) / 2, y: (top.y + chin.y) / 2 },
      width: Math.abs(a.x - b.x),
      signals: faceSignals(obs.blendshapes),
    };
  }
}

/**
 * Landmark jitter while the head is roughly still: the median frame-to-frame
 * movement of the nose tip. A direct, measured indicator of tracking noise
 * (which rises in poor light), robust to deliberate head movement.
 */
export class JitterMeter {
  private last: Point | null = null;
  private deltas: number[] = [];

  push(p: Point): number {
    if (this.last) {
      this.deltas.push(Math.hypot(p.x - this.last.x, p.y - this.last.y));
      if (this.deltas.length > 45) this.deltas.shift();
    }
    this.last = p;
    return this.value;
  }

  reset(): void {
    this.last = null;
    this.deltas = [];
  }

  get value(): number {
    return this.deltas.length < 5 ? 0 : median(this.deltas);
  }
}
