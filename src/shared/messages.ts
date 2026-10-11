import { isActionId, type ActionId, type ActionParams, type HintFilter } from './actions';
import type { ControlMode, CursorSource, DiagFrame, EngineStatus, PendingConfirmation, Phase, Quality } from './types';

/**
 * Message protocol between the three extension contexts:
 *
 *   page agent  <-- port "hf-agent" -->  engine (offscreen document)
 *   dashboard   <-- port "hf-status" -->  engine
 *   any page    --- runtime message --->  service worker (privileged browser APIs)
 *
 * Everything that crosses a boundary is validated with the guards below
 * before it is acted on.
 */

export const AGENT_PORT = 'hf-agent';
export const STATUS_PORT = 'hf-status';

// ---- engine -> page agent ---------------------------------------------------

/** Compact state shown in the on-page heads-up display. */
export interface HudState {
  phase: Phase;
  pausedReason: string | null;
  graceRemainingMs: number;
  controlMode: ControlMode;
  cursorSource: CursorSource;
  tracking: Quality;
  cameraOn: boolean;
  micOn: boolean;
  listening: boolean;
  dictating: boolean;
  interim: string;
  dragging: boolean;
  pending: PendingConfirmation | null;
  notice: string;
  /** Voice mode: keep numbered labels on screen. */
  autoHints: boolean;
}

export type PageAction =
  | 'click'
  | 'doubleClick'
  | 'rightClick'
  | 'dragStart'
  | 'dragEnd'
  | 'dragCancel'
  | 'cancelClick'
  | 'scrollBy'
  | 'scrollTo'
  | 'showHints'
  | 'hideHints'
  | 'toggleHints'
  | 'clickHint'
  | 'clickText'
  | 'media'
  | 'autoScroll'
  | 'stopScroll'
  | 'showHelp'
  | 'hideHelp'
  | 'insertText'
  | 'undoText'
  | 'pressKey'
  | 'confirmed'
  | 'declined'
  | 'toast';

export interface PageActionParams {
  /** Scroll amounts as a fraction of the viewport. */
  dx?: number;
  dy?: number;
  to?: 'top' | 'bottom';
  number?: number;
  filter?: HintFilter;
  text?: string;
  key?: string;
  id?: string;
  tone?: 'info' | 'ok' | 'warn';
  /** media: what to do. */
  media?: 'play' | 'pause' | 'toggle' | 'mute' | 'unmute';
  /** Engine-side id used to pair results with requests. */
  requestId?: string;
}

export type EngineToAgent =
  | { t: 'cursor'; x: number; y: number; show: boolean; ok: boolean }
  | { t: 'hud'; hud: HudState }
  | { t: 'do'; action: PageAction; params?: PageActionParams };

// ---- page agent -> engine ---------------------------------------------------

export type AgentEventName =
  | 'click'
  | 'click-blocked'
  | 'dwell-start'
  | 'dwell-cancel'
  | 'drag-start'
  | 'drag-end'
  | 'hints-shown'
  | 'hints-hidden'
  | 'hint-missing'
  | 'text-inserted'
  | 'text-failed'
  | 'text-undone'
  | 'key-pressed'
  | 'target-missing';

export type AgentToEngine =
  | { t: 'hello'; kind: 'content' | 'extension'; href: string }
  | { t: 'visibility'; visible: boolean; focused: boolean }
  | { t: 'event'; name: AgentEventName; detail?: string; requestId?: string }
  | { t: 'confirm-request'; id: string; prompt: string }
  | { t: 'confirm-answer'; id: string; ok: boolean }
  /** A link that wants a new tab: synthetic clicks cannot open one, so the browser is asked to. */
  | { t: 'open-tab'; url: string };

const AGENT_EVENTS: readonly AgentEventName[] = [
  'click',
  'click-blocked',
  'dwell-start',
  'dwell-cancel',
  'drag-start',
  'drag-end',
  'hints-shown',
  'hints-hidden',
  'hint-missing',
  'text-inserted',
  'text-failed',
  'text-undone',
  'key-pressed',
  'target-missing',
];

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null;
const str = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length <= max;

