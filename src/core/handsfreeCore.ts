import { ACTIONS, actionLabel, type ActionId, type ActionParams } from '../shared/actions';
import type {
  AgentToEngine,
  BrowserCommand,
  HudState,
  PageAction,
  PageActionParams,
  SpeechEvent,
} from '../shared/messages';
import { needsFaceModel, type DeepPartial, type Settings } from '../shared/settings';
import type {
  CalibrationStatus,
  ControlMode,
  CursorSource,
  EngineStatus,
  GestureLogEntry,
  HandStatus,
  HeadCalibration,
  Point,
  Quality,
  SessionStats,
  VoiceStatus,
} from '../shared/types';
import { CalibrationSession, IDLE_CALIBRATION } from './calibration';
import { defaultCalibration, headOffset, nudgeCalibration, recenterCalibration, type HeadSample } from './cursor/headMapper';
import { CursorController, PointerPipeline, handOffset, type PointerConfig } from './cursor/pointer';
import { HeadPoseEstimator, JitterMeter, type FaceFeatures, type FaceObservation } from './face/pose';
import { FaceGestureEngine } from './gestures/faceGestureEngine';
import { HandGestureEngine, toHandStatus, type GestureEvent, type TrackedHand } from './gestures/handGestureEngine';
import { gestureDef, gestureName } from './gestures/registry';
import type { HandObservation } from './hand/features';
import { ramp } from './math';
import { SafetyController } from './safety';
import { PresenceMonitor, rateFaceQuality, rateHandQuality } from './tracking';
import { applySpokenPunctuation, DictationSession } from './voice/dictation';
import { parseAlternatives, tidySpokenEmail } from './voice/parser';
import { resolveSite } from './voice/sites';

export type ActionOrigin = 'gesture' | 'voice' | 'ui' | 'keyboard' | 'confirmed';

export interface ExecuteResult {
  status: 'executed' | 'blocked' | 'pending';
  message: string;
}

/** Everything the core needs from the outside world. */
export interface CoreSink {
  cursor(x: number, y: number, show: boolean, ok: boolean): void;
  page(action: PageAction, params?: PageActionParams): void;
  browser(cmd: BrowserCommand, args?: { number?: number; text?: string }): void;
  patchSettings(patch: DeepPartial<Settings>): void;
  setListening(on: boolean): void;
  exit(): void;
}

export interface FrameInput {
  /** `undefined` = the face model did not run this frame; `null` = it ran and found no face. */
  face: FaceObservation | null | undefined;
  /** `undefined` = the hand model did not run this frame. */
  hands: HandObservation[] | undefined;
  /** Image width / height. */
  aspect: number;
}

interface Pending {
  id: string;
  prompt: string;
  expiresAt: number;
  confirm: () => void;
  cancel: () => void;
}

interface ScrollHold {
  origin: Point;
  lastT: number;
}

const CONFIRM_TIMEOUT_MS = 10000;
const PUSH_TO_TALK_MS = 8000;
/** Microphone noise floor (RMS, 0..1) above which the room counts as noisy. */
const NOISY_FLOOR = 0.045;
const HYBRID_HAND_ON_MS = 300;
const HYBRID_HAND_OFF_MS = 900;
const DRIFT_TAU_MS = 15000;
const DRIFT_LIMIT = 0.4;
const DRIFT_HOLD_MS = 15000;

/**
 * Actions that fire wherever the cursor happens to be. During the warm-up
 * after "start" the cursor has not settled, so these stay locked even when spoken.
 */
const POINTER_ACTIONS: ReadonlySet<ActionId> = new Set<ActionId>(['click', 'double_click', 'right_click', 'drag_start', 'drag']);

const SPEECH_ERRORS: Record<string, { message: string; recovery: string; fatal: boolean }> = {
  'not-allowed': {
    message: 'Microphone access is blocked.',
    recovery: 'Allow the microphone for Handsfree in the dashboard, then turn voice back on.',
    fatal: true,
  },
  'service-not-allowed': {
    message: 'This browser does not allow speech recognition here.',
    recovery: 'Open the dashboard and switch the voice host to "Dashboard tab" in Voice settings.',
    fatal: true,
  },
  'audio-capture': {
    message: 'No microphone was found.',
    recovery: 'Connect a microphone and turn voice back on.',
    fatal: true,
  },
  network: {
    message: 'Speech recognition could not reach its service.',
    recovery: "Chrome's built-in speech recognition needs an internet connection. Check your connection.",
    fatal: false,
  },
  'language-not-supported': {
    message: 'The selected language is not supported by speech recognition.',
    recovery: 'Choose another language in Voice settings.',
    fatal: true,
  },
  unsupported: {
    message: 'Speech recognition is not available in this browser.',
    recovery: 'Use Chrome or Edge on desktop, or control Handsfree with gestures and dwell clicking.',
    fatal: true,
  },
};

const emptyStats = (): SessionStats => ({
  clicks: 0,
  canceledClicks: 0,
  dwellStarts: 0,
  failedCommands: 0,
  executedCommands: 0,
  recoveries: 0,
  autoPauses: 0,
  confirmationsRequested: 0,
  confirmationsCanceled: 0,
});

const pointerConfig = (s: Settings): PointerConfig => ({
  sensitivity: s.cursor.sensitivity,
  smoothing: s.cursor.smoothing,
  deadZone: s.cursor.deadZone,
  acceleration: s.cursor.acceleration,
  dynamics: s.cursor.dynamics,
});

/**
 * The Handsfree state machine, free of browser APIs so it can be driven by
 * mocked landmarks and transcripts in tests.
 *
 * Inputs: tracking frames, speech events, page-agent messages, UI actions.
 * Outputs (through the sink): cursor positions, page actions, browser
 * commands. Every action, whatever its origin, goes through `execute()` and
 * therefore through the safety controller.
 */
export class HandsfreeCore {
  private settings: Settings;
  private readonly safety: SafetyController;
  private readonly handEngine: HandGestureEngine;
  private readonly faceEngine: FaceGestureEngine;
  private readonly poseEstimator = new HeadPoseEstimator();
  private readonly jitter = new JitterMeter();
  private readonly facePresence = new PresenceMonitor();
  private readonly handPresence = new PresenceMonitor();
  private readonly headPipeline: PointerPipeline;
  private readonly handPipeline: PointerPipeline;
  private readonly cursor = new CursorController();
  private readonly dictation = new DictationSession();

  private cal: HeadCalibration | null = null;
  private calStamp: number | null = null;
  private calSession: CalibrationSession | null = null;
  private calStatus: CalibrationStatus = IDLE_CALIBRATION;

  private source: CursorSource = 'none';
  private hybridSource: 'head' | 'hand' = 'head';
  private handSeenSince: number | null = null;
  private handGoneSince: number | null = null;

