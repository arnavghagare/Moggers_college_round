import type { ActionId } from '../../shared/actions';

/**
 * The gesture registry: every gesture Handsfree can recognise is declared
 * here, once, with its defaults. Recognition code looks gestures up by id and
 * the settings UI is generated from this list, so there are no gesture
 * conditions scattered through the application.
 */

export type GestureKind = 'hand-pose' | 'hand-motion' | 'two-hand' | 'face';

export interface GestureConfig {
  enabled: boolean;
  /** Confidence (0..1) needed to activate. */
  threshold: number;
  /** Confidence below which an active gesture is released (hysteresis). */
  releaseThreshold: number;
  /** How long the gesture must be seen before it counts. */
  minDurationMs: number;
  /** Minimum time between two activations. */
  cooldownMs: number;
  action: ActionId;
}

export interface GestureDefinition {
  id: string;
  name: string;
  description: string;
  kind: GestureKind;
  /** Landmarks / derived features the recogniser depends on. */
  requires: string;
  /**
   * `direct` gestures are measured from landmarks in every frame. `inferred`
   * gestures depend on quantities a single RGB camera cannot observe directly
   * (depth, timing patterns) and are less reliable.
   */
  evidence: 'direct' | 'inferred';
  /** Only one-shot actions make sense (the gesture has no held state). */
  oneshotOnly: boolean;
  defaults: GestureConfig;
}

const cfg = (
  action: ActionId,
  threshold: number,
  releaseThreshold: number,
  minDurationMs: number,
  cooldownMs: number,
  enabled = true,
): GestureConfig => ({ enabled, threshold, releaseThreshold, minDurationMs, cooldownMs, action });

