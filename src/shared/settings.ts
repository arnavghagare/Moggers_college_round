import { isActionId } from './actions';
import type { ControlMode, HeadCalibration } from './types';
import { isPolyFit } from '../core/cursor/polyFit';
import { defaultGestureConfigs, gestureDef, type GestureConfig } from '../core/gestures/registry';

export interface Settings {
  version: 1;
  onboarded: boolean;
  theme: 'dark' | 'light' | 'system';
  textScale: number;
  controlMode: ControlMode;
  /** In hybrid mode: switch only on request, or let a visible pointing hand take over. */
  hybridPolicy: 'explicit' | 'handPriority';
  features: {
    handGestures: boolean;
    faceGestures: boolean;
    voice: boolean;
  };
  camera: {
    deviceId: string | null;
    maxFps: number;
    delegate: 'GPU' | 'CPU';
  };
  cursor: {
    size: number;
    color: string;
    /** Multiplier on the calibrated range. */
    sensitivity: number;
    /** 0 = raw, 1 = heaviest smoothing. */
    smoothing: number;
    /** Movement ignored around the resting position, as a fraction of the screen. */
    deadZone: number;
    /** 0 = linear response. */
    acceleration: number;
    dynamics: 'absolute' | 'relative';
    headSource: 'pose' | 'position';
    invertX: boolean;
    invertY: boolean;
    handAnchor: 'knuckle' | 'indexTip' | 'palm';
    /** Fraction of the camera frame that maps to the whole screen in hand mode. */
    handArea: number;
    /** Centre of that area in the mirrored camera image: where your hand rests comfortably. */
    handCenterX: number;
    handCenterY: number;
  };
  click: {
    dwellEnabled: boolean;
    dwellMs: number;
    dwellRadiusPx: number;
    dwellInteractiveOnly: boolean;
    confirmPolicy: 'never' | 'risky' | 'always';
    scrollStepRatio: number;
  };
  safety: {
    graceMs: number;
    /** Auto-pause after this much continuous tracking loss. */
    autoPauseMs: number;
    /** Time the cursor is held still after tracking comes back. */
    settleMs: number;
    resumeAfterLoss: 'auto' | 'manual';
  };
  voice: {
    lang: string;
    mode: 'always' | 'wake' | 'push';
    wakeWord: string;
    minConfidence: number;
    host: 'offscreen' | 'dashboard';
  };
  hints: {
    maxLabels: number;
    /** In voice mode, keep numbers on screen so any element is one word away. */
    autoInVoiceMode: boolean;
  };
  drift: 'off' | 'suggest' | 'auto';
  gestures: Record<string, GestureConfig>;
  calibration: HeadCalibration | null;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  onboarded: false,
  theme: 'dark',
  textScale: 1,
  controlMode: 'head',
  hybridPolicy: 'explicit',
  features: {
    handGestures: false,
    faceGestures: false,
    voice: true,
  },
  camera: {
    deviceId: null,
    maxFps: 30,
    delegate: 'GPU',
  },
  cursor: {
    size: 28,
    color: '#ccff00',
    sensitivity: 1,
    smoothing: 0.55,
    deadZone: 0.006,
    acceleration: 0.3,
    dynamics: 'absolute',
    headSource: 'pose',
    invertX: false,
    invertY: false,
    handAnchor: 'knuckle',
    handArea: 0.6,
    handCenterX: 0.5,
    handCenterY: 0.55,
  },
  click: {
    dwellEnabled: true,
    dwellMs: 1100,
    dwellRadiusPx: 34,
    dwellInteractiveOnly: true,
    confirmPolicy: 'risky',
    scrollStepRatio: 0.7,
  },
  safety: {
    graceMs: 3000,
    autoPauseMs: 5000,
    settleMs: 450,
    resumeAfterLoss: 'auto',
  },
  voice: {
    lang: 'en-US',
    mode: 'always',
    wakeWord: 'computer',
    minConfidence: 0.5,
    host: 'offscreen',
  },
  hints: {
    maxLabels: 150,
    autoInVoiceMode: true,
  },
  drift: 'suggest',
  gestures: defaultGestureConfigs(),
  calibration: null,
};

