import { describe, expect, it } from 'vitest';
import { computeHandFeatures } from '../../src/core/hand/features';
import { scoreHandPoses } from '../../src/core/hand/poses';
import { HAND_POSE_PRIORITY } from '../../src/core/gestures/registry';
import { POSES, TEST_ASPECT, makeHand } from '../helpers/synthetic';

const features = (obs: ReturnType<typeof makeHand>) => computeHandFeatures(obs, TEST_ASPECT);
const best = (obs: ReturnType<typeof makeHand>) => {
  const scores = scoreHandPoses(features(obs));
  return [...HAND_POSE_PRIORITY].sort((a, b) => scores[b] - scores[a])[0];
};

describe('finger extension', () => {
  it('reports all fingers extended for an open hand', () => {
    const f = features(POSES.open());
    expect(f.states).toEqual({ thumb: true, index: true, middle: true, ring: true, pinky: true });
    expect(f.extendedCount).toBe(5);
    expect(f.fingers.index.extension).toBeGreaterThan(0.9);
  });

  it('reports all fingers folded for a fist', () => {
    const f = features(POSES.fist());
    expect(f.states).toEqual({ thumb: false, index: false, middle: false, ring: false, pinky: false });
    expect(f.fingers.middle.extension).toBeLessThan(0.1);
  });

  it('separates the index finger when pointing', () => {
    const f = features(POSES.point());
    expect(f.states.index).toBe(true);
    expect(f.states.middle).toBe(false);
    expect(f.states.ring).toBe(false);
    expect(f.states.pinky).toBe(false);
  });

  it('extension falls monotonically as a finger curls', () => {
    const values = [0, 0.25, 0.5, 0.75, 1].map(
      (c) => features(makeHand({ curls: [c, 0, 0, 0] })).fingers.index.extension,
    );
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
    expect(values[0]).toBeGreaterThan(0.9);
    expect(values[4]).toBeLessThan(0.1);
  });

  it('reports joint angles near 180 degrees for a straight finger', () => {
    const f = features(POSES.open());
    expect(f.fingers.index.angles[1]).toBeGreaterThan(170);
    expect(features(POSES.fist()).fingers.index.angles[1]).toBeLessThan(110);
  });
});

describe('hand geometry', () => {
  it('measures a small thumb-index distance when pinching', () => {
    expect(features(POSES.pinch()).pinchDistance).toBeLessThan(0.2);
    expect(features(POSES.open()).pinchDistance).toBeGreaterThan(0.6);
  });

  it('places the palm centre where the hand is', () => {
    const f = features(POSES.open({ x: 0.3, y: 0.7 }));
    expect(f.palmCenter.x).toBeCloseTo(0.3, 2);
    expect(f.palmCenter.y).toBeCloseTo(0.7, 2);
  });

  it('apparent size grows as the hand approaches the camera', () => {
    const far = features(POSES.open({ scale: 0.015 })).apparentSize;
    const near = features(POSES.open({ scale: 0.03 })).apparentSize;
    expect(near).toBeCloseTo(far * 2, 2);
  });

  it('measures in-plane rotation', () => {
    expect(Math.abs(features(POSES.open()).rollDeg)).toBeLessThan(12);
    const rotated = features(POSES.open({ rotate: 60 })).rollDeg - features(POSES.open()).rollDeg;
    expect(rotated).toBeCloseTo(60, 0);
  });

  it('identifies which side of the hand faces the camera for both hands', () => {
    expect(features(POSES.open({ handedness: 'Right' })).palmFacing).toBe('camera');
    expect(features(POSES.open({ handedness: 'Left' })).palmFacing).toBe('camera');
  });

  it('works without world landmarks', () => {
    const obs = POSES.point();
    const f = computeHandFeatures({ ...obs, world: null }, TEST_ASPECT);
    expect(f.states.index).toBe(true);
    expect(f.states.middle).toBe(false);
  });
});

describe('pose scoring', () => {
  const makers = {
    open_palm: POSES.open,
    fist: POSES.fist,
    point: POSES.point,
    two_fingers: POSES.two,
    three_fingers: POSES.three,
    pinch: POSES.pinch,
    thumbs_up: POSES.thumbsUp,
    thumbs_down: POSES.thumbsDown,
  } as const;
  const ids = Object.keys(makers) as Array<keyof typeof makers>;

  it.each(ids)('scores %s highest for its own pose', (id) => {
    const obs = makers[id]();
    expect(best(obs)).toBe(id);
    expect(scoreHandPoses(features(obs))[id]).toBeGreaterThan(0.8);
  });

  it.each(ids)('recognises %s on the left hand too', (id) => {
    expect(best(makers[id]({ handedness: 'Left' }))).toBe(id);
  });

  it('does not mistake a fist for a pinch', () => {
    expect(scoreHandPoses(features(POSES.fist())).pinch).toBeLessThan(0.3);
  });

  it('keeps mutually exclusive poses apart', () => {
    const open = scoreHandPoses(features(POSES.open()));
    expect(open.fist).toBeLessThan(0.1);
    expect(open.point).toBeLessThan(0.1);
    const fist = scoreHandPoses(features(POSES.fist()));
    expect(fist.open_palm).toBeLessThan(0.1);
    expect(fist.thumbs_up).toBeLessThan(0.2);
  });

  it('is independent of hand position and size', () => {
    const a = scoreHandPoses(features(POSES.two({ x: 0.2, y: 0.3, scale: 0.012 })));
    const b = scoreHandPoses(features(POSES.two({ x: 0.8, y: 0.7, scale: 0.03 })));
    expect(a.two_fingers).toBeCloseTo(b.two_fingers, 3);
  });
});