export function parseAgentToEngine(msg: unknown): AgentToEngine | null {
  if (!isRec(msg)) return null;
  switch (msg.t) {
    case 'hello':
      if ((msg.kind === 'content' || msg.kind === 'extension') && str(msg.href, 4096)) {
        return { t: 'hello', kind: msg.kind, href: msg.href };
      }
      return null;
    case 'visibility':
      if (typeof msg.visible === 'boolean' && typeof msg.focused === 'boolean') {
        return { t: 'visibility', visible: msg.visible, focused: msg.focused };
      }
      return null;
    case 'event':
      if (AGENT_EVENTS.includes(msg.name as AgentEventName)) {
        return {
          t: 'event',
          name: msg.name as AgentEventName,
          detail: str(msg.detail, 300) ? msg.detail : undefined,
          requestId: str(msg.requestId, 64) ? msg.requestId : undefined,
        };
      }
      return null;
    case 'confirm-request':
      if (str(msg.id, 64) && str(msg.prompt, 300)) return { t: 'confirm-request', id: msg.id, prompt: msg.prompt };
      return null;
    case 'confirm-answer':
      if (str(msg.id, 64) && typeof msg.ok === 'boolean') return { t: 'confirm-answer', id: msg.id, ok: msg.ok };
      return null;
    case 'open-tab':
      return str(msg.url, 4096) && /^https?:\/\//i.test(msg.url) ? { t: 'open-tab', url: msg.url } : null;
    default:
      return null;
  }
}

// ---- dashboard <-> engine ---------------------------------------------------

/** Events from a speech recogniser, wherever it is hosted. */
export type SpeechEvent =
  | { kind: 'state'; state: 'starting' | 'listening' | 'stopped' }
  | { kind: 'interim'; text: string }
  | { kind: 'final'; text: string; confidence: number | null; alternatives: string[] }
  | { kind: 'error'; code: string }
  | { kind: 'mic'; state: 'off' | 'on' | 'denied' | 'notfound' | 'error' }
  | { kind: 'level'; level: number; noiseFloor: number };

export type EngineToClient =
  | { t: 'status'; status: EngineStatus }
  | { t: 'frame'; frame: DiagFrame }
  | { t: 'voice-ctl'; listen: boolean; lang: string };

export type ClientToEngine =
  | { t: 'subscribe'; diag: boolean }
  | { t: 'action'; action: ActionId; params?: ActionParams }
  | { t: 'calibration'; cmd: 'start' | 'cancel' }
  | { t: 'voice-host'; ready: boolean }
  | { t: 'voice-event'; event: SpeechEvent };

function parseSpeechEvent(ev: unknown): SpeechEvent | null {
  if (!isRec(ev)) return null;
  switch (ev.kind) {
    case 'state':
      return ev.state === 'starting' || ev.state === 'listening' || ev.state === 'stopped'
        ? { kind: 'state', state: ev.state }
        : null;
    case 'interim':
      return str(ev.text) ? { kind: 'interim', text: ev.text } : null;
    case 'final':
      if (!str(ev.text)) return null;
      return {
        kind: 'final',
        text: ev.text,
        confidence: typeof ev.confidence === 'number' ? ev.confidence : null,
        alternatives: Array.isArray(ev.alternatives) ? ev.alternatives.filter((a): a is string => str(a)).slice(0, 5) : [],
      };
    case 'error':
      return str(ev.code, 64) ? { kind: 'error', code: ev.code } : null;
    case 'mic':
      return ['off', 'on', 'denied', 'notfound', 'error'].includes(ev.state as string)
        ? { kind: 'mic', state: ev.state as 'off' }
        : null;
    case 'level':
      return typeof ev.level === 'number' && typeof ev.noiseFloor === 'number'
        ? { kind: 'level', level: ev.level, noiseFloor: ev.noiseFloor }
        : null;
    default:
      return null;
  }
}

function parseParams(p: unknown): ActionParams | undefined {
  if (!isRec(p)) return undefined;
  const out: ActionParams = {};
  if (typeof p.number === 'number' && Number.isFinite(p.number)) out.number = Math.trunc(p.number);
  if (str(p.text)) out.text = p.text;
  if (str(p.key, 32)) out.key = p.key;
  if (typeof p.amount === 'number' && Number.isFinite(p.amount)) out.amount = p.amount;
  if (p.filter === 'all' || p.filter === 'links' || p.filter === 'buttons' || p.filter === 'fields') out.filter = p.filter;
  return out;
}

export function parseClientToEngine(msg: unknown): ClientToEngine | null {
  if (!isRec(msg)) return null;
  switch (msg.t) {
    case 'subscribe':
      return { t: 'subscribe', diag: msg.diag === true };
    case 'action':
      return isActionId(msg.action) ? { t: 'action', action: msg.action, params: parseParams(msg.params) } : null;
    case 'calibration':
      return msg.cmd === 'start' || msg.cmd === 'cancel' ? { t: 'calibration', cmd: msg.cmd } : null;
    case 'voice-host':
      return { t: 'voice-host', ready: msg.ready === true };
    case 'voice-event': {
      const event = parseSpeechEvent(msg.event);
      return event ? { t: 'voice-event', event } : null;
    }
    default:
      return null;
  }
}

