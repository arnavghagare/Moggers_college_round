import type { FingerStates, Handedness, Landmark, Point } from '../../shared/types';
import { angleAt, cross3, dist3, len3, ramp, sub3 } from '../math';

/** MediaPipe hand landmark indices (21-point model). */
export const HL = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

export const HAND_CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';
export const FINGERS: FingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];

const CHAINS: Record<Exclude<FingerName, 'thumb'>, [number, number, number, number]> = {
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};

/** One detected hand, as delivered by the vision layer. */
export interface HandObservation {
  /** 21 landmarks in mirrored, normalized image coordinates (x and y in 0..1). */
  landmarks: Landmark[];
  /** Metric 3D landmarks relative to the hand, when the model provides them. */
  world: Landmark[] | null;
  /** The user's actual hand, after correcting for the unmirrored camera image. */
  handedness: Handedness;
  score: number;
}

export interface FingerFeature {
  /** 0 = fully curled, 1 = fully extended. */
  extension: number;
  extended: boolean;
  /** Interior joint angles in degrees: [MCP, PIP, DIP] (thumb: [CMC, MCP, IP]). 180 = straight. */
  angles: [number, number, number];
}

export interface HandFeatures {
  handedness: Handedness;
  score: number;
  fingers: Record<FingerName, FingerFeature>;
  states: FingerStates;
  extendedCount: number;
  /** Positions in mirrored, normalized image coordinates. */
  wrist: Point;
  palmCenter: Point;
  indexTip: Point;
  indexKnuckle: Point;
  /** Apparent hand size (wrist to middle knuckle) in units of image height. Grows as the hand approaches. */
  apparentSize: number;
  /** Palm width (index to little-finger knuckle) relative to hand length. */
  palmWidthRatio: number;
  /** In-plane rotation: 0 = fingers pointing up, positive = rotated clockwise in the mirrored view. */
  rollDeg: number;
  /** Whether the palm or the back of the hand faces the camera (uses the estimated 3D landmarks). */
  palmFacing: 'camera' | 'away' | 'side';
  /** Thumb tip to each other fingertip, relative to hand length: [index, middle, ring, little]. */
  thumbTo: [number, number, number, number];
  /** Distance between neighbouring fingertips, relative to hand length: [index-middle, middle-ring, ring-little]. */
  tipSpread: [number, number, number];
  /** Thumb tip to index tip, relative to hand length. Small = pinching. */
  pinchDistance: number;
  /** Index fingertip distance from the palm centre, relative to hand length. */
  indexReach: number;
  /** Unit vector from thumb knuckle to thumb tip in the image (y grows downward). */
  thumbDirection: Point;
}

const mean = (pts: Landmark[]): Landmark => {
  const out = { x: 0, y: 0, z: 0 };
  for (const p of pts) {
    out.x += p.x;
    out.y += p.y;
    out.z += p.z;
  }
  out.x /= pts.length;
  out.y /= pts.length;
  out.z /= pts.length;
  return out;
};

function fingerFeature(p: Landmark[], wrist: Landmark, chain: [number, number, number, number]): FingerFeature {
  const [mcp, pip, dip, tip] = chain.map((i) => p[i]);
  const chainLength = dist3(mcp, pip) + dist3(pip, dip) + dist3(dip, tip);
  // Straight-line reach over total bone length: ~1 when straight, ~0.35 when curled.
  const reach = chainLength > 1e-9 ? dist3(mcp, tip) / chainLength : 0;
  const angles: [number, number, number] = [angleAt(wrist, mcp, pip), angleAt(mcp, pip, dip), angleAt(pip, dip, tip)];
  // A straight finger folded flat at the knuckle still counts as curled.
  const knuckle = ramp(angles[0], 95, 135);
  const extension = ramp(reach, 0.62, 0.93) * (0.5 + 0.5 * knuckle);
  return { extension, extended: extension > 0.6, angles };
}

function thumbFeature(p: Landmark[]): FingerFeature {
  const tip = p[HL.THUMB_TIP];
  const palmWidth = dist3(p[HL.INDEX_MCP], p[HL.PINKY_MCP]);
  // How far the thumb tip sits from the far side of the palm. A thumb folded
  // across the palm is ~0.5 palm widths away, an abducted thumb ~2.
  const outness = palmWidth > 1e-9 ? dist3(tip, p[HL.PINKY_MCP]) / palmWidth : 0;
  const angles: [number, number, number] = [
    angleAt(p[HL.WRIST], p[HL.THUMB_CMC], p[HL.THUMB_MCP]),
    angleAt(p[HL.THUMB_CMC], p[HL.THUMB_MCP], p[HL.THUMB_IP]),
    angleAt(p[HL.THUMB_MCP], p[HL.THUMB_IP], p[HL.THUMB_TIP]),
  ];
  const straight = ramp(angles[2], 115, 150);
  const extension = ramp(outness, 1.1, 1.7) * (0.4 + 0.6 * straight);
  return { extension, extended: extension > 0.6, angles };
}