export const GESTURES: GestureDefinition[] = [
  // ---- Static hand poses -------------------------------------------------
  {
    id: 'open_palm',
    name: 'Open palm',
    description: 'All fingers extended, palm toward the camera.',
    kind: 'hand-pose',
    requires: 'Extension of all five fingers',
    evidence: 'direct',
    oneshotOnly: false,
    defaults: cfg('move_cursor', 0.7, 0.5, 120, 0),
  },
  {
    id: 'point',
    name: 'Index finger pointing',
    description: 'Index finger extended, the other three fingers folded.',
    kind: 'hand-pose',
    requires: 'Index extension, middle / ring / little finger curl',
    evidence: 'direct',
    oneshotOnly: false,
    defaults: cfg('move_cursor', 0.65, 0.45, 100, 0),
  },
  {
    id: 'pinch',
    name: 'Pinch (tap)',
    description: 'Touch thumb and index fingertip, then release. The action fires on release.',
    kind: 'hand-pose',
    requires: 'Thumb tip to index tip distance, relative to hand size',
    evidence: 'direct',
    oneshotOnly: false,
    defaults: cfg('click', 0.8, 0.6, 60, 250),
  },
  {
    id: 'pinch_hold',
    name: 'Pinch and hold',
    description: 'Keep thumb and index together. Releasing the pinch ends the held action (for example a drag).',
    kind: 'hand-pose',
    requires: 'A pinch sustained for the minimum duration',
    evidence: 'direct',
    oneshotOnly: false,
    defaults: cfg('drag', 0.8, 0.6, 450, 250),
  },
  {
    id: 'two_fingers',
    name: 'Two fingers',
    description: 'Index and middle finger extended, ring and little finger folded.',
    kind: 'hand-pose',
    requires: 'Index and middle extension, ring / little finger curl',
    evidence: 'direct',
    oneshotOnly: false,
    defaults: cfg('scroll', 0.65, 0.45, 150, 0),
  },
  {
    id: 'three_fingers',
    name: 'Three fingers',
    description: 'Index, middle and ring finger extended, little finger folded.',
    kind: 'hand-pose',
    requires: 'Index / middle / ring extension, little finger curl',
    evidence: 'direct',
    oneshotOnly: false,
    defaults: cfg('switch_mode', 0.65, 0.45, 350, 1500),
  },
  {
    id: 'fist',
    name: 'Fist',
    description: 'All four fingers curled into the palm.',
    kind: 'hand-pose',
    requires: 'Curl of index, middle, ring and little finger',
    evidence: 'direct',
    oneshotOnly: false,
    defaults: cfg('hold_cursor', 0.7, 0.5, 150, 0),
  },
  {
    id: 'thumbs_up',
    name: 'Thumbs up',
    description: 'Fist with the thumb extended and pointing up.',
    kind: 'hand-pose',
    requires: 'Thumb extension and direction, curl of the other fingers',
    evidence: 'direct',
    oneshotOnly: false,
    defaults: cfg('confirm', 0.6, 0.4, 350, 1000),
  },
  {
    id: 'thumbs_down',
    name: 'Thumbs down',
    description: 'Fist with the thumb extended and pointing down.',
    kind: 'hand-pose',
    requires: 'Thumb extension and direction, curl of the other fingers',
    evidence: 'direct',
    oneshotOnly: false,
    defaults: cfg('cancel', 0.6, 0.4, 350, 1000),
  },

  // ---- Dynamic hand gestures ---------------------------------------------
  {
    id: 'grab',
    name: 'Open hand to fist',
    description: 'Close an open hand into a fist in one motion.',
    kind: 'hand-motion',
    requires: 'An open palm followed by a fist within 0.7 s',
    evidence: 'direct',
    oneshotOnly: true,
    defaults: cfg('none', 0.7, 0.5, 0, 1000),
  },
  {
    id: 'swipe_left',
    name: 'Swipe left',
    description: 'Move an open hand quickly to the left. Ignored while the hand is steering the cursor.',
    kind: 'hand-motion',
    requires: 'Palm displacement over a 0.45 s window',
    evidence: 'direct',
    oneshotOnly: true,
    defaults: cfg('go_back', 0.6, 0.3, 0, 900),
  },
  {
    id: 'swipe_right',
    name: 'Swipe right',
    description: 'Move an open hand quickly to the right. Ignored while the hand is steering the cursor.',
    kind: 'hand-motion',
    requires: 'Palm displacement over a 0.45 s window',
    evidence: 'direct',
    oneshotOnly: true,
    defaults: cfg('go_forward', 0.6, 0.3, 0, 900),
  },
  {
    id: 'swipe_up',
    name: 'Swipe up',
    description: 'Move an open hand quickly upward. Ignored while the hand is steering the cursor.',
    kind: 'hand-motion',
    requires: 'Palm displacement over a 0.45 s window',
    evidence: 'direct',
    oneshotOnly: true,
    defaults: cfg('scroll_down', 0.6, 0.3, 0, 900),
  },
  {
    id: 'swipe_down',
    name: 'Swipe down',
    description: 'Move an open hand quickly downward. Ignored while the hand is steering the cursor.',
    kind: 'hand-motion',
    requires: 'Palm displacement over a 0.45 s window',
    evidence: 'direct',
    oneshotOnly: true,
    defaults: cfg('scroll_up', 0.6, 0.3, 0, 900),
  },
  {
    id: 'hand_raise',
    name: 'Hand raise',
    description: 'Hold an open hand in the upper part of the camera view.',
    kind: 'hand-motion',
    requires: 'Open palm with the wrist in the top third of the frame, sustained',
    evidence: 'direct',
    oneshotOnly: true,
    defaults: cfg('toggle_pause', 0.6, 0.4, 1200, 2500),
  },
  {
    id: 'hand_push',
    name: 'Push toward camera',
    description: 'Move an open hand quickly toward the camera. Depth is inferred from apparent hand size.',
    kind: 'hand-motion',
    requires: 'Growth of apparent hand size over a 0.45 s window',
    evidence: 'inferred',
    oneshotOnly: true,
    defaults: cfg('none', 0.6, 0.3, 0, 1200, false),
  },

  // ---- Two-hand gestures -------------------------------------------------
  {
    id: 'two_hand_spread',
    name: 'Two hands apart',
    description: 'With both hands open, move them apart.',
    kind: 'two-hand',
    requires: 'Two open hands, increasing distance between the palms',
    evidence: 'direct',
    oneshotOnly: true,
    defaults: cfg('zoom_in', 0.6, 0.3, 0, 800),
  },
  {
    id: 'two_hand_squeeze',
    name: 'Two hands together',
    description: 'With both hands open, move them toward each other.',
    kind: 'two-hand',
    requires: 'Two open hands, decreasing distance between the palms',
    evidence: 'direct',
    oneshotOnly: true,
    defaults: cfg('zoom_out', 0.6, 0.3, 0, 800),
  },

  // ---- Facial gestures (all off by default) ------------------------------
  {
    id: 'blink_long',
    name: 'Long blink',
    description: 'Close both eyes for noticeably longer than a natural blink.',
    kind: 'face',
    requires: 'eyeBlinkLeft and eyeBlinkRight blendshapes',
    evidence: 'direct',
    oneshotOnly: true,
    defaults: cfg('click', 0.6, 0.35, 700, 1200, false),
  },
  {
    id: 'double_blink',
    name: 'Double blink',
    description: 'Two short blinks in quick succession. Single blinks are ignored.',
    kind: 'face',
    requires: 'eyeBlinkLeft and eyeBlinkRight blendshapes, timing pattern',
    evidence: 'inferred',
    oneshotOnly: true,
    defaults: cfg('click', 0.6, 0.35, 0, 1200, false),
  },
  {
    id: 'wink_left',
    name: 'Left wink',
    description: 'Close your left eye while the right eye stays open.',
    kind: 'face',
    requires: 'Difference between the eyeBlinkLeft and eyeBlinkRight blendshapes',
    evidence: 'inferred',
    oneshotOnly: true,
    defaults: cfg('right_click', 0.55, 0.3, 350, 1200, false),
  },
  {
    id: 'wink_right',
    name: 'Right wink',
    description: 'Close your right eye while the left eye stays open.',
    kind: 'face',
    requires: 'Difference between the eyeBlinkRight and eyeBlinkLeft blendshapes',
    evidence: 'inferred',
    oneshotOnly: true,
    defaults: cfg('click', 0.55, 0.3, 350, 1200, false),
  },
  {
    id: 'brow_raise',
    name: 'Eyebrow raise',
    description: 'Raise both eyebrows and hold briefly.',
    kind: 'face',
    requires: 'browInnerUp and browOuterUp blendshapes',
    evidence: 'direct',
    oneshotOnly: true,
    defaults: cfg('click', 0.6, 0.35, 350, 1000, false),
  },
  {
    id: 'mouth_open',
    name: 'Mouth open',
    description: 'Open your mouth and hold briefly. Speaking can trigger this, so avoid combining it with voice.',
    kind: 'face',
    requires: 'jawOpen blendshape',
    evidence: 'direct',
    oneshotOnly: true,
    defaults: cfg('click', 0.55, 0.3, 300, 1000, false),
  },
  {
    id: 'smile',
    name: 'Smile',
    description: 'A broad smile, held briefly.',
    kind: 'face',
    requires: 'mouthSmileLeft and mouthSmileRight blendshapes',
    evidence: 'direct',
    oneshotOnly: true,
    defaults: cfg('toggle_numbers', 0.7, 0.4, 500, 1500, false),
  },
];

const BY_ID = new Map(GESTURES.map((g) => [g.id, g]));

export function gestureDef(id: string): GestureDefinition | undefined {
  return BY_ID.get(id);
}

export function gestureName(id: string): string {
  return BY_ID.get(id)?.name ?? id;
}

export function defaultGestureConfigs(): Record<string, GestureConfig> {
  const out: Record<string, GestureConfig> = {};
  for (const g of GESTURES) out[g.id] = { ...g.defaults };
  return out;
}

/**
 * Explicit priority used to resolve conflicts between hand poses whose scores
 * are both above threshold. Earlier entries win.
 */
export const HAND_POSE_PRIORITY = [
  'pinch',
  'thumbs_up',
  'thumbs_down',
  'fist',
  'three_fingers',
  'two_fingers',
  'point',
  'open_palm',
] as const;

export type HandPoseId = (typeof HAND_POSE_PRIORITY)[number];
