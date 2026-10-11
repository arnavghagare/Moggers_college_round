/** Shared data types used across the engine, the page agent and the dashboard. */

export interface Point {
  x: number;
  y: number;
}

export interface Landmark {
  x: number;
  y: number;
  z: number;
}

/** Which input drives the pointer. */
export type ControlMode = 'head' | 'hand' | 'hybrid' | 'voice';
export type CursorSource = 'head' | 'hand' | 'none';
export type Handedness = 'Left' | 'Right';

export type Phase =
  /** Models / camera still starting. No interaction possible. */
  | 'loading'
  /** Startup grace period: the cursor moves but nothing can be activated. */
  | 'grace'
  | 'active'
  /** Paused by the user. */
  | 'paused'
  /** Paused automatically after sustained loss of tracking. */
  | 'suspended'
  | 'error';

/** Why Handsfree is paused right after it is switched on with voice available: it waits to be told to begin. */
export const AWAITING_START = 'Waiting for you to say "start"';

export type Quality = 'good' | 'fair' | 'poor' | 'lost' | 'off';

export interface AxisCalibration {
  /** Signal value at the neutral (centre) position. */
  neutral: number;
  /** Signal value when pointing at the right / bottom edge. */
  pos: number;
  /** Signal value when pointing at the left / top edge. */
  neg: number;
}

export interface SourceCalibration {
  x: AxisCalibration;
  y: AxisCalibration;
}

/** Fitted polynomial mapping; see core/cursor/polyFit.ts. */
export interface PolyFitData {
  neutral: [number, number];
  scale: [number, number];
  cx: number[];
  cy: number[];
}

export interface HeadCalibration {
  /** Head rotation (yaw / pitch in degrees). */
  pose: SourceCalibration;
  /** Nose position in the mirrored camera image (0..1). */
  position: SourceCalibration;
  /** Polynomial fit from the 9-point calibration, per pointer source. Preferred over the per-axis ranges. */
  fit?: { pose?: PolyFitData; position?: PolyFitData };
  /** Measured leave-one-out pointing error, as a fraction of the screen. */
  error?: number;
  /** 0..1, derived from sample noise relative to the measured range. */
  quality: number;
  createdAt: number;
}

export interface FingerStates {
  thumb: boolean;
  index: boolean;
  middle: boolean;
  ring: boolean;
  pinky: boolean;
}

export interface HandStatus {
  handedness: Handedness;
  /** Handedness classification score reported by the model. */
  score: number;
  /** Stable (debounced) gesture currently held, if any. */
  pose: string | null;
  poseConfidence: number;
  /** Best raw candidate in the current frame, before debouncing. */
  candidate: string | null;
  candidateConfidence: number;
  fingers: FingerStates;
  extension: [number, number, number, number, number];
  pinchDistance: number;
  palm: Point;
  rollDeg: number;
  palmFacing: 'camera' | 'away' | 'side';
  speed: number;
  direction: 'left' | 'right' | 'up' | 'down' | 'still';
  /** Positive when the hand appears to be approaching the camera (inferred from apparent size). */
  depthTrend: number;
  stable: boolean;
}

export interface GestureLogEntry {
  id: string;
  name: string;
  t: number;
  confidence: number;
  action: string;
  executed: boolean;
  reason?: string;
}

export type VoiceResultStatus =
  | 'executed'
  | 'rejected'
  | 'ambiguous'
  | 'unknown'
  | 'blocked'
  | 'pending'
  | 'dictated';

export interface VoiceStatus {
  supported: boolean;
  /** `reconnecting`: the recogniser dropped out and is being restarted; nothing is heard meanwhile. */
  state: 'off' | 'starting' | 'listening' | 'muted' | 'reconnecting' | 'error';
  mode: 'always' | 'wake' | 'push';
  error: string | null;
  recovery: string | null;
  interim: string;
  lastPhrase: string;
  lastIntent: string | null;
  /** The value the parser extracted from the last phrase (search query, site, text to type), if any. */
  lastPayload: string;
  lastConfidence: number | null;
  lastStatus: VoiceResultStatus | null;
  lastMessage: string;
  /** The last spoken command that was actually carried out. */
  lastExecuted: string;
  /** What the browser reported back about the most recent command, when it had something to say. */
  lastNote: string;
  micState: 'off' | 'on' | 'denied' | 'notfound' | 'error';
  micLevel: number;
  noiseFloor: number;
  noisy: boolean;
  dictating: boolean;
  host: 'offscreen' | 'dashboard';
}

export interface CalibrationStatus {
  active: boolean;
  step: string | null;
  stepIndex: number;
  totalSteps: number;
  phase: 'idle' | 'prepare' | 'collect' | 'done' | 'failed';
  progress: number;
  message: string;
  quality: number | null;
  /** Measured pointing error of the finished calibration, as a fraction of the screen. */
  accuracy: number | null;
  elapsedMs: number;
}

export interface PendingConfirmation {
  id: string;
  prompt: string;
  remainingMs: number;
}

export interface SessionStats {
  clicks: number;
  canceledClicks: number;
  dwellStarts: number;
  failedCommands: number;
  executedCommands: number;
  recoveries: number;
  autoPauses: number;
  confirmationsRequested: number;
  confirmationsCanceled: number;
}

export interface EngineStatus {
  t: number;
  phase: Phase;
  pausedReason: string | null;
  graceRemainingMs: number;
  error: { code: string; message: string; recovery: string } | null;
  controlMode: ControlMode;
  cursorSource: CursorSource;
  camera: {
    state: 'off' | 'starting' | 'on' | 'denied' | 'notfound' | 'error';
    label: string;
    width: number;
    height: number;
  };
  models: {
    face: 'off' | 'loading' | 'ready' | 'error';
    hand: 'off' | 'loading' | 'ready' | 'error';
    delegate: string;
  };
  perf: {
    fps: number;
    faceMs: number;
    handMs: number;
    frameMs: number;
    degraded: boolean;
    handEvery: number;
    droppedFrames: number;
  };
  face: {
    present: boolean;
    quality: Quality;
    lostMs: number;
    lossRate: number;
    jitter: number;
    yaw: number;
    pitch: number;
    roll: number;
    poseSource: 'matrix' | 'landmarks' | 'none';
    signals: { blinkLeft: number; blinkRight: number; jawOpen: number; smile: number; browUp: number };
  };
  hands: HandStatus[];
  handQuality: Quality;
  lighting: { luma: number; contrast: number; rating: 'ok' | 'dim' | 'dark' | 'bright' | 'unknown'; advice: string };
  cursor: { x: number; y: number; settling: boolean; dragging: boolean; frozen: boolean };
  lastGesture: GestureLogEntry | null;
  gestureLog: GestureLogEntry[];
  voice: VoiceStatus;
  page: { controllable: boolean; reason: string; tabId: number | null; agents: number };
  calibration: CalibrationStatus;
  calibrated: boolean;
  postureShifted: boolean;
  pending: PendingConfirmation | null;
  hintsShown: boolean;
  stats: SessionStats;
}

/** One frame of raw tracking data, streamed to the Lab view on request. */
export interface DiagFrame {
  t: number;
  /** Mirrored, normalized face landmarks (478 points) or null. */
  face: Array<[number, number]> | null;
  hands: Array<{ handedness: Handedness; points: Array<[number, number]> }>;
}
