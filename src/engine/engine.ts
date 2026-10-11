import type { FaceObservation } from '../core/face/pose';
import { HandsfreeCore, type CoreSink } from '../core/handsfreeCore';
import type { HandObservation } from '../core/hand/features';
import { PerfGovernor, rateLighting, type LightingReading } from '../core/tracking';
import {
  AGENT_PORT,
  STATUS_PORT,
  parseAgentToEngine,
  parseClientToEngine,
  parseEngineControl,
  type ActiveTabInfo,
  type EngineToAgent,
  type EngineToClient,
  type SpeechEvent,
  type WorkerRequest,
  type WorkerResponse,
} from '../shared/messages';
import { needsCamera, needsFaceModel, needsHandModel, sanitizeSettings, type Settings } from '../shared/settings';
import type { DiagFrame, EngineStatus } from '../shared/types';
import { Camera, LightMeter, explainCameraError, type CameraError } from './camera';
import { WebSpeechProvider, type SpeechProvider } from './speech';
import { Vision, type FrameImage } from './vision';

interface AgentConn {
  port: chrome.runtime.Port;
  tabId: number;
  visible: boolean;
  focused: boolean;
  lastFocus: number;
}

interface StatusConn {
  port: chrome.runtime.Port;
  diag: boolean;
  voiceHost: boolean;
}

const STATUS_INTERVAL_MS = 110;
const HUD_INTERVAL_MS = 130;
const DIAG_INTERVAL_MS = 45;
const LIGHT_INTERVAL_MS = 1000;
const PUMP_INTERVAL_MS = 125;
/** With the camera on, no frame for this long counts as lost tracking. */
const STALL_MS = 1200;
/** Longest wait for the first processed frame before reporting a camera problem. */
const WARMUP_TIMEOUT_MS = 20000;

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

function send(request: WorkerRequest): Promise<WorkerResponse | undefined> {
  return chrome.runtime.sendMessage(request).catch(() => undefined);
}

/**
 * The Handsfree engine. It runs in the extension's offscreen document for as
 * long as Handsfree is switched on, and owns the camera, the tracking models,
 * speech recognition and the core state machine. Page agents and the
 * dashboard connect to it with ports.
 */
export class Engine {
  private settings!: Settings;
  private core!: HandsfreeCore;
  private readonly vision = new Vision();
  private readonly camera = new Camera();
  private readonly light = new LightMeter();
  private readonly perf = new PerfGovernor();
  private speech: SpeechProvider | null = null;

  private readonly agents = new Map<number, AgentConn>();
  private readonly statusPorts = new Set<StatusConn>();
  private target: AgentConn | null = null;
  private activeTab: ActiveTabInfo = { tabId: null, controllable: false, reason: '' };

  private error: EngineStatus['error'] = null;
  private lighting: LightingReading = rateLighting(NaN, 0);
  private lastFace: FaceObservation | null = null;
  private lastHands: HandObservation[] = [];

  private lastFrameAt = 0;
  private lastStatusAt = 0;
  private lastHudAt = 0;
  private lastDiagAt = 0;
  private lastLightAt = 0;
  private busy = false;
  private wantListening = false;
  private pump: ReturnType<typeof setInterval> | null = null;
  private trackingQueue: Promise<void> = Promise.resolve();
  private stopped = false;
  /** Set while waiting for the first processed frame after (re)starting tracking. */
  private warmupSince: number | null = null;
  private unsubscribe: Array<() => void> = [];

