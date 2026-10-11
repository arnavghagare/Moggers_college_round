import type { FaceObservation } from '../../src/core/face/pose';
import type { HandObservation } from '../../src/core/hand/features';
import type { Handedness, Landmark } from '../../src/shared/types';

/**
 * Synthetic landmark generators for tests. They build geometrically plausible
 * hands and faces from a handful of parameters, so recognition logic can be
 * exercised without a camera. They are test fixtures only and are never used
 * by the application.
 */

export interface HandSpec {
  /** Curl per finger, 0 = straight, 1 = fully curled: [index, middle, ring, little]. */
  curls?: [number, number, number, number];
  thumb?: 'out' | 'folded';
  /** Bring thumb and index tips together. */
  pinch?: boolean;
  handedness?: Handedness;
  /** Palm centre in normalized image coordinates. */
  x?: number;
  y?: number;
  /** Image heights per centimetre: larger = closer to the camera. */
  scale?: number;
  /** In-plane rotation in degrees (clockwise in the image). */
  rotate?: number;
  score?: number;
}

const DEG = Math.PI / 180;
const ASPECT = 4 / 3;

// Right hand, palm toward the camera, in a mirror view. Centimetres, y up, z toward the camera.
const MCP: Array<[number, number]> = [
  [-2.5, 9.0],
  [-0.8, 9.3],
  [0.9, 8.7],
  [2.6, 7.8],
];
const SEGMENTS: Array<[number, number, number]> = [
  [4.5, 2.6, 2.2],
  [5.0, 3.0, 2.4],
  [4.6, 2.8, 2.3],
  [3.6, 2.0, 2.0],
];
const THUMB_OUT: Array<[number, number, number]> = [
  [-2.5, 2.0, 0],
  [-4.2, 4.5, 0],
  [-5.6, 6.6, 0],
  [-6.8, 8.6, 0],
];
const THUMB_FOLDED: Array<[number, number, number]> = [
  [-2.3, 2.2, 0.5],
  [-2.6, 4.6, 1.2],
  [-1.4, 6.0, 1.8],
  [0.2, 6.5, 2.0],
];

function finger(mcp: [number, number], lengths: [number, number, number], curl: number): Array<[number, number, number]> {
  const flex = [curl * 80, curl * 100, curl * 70];
  const points: Array<[number, number, number]> = [[mcp[0], mcp[1], 0]];
  let angle = 0;
  let [x, y, z] = points[0];
  for (let i = 0; i < 3; i++) {
    angle += flex[i] * DEG;
    y += Math.cos(angle) * lengths[i];
    z += Math.sin(angle) * lengths[i];
    points.push([x, y, z]);
  }
  void x;
  return points;
}

/** Build a 21-landmark hand in the layout produced by the vision layer. */
export function makeHand(spec: HandSpec = {}): HandObservation {
  const curls = spec.curls ?? [0, 0, 0, 0];
  const handedness = spec.handedness ?? 'Right';
  const scale = spec.scale ?? 0.02;
  const cx = spec.x ?? 0.5;
  const cy = spec.y ?? 0.6;

  let pts: Array<[number, number, number]> = [[0, 0, 0]];
  pts.push(...(spec.thumb === 'folded' ? THUMB_FOLDED : THUMB_OUT));
  for (let f = 0; f < 4; f++) pts.push(...finger(MCP[f], SEGMENTS[f], curls[f]));

  if (spec.pinch) {
    // Bend the index toward the thumb and bring the thumb tip up to meet it.
    const meet: [number, number, number] = [-4.4, 9.6, 2.6];
    pts[6] = [-3.0, 11.6, 1.6];
    pts[7] = [-3.8, 11.0, 2.4];
    pts[8] = [meet[0] + 0.3, meet[1] + 0.4, meet[2]];
    pts[2] = [-4.0, 4.6, 0.8];
    pts[3] = [-4.6, 7.0, 1.8];
    pts[4] = [meet[0] - 0.3, meet[1] - 0.4, meet[2]];
  }

  const rot = (spec.rotate ?? 0) * DEG;
  if (rot !== 0) {
    // Positive = clockwise as seen in the image (y up here, so negate the angle).
    const c = Math.cos(-rot);
    const s = Math.sin(-rot);
    pts = pts.map(([x, y, z]) => [x * c - y * s, x * s + y * c, z]);
  }
  if (handedness === 'Left') pts = pts.map(([x, y, z]) => [-x, y, z]);

  // Palm centre (mean of wrist and knuckles) is placed at (cx, cy).
  const palmIdx = [0, 5, 9, 13, 17];
  const px = palmIdx.reduce((a, i) => a + pts[i][0], 0) / 5;
  const py = palmIdx.reduce((a, i) => a + pts[i][1], 0) / 5;

  const landmarks: Landmark[] = pts.map(([x, y, z]) => ({
    x: cx + ((x - px) * scale) / ASPECT,
    y: cy - (y - py) * scale,
    z: -z * scale,
  }));
  const world: Landmark[] = pts.map(([x, y, z]) => ({ x: x / 100, y: -y / 100, z: -z / 100 }));
  return { landmarks, world, handedness, score: spec.score ?? 0.95 };
}

