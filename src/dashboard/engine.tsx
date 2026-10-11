import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PageAgent, type AgentEvent } from '../agent/agent';
import { WebSpeechProvider } from '../engine/speech';
import type { ActionId, ActionParams } from '../shared/actions';
import { STATUS_PORT, type ClientToEngine, type EngineToClient, type WorkerRequest, type WorkerResponse } from '../shared/messages';
import { DEFAULT_SETTINGS, applyPatch, type DeepPartial, type Settings } from '../shared/settings';
import { ENGINE_ERROR_KEY, loadRuntime, loadSettings, onRuntimeChanged, onSettingsChanged, patchSettings } from '../shared/storage';
import type { DiagFrame, EngineStatus } from '../shared/types';

type FrameListener = (frame: DiagFrame) => void;

export interface EngineApi {
  /** Settings and on/off state have been read from storage. */
  loaded: boolean;
  enabled: boolean;
  /** Live engine status, or null while Handsfree is off or still connecting. */
  status: EngineStatus | null;
  settings: Settings;
  patch(patch: DeepPartial<Settings>): void;
  /** Resolve to true when the change went through; a failure is left in `lastError`. */
  enable(): Promise<boolean>;
  disable(): Promise<boolean>;
  busy: boolean;
  lastError: string | null;
  clearError(): void;
  /** A fatal error reported by the engine document itself, if it crashed. */
  engineError: string | null;
  act(action: ActionId, params?: ActionParams): void;
  calibration(cmd: 'start' | 'cancel'): void;
  /** Receive raw landmark frames while subscribed (used by the Lab). */
  onFrame(listener: FrameListener): () => void;
}

const EngineContext = createContext<EngineApi | null>(null);

/** Events from the page agent running in this dashboard tab (used by the benchmark). */
export const agentBus = new EventTarget();
export type AgentBusEvent = CustomEvent<AgentEvent>;

async function ask(request: WorkerRequest): Promise<WorkerResponse> {
  const response = (await chrome.runtime.sendMessage(request)) as WorkerResponse | undefined;
  return response ?? { ok: false, error: 'The Handsfree background service did not respond.' };
}