export const VOICE_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'en-US', label: 'English (United States)' },
  { code: 'en-GB', label: 'English (United Kingdom)' },
  { code: 'en-IN', label: 'English (India)' },
  { code: 'en-AU', label: 'English (Australia)' },
];

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge stored values over defaults. Only keys that exist in the defaults and
 * have the same primitive type survive, so stale or malformed storage can
 * never produce an invalid settings object.
 */
function mergeKnown<T>(defaults: T, stored: unknown): T {
  if (!isPlain(defaults) || !isPlain(stored)) return defaults;
  const out: Plain = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const base = (defaults as Plain)[key];
    const value = stored[key];
    if (value === undefined) continue;
    if (isPlain(base)) out[key] = mergeKnown(base, value);
    else if (base === null || typeof base === typeof value) out[key] = value;
  }
  return out as T;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

function sanitizeGesture(id: string, stored: unknown): GestureConfig {
  const def = gestureDef(id)!;
  const merged = mergeKnown(def.defaults, stored);
  const threshold = clamp(merged.threshold, 0.05, 1);
  return {
    enabled: merged.enabled,
    threshold,
    releaseThreshold: clamp(merged.releaseThreshold, 0, threshold),
    minDurationMs: clamp(merged.minDurationMs, 0, 5000),
    cooldownMs: clamp(merged.cooldownMs, 0, 10000),
    action: isActionId(merged.action) ? merged.action : def.defaults.action,
  };
}

function isAxis(value: unknown): boolean {
  return (
    isPlain(value) &&
    ['neutral', 'pos', 'neg'].every((k) => typeof value[k] === 'number' && Number.isFinite(value[k] as number))
  );
}

function sanitizeCalibration(stored: unknown): HeadCalibration | null {
  if (!isPlain(stored)) return null;
  for (const source of ['pose', 'position']) {
    const s = stored[source];
    if (!isPlain(s) || !isAxis(s.x) || !isAxis(s.y)) return null;
  }
  if (typeof stored.quality !== 'number' || typeof stored.createdAt !== 'number') return null;
  const out = { ...(stored as unknown as HeadCalibration) };
  // A malformed fitted model is dropped; the per-axis ranges still work without it.
  const fit = isPlain(stored.fit) ? stored.fit : null;
  out.fit = fit
    ? { pose: isPolyFit(fit.pose) ? fit.pose : undefined, position: isPolyFit(fit.position) ? fit.position : undefined }
    : undefined;
  if (!out.fit) delete out.fit;
  if (typeof out.error !== 'number' || !Number.isFinite(out.error)) delete out.error;
  return out;
}