  async start(): Promise<void> {
    // chrome.storage does not exist in an offscreen document: settings come from the service worker.
    const stored = await send({ type: 'hf/settings' });
    this.settings = sanitizeSettings(stored?.settings);
    this.core = new HandsfreeCore(this.settings, this.sink());

    chrome.runtime.onConnect.addListener(this.onConnect);
    chrome.runtime.onMessage.addListener(this.onRuntimeMessage);
    this.unsubscribe.push(
      () => chrome.runtime.onConnect.removeListener(this.onConnect),
      () => chrome.runtime.onMessage.removeListener(this.onRuntimeMessage),
    );
    this.pump = setInterval(() => this.onPump(), PUMP_INTERVAL_MS);

    const active = await send({ type: 'hf/active-tab' });
    if (active?.activeTab) this.activeTab = active.activeTab;

    // Voice does not depend on the camera: start it right away.
    this.core.startVoice(performance.now());
    await this.applyTracking();
  }

  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pump) clearInterval(this.pump);
    this.pump = null;
    this.core.shutdown(performance.now());
    this.broadcastHud(true);
    for (const fn of this.unsubscribe.splice(0)) fn();
    this.speech?.dispose();
    this.speech = null;
    this.camera.stop();
    this.vision.dispose();
    for (const conn of this.agents.values()) conn.port.disconnect();
    for (const conn of this.statusPorts) conn.port.disconnect();
    this.agents.clear();
    this.statusPorts.clear();
  }

  // ---- outputs ----------------------------------------------------------------

  private sink(): CoreSink {
    return {
      cursor: (x, y, show, ok) => this.toTarget({ t: 'cursor', x: round4(x), y: round4(y), show, ok }),
      page: (action, params) => this.toTarget({ t: 'do', action, params }),
      browser: (cmd, args) =>
        void send({ type: 'hf/browser', cmd, ...args }).then((res) => {
          // A command that could not be carried out is said so, never passed over in silence.
          const text = res && !res.ok ? res.error : res?.note;
          if (!text || this.stopped) return;
          this.core.notify(text, performance.now());
          this.broadcastHud(true);
          this.broadcastStatus(true);
        }),
      patchSettings: (patch) => void send({ type: 'hf/settings-patch', patch: patch as Record<string, unknown> }),
      setListening: (on) => this.setListening(on),
      exit: () => void send({ type: 'hf/disable' }),
    };
  }

  private toTarget(msg: EngineToAgent): void {
    const target = this.target;
    if (!target) return;
    try {
      target.port.postMessage(msg);
    } catch {
      this.dropAgent(target);
    }
  }

  // ---- settings and tracking ------------------------------------------------------

  private onSettings(next: Settings): void {
    const prev = this.settings;
    this.settings = next;
    this.core.configure(next, performance.now());
    this.perf.setBudget(1000 / next.camera.maxFps + 8);

    const trackingChanged =
      needsCamera(prev) !== needsCamera(next) ||
      needsFaceModel(prev) !== needsFaceModel(next) ||
      needsHandModel(prev) !== needsHandModel(next) ||
      prev.camera.deviceId !== next.camera.deviceId ||
      prev.camera.delegate !== next.camera.delegate ||
      prev.camera.maxFps !== next.camera.maxFps;
    if (trackingChanged) void this.applyTracking();

    if (prev.voice.host !== next.voice.host || prev.voice.lang !== next.voice.lang) {
      const listening = this.wantListening;
      this.setListening(false);
      this.speech?.dispose();
      this.speech = null;
      if (listening) this.setListening(true);
    }
  }

  /** Bring camera and models in line with the current settings. Calls are serialised. */
  private applyTracking(): Promise<void> {
    this.trackingQueue = this.trackingQueue.then(() => this.doApplyTracking()).catch((err) => {
      console.error('[handsfree] tracking setup failed', err);
    });
    return this.trackingQueue;
  }

  private async doApplyTracking(): Promise<void> {
    if (this.stopped) return;
    const s = this.settings;
    const wantCamera = needsCamera(s);
    this.error = null;
    this.perf.setBudget(1000 / s.camera.maxFps + 8);

    if (!wantCamera) {
      // Voice-only: release the camera and the models entirely.
      this.warmupSince = null;
      this.camera.stop();
      this.vision.dispose();
      this.lastFace = null;
      this.lastHands = [];
      this.perf.reset();
      this.lighting = rateLighting(NaN, 0);
      this.core.setLoading();
      this.core.ready(performance.now());
      this.broadcastStatus(true);
      return;
    }

    this.core.setLoading();
    this.broadcastStatus(true);
    try {
      await this.vision.configure({ face: needsFaceModel(s), hand: needsHandModel(s), delegate: s.camera.delegate });
    } catch {
      this.fail({
        code: 'models',
        message: this.vision.lastError || 'The tracking models failed to load.',
        recovery: 'Run "npm run build" again to restore the model files, then reload the extension. If it persists, switch the processing device to CPU in Cursor settings.',
      });
      return;
    }
    if (this.stopped) return;

    const cameraMatches =
      this.camera.state === 'on' && (s.camera.deviceId === null || s.camera.deviceId === this.camera.deviceId);
    if (!cameraMatches) {
      try {
        await this.camera.start(
          s.camera.deviceId,
          s.camera.maxFps,
          (image, w, h) => this.onFrame(image, w, h),
          (err) => this.onCameraError(err),
        );
      } catch (err) {
        this.onCameraError(explainCameraError(err));
        return;
      }
    }
    if (this.stopped) {
      this.camera.stop();
      return;
    }
    // The first inference compiles shaders and can take seconds. The grace
    // period starts only once a frame has actually been processed, so the
    // neutral head position is never taken from a model that is still warming up.
    this.warmupSince = performance.now();
    this.broadcastStatus(true);
  }

  private fail(error: NonNullable<EngineStatus['error']>): void {
    this.error = error;
    this.warmupSince = null;
    this.core.setError(error.message);
    this.broadcastStatus(true);
    this.broadcastHud(true);
  }

  private onCameraError(err: CameraError): void {
    this.fail({ code: `camera-${err.state}`, message: err.message, recovery: err.recovery });
  }

  // ---- frames -------------------------------------------------------------------------

  private onFrame(image: FrameImage, width: number, height: number): void {
    if (this.stopped) return;
    if (this.busy) {
      this.perf.noteDropped();
      return;
    }
    this.busy = true;
    try {
      // Model timestamps must increase monotonically; this is the capture time.
      const stamp = performance.now();
      let face: FaceObservation | null | undefined;
      let hands: HandObservation[] | undefined;
      let faceMs: number | null = null;
      let handMs: number | null = null;

      if (this.vision.hasFace) {
        const start = performance.now();
        face = this.vision.detectFace(image, stamp);
        faceMs = performance.now() - start;
        this.lastFace = face;
      }
      if (this.vision.hasHand && this.perf.shouldRunHands()) {
        const start = performance.now();
        hands = this.vision.detectHands(image, stamp);
        handMs = performance.now() - start;
        this.lastHands = hands;
      }
      // Everything downstream runs on the time the result became available.
      const t = performance.now();
      if (this.warmupSince !== null) {
        // Warm-up frame: tracking works. Start the grace period now and keep its timing out of the statistics.
        this.warmupSince = null;
        this.perf.reset();
        this.core.ready(t);
      } else {
        this.perf.record(t, faceMs, handMs);
      }
      this.lastFrameAt = t;

      if (t - this.lastLightAt >= LIGHT_INTERVAL_MS) {
        this.lastLightAt = t;
        const reading = this.light.measure(image);
        if (reading) this.lighting = rateLighting(reading.luma, reading.contrast);
      }

      this.core.frame(t, { face, hands, aspect: height > 0 ? width / height : 4 / 3 });
      this.broadcast(t);
    } catch (err) {
      console.error('[handsfree] frame failed', err);
    } finally {
      this.busy = false;
    }
  }

  /** Timer: keeps time-based logic alive without frames (voice-only mode, or a stalled camera). */
  private onPump(): void {
    if (this.stopped) return;
    const t = performance.now();
    if (this.warmupSince !== null) {
      if (t - this.warmupSince > WARMUP_TIMEOUT_MS) {
        this.fail({
          code: 'camera-error',
          message: 'The camera is on but no picture is arriving.',
          recovery: 'Check that the camera is not covered or in use by another app, then switch Handsfree off and on again.',
        });
      } else {
        this.broadcastStatus(false);
      }
      return;
    }
    if (t - this.lastFrameAt < PUMP_INTERVAL_MS * 2) return;
    if (this.camera.state === 'on' && this.core.phase !== 'loading' && t - this.lastFrameAt > STALL_MS) {
      // The camera is on but silent: report honest "nothing detected" frames so the safety logic reacts.
      this.lastFace = null;
      this.lastHands = [];
      this.core.frame(t, {
        face: this.vision.hasFace ? null : undefined,
        hands: this.vision.hasHand ? [] : undefined,
        aspect: 4 / 3,
      });
    } else {
      this.core.tick(t);
    }
    this.broadcast(t);
  }

  // ---- broadcasting ---------------------------------------------------------------------

  private broadcast(t: number): void {
    if (t - this.lastHudAt >= HUD_INTERVAL_MS) this.broadcastHud(false);
    if (t - this.lastStatusAt >= STATUS_INTERVAL_MS) this.broadcastStatus(false);
    if (t - this.lastDiagAt >= DIAG_INTERVAL_MS) this.broadcastDiag(t);
  }

  private broadcastHud(force: boolean): void {
    const t = performance.now();
    if (!force && t - this.lastHudAt < HUD_INTERVAL_MS) return;
    this.lastHudAt = t;
    this.toTarget({
      t: 'hud',
      hud: this.core.hud(t, { cameraOn: this.camera.state === 'on', fps: this.perf.snapshot.fps }),
    });
  }

  private buildStatus(t: number): EngineStatus {
    const perf = this.perf.snapshot;
    return {
      t,
      ...this.core.status(t, perf.fps),
      error: this.error,
      camera: {
        state: this.camera.state === 'off' && this.error?.code.startsWith('camera-')
          ? (this.error.code.slice(7) as EngineStatus['camera']['state'])
          : this.camera.state,
        label: this.camera.label,
        width: this.camera.width,
        height: this.camera.height,
      },
      models: { face: this.vision.faceState, hand: this.vision.handState, delegate: this.vision.delegate },
      perf,
      lighting: this.lighting,
      page: {
        controllable: this.target !== null,
        reason: this.target ? '' : this.activeTab.reason || 'Waiting for the page to connect.',
        tabId: this.activeTab.tabId,
        agents: this.agents.size,
      },
    };
  }

  private broadcastStatus(force: boolean): void {
    const t = performance.now();
    if (!force && t - this.lastStatusAt < STATUS_INTERVAL_MS) return;
    this.lastStatusAt = t;
    if (this.statusPorts.size === 0) return;
    const msg: EngineToClient = { t: 'status', status: this.buildStatus(t) };
    for (const conn of this.statusPorts) this.toClient(conn, msg);
  }

  private broadcastDiag(t: number): void {
    let wanted = false;
    for (const conn of this.statusPorts) wanted ||= conn.diag;
    if (!wanted) return;
    this.lastDiagAt = t;
    const frame: DiagFrame = {
      t,
      face: this.lastFace ? this.lastFace.landmarks.map((p) => [round4(p.x), round4(p.y)] as [number, number]) : null,
      hands: this.lastHands.map((h) => ({
        handedness: h.handedness,
        points: h.landmarks.map((p) => [round4(p.x), round4(p.y)] as [number, number]),
      })),
    };
    for (const conn of this.statusPorts) if (conn.diag) this.toClient(conn, { t: 'frame', frame });
  }

  private toClient(conn: StatusConn, msg: EngineToClient): void {
    try {
      conn.port.postMessage(msg);
    } catch {
      this.statusPorts.delete(conn);
    }
  }

  // ---- voice ------------------------------------------------------------------------------

  private onSpeech = (event: SpeechEvent, key?: string): void => {
    if (this.stopped) return;
    this.core.speechEvent(event, performance.now(), key);
    if (event.kind === 'final' || event.kind === 'error' || event.kind === 'state') {
      this.broadcastHud(true);
      this.broadcastStatus(true);
    }
  };

  private setListening(on: boolean): void {
    this.wantListening = on;
    if (this.settings.voice.host === 'dashboard') {
      const hosts = [...this.statusPorts].filter((c) => c.voiceHost);
      for (const conn of hosts) this.toClient(conn, { t: 'voice-ctl', listen: on, lang: this.settings.voice.lang });
      if (on && hosts.length === 0) {
        // Not fatal: voice starts as soon as a dashboard tab connects.
        this.core.speechEvent({ kind: 'state', state: 'starting' }, performance.now());
      }
      return;
    }
    if (on) {
      this.speech ??= new WebSpeechProvider(this.onSpeech);
      this.speech.start(this.settings.voice.lang);
    } else {
      this.speech?.stop();
    }
  }

  // ---- connections ---------------------------------------------------------------------------

  private onConnect = (port: chrome.runtime.Port): void => {
    if (this.stopped || port.sender?.id !== chrome.runtime.id) return;
    if (port.name === AGENT_PORT) this.acceptAgent(port);
    else if (port.name === STATUS_PORT) this.acceptStatus(port);
  };

  private acceptAgent(port: chrome.runtime.Port): void {
    const tabId = port.sender?.tab?.id;
    // Only top-level frames host the cursor.
    if (tabId === undefined || (port.sender?.frameId ?? 0) !== 0) {
      port.disconnect();
      return;
    }
    const previous = this.agents.get(tabId);
    if (previous) previous.port.disconnect();
    const conn: AgentConn = { port, tabId, visible: false, focused: false, lastFocus: 0 };
    this.agents.set(tabId, conn);

    port.onMessage.addListener((raw) => {
      const msg = parseAgentToEngine(raw);
      if (!msg || this.agents.get(tabId) !== conn) return;
      if (msg.t === 'hello') {
        this.retarget();
        return;
      }
      if (msg.t === 'visibility') {
        conn.visible = msg.visible;
        conn.focused = msg.focused;
        if (msg.visible && msg.focused) conn.lastFocus = performance.now();
        this.retarget();
        return;
      }
      // Only the page that is actually being controlled may report events or ask for confirmation.
      if (this.target !== conn) return;
      if (msg.t === 'open-tab') {
        // The agent only asks after a click it carried out; the URL is re-checked by the service worker.
        if (this.core.phase === 'active') void send({ type: 'hf/browser', cmd: 'openUrl', text: msg.url });
        return;
      }
      this.core.agentMessage(msg, performance.now());
      this.broadcastHud(true);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (this.agents.get(tabId) === conn) this.dropAgent(conn);
    });
    this.retarget();
  }

  private dropAgent(conn: AgentConn): void {
    if (this.agents.get(conn.tabId) === conn) this.agents.delete(conn.tabId);
    if (this.target === conn) {
      this.target = null;
      this.retarget();
    }
  }

  /** Decide which page receives the cursor: the active tab of the focused window. */
  private retarget(): void {
    let next: AgentConn | null = null;
    if (this.activeTab.tabId !== null) next = this.agents.get(this.activeTab.tabId) ?? null;
    if (!next && this.activeTab.tabId === null) {
      for (const conn of this.agents.values()) {
        if (conn.visible && (!next || conn.lastFocus > next.lastFocus)) next = conn;
      }
    }
    if (next === this.target) return;
    const previous = this.target;
    if (previous) {
      // Leave nothing interactive behind on the page we are moving away from.
      try {
        previous.port.postMessage({ t: 'do', action: 'dragCancel' } satisfies EngineToAgent);
        previous.port.postMessage({ t: 'do', action: 'hideHints' } satisfies EngineToAgent);
        previous.port.postMessage({ t: 'cursor', x: 0.5, y: 0.5, show: false, ok: false } satisfies EngineToAgent);
      } catch {
        /* port already closed */
      }
    }
    this.target = next;
    this.core.targetChanged(this.agents.size);
    this.broadcastHud(true);
    this.broadcastStatus(true);
  }

  private acceptStatus(port: chrome.runtime.Port): void {
    // Status ports are for the extension's own pages only, never content scripts.
    const url = port.sender?.url ?? '';
    if (!url.startsWith(chrome.runtime.getURL(''))) {
      port.disconnect();
      return;
    }
    const conn: StatusConn = { port, diag: false, voiceHost: false };
    this.statusPorts.add(conn);
    port.onMessage.addListener((raw) => {
      const msg = parseClientToEngine(raw);
      if (!msg) return;
      const t = performance.now();
      switch (msg.t) {
        case 'subscribe':
          conn.diag = msg.diag;
          break;
        case 'action': {
          const result = this.core.execute(msg.action, msg.params ?? {}, 'ui', t);
          if (result.status === 'blocked') this.toTarget({ t: 'do', action: 'toast', params: { text: result.message, tone: 'warn' } });
          break;
        }
        case 'calibration':
          if (msg.cmd === 'start') this.core.startCalibration(t);
          else this.core.cancelCalibration(t);
          break;
        case 'voice-host':
          conn.voiceHost = msg.ready;
          if (msg.ready && this.settings.voice.host === 'dashboard') {
            this.toClient(conn, { t: 'voice-ctl', listen: this.wantListening, lang: this.settings.voice.lang });
          }
          break;
        case 'voice-event':
          if (conn.voiceHost && this.settings.voice.host === 'dashboard') this.onSpeech(msg.event);
          break;
      }
      this.broadcastStatus(true);
      this.broadcastHud(true);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      this.statusPorts.delete(conn);
    });
    this.toClient(conn, { t: 'status', status: this.buildStatus(performance.now()) });
  }

  private onRuntimeMessage = (raw: unknown, sender: chrome.runtime.MessageSender): undefined => {
    // Control messages come from the service worker only: same extension, not a tab.
    if (sender.id !== chrome.runtime.id || sender.tab) return undefined;
    const msg = parseEngineControl(raw);
    if (!msg) return undefined;
    if (msg.kind === 'shutdown') {
      this.shutdown();
    } else if (msg.kind === 'settings') {
      this.onSettings(sanitizeSettings(msg.settings));
    } else if (msg.kind === 'active-tab') {
      this.activeTab = msg.info;
      this.retarget();
      this.broadcastStatus(true);
    } else {
      this.core.execute(msg.action, {}, 'keyboard', performance.now());
      this.broadcastHud(true);
      this.broadcastStatus(true);
    }
    return undefined;
  };
}