  private face: FaceFeatures | null = null;
  private faceWasLost = true;
  private hands: TrackedHand[] = [];
  private steeringHand: 'Left' | 'Right' | null = null;
  private wasSteering = false;
  private cursorFrozen = false;
  private sourceTracked = false;

  private dragging = false;
  private hintsShown = false;
  /** Voice mode keeps numbers on screen until the user hides them. */
  private hintsWanted = true;
  private readonly scrollHolds = new Map<string, ScrollHold>();
  private pending: Pending | null = null;
  private pendingSeq = 0;

  private drift: Point = { x: 0, y: 0 };
  private driftSince: number | null = null;
  private driftT = 0;
  private postureShifted = false;

  private listening = false;
  private voiceStarted = false;
  private muted = false;
  private pushUntil = 0;
  private voiceFatal = false;
  /** Recognition results already acted on, so a result delivered twice runs once. */
  private readonly handledResults = new Set<string>();
  private readonly voice: VoiceStatus;

  private notice = '';
  private noticeUntil = 0;
  private gestureLog: GestureLogEntry[] = [];
  private stats = emptyStats();
  private agentCount = 0;
  private now = 0;

  constructor(
    settings: Settings,
    private readonly sink: CoreSink,
  ) {
    this.settings = settings;
    // With voice available, hearing and acting are separate: Handsfree listens
    // straight away but does nothing until it is told to start.
    this.safety = new SafetyController(settings.safety, !settings.features.voice);
    this.handEngine = new HandGestureEngine(settings.gestures);
    this.faceEngine = new FaceGestureEngine(settings.gestures);
    this.headPipeline = new PointerPipeline(pointerConfig(settings));
    this.handPipeline = new PointerPipeline(pointerConfig(settings));
    this.voice = {
      supported: true,
      state: 'off',
      mode: settings.voice.mode,
      error: null,
      recovery: null,
      interim: '',
      lastPhrase: '',
      lastIntent: null,
      lastPayload: '',
      lastConfidence: null,
      lastStatus: null,
      lastMessage: '',
      lastExecuted: '',
      lastNote: '',
      micState: 'off',
      micLevel: 0,
      noiseFloor: 0,
      noisy: false,
      dictating: false,
      host: settings.voice.host,
    };
    this.loadCalibration();
  }

  // ---- configuration --------------------------------------------------------

  configure(settings: Settings, t: number): void {
    const prev = this.settings;
    this.settings = settings;
    this.safety.configure(settings.safety);
    this.handEngine.setConfig(settings.gestures);
    this.faceEngine.setConfig(settings.gestures);
    this.headPipeline.configure(pointerConfig(settings));
    this.handPipeline.configure(pointerConfig(settings));
    this.voice.mode = settings.voice.mode;
    this.voice.host = settings.voice.host;

    if ((settings.calibration?.createdAt ?? null) !== this.calStamp) this.loadCalibration();
    if (prev.controlMode !== settings.controlMode) {
      this.hybridSource = 'head';
      this.hintsWanted = true;
      this.releaseHeld(t, 'mode changed');
      this.say(`Control mode: ${modeLabel(settings.controlMode)}`);
    }
    if (prev.voice.host !== settings.voice.host || prev.voice.lang !== settings.voice.lang) {
      this.voiceFatal = false;
    }
    if (!settings.features.voice && this.dictation.active) this.dictation.stop();
    if (!settings.features.faceGestures) this.faceEngine.reset();
    // Voice was switched off while Handsfree was still waiting to hear "start": nobody can say it now.
    if (!settings.features.voice && this.safety.awaitingStart) this.safety.resume(t);
    const reach = (s: Settings): string => `${s.cursor.handCenterX}|${s.cursor.handCenterY}|${s.cursor.handArea}|${s.cursor.handAnchor}`;
    if (reach(prev) !== reach(settings)) {
      // A new reach (for example after calibrating) moves where the hand points: glide there, never jump.
      this.handPipeline.reset();
      this.handPipeline.syncTo(this.cursor.position);
      this.cursor.beginGlide();
    }
    this.syncListening(t);
  }

  private loadCalibration(): void {
    this.cal = this.settings.calibration;
    this.calStamp = this.settings.calibration?.createdAt ?? null;
    this.resetDrift();
  }

  // ---- lifecycle --------------------------------------------------------------

  /** Camera and models are ready (or not needed): start the grace period. */
  ready(t: number): void {
    this.now = t;
    this.safety.start(t);
    this.startVoice(t);
  }

  /**
   * Allow voice to run. Separate from `ready()` so that voice still works when
   * the camera fails: the user can then say "use voice only".
   */
  startVoice(t: number): void {
    this.voiceStarted = true;
    this.syncListening(t);
  }

  setLoading(): void {
    this.safety.setLoading();
  }

  setError(reason: string): void {
    this.safety.setError(reason);
  }

  /** Release everything that is being held. Called on shutdown, pause and tracking loss. */
  private releaseHeld(_t: number, _why: string): void {
    if (this.dragging) {
      this.dragging = false;
      this.sink.page('dragCancel');
    }
    this.scrollHolds.clear();
    this.sink.page('stopScroll');
    this.sink.page('cancelClick');
  }

  shutdown(t: number): void {
    this.releaseHeld(t, 'shutdown');
    this.cancelPending('shutdown');
    this.dictation.stop();
    this.listening = false;
    this.sink.setListening(false);
  }

  // ---- frames -----------------------------------------------------------------

  frame(t: number, input: FrameInput): void {
    this.now = t;

    if (input.face !== undefined) {
      this.facePresence.push(t, input.face !== null);
      if (input.face) {
        this.face = this.poseEstimator.update(input.face, input.aspect, t);
        this.jitter.push(this.face.nose);
      } else {
        this.face = null;
      }
    }

    if (input.hands !== undefined) {
      const result = this.handEngine.update(t, input.hands, input.aspect, { handSteering: this.source === 'hand' });
      this.hands = result.hands;
      this.handPresence.push(t, result.hands.length > 0);
      for (const ev of result.events) this.onGesture(ev, t);
    }

    this.updateCalibration(t);

    if (this.settings.features.faceGestures && input.face !== undefined && !this.calSession?.active) {
      for (const ev of this.faceEngine.update(t, this.face?.signals ?? null)) this.onGesture(ev, t);
    }

    this.updateSource(t);
    this.updateCursor(t);
    this.updateScrollHolds(t);
    this.tick(t);
    this.emitCursor(t);
  }