export function sanitizeSettings(stored: unknown): Settings {
  const s = mergeKnown(DEFAULT_SETTINGS, stored);
  const raw = isPlain(stored) ? stored : {};
  const gestures: Record<string, GestureConfig> = {};
  const storedGestures = isPlain(raw.gestures) ? raw.gestures : {};
  for (const id of Object.keys(DEFAULT_SETTINGS.gestures)) gestures[id] = sanitizeGesture(id, storedGestures[id]);

  return {
    ...s,
    version: 1,
    theme: oneOf(s.theme, ['dark', 'light', 'system'], 'dark'),
    textScale: clamp(s.textScale, 0.85, 1.6),
    controlMode: oneOf(s.controlMode, ['head', 'hand', 'hybrid', 'voice'], 'head'),
    hybridPolicy: oneOf(s.hybridPolicy, ['explicit', 'handPriority'], 'explicit'),
    camera: {
      deviceId: typeof raw.camera === 'object' && isPlain(raw.camera) && typeof raw.camera.deviceId === 'string'
        ? raw.camera.deviceId
        : null,
      maxFps: clamp(s.camera.maxFps, 10, 60),
      delegate: oneOf(s.camera.delegate, ['GPU', 'CPU'], 'GPU'),
    },
    cursor: {
      ...s.cursor,
      size: clamp(s.cursor.size, 12, 96),
      color: /^#[0-9a-f]{6}$/i.test(s.cursor.color) ? s.cursor.color : DEFAULT_SETTINGS.cursor.color,
      sensitivity: clamp(s.cursor.sensitivity, 0.3, 3),
      smoothing: clamp(s.cursor.smoothing, 0, 1),
      deadZone: clamp(s.cursor.deadZone, 0, 0.05),
      acceleration: clamp(s.cursor.acceleration, 0, 1),
      dynamics: oneOf(s.cursor.dynamics, ['absolute', 'relative'], 'absolute'),
      headSource: oneOf(s.cursor.headSource, ['pose', 'position'], 'pose'),
      handAnchor: oneOf(s.cursor.handAnchor, ['knuckle', 'indexTip', 'palm'], 'knuckle'),
      handArea: clamp(s.cursor.handArea, 0.3, 0.95),
      handCenterX: clamp(s.cursor.handCenterX, 0.2, 0.8),
      handCenterY: clamp(s.cursor.handCenterY, 0.2, 0.8),
    },
    click: {
      ...s.click,
      dwellMs: clamp(s.click.dwellMs, 400, 4000),
      dwellRadiusPx: clamp(s.click.dwellRadiusPx, 10, 120),
      confirmPolicy: oneOf(s.click.confirmPolicy, ['never', 'risky', 'always'], 'risky'),
      scrollStepRatio: clamp(s.click.scrollStepRatio, 0.2, 1),
    },
    safety: {
      graceMs: clamp(s.safety.graceMs, 1000, 10000),
      autoPauseMs: clamp(s.safety.autoPauseMs, 1500, 30000),
      settleMs: clamp(s.safety.settleMs, 100, 2000),
      resumeAfterLoss: oneOf(s.safety.resumeAfterLoss, ['auto', 'manual'], 'auto'),
    },
    voice: {
      lang: typeof s.voice.lang === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(s.voice.lang) ? s.voice.lang : 'en-US',
      mode: oneOf(s.voice.mode, ['always', 'wake', 'push'], 'always'),
      wakeWord: (s.voice.wakeWord || 'computer').toLowerCase().replace(/[^a-z ]/g, '').trim() || 'computer',
      minConfidence: clamp(s.voice.minConfidence, 0, 0.95),
      host: oneOf(s.voice.host, ['offscreen', 'dashboard'], 'offscreen'),
    },
    hints: { maxLabels: clamp(Math.round(s.hints.maxLabels), 10, 400), autoInVoiceMode: s.hints.autoInVoiceMode },
    drift: oneOf(s.drift, ['off', 'suggest', 'auto'], 'suggest'),
    gestures,
    calibration: sanitizeCalibration(raw.calibration),
  };
}

/** Recursive partial used for settings patches. */
export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export function applyPatch(current: Settings, patch: DeepPartial<Settings>): Settings {
  const merge = (base: unknown, change: unknown): unknown => {
    if (!isPlain(base) || !isPlain(change)) return change === undefined ? base : change;
    const out: Plain = { ...base };
    for (const key of Object.keys(change)) out[key] = merge(base[key], change[key]);
    return out;
  };
  return sanitizeSettings(merge(current, patch));
}

export function needsFaceModel(s: Settings): boolean {
  return s.controlMode === 'head' || s.controlMode === 'hybrid' || s.features.faceGestures;
}

export function needsHandModel(s: Settings): boolean {
  return s.controlMode === 'hand' || s.controlMode === 'hybrid' || s.features.handGestures;
}

export function needsCamera(s: Settings): boolean {
  return needsFaceModel(s) || needsHandModel(s);
}
