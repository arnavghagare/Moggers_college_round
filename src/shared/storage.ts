import { applyPatch, sanitizeSettings, type DeepPartial, type Settings } from './settings';

export const SETTINGS_KEY = 'hf:settings';
/** `{ enabled: boolean }` - written by the service worker, watched by page agents. */
export const RUNTIME_KEY = 'hf:runtime';

/** `{ where, message, at }` - the last fatal error in the engine document, if any. */
export const ENGINE_ERROR_KEY = 'hf:engine-error';

export interface RuntimeState {
  enabled: boolean;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return sanitizeSettings(stored[SETTINGS_KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

/** Read-modify-write. Callers in one context are serialised to avoid lost updates. */
let queue: Promise<unknown> = Promise.resolve();
export function patchSettings(patch: DeepPartial<Settings>): Promise<Settings> {
  const next = queue.then(async () => {
    const updated = applyPatch(await loadSettings(), patch);
    await saveSettings(updated);
    return updated;
  });
  queue = next.catch(() => undefined);
  return next;
}

export function onSettingsChanged(listener: (settings: Settings) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    listener(sanitizeSettings(changes[SETTINGS_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

export async function loadRuntime(): Promise<RuntimeState> {
  const stored = await chrome.storage.local.get(RUNTIME_KEY);
  const value = stored[RUNTIME_KEY] as Partial<RuntimeState> | undefined;
  return { enabled: value?.enabled === true };
}

export function onRuntimeChanged(listener: (state: RuntimeState) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !changes[RUNTIME_KEY]) return;
    const value = changes[RUNTIME_KEY].newValue as Partial<RuntimeState> | undefined;
    listener({ enabled: value?.enabled === true });
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