  /** Time-based housekeeping. Called from `frame()`, or on a timer in voice-only mode. */
  tick(t: number): void {
    this.now = t;
    // Voice mode has no camera frames, so the cursor source must be kept current here too.
    this.updateSource(t);
    const voiceOnly = this.source === 'none';
    const event = this.safety.tick(t, voiceOnly || this.trackingHealthy());
    if (event === 'auto-paused') {
      this.stats.autoPauses += 1;
      this.releaseHeld(t, 'tracking lost');
      this.dictation.stop();
      this.say('Paused: tracking was lost. Move back into view to continue.', 'warn');
    } else if (event === 'recovered') {
      this.stats.recoveries += 1;
      this.say('Tracking is back. Resuming...', 'ok');
    } else if (event === 'grace-ended') {
      // Without a user calibration, take the settled pose as neutral.
      if (!this.settings.calibration && this.face && this.cal) {
        this.cal = recenterCalibration(this.cal, this.sample(this.face));
        this.headPipeline.reset();
        this.cursor.beginGlide();
      }
    }

    if (this.pending && t >= this.pending.expiresAt) this.cancelPending('timed out');
    if (this.settings.voice.mode === 'push' && this.listening && t >= this.pushUntil) this.syncListening(t);
    if (this.notice && t >= this.noticeUntil) this.notice = '';
  }

  /** Whether the input driving the cursor is healthy enough to keep running. */
  private trackingHealthy(): boolean {
    switch (this.source) {
      case 'head':
        return this.face !== null || (this.settings.controlMode === 'hybrid' && this.hands.length > 0);
      // A hand leaving the frame is normal use, not a tracking failure.
      case 'hand':
        return true;
      default:
        return true;
    }
  }

  private sample(face: FaceFeatures): HeadSample {
    return { yaw: face.pose.yaw, pitch: face.pose.pitch, x: face.nose.x, y: face.nose.y };
  }

  private updateSource(t: number): void {
    const mode = this.settings.controlMode;
    let next: CursorSource;
    if (mode === 'head') next = 'head';
    else if (mode === 'hand') next = 'hand';
    else if (mode === 'voice') next = 'none';
    else {
      if (this.settings.hybridPolicy === 'handPriority') {
        const steering = this.findSteeringHand() !== null;
        if (steering) {
          this.handGoneSince = null;
          this.handSeenSince ??= t;
          if (t - this.handSeenSince >= HYBRID_HAND_ON_MS) this.hybridSource = 'hand';
        } else {
          this.handSeenSince = null;
          this.handGoneSince ??= t;
          if (t - this.handGoneSince >= HYBRID_HAND_OFF_MS) this.hybridSource = 'head';
        }
      }
      next = this.hybridSource;
    }
    if (next === this.source) return;
    this.source = next;
    // Never jump when the driving input changes: restart filters and glide.
    this.headPipeline.reset();
    this.handPipeline.reset();
    this.headPipeline.syncTo(this.cursor.position);
    this.handPipeline.syncTo(this.cursor.position);
    this.faceWasLost = true;
    this.wasSteering = false;
    this.cursor.beginGlide();
    this.releaseHeld(t, 'source changed');
  }

  /** The hand whose stable pose is mapped to "move the cursor". */
  private findSteeringHand(): TrackedHand | null {
    // The pose must also hold in the current frame: while a pose is merely
    // being debounced on its way out, the cursor freezes rather than follow.
    const steers = (h: TrackedHand): boolean => {
      if (h.pose === null) return false;
      const cfg = this.settings.gestures[h.pose];
      return cfg?.action === 'move_cursor' && h.scores[h.pose] >= cfg.releaseThreshold;
    };
    const current = this.hands.find((h) => h.features.handedness === this.steeringHand);
    if (current && steers(current)) return current;
    return this.hands.find(steers) ?? null;
  }

  private updateCursor(t: number): void {
    this.cursorFrozen = false;
    this.sourceTracked = false;

    if (!this.safety.cursorLive || this.calSession?.active) {
      this.cursor.hold(t);
      // Coming back from a pause must not replay stale filter state.
      this.faceWasLost = true;
      this.wasSteering = false;
      return;
    }

    if (this.source === 'head') {
      if (!this.face) {
        this.faceWasLost = true;
        this.cursor.hold(t);
        return;
      }
      const sample = this.sample(this.face);
      if (!this.cal) this.cal = defaultCalibration(sample);
      if (this.faceWasLost) {
        // Tracking (re)acquired: start filters fresh, hold, then glide.
        this.faceWasLost = false;
        this.headPipeline.reset();
        this.headPipeline.syncTo(this.cursor.position);
        this.cursor.beginSettle(t, this.settings.safety.settleMs);
      }
      const offset = headOffset(sample, this.cal, {
        source: this.settings.cursor.headSource,
        invertX: this.settings.cursor.invertX,
        invertY: this.settings.cursor.invertY,
      });
      this.updateDrift(t, offset);
      const target = this.headPipeline.update(offset.x, offset.y, t);
      this.cursor.follow(target, t);
      this.sourceTracked = !this.cursor.isSettling(t);
      return;
    }

    if (this.source === 'hand') {
      const hand = this.findSteeringHand();
      // A pinch freezes the cursor so the click lands where the user aimed,
      // except during a drag, where the cursor has to follow the hand.
      const dragHand = this.dragging ? this.hands.find((h) => h.pinchHeld) : undefined;
      const active = hand ?? dragHand ?? null;
      if (!active) {
        this.steeringHand = null;
        this.wasSteering = false;
        this.cursorFrozen = this.hands.length > 0;
        this.cursor.hold(t);
        return;
      }
      this.steeringHand = active.features.handedness;
      if (!this.wasSteering) {
        this.wasSteering = true;
        this.handPipeline.reset();
        this.handPipeline.syncTo(this.cursor.position);
        this.cursor.beginGlide();
      }
      const f = active.features;
      const anchor =
        this.settings.cursor.handAnchor === 'indexTip'
          ? f.indexTip
          : this.settings.cursor.handAnchor === 'palm'
            ? f.palmCenter
            : f.indexKnuckle;
      const offset = handOffset(anchor, this.settings.cursor.handArea, {
        x: this.settings.cursor.handCenterX,
        y: this.settings.cursor.handCenterY,
      });
      const target = this.handPipeline.update(offset.x, offset.y, t);
      this.cursor.follow(target, t);
      this.sourceTracked = hand !== null;
      return;
    }

    this.cursor.hold(t);
  }

  private emitCursor(t: number): void {
    const show = this.source !== 'none' && !this.calSession?.active;
    const ok =
      show &&
      this.safety.interactive &&
      this.sourceTracked &&
      !this.cursorFrozen &&
      !this.dragging &&
      !this.cursor.isSettling(t);
    const p = this.cursor.position;
    this.sink.cursor(p.x, p.y, show, ok);
  }

  // ---- posture drift ------------------------------------------------------------

  private resetDrift(): void {
    this.drift = { x: 0, y: 0 };
    this.driftSince = null;
    this.driftT = 0;
    this.postureShifted = false;
  }