/**
 * Derive geometric features from one hand's landmarks.
 *
 * @param aspect image width / height, used to make image distances isotropic.
 */
export function computeHandFeatures(obs: HandObservation, aspect: number): HandFeatures {
  const lm = obs.landmarks;
  // Image-space points in units of image height, so distances are isotropic.
  const img: Landmark[] = lm.map((p) => ({ x: p.x * aspect, y: p.y, z: (p.z ?? 0) * aspect }));
  // Joint angles are far more stable in the model's metric 3D output, when present.
  const p3 = obs.world && obs.world.length === 21 ? obs.world : img;

  const wrist3 = p3[HL.WRIST];
  const length3 = dist3(wrist3, p3[HL.MIDDLE_MCP]) || 1e-6;

  const fingers: Record<FingerName, FingerFeature> = {
    thumb: thumbFeature(p3),
    index: fingerFeature(p3, wrist3, CHAINS.index),
    middle: fingerFeature(p3, wrist3, CHAINS.middle),
    ring: fingerFeature(p3, wrist3, CHAINS.ring),
    pinky: fingerFeature(p3, wrist3, CHAINS.pinky),
  };
  const states: FingerStates = {
    thumb: fingers.thumb.extended,
    index: fingers.index.extended,
    middle: fingers.middle.extended,
    ring: fingers.ring.extended,
    pinky: fingers.pinky.extended,
  };

  const palm3 = mean([p3[0], p3[5], p3[9], p3[13], p3[17]]);
  const palmImg = mean([lm[0], lm[5], lm[9], lm[13], lm[17]]);

  const tips = [p3[HL.INDEX_TIP], p3[HL.MIDDLE_TIP], p3[HL.RING_TIP], p3[HL.PINKY_TIP]];
  const thumbTo = tips.map((t) => dist3(p3[HL.THUMB_TIP], t) / length3) as [number, number, number, number];
  const tipSpread: [number, number, number] = [
    dist3(tips[0], tips[1]) / length3,
    dist3(tips[1], tips[2]) / length3,
    dist3(tips[2], tips[3]) / length3,
  ];

  // In-plane rotation from the wrist -> middle knuckle direction in the image.
  const axis = sub3(img[HL.MIDDLE_MCP], img[HL.WRIST]);
  const rollDeg = (Math.atan2(axis.x, -axis.y) * 180) / Math.PI;

  // Palm normal from the two knuckle directions. The sign flips with handedness.
  const normal = cross3(sub3(p3[HL.INDEX_MCP], wrist3), sub3(p3[HL.PINKY_MCP], wrist3));
  const nLen = len3(normal) || 1e-9;
  const facing = (normal.z / nLen) * (obs.handedness === 'Right' ? 1 : -1);
  const palmFacing = Math.abs(facing) < 0.35 ? 'side' : facing > 0 ? 'camera' : 'away';

  const thumbVec = sub3(img[HL.THUMB_TIP], img[HL.THUMB_MCP]);
  const thumbLen = Math.hypot(thumbVec.x, thumbVec.y) || 1e-9;

  return {
    handedness: obs.handedness,
    score: obs.score,
    fingers,
    states,
    extendedCount: Object.values(states).filter(Boolean).length,
    wrist: { x: lm[HL.WRIST].x, y: lm[HL.WRIST].y },
    palmCenter: { x: palmImg.x, y: palmImg.y },
    indexTip: { x: lm[HL.INDEX_TIP].x, y: lm[HL.INDEX_TIP].y },
    indexKnuckle: { x: lm[HL.INDEX_MCP].x, y: lm[HL.INDEX_MCP].y },
    apparentSize: Math.hypot(axis.x, axis.y),
    palmWidthRatio: dist3(p3[HL.INDEX_MCP], p3[HL.PINKY_MCP]) / length3,
    rollDeg,
    palmFacing,
    thumbTo,
    tipSpread,
    pinchDistance: thumbTo[0],
    indexReach: dist3(p3[HL.INDEX_TIP], palm3) / length3,
    thumbDirection: { x: thumbVec.x / thumbLen, y: thumbVec.y / thumbLen },
  };
}