// ---- runtime messages to / from the service worker ---------------------------

export type BrowserCommand =
  | 'back'
  | 'forward'
  | 'reload'
  | 'newTab'
  | 'closeTab'
  | 'nextTab'
  | 'prevTab'
  | 'switchTab'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'search'
  | 'openUrl'
  | 'navigate'
  | 'duplicateTab'
  | 'openDashboard';

const BROWSER_COMMANDS: readonly BrowserCommand[] = [
  'back',
  'forward',
  'reload',
  'newTab',
  'closeTab',
  'nextTab',
  'prevTab',
  'switchTab',
  'zoomIn',
  'zoomOut',
  'zoomReset',
  'search',
  'openUrl',
  'navigate',
  'duplicateTab',
  'openDashboard',
];

/*
 * The engine runs in an offscreen document, where chrome.runtime is the only
 * extension API available. It therefore reads and writes settings, and
 * reports fatal errors, through the service worker.
 */
export type WorkerRequest =
  | { type: 'hf/enable' }
  | { type: 'hf/disable' }
  | { type: 'hf/state' }
  | { type: 'hf/active-tab' }
  | { type: 'hf/settings' }
  | { type: 'hf/settings-patch'; patch: Record<string, unknown> }
  | { type: 'hf/engine-error'; where: string; message: string }
  | { type: 'hf/browser'; cmd: BrowserCommand; number?: number; text?: string };

export interface ActiveTabInfo {
  tabId: number | null;
  controllable: boolean;
  reason: string;
}

export interface WorkerResponse {
  ok: boolean;
  enabled?: boolean;
  error?: string;
  activeTab?: ActiveTabInfo;
  /** Raw stored settings; the receiver sanitizes them. */
  settings?: unknown;
}

export function parseWorkerRequest(msg: unknown): WorkerRequest | null {
  if (!isRec(msg)) return null;
  switch (msg.type) {
    case 'hf/enable':
    case 'hf/disable':
    case 'hf/state':
    case 'hf/active-tab':
    case 'hf/settings':
      return { type: msg.type };
    case 'hf/settings-patch':
      return isRec(msg.patch) ? { type: 'hf/settings-patch', patch: msg.patch } : null;
    case 'hf/engine-error':
      return str(msg.where, 200) && str(msg.message, 2000)
        ? { type: 'hf/engine-error', where: msg.where, message: msg.message }
        : null;
    case 'hf/browser':
      if (!BROWSER_COMMANDS.includes(msg.cmd as BrowserCommand)) return null;
      return {
        type: 'hf/browser',
        cmd: msg.cmd as BrowserCommand,
        number: typeof msg.number === 'number' && Number.isFinite(msg.number) ? Math.trunc(msg.number) : undefined,
        text: str(msg.text, 4096) ? msg.text : undefined,
      };
    default:
      return null;
  }
}

/** Service worker -> engine. */
export type EngineControl =
  | { type: 'hf/engine'; kind: 'active-tab'; info: ActiveTabInfo }
  | { type: 'hf/engine'; kind: 'action'; action: ActionId }
  /** Stored settings changed. Raw value; the engine sanitizes it. */
  | { type: 'hf/engine'; kind: 'settings'; settings: unknown }
  | { type: 'hf/engine'; kind: 'shutdown' };

export function parseEngineControl(msg: unknown): EngineControl | null {
  if (!isRec(msg) || msg.type !== 'hf/engine') return null;
  if (msg.kind === 'shutdown') return { type: 'hf/engine', kind: 'shutdown' };
  if (msg.kind === 'settings') return { type: 'hf/engine', kind: 'settings', settings: msg.settings };
  if (msg.kind === 'action' && isActionId(msg.action)) return { type: 'hf/engine', kind: 'action', action: msg.action };
  if (msg.kind === 'active-tab' && isRec(msg.info)) {
    const info = msg.info;
    return {
      type: 'hf/engine',
      kind: 'active-tab',
      info: {
        tabId: typeof info.tabId === 'number' ? info.tabId : null,
        controllable: info.controllable === true,
        reason: str(info.reason, 300) ? info.reason : '',
      },
    };
  }
  return null;
}

/** True when a message was sent by one of this extension's own pages (not a content script). */
export function isFromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}