  /**
   * Track the long-run average pointer offset. A resting position that stays
   * far from neutral suggests the user's posture has changed.
   */
  private updateDrift(t: number, offset: Point): void {
    if (this.settings.drift === 'off') {
      this.postureShifted = false;
      return;
    }
    const dt = this.driftT > 0 ? Math.min(500, t - this.driftT) : 0;
    this.driftT = t;
    const k = dt / DRIFT_TAU_MS;
    this.drift = { x: this.drift.x + (offset.x - this.drift.x) * k, y: this.drift.y + (offset.y - this.drift.y) * k };
    const magnitude = Math.hypot(this.drift.x, this.drift.y);
    if (magnitude < DRIFT_LIMIT) {
      this.driftSince = null;
      this.postureShifted = false;
      return;
    }
    this.driftSince ??= t;
    if (t - this.driftSince < DRIFT_HOLD_MS) return;
    this.postureShifted = true;
    if (this.settings.drift === 'auto' && this.cal && dt > 0) {
      // Conservative correction: at most 2% of the range per second, toward the
      // long-run average. The pointer moves no faster than a slow drift.
      const step = Math.min(1, (0.02 * dt) / 1000 / magnitude);
      const du = this.drift.x * step;
      const dv = this.drift.y * step;
      this.cal = nudgeCalibration(this.cal, this.settings.cursor.headSource, du, dv);
      this.drift = { x: this.drift.x - du, y: this.drift.y - dv };
    }
  }

  // ---- calibration ----------------------------------------------------------------

  startCalibration(t: number): ExecuteResult {
    if (!needsFaceModel(this.settings)) {
      return this.blocked('Calibration is for head control. Switch to head control first.');
    }
    this.releaseHeld(t, 'calibration');
    this.calSession = new CalibrationSession(t);
    this.calStatus = this.calSession.status(t);
    return { status: 'executed', message: 'Calibration started' };
  }

  cancelCalibration(t: number): void {
    if (!this.calSession) return;
    this.calSession.cancel(t);
    this.calStatus = this.calSession.status(t);
    this.calSession = null;
  }

  private updateCalibration(t: number): void {
    const session = this.calSession;
    if (!session) return;
    session.update(t, this.face ? this.sample(this.face) : null);
    this.calStatus = session.status(t);
    if (session.active) return;
    this.calSession = null;
    const result = session.result;
    if (result) {
      this.cal = result;
      this.calStamp = result.createdAt;
      this.resetDrift();
      this.sink.patchSettings({ calibration: result });
      this.headPipeline.reset();
      this.faceWasLost = true;
    }
  }

  // ---- gestures -------------------------------------------------------------------

  private onGesture(ev: GestureEvent, t: number): void {
    const cfg = this.settings.gestures[ev.id];
    const def = gestureDef(ev.id);
    if (!cfg || !def || !cfg.enabled) return;
    const action = cfg.action;
    const kind = ACTIONS[action].kind;
    const steeringOnly = action === 'move_cursor' || action === 'hold_cursor';

    // With hand gestures switched off, hands may still steer the cursor in hand mode.
    // Hand mode is built on gestures. In the other modes they are an optional extra.
    const handGestures = this.settings.controlMode === 'hand' || this.settings.features.handGestures;
    if (def.kind !== 'face' && !handGestures && !steeringOnly) return;
    if (this.calSession?.active && !steeringOnly) return;

    if (kind === 'hold') {
      if (ev.phase === 'start') {
        this.log(ev, action, true);
        this.beginHold(action, ev, t);
      } else if (ev.phase === 'end') {
        this.endHold(action, ev, t);
      }
      return;
    }

    if (ev.phase !== 'trigger') return;
    if (action === 'none') {
      this.log(ev, action, false, 'No action assigned');
      return;
    }
    const result = this.execute(action, {}, 'gesture', t);
    this.log(ev, action, result.status !== 'blocked', result.status === 'blocked' ? result.message : undefined);
  }

  private log(ev: GestureEvent, action: ActionId, executed: boolean, reason?: string): void {
    this.gestureLog.unshift({
      id: ev.id,
      name: gestureName(ev.id),
      t: ev.t,
      confidence: ev.confidence,
      action: actionLabel(action),
      executed,
      reason,
    });
    if (this.gestureLog.length > 12) this.gestureLog.length = 12;
  }

  private beginHold(action: ActionId, ev: GestureEvent, t: number): void {
    const key = `${ev.hand}:${action}`;
    if (action === 'drag') {
      this.execute('drag_start', {}, 'gesture', t);
    } else if (action === 'scroll') {
      if (!this.safety.check('scroll').allowed) return;
      const hand = this.hands.find((h) => h.features.handedness === ev.hand);
      if (hand) this.scrollHolds.set(key, { origin: { ...hand.features.palmCenter }, lastT: t });
    }
  }

  private endHold(action: ActionId, ev: GestureEvent, t: number): void {
    const key = `${ev.hand}:${action}`;
    if (action === 'drag') {
      if (!this.dragging) return;
      if (ev.aborted) {
        // The hand vanished mid-drag: cancel rather than drop somewhere unintended.
        this.dragging = false;
        this.sink.page('dragCancel');
        this.say('Drag cancelled: hand lost', 'warn');
      } else {
        this.execute('drag_end', {}, 'gesture', t);
      }
    } else if (action === 'scroll') {
      this.scrollHolds.delete(key);
    }
  }

  /** While a scroll gesture is held, hand displacement from where it began sets the scroll speed. */
  private updateScrollHolds(t: number): void {
    if (this.scrollHolds.size === 0) return;
    if (!this.safety.interactive) {
      this.scrollHolds.clear();
      return;
    }
    for (const [key, hold] of this.scrollHolds) {
      const handedness = key.split(':')[0];
      const hand = this.hands.find((h) => h.features.handedness === handedness);
      if (!hand) continue;
      const dt = Math.min(0.1, (t - hold.lastT) / 1000);
      hold.lastT = t;
      const ox = hand.features.palmCenter.x - hold.origin.x;
      const oy = hand.features.palmCenter.y - hold.origin.y;
      // Viewports per second: nothing inside the dead zone, then proportional.
      const speed = (o: number): number => Math.sign(o) * ramp(Math.abs(o), 0.03, 0.22) * 2.4;
      const dx = Math.abs(ox) > Math.abs(oy) * 1.5 ? speed(ox) * dt : 0;
      const dy = Math.abs(oy) >= Math.abs(ox) / 1.5 ? speed(oy) * dt : 0;
      if (dx !== 0 || dy !== 0) this.sink.page('scrollBy', { dx, dy });
    }
  }

  // ---- actions --------------------------------------------------------------------

  private blocked(message: string): ExecuteResult {
    return { status: 'blocked', message };
  }

  private done(message: string): ExecuteResult {
    return { status: 'executed', message };
  }

  private say(text: string, tone: 'info' | 'ok' | 'warn' = 'info'): void {
    this.notice = text;
    this.noticeUntil = this.now + 4000;
    this.sink.page('toast', { text, tone });
  }

  /** Feedback from outside the core (the browser refusing a command, for example). */
  notify(text: string, t: number): void {
    this.now = t;
    this.voice.lastNote = text;
    this.say(text, 'warn');
  }