export const POSES = {
  open: (extra: HandSpec = {}): HandObservation => makeHand({ curls: [0, 0, 0, 0], ...extra }),
  fist: (extra: HandSpec = {}): HandObservation => makeHand({ curls: [1, 1, 1, 1], thumb: 'folded', ...extra }),
  point: (extra: HandSpec = {}): HandObservation => makeHand({ curls: [0, 1, 1, 1], thumb: 'folded', ...extra }),
  two: (extra: HandSpec = {}): HandObservation => makeHand({ curls: [0, 0, 1, 1], thumb: 'folded', ...extra }),
  three: (extra: HandSpec = {}): HandObservation => makeHand({ curls: [0, 0, 0, 1], thumb: 'folded', ...extra }),
  pinch: (extra: HandSpec = {}): HandObservation => makeHand({ curls: [0, 0, 0, 0], pinch: true, ...extra }),
  // Thumb direction in the base pose is ~32 degrees left of straight up.
  thumbsUp: (extra: HandSpec = {}): HandObservation => makeHand({ curls: [1, 1, 1, 1], thumb: 'out', rotate: 32, ...extra }),
  thumbsDown: (extra: HandSpec = {}): HandObservation => makeHand({ curls: [1, 1, 1, 1], thumb: 'out', rotate: 212, ...extra }),
};

export const TEST_ASPECT = ASPECT;

export interface FaceSpec {
  /** Degrees, user-centric: positive yaw = turned to the user's right, positive pitch = looking up. */
  yaw?: number;
  pitch?: number;
  /** Nose position in the mirrored image. */
  x?: number;
  y?: number;
  blendshapes?: Record<string, number>;
  /** Omit the transformation matrix, forcing the landmark-based estimate. */
  noMatrix?: boolean;
  /** Emit a matrix whose yaw sign is inverted (to test the sign guard). */
  flipMatrixYaw?: boolean;
}

/**
 * A face observation with the handful of landmarks the code uses, plus a
 * transformation matrix that follows the convention documented in pose.ts.
 */
export function makeFace(spec: FaceSpec = {}): FaceObservation {
  const yaw = (spec.yaw ?? 0) * DEG;
  const pitch = (spec.pitch ?? 0) * DEG;
  const cx = spec.x ?? 0.5;
  const cy = spec.y ?? 0.5;
  const halfW = 0.09;
  const halfH = 0.16;

  const landmarks: Landmark[] = Array.from({ length: 478 }, () => ({ x: cx, y: cy, z: 0 }));
  // Mirrored image: turning right moves the nose right; looking up moves it up.
  const noseDx = Math.tan(yaw) * 1.2 * halfW;
  const noseDy = -Math.tan(pitch) * 1.2 * halfH;
  landmarks[1] = { x: cx + noseDx, y: cy + noseDy, z: -0.05 };
  landmarks[234] = { x: cx - halfW, y: cy, z: 0 };
  landmarks[454] = { x: cx + halfW, y: cy, z: 0 };
  landmarks[10] = { x: cx, y: cy - halfH, z: 0 };
  landmarks[152] = { x: cx, y: cy + halfH, z: 0 };
  landmarks[33] = { x: cx - 0.05, y: cy - 0.04, z: 0 };
  landmarks[263] = { x: cx + 0.05, y: cy - 0.04, z: 0 };

  let matrix: number[] | null = null;
  if (!spec.noMatrix) {
    // Camera space is unmirrored: the user's right is image-left, so forward.x = -sin(yaw).
    const sign = spec.flipMatrixYaw ? -1 : 1;
    const fx = -Math.sin(yaw) * Math.cos(pitch) * sign;
    const fy = Math.sin(pitch);
    const fz = Math.cos(yaw) * Math.cos(pitch);
    matrix = [1, 0, 0, 0, 0, 1, 0, 0, fx, fy, fz, 0, 0, 0, -50, 1];
  }
  return { landmarks, blendshapes: spec.blendshapes ?? { eyeBlinkLeft: 0, eyeBlinkRight: 0, jawOpen: 0 }, matrix };
}