export function EngineProvider({ children, controllable = true }: { children: ReactNode; controllable?: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);

  const portRef = useRef<chrome.runtime.Port | null>(null);
  const listeners = useRef(new Set<FrameListener>());
  const voiceCtl = useRef<((listen: boolean, lang: string) => void) | null>(null);
  /** Settings writes from this page that storage has not confirmed yet. */
  const pendingWrites = useRef(0);

  // ---- settings and on/off state ----
  useEffect(() => {
    let alive = true;
    void Promise.all([loadSettings(), loadRuntime(), ask({ type: 'hf/state' }).catch(() => null)]).then(([s, runtime, state]) => {
      if (!alive) return;
      setSettings(s);
      setEnabled(state?.enabled ?? runtime.enabled);
      setLoaded(true);
    });
    // While this page is still writing, storage echoes are older than what is on screen:
    // applying them would make a slider jump back under the pointer.
    const offSettings = onSettingsChanged((s) => {
      if (pendingWrites.current === 0) setSettings(s);
    });
    const offRuntime = onRuntimeChanged((r) => setEnabled(r.enabled));
    const readError = (value: unknown): void => {
      const message = (value as { message?: unknown } | undefined)?.message;
      setEngineError(typeof message === 'string' ? message : null);
    };
    void chrome.storage.local.get(ENGINE_ERROR_KEY).then((stored) => alive && readError(stored[ENGINE_ERROR_KEY]));
    const onStored = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area === 'local' && changes[ENGINE_ERROR_KEY]) readError(changes[ENGINE_ERROR_KEY].newValue);
    };
    chrome.storage.onChanged.addListener(onStored);
    return () => {
      alive = false;
      offSettings();
      offRuntime();
      chrome.storage.onChanged.removeListener(onStored);
    };
  }, []);

  const send = useCallback((msg: ClientToEngine) => {
    try {
      portRef.current?.postMessage(msg);
    } catch {
      portRef.current = null;
    }
  }, []);

  // ---- status port ----
  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      setConnected(false);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      if (!alive) return;
      const port = chrome.runtime.connect({ name: STATUS_PORT });
      portRef.current = port;
      port.onMessage.addListener((msg: EngineToClient) => {
        if (msg.t === 'status') {
          setStatus(msg.status);
          setConnected(true);
        } else if (msg.t === 'frame') {
          for (const listener of listeners.current) listener(msg.frame);
        } else if (msg.t === 'voice-ctl') {
          voiceCtl.current?.(msg.listen, msg.lang);
        }
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (portRef.current === port) portRef.current = null;
        setConnected(false);
        // The engine is gone: a frozen "live" status would be misleading.
        setStatus(null);
        // The engine may still be starting: keep trying while Handsfree is on.
        if (alive) timer = setTimeout(connect, 700);
      });
      if (listeners.current.size > 0) port.postMessage({ t: 'subscribe', diag: true } satisfies ClientToEngine);
    };
    connect();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      try {
        portRef.current?.disconnect();
      } catch {
        /* already closed */
      }
      portRef.current = null;
    };
  }, [enabled]);

  // ---- this tab is also a page Handsfree can control ----
  useEffect(() => {
    if (!enabled || !controllable) return;
    const agent = new PageAgent({
      kind: 'extension',
      onEvent: (event) => agentBus.dispatchEvent(new CustomEvent('agent', { detail: event })),
    });
    void agent.start();
    return () => agent.stop();
  }, [enabled, controllable]);

  // ---- optional: host speech recognition in this tab ----
  const hostVoice = enabled && connected && controllable && settings.voice.host === 'dashboard';
  useEffect(() => {
    if (!hostVoice) return;
    const provider = new WebSpeechProvider((event) => send({ t: 'voice-event', event }));
    voiceCtl.current = (listen, lang) => (listen ? provider.start(lang) : provider.stop());
    send({ t: 'voice-host', ready: true });
    return () => {
      voiceCtl.current = null;
      provider.dispose();
      send({ t: 'voice-host', ready: false });
    };
  }, [hostVoice, send]);

  // The functions are stable across renders, so effects can depend on them
  // without re-running every time a status update arrives.
  const run = useCallback(async (request: WorkerRequest): Promise<boolean> => {
    setBusy(true);
    setLastError(null);
    try {
      const response = await ask(request);
      if (!response.ok) {
        setLastError(response.error ?? 'Something went wrong.');
        return false;
      }
      if (response.enabled !== undefined) setEnabled(response.enabled);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLastError(/context invalidated/i.test(message) ? 'Handsfree was reloaded. Refresh this page to carry on.' : message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  const patch = useCallback((change: DeepPartial<Settings>): void => {
    // Update the UI immediately; storage is the source of truth for every other context.
    setSettings((current) => applyPatch(current, change));
    pendingWrites.current += 1;
    patchSettings(change).then(
      (stored) => {
        pendingWrites.current -= 1;
        // The last write has landed: settle on exactly what storage now holds.
        if (pendingWrites.current === 0) setSettings(stored);
      },
      (err: unknown) => {
        pendingWrites.current -= 1;
        setLastError(`That setting could not be saved: ${err instanceof Error ? err.message : String(err)}`);
        if (pendingWrites.current === 0) void loadSettings().then(setSettings, () => undefined);
      },
    );
  }, []);
  const clearError = useCallback(() => setLastError(null), []);
  const enable = useCallback(() => run({ type: 'hf/enable' }), [run]);
  const disable = useCallback(() => run({ type: 'hf/disable' }), [run]);
  const act = useCallback((action: ActionId, params?: ActionParams) => send({ t: 'action', action, params }), [send]);
  const calibration = useCallback((cmd: 'start' | 'cancel') => send({ t: 'calibration', cmd }), [send]);
  const onFrame = useCallback(
    (listener: FrameListener) => {
      listeners.current.add(listener);
      if (listeners.current.size === 1) send({ t: 'subscribe', diag: true });
      return () => {
        listeners.current.delete(listener);
        if (listeners.current.size === 0) send({ t: 'subscribe', diag: false });
      };
    },
    [send],
  );

  const api = useMemo<EngineApi>(
    () => ({
      loaded,
      enabled,
      status: enabled ? status : null,
      settings,
      patch,
      enable,
      disable,
      busy,
      lastError,
      clearError,
      engineError: enabled ? engineError : null,
      act,
      calibration,
      onFrame,
    }),
    [loaded, enabled, status, settings, busy, lastError, clearError, engineError, patch, enable, disable, act, calibration, onFrame],
  );

  return <EngineContext.Provider value={api}>{children}</EngineContext.Provider>;
}

export function useEngine(): EngineApi {
  const api = useContext(EngineContext);
  if (!api) throw new Error('useEngine must be used inside EngineProvider');
  return api;
}

/** Apply theme and text size to the document. */
export function useAppearance(settings: Settings): void {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const apply = (): void => {
      const theme = settings.theme === 'system' ? (media.matches ? 'light' : 'dark') : settings.theme;
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.setProperty('--scale', String(settings.textScale));
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [settings.theme, settings.textScale]);
}

export interface Route {
  path: string;
  query: URLSearchParams;
}

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return { path: path || '', query: new URLSearchParams(query) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onChange = (): void => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(path: string): void {
  window.location.hash = `#/${path}`;
}

export type PermissionName2 = 'camera' | 'microphone';
export type PermissionValue = 'granted' | 'denied' | 'prompt' | 'unknown';

/** Live browser permission state for the camera or microphone. */
export function usePermission(name: PermissionName2): PermissionValue {
  const [value, setValue] = useState<PermissionValue>('unknown');
  useEffect(() => {
    let status: PermissionStatus | null = null;
    let alive = true;
    const update = (): void => {
      if (alive && status) setValue(status.state);
    };
    navigator.permissions
      .query({ name: name as PermissionName })
      .then((s) => {
        status = s;
        update();
        s.addEventListener('change', update);
      })
      .catch(() => setValue('unknown'));
    return () => {
      alive = false;
      status?.removeEventListener('change', update);
    };
  }, [name]);
  return value;
}

/**
 * Ask for a media permission by opening the device briefly. The stream is
 * closed straight away; nothing is recorded.
 */
export async function requestMedia(kind: 'video' | 'audio'): Promise<{ ok: boolean; message: string }> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(kind === 'video' ? { video: true } : { audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return { ok: true, message: '' };
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    const device = kind === 'video' ? 'camera' : 'microphone';
    if (name === 'NotAllowedError') {
      return {
        ok: false,
        message: `Access to the ${device} was blocked. Click the ${device} icon in the address bar of this tab, choose "Always allow", then try again.`,
      };
    }
    if (name === 'NotFoundError') return { ok: false, message: `No ${device} was found. Connect one and try again.` };
    if (name === 'NotReadableError') {
      return { ok: false, message: `The ${device} is in use by another application. Close it and try again.` };
    }
    return { ok: false, message: `The ${device} could not be opened: ${err instanceof Error ? err.message : String(err)}` };
  }
}