  private setPending(prompt: string, confirm: () => void, cancel: () => void, id?: string): Pending {
    if (this.pending) this.cancelPending('replaced');
    const pending: Pending = {
      id: id ?? `p${++this.pendingSeq}`,
      prompt,
      expiresAt: this.now + CONFIRM_TIMEOUT_MS,
      confirm,
      cancel,
    };
    this.pending = pending;
    this.stats.confirmationsRequested += 1;
    return pending;
  }

  private cancelPending(_why: string): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.stats.confirmationsCanceled += 1;
    p.cancel();
  }

  /**
   * Run an action. This is the only path by which gestures, voice, the
   * dashboard and keyboard shortcuts cause anything to happen.
   */
  execute(action: ActionId, params: ActionParams, origin: ActionOrigin, t: number): ExecuteResult {
    this.now = t;
    const def = ACTIONS[action];
    const verdict = this.safety.check(action);
    if (!verdict.allowed) {
      // The warm-up lock exists so that a cursor or a gesture cannot fire before the user has
      // settled. A command said out loud right after "start" is no accident, so it goes through.
      const spokenInWarmUp = this.safety.phase === 'grace' && (origin === 'voice' || origin === 'confirmed') && !POINTER_ACTIONS.has(action);
      if (!spokenInWarmUp) return this.blocked(verdict.reason);
    }
    if (this.calSession?.active && !def.allowedWhilePaused) {
      return this.blocked('Calibration is running. Say "cancel" to stop it.');
    }

    if ('confirm' in def && def.confirm && origin !== 'ui' && origin !== 'confirmed') {
      this.setPending(
        `${def.label}?`,
        () => this.execute(action, params, 'confirmed', this.now),
        () => undefined,
      );
      return { status: 'pending', message: `${def.label}? Say "confirm" or "cancel".` };
    }

    const noPointer = this.source === 'none';
    switch (action) {
      case 'none':
      case 'move_cursor':
      case 'hold_cursor':
      case 'drag':
      case 'scroll':
        return this.done('');

      case 'click':
      case 'double_click':
      case 'right_click': {
        if (noPointer) return this.blocked('There is no cursor in voice-only mode. Say "show numbers" instead.');
        if (this.pending) return this.blocked('Answer the confirmation first: say "confirm" or "cancel".');
        const page: PageAction = action === 'click' ? 'click' : action === 'double_click' ? 'doubleClick' : 'rightClick';
        this.sink.page(page);
        return this.done(def.label);
      }
      case 'drag_start':
        if (noPointer) return this.blocked('There is no cursor in voice-only mode.');
        if (this.dragging) return this.blocked('Already dragging. Say "release" to drop.');
        this.dragging = true;
        this.sink.page('dragStart');
        return this.done('Dragging. Say "release" to drop.');
      case 'drag_end':
        if (!this.dragging) return this.blocked('Nothing is being dragged.');
        this.dragging = false;
        this.sink.page(this.safety.interactive ? 'dragEnd' : 'dragCancel');
        return this.done('Released');

      case 'scroll_up':
      case 'scroll_down': {
        const amount = this.settings.click.scrollStepRatio * (params.amount ?? 1);
        this.sink.page('scrollBy', { dx: 0, dy: action === 'scroll_down' ? amount : -amount });
        return this.done(def.label);
      }
      case 'scroll_top':
        this.sink.page('scrollTo', { to: 'top' });
        return this.done(def.label);
      case 'scroll_bottom':
        this.sink.page('scrollTo', { to: 'bottom' });
        return this.done(def.label);
      case 'scroll_auto_down':
      case 'scroll_auto_up':
        // Viewports per second: slow enough to read along.
        this.sink.page('autoScroll', { dy: action === 'scroll_auto_down' ? 0.3 : -0.3 });
        return this.done('Scrolling. Say "stop scrolling" to stop.');
      case 'scroll_stop':
        this.sink.page('stopScroll');
        return this.done(def.label);

      case 'open_site':
      case 'navigate_site': {
        const spoken = (params.text ?? '').trim();
        if (!spoken) return this.blocked('Say which site, for example "open youtube".');
        const site = resolveSite(spoken);
        if (!site) {
          // Not a known site and not shaped like an address: search instead of guessing a URL.
          this.sink.browser('search', { text: spoken });
          return this.done(`Searching for "${spoken}"`);
        }
        this.sink.browser(action === 'open_site' ? 'openUrl' : 'navigate', { text: site.url });
        return this.done(`Opening ${site.label}`);
      }
      case 'duplicate_tab':
        this.sink.browser('duplicateTab');
        return this.done(def.label);

      case 'media_play':
        this.sink.page('media', { media: 'play' });
        return this.done(def.label);
      case 'media_pause':
        this.sink.page('media', { media: 'pause' });
        return this.done(def.label);
      case 'media_toggle':
        this.sink.page('media', { media: 'toggle' });
        return this.done(def.label);
      case 'media_mute':
        this.sink.page('media', { media: 'mute' });
        return this.done(def.label);
      case 'media_unmute':
        this.sink.page('media', { media: 'unmute' });
        return this.done(def.label);

      case 'click_text':
        if (!params.text) return this.blocked('Say what to click, for example "click sign in".');
        if (this.pending) return this.blocked('Answer the confirmation first: say "confirm" or "cancel".');
        this.sink.page('clickText', { text: params.text });
        return this.done('');
      case 'show_help':
        this.sink.page('showHelp');
        return this.done('');
      case 'hide_help':
        this.sink.page('hideHelp');
        return this.done('');

      case 'go_back':
        this.sink.browser('back');
        return this.done('Going back. Say "go forward" to undo.');
      case 'go_forward':
        this.sink.browser('forward');
        return this.done('Going forward. Say "go back" to undo.');
      case 'reload':
        this.sink.browser('reload');
        return this.done(def.label);
      case 'new_tab':
        this.sink.browser('newTab');
        return this.done(def.label);
      case 'close_tab':
        this.sink.browser('closeTab');
        return this.done('Tab closed');
      case 'next_tab':
        this.sink.browser('nextTab');
        return this.done(def.label);
      case 'prev_tab':
        this.sink.browser('prevTab');
        return this.done(def.label);
      case 'switch_tab':
        if (!params.number || params.number < 1) return this.blocked('Say a tab number, for example "switch to tab 2".');
        this.sink.browser('switchTab', { number: params.number });
        return this.done(`Tab ${params.number}`);
      case 'zoom_in':
        this.sink.browser('zoomIn');
        return this.done(def.label);
      case 'zoom_out':
        this.sink.browser('zoomOut');
        return this.done(def.label);
      case 'zoom_reset':
        this.sink.browser('zoomReset');
        return this.done(def.label);
      case 'search':
      case 'search_new_tab':
      case 'search_here': {
        const query = (params.text ?? '').trim();
        if (!query) return this.blocked('Say what to search for.');
        // The query only ever becomes a search. It is never navigated to, typed as a command or run.
        if (action === 'search_new_tab') {
          this.sink.browser('search', { text: query });
          return this.done(`New tab: searching for "${query}"`);
        }
        this.sink.browser(action === 'search_here' ? 'searchPage' : 'searchTab', { text: query });
        return this.done(`Searching for "${query}"`);
      }
      case 'browser_settings':
        this.sink.browser('openSettings');
        return this.done('Opening browser settings');
      case 'incognito_window':
        this.sink.browser('incognito');
        return this.done('Opening an incognito window');

      case 'show_numbers':
        this.hintsWanted = true;
        this.sink.page('showHints', { filter: params.filter ?? 'all' });
        return this.done('Say a number to click it, or "hide numbers".');
      case 'hide_numbers':
        this.hintsWanted = false;
        this.sink.page('hideHints');
        return this.done(def.label);
      case 'toggle_numbers':
        this.hintsWanted = !this.hintsShown;
        this.sink.page('toggleHints');
        return this.done(def.label);
      case 'click_number':
        if (!params.number) return this.blocked('Say the number shown next to the element.');
        if (!this.hintsShown) return this.blocked('Numbers are not showing. Say "show numbers" first.');
        if (this.pending) return this.blocked('Answer the confirmation first: say "confirm" or "cancel".');
        this.sink.page('clickHint', { number: params.number });
        return this.done(`Number ${params.number}`);

      case 'press_key':
        if (!params.key) return this.blocked('Say which key to press.');
        this.sink.page('pressKey', { key: params.key });
        return this.done(`Pressed ${params.key === ' ' ? 'space' : params.key}`);

      case 'switch_mode':
        return this.switchMode(t);
      case 'use_head':
        return this.useSource('head', t);
      case 'use_hand':
        return this.useSource('hand', t);
      case 'use_voice':
        this.sink.patchSettings({ controlMode: 'voice' });
        return this.done('Voice mode. Say a number to click it. The camera is off.');

      case 'pause':
        return this.pause(t);
      case 'resume':
        return this.resume(t);
      case 'toggle_pause':
        return this.safety.phase === 'paused' || this.safety.phase === 'suspended' ? this.resume(t) : this.pause(t);

      case 'recenter': {
        if (this.source !== 'head' || !this.face || !this.cal) {
          return this.blocked('Recentring needs head control with your face in view.');
        }
        this.cal = recenterCalibration(this.cal, this.sample(this.face));
        this.resetDrift();
        this.headPipeline.reset();
        this.headPipeline.syncTo({ x: 0.5, y: 0.5 });
        this.cursor.beginGlide();
        return this.done('Recentred');
      }
      case 'recalibrate':
        this.sink.browser('openDashboard', { text: 'head?start=1' });
        return this.done('Opening calibration');
      case 'show_settings':
        this.sink.browser('openDashboard', { text: '' });
        return this.done('Opening settings');
      case 'exit':
        this.sink.exit();
        return this.done('Handsfree is turning off');

      case 'toggle_listening':
        return this.setMuted(this.listening, t);
      case 'stop_listening':
        return this.setMuted(true, t);

      case 'start_dictation':
        if (!this.settings.features.voice) return this.blocked('Voice is turned off.');
        if (!this.dictation.start()) return this.blocked('Already dictating.');
        return this.done('Dictating. Say "stop dictation" when you are done.');
      case 'stop_dictation':
        if (!this.dictation.stop()) return this.blocked('Dictation is not running.');
        return this.done('Dictation stopped');
      case 'undo_dictation': {
        const segment = this.dictation.undoLast();
        if (!segment) return this.blocked('There is nothing to undo.');
        this.sink.page('undoText', { number: 1 });
        return this.done('Removed the last phrase');
      }
      case 'clear_dictation': {
        const count = this.dictation.clear();
        if (count === 0) return this.blocked('The dictated draft is empty.');
        this.sink.page('undoText', { number: count });
        return this.done('Dictated draft cleared');
      }
      case 'type_text': {
        const text = applySpokenPunctuation(params.text ?? '');
        if (!text) return this.blocked('Say what to type.');
        this.sink.page('insertText', { text, requestId: 'once' });
        return this.done('Typed');
      }

      case 'confirm': {
        const p = this.pending;
        if (!p) return this.blocked('There is nothing to confirm.');
        this.pending = null;
        p.confirm();
        return this.done('Confirmed');
      }
      case 'cancel':
        if (this.calSession?.active) {
          this.cancelCalibration(t);
          return this.done('Calibration cancelled');
        }
        if (this.pending) {
          this.cancelPending('cancelled');
          return this.done('Cancelled');
        }
        this.releaseHeld(t, 'cancel');
        return this.done('Cancelled');
    }
  }

  private pause(t: number): ExecuteResult {
    const event = this.safety.pause();
    if (!event) return this.blocked('Already paused.');
    this.releaseHeld(t, 'paused');
    this.cancelPending('paused');
    // Dictation would keep typing what it hears: pausing ends it.
    this.dictation.stop();
    return this.done('Paused. Say "start" or "resume" to continue.');
  }

  private resume(t: number): ExecuteResult {
    const event = this.safety.resume(t);
    if (!event) return this.blocked('Handsfree is not paused.');
    return this.done('Resuming...');
  }

  private switchMode(t: number): ExecuteResult {
    const mode = this.settings.controlMode;
    if (mode === 'hybrid') return this.useSource(this.hybridSource === 'head' ? 'hand' : 'head', t);
    const next: ControlMode = mode === 'head' ? 'hand' : 'head';
    this.sink.patchSettings({ controlMode: next });
    return this.done(`Switching to ${modeLabel(next)}`);
  }

  private useSource(source: 'head' | 'hand', _t: number): ExecuteResult {
    if (this.settings.controlMode === 'hybrid') {
      this.hybridSource = source;
      this.handSeenSince = null;
      this.handGoneSince = null;
      return this.done(`${source === 'head' ? 'Head' : 'Hand'} now controls the cursor`);
    }
    if (this.settings.controlMode === source) return this.done(`Already using ${source} control`);
    this.sink.patchSettings({ controlMode: source });
    return this.done(`Switching to ${source} control`);
  }

  // ---- voice ----------------------------------------------------------------------

  private setMuted(muted: boolean, t: number): ExecuteResult {
    if (!this.settings.features.voice) return this.blocked('Voice is turned off in settings.');
    if (this.settings.voice.mode === 'push') {
      this.pushUntil = muted ? 0 : t + PUSH_TO_TALK_MS;
    } else {
      this.muted = muted;
    }
    this.voiceFatal = false;
    this.syncListening(t);
    return this.done(muted ? 'Voice muted' : 'Listening');
  }

  private wantsListening(t: number): boolean {
    if (!this.voiceStarted || !this.settings.features.voice || this.voiceFatal) return false;
    if (this.settings.voice.mode === 'push') return t < this.pushUntil || this.dictation.active;
    return !this.muted;
  }

  private syncListening(t: number): void {
    const want = this.wantsListening(t);
    if (want === this.listening) return;
    this.listening = want;
    this.sink.setListening(want);
    if (!want) {
      this.voice.interim = '';
      if (this.voice.state !== 'error') this.voice.state = this.settings.features.voice ? 'muted' : 'off';
      if (this.dictation.active && !this.settings.features.voice) this.dictation.stop();
    } else {
      this.voice.state = 'starting';
      this.voice.error = null;
      this.voice.recovery = null;
    }
  }

  speechEvent(ev: SpeechEvent, t: number, resultKey?: string): void {
    this.now = t;
    switch (ev.kind) {
      case 'state':
        if (ev.state === 'listening') {
          this.voice.state = 'listening';
          this.voice.error = null;
          this.voice.recovery = null;
        } else if (ev.state === 'starting') {
          if (this.voice.state !== 'error' && this.voice.state !== 'reconnecting') this.voice.state = 'starting';
        } else if (this.voice.state !== 'error' && this.voice.state !== 'reconnecting') {
          this.voice.state = this.listening ? 'starting' : this.settings.features.voice ? 'muted' : 'off';
        }
        break;
      case 'interim':
        // Display only. An interim transcript is never parsed or executed.
        if (!this.listening) break;
        this.voice.interim = ev.text;
        if (this.settings.voice.mode === 'push' && this.listening) this.pushUntil = t + PUSH_TO_TALK_MS;
        break;
      case 'final':
        this.voice.interim = '';
        // Heard after listening was switched off: stale, so it is dropped.
        if (!this.listening || !ev.text.trim()) break;
        if (resultKey !== undefined) {
          if (this.handledResults.has(resultKey)) break;
          this.handledResults.add(resultKey);
          if (this.handledResults.size > 200) this.handledResults.delete(this.handledResults.values().next().value as string);
        }
        this.onFinal(ev.alternatives.length > 0 ? ev.alternatives : [ev.text], ev.confidence, t, resultKey);
        break;
      case 'error': {
        const known = SPEECH_ERRORS[ev.code];
        // "no-speech" and "aborted" are part of normal operation.
        if (!known) break;
        this.voice.error = known.message;
        this.voice.recovery = known.recovery;
        // Not fatal: the recogniser restarts by itself, and until it does nothing is being heard.
        this.voice.state = known.fatal ? 'error' : 'reconnecting';
        if (ev.code === 'unsupported') this.voice.supported = false;
        if (known.fatal) {
          this.voiceFatal = true;
          this.dictation.stop();
          this.syncListening(t);
          this.voice.state = 'error';
          // Nobody can say "start" without a microphone. With a camera mode there is still a cursor to use.
          if (this.safety.awaitingStart && this.settings.controlMode !== 'voice') {
            this.safety.resume(t);
            this.say('The microphone is not available, so Handsfree started without waiting for "start".', 'warn');
          }
        }
        break;
      }
      case 'mic':
        this.voice.micState = ev.state;
        break;
      case 'level':
        this.voice.micLevel = ev.level;
        this.voice.noiseFloor = ev.noiseFloor;
        this.voice.noisy = ev.noiseFloor > NOISY_FLOOR;
        break;
    }
  }

  private onFinal(alternatives: string[], confidence: number | null, t: number, resultKey?: string): void {
    // In a noisy room a command needs stronger evidence.
    const minConfidence = Math.min(0.95, this.settings.voice.minConfidence + (this.voice.noisy ? 0.15 : 0));
    const { result, text } = parseAlternatives(alternatives, confidence, {
      hintsShown: this.hintsShown,
      dictating: this.dictation.active,
      mode: this.settings.voice.mode,
      wakeWord: this.settings.voice.wakeWord,
      minConfidence,
      pending: this.pending !== null,
    });
    if (result.status === 'ignored') return;
    if (this.settings.voice.mode === 'push') this.pushUntil = t + PUSH_TO_TALK_MS;

    this.voice.lastPhrase = text;
    this.voice.lastConfidence = confidence !== null && confidence > 0 ? confidence : null;
    this.voice.lastIntent = null;
    this.voice.lastPayload = '';
    this.voice.lastNote = '';

    switch (result.status) {
      case 'match': {
        this.voice.lastIntent = ACTIONS[result.action].label;
        const { text: payload, number, key } = result.params;
        this.voice.lastPayload = payload ?? (number !== undefined ? String(number) : (key ?? ''));
        const outcome = this.execute(result.action, result.params, 'voice', t);
        this.voice.lastStatus = outcome.status;
        this.voice.lastMessage = outcome.message;
        if (outcome.status === 'blocked') {
          this.stats.failedCommands += 1;
          this.say(outcome.message, 'warn');
        } else {
          this.stats.executedCommands += 1;
          if (outcome.status === 'executed') {
            const label = ACTIONS[result.action].label;
            this.voice.lastExecuted = this.voice.lastPayload ? `${label}: ${this.voice.lastPayload}` : label;
          }
          if (outcome.message) this.say(outcome.message, 'ok');
        }
        break;
      }
      case 'unknown': {
        if (this.dictation.active) {
          // Typing is an action like any other: nothing is inserted unless actions are enabled.
          if (!this.safety.cursorLive) {
            this.voice.lastStatus = 'blocked';
            this.voice.lastMessage = 'Not typed: actions are paused.';
            break;
          }
          // A phrase that is an email address from start to finish is typed as the address.
          const segment = this.dictation.accept(tidySpokenEmail(text), resultKey);
          if (segment) {
            this.sink.page('insertText', { text: segment.text, requestId: segment.id });
            this.voice.lastStatus = 'dictated';
            this.voice.lastMessage = 'Typed';
          }
          break;
        }
        this.voice.lastStatus = 'unknown';
        this.voice.lastMessage = 'Not a command. Say "show settings" to see the command list.';
        this.stats.failedCommands += 1;
        this.say(`"${text}" is not a command`, 'warn');
        break;
      }
      case 'ambiguous':
      case 'rejected':
        this.voice.lastStatus = result.status;
        this.voice.lastMessage = result.reason;
        this.stats.failedCommands += 1;
        this.say(result.reason, 'warn');
        break;
    }
    this.voice.dictating = this.dictation.active;
    this.syncListening(t);
  }

  // ---- page agent -------------------------------------------------------------------

  /** The page being controlled changed (tab switch, navigation, agent reconnect). */
  targetChanged(agentCount: number): void {
    this.agentCount = agentCount;
    this.hintsShown = false;
    if (this.dragging) this.dragging = false;
    this.scrollHolds.clear();
    if (this.pending) this.cancelPending('page changed');
  }

  agentMessage(msg: AgentToEngine, t: number): void {
    this.now = t;
    if (msg.t === 'confirm-request') {
      const id = msg.id;
      this.setPending(
        msg.prompt,
        () => this.sink.page('confirmed', { id }),
        () => this.sink.page('declined', { id }),
        id,
      );
      return;
    }
    if (msg.t === 'confirm-answer') {
      if (!this.pending || this.pending.id !== msg.id) return;
      if (msg.ok) this.execute('confirm', {}, 'ui', t);
      else this.cancelPending('declined');
      return;
    }
    if (msg.t !== 'event') return;
    switch (msg.name) {
      case 'click':
        this.stats.clicks += 1;
        break;
      case 'dwell-start':
        this.stats.dwellStarts += 1;
        break;
      case 'dwell-cancel':
        this.stats.canceledClicks += 1;
        break;
      case 'drag-end':
        this.dragging = false;
        break;
      case 'hints-shown':
        this.hintsShown = true;
        break;
      case 'hints-hidden':
        this.hintsShown = false;
        break;
      case 'hint-missing':
        this.stats.failedCommands += 1;
        this.say(`There is no number ${msg.detail ?? ''} on screen`, 'warn');
        break;
      case 'target-missing':
        this.stats.failedCommands += 1;
        this.voice.lastStatus = 'blocked';
        this.voice.lastMessage = msg.detail || 'Nothing on the page matched that.';
        this.say(this.voice.lastMessage, 'warn');
        break;
      case 'text-inserted':
        if (msg.requestId) this.dictation.resolve(msg.requestId, true);
        break;
      case 'text-failed':
        if (msg.requestId) this.dictation.resolve(msg.requestId, false);
        this.voice.lastStatus = 'blocked';
        this.voice.lastMessage = msg.detail || 'No text field is focused.';
        this.say(this.voice.lastMessage, 'warn');
        break;
      default:
        break;
    }
  }

  // ---- status -----------------------------------------------------------------------

  get phase() {
    return this.safety.phase;
  }

  get isListening(): boolean {
    return this.listening;
  }

  get cursorSource(): CursorSource {
    return this.source;
  }

  get calibrating(): boolean {
    return this.calSession?.active ?? false;
  }

  private faceQuality(fps: number): Quality {
    if (!needsFaceModel(this.settings)) return 'off';
    return rateFaceQuality({
      present: this.face !== null,
      lossRate: this.facePresence.lossRate,
      jitter: this.jitter.value,
      fps,
    });
  }

  private trackingQuality(fps: number): Quality {
    if (this.source === 'none') return 'off';
    if (this.source === 'head') return this.faceQuality(fps);
    const best = this.hands.reduce((m, h) => Math.max(m, h.features.score), 0);
    return rateHandQuality({ present: this.hands.length > 0, lossRate: this.handPresence.lossRate, score: best, fps });
  }

  hud(t: number, env: { cameraOn: boolean; fps: number }): HudState {
    const pending = this.pending;
    return {
      phase: this.safety.phase,
      pausedReason: this.safety.pausedReason,
      graceRemainingMs: this.safety.graceRemaining(t),
      controlMode: this.settings.controlMode,
      cursorSource: this.source,
      tracking: this.trackingQuality(env.fps),
      cameraOn: env.cameraOn,
      micOn: this.voice.micState === 'on' || this.voice.state === 'listening',
      listening: this.voice.state === 'listening',
      dictating: this.dictation.active,
      interim: this.voice.interim,
      dragging: this.dragging,
      pending: pending ? { id: pending.id, prompt: pending.prompt, remainingMs: Math.max(0, pending.expiresAt - t) } : null,
      notice: this.notice,
      autoHints:
        this.settings.controlMode === 'voice' &&
        this.settings.hints.autoInVoiceMode &&
        this.hintsWanted &&
        this.safety.interactive &&
        pending === null,
    };
  }

  /** The parts of the engine status the core knows about. */
  status(t: number, fps: number): Pick<
    EngineStatus,
    | 'phase'
    | 'pausedReason'
    | 'graceRemainingMs'
    | 'controlMode'
    | 'cursorSource'
    | 'face'
    | 'hands'
    | 'handQuality'
    | 'cursor'
    | 'lastGesture'
    | 'gestureLog'
    | 'voice'
    | 'calibration'
    | 'calibrated'
    | 'postureShifted'
    | 'pending'
    | 'hintsShown'
    | 'stats'
  > {
    const hands: HandStatus[] = this.hands.map(toHandStatus);
    const pending = this.pending;
    const p = this.cursor.position;
    const s = this.face?.signals;
    const bestHand = this.hands.reduce((m, h) => Math.max(m, h.features.score), 0);
    return {
      phase: this.safety.phase,
      pausedReason: this.safety.pausedReason,
      graceRemainingMs: this.safety.graceRemaining(t),
      controlMode: this.settings.controlMode,
      cursorSource: this.source,
      face: {
        present: this.face !== null,
        quality: this.faceQuality(fps),
        lostMs: this.facePresence.lostMs(t),
        lossRate: this.facePresence.lossRate,
        jitter: this.jitter.value,
        yaw: this.face?.pose.yaw ?? 0,
        pitch: this.face?.pose.pitch ?? 0,
        roll: this.face?.pose.roll ?? 0,
        poseSource: this.face?.pose.source ?? 'none',
        signals: {
          blinkLeft: s?.blinkLeft ?? 0,
          blinkRight: s?.blinkRight ?? 0,
          jawOpen: s?.jawOpen ?? 0,
          smile: s?.smile ?? 0,
          browUp: s?.browUp ?? 0,
        },
      },
      hands,
      handQuality: rateHandQuality({
        present: this.hands.length > 0,
        lossRate: this.handPresence.lossRate,
        score: bestHand,
        fps,
      }),
      cursor: {
        x: p.x,
        y: p.y,
        settling: this.cursor.isSettling(t),
        dragging: this.dragging,
        frozen: this.cursorFrozen,
      },
      lastGesture: this.gestureLog[0] ?? null,
      gestureLog: this.gestureLog,
      voice: { ...this.voice, dictating: this.dictation.active },
      calibration: this.calStatus,
      calibrated: this.settings.calibration !== null,
      postureShifted: this.postureShifted,
      pending: pending ? { id: pending.id, prompt: pending.prompt, remainingMs: Math.max(0, pending.expiresAt - t) } : null,
      hintsShown: this.hintsShown,
      stats: this.stats,
    };
  }

  get pageAgents(): number {
    return this.agentCount;
  }

  /** Raw landmark access for the diagnostics stream. */
  get trackedHands(): TrackedHand[] {
    return this.hands;
  }
}

export function modeLabel(mode: ControlMode): string {
  switch (mode) {
    case 'head':
      return 'head control';
    case 'hand':
      return 'hand control';
    case 'hybrid':
      return 'head + hand';
    case 'voice':
      return 'voice only';
  }
}
