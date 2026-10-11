import {
  isFromExtensionPage,
  parseWorkerRequest,
  type ActiveTabInfo,
  type BrowserCommand,
  type EngineControl,
  type WorkerResponse,
} from '../shared/messages';
import { isWebUrl } from '../core/voice/sites';
import type { DeepPartial, Settings } from '../shared/settings';
import { ENGINE_ERROR_KEY, RUNTIME_KEY, SETTINGS_KEY, loadSettings, patchSettings } from '../shared/storage';

/**
 * Background service worker. It owns the privileged browser APIs: creating
 * the offscreen engine document, tab and navigation commands, and telling the
 * engine which tab is active.
 *
 * The worker can be suspended at any time, so it keeps no state in memory:
 * "is Handsfree on?" is answered by whether the offscreen document exists.
 */

const OFFSCREEN_URL = 'offscreen.html';
const DASHBOARD_URL = 'dashboard.html';

async function hasEngine(): Promise<boolean> {
  return chrome.offscreen.hasDocument();
}

function toEngine(message: EngineControl): void {
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

async function setBadge(enabled: boolean): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: '#0f766e' });
  await chrome.action.setBadgeText({ text: enabled ? 'ON' : '' });
  await chrome.action.setTitle({ title: enabled ? 'Handsfree is on' : 'Handsfree is off' });
}

// ---- active tab ---------------------------------------------------------------

function describeTab(tab: chrome.tabs.Tab | undefined): ActiveTabInfo {
  if (!tab || tab.id === undefined) return { tabId: null, controllable: false, reason: 'No active tab.' };
  const url = tab.url ?? tab.pendingUrl ?? '';
  const own = chrome.runtime.getURL('');
  let reason = '';
  if (url.startsWith(own)) reason = '';
  else if (url === '' || /^(chrome|edge|about|devtools|view-source|chrome-search|chrome-untrusted):/i.test(url)) {
    reason = 'Browser pages (new tab, settings, extensions) cannot be controlled by any extension. Voice tab commands still work: say "open new tab" or "go back".';
  } else if (/^chrome-extension:/i.test(url)) {
    reason = "Another extension's page cannot be controlled.";
  } else if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url)) {
    reason = 'The Chrome Web Store blocks extensions from interacting with it.';
  } else if (/^file:/i.test(url)) {
    reason = 'Local files need "Allow access to file URLs" enabled for Handsfree on the extensions page.';
  } else if (/\.pdf($|[?#])/i.test(url)) {
    reason = "Chrome's PDF viewer only partly supports page scripts; scrolling and clicking may not work here.";
  }
  const blocked = reason !== '' && !/^file:|\.pdf/i.test(url);
  return { tabId: tab.id, controllable: !blocked, reason };
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
  return tab;
}

async function reportActiveTab(): Promise<ActiveTabInfo> {
  const info = describeTab(await activeTab());
  if (await hasEngine()) toEngine({ type: 'hf/engine', kind: 'active-tab', info });
  return info;
}

chrome.tabs.onActivated.addListener(() => void reportActiveTab());
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void reportActiveTab();
});
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && (change.url !== undefined || change.status === 'complete')) void reportActiveTab();
});

// The engine cannot read storage itself, so settings changes are forwarded to it.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  void hasEngine().then((running) => {
    if (running) toEngine({ type: 'hf/engine', kind: 'settings', settings: changes[SETTINGS_KEY].newValue });
  });
});

// ---- enable / disable ---------------------------------------------------------------

/** Tabs that were open before Handsfree was installed or reloaded have no content script yet. */
async function injectIntoOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined || tab.discarded) return;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      } catch {
        // Protected page or the tab is gone: it simply stays uncontrolled.
      }
    }),
  );
}

async function enable(): Promise<WorkerResponse> {
  if (!(await hasEngine())) {
    await chrome.storage.local.remove(ENGINE_ERROR_KEY);
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification:
        'Runs webcam head and hand tracking and speech recognition for hands-free control while no extension page is visible.',
    });
  }
  await chrome.storage.local.set({ [RUNTIME_KEY]: { enabled: true } });
  await setBadge(true);
  void injectIntoOpenTabs();
  void reportActiveTab();
  return { ok: true, enabled: true };
}

async function disable(): Promise<WorkerResponse> {
  // Page agents watch this key and remove their overlays as soon as it flips.
  await chrome.storage.local.set({ [RUNTIME_KEY]: { enabled: false } });
  if (await hasEngine()) {
    toEngine({ type: 'hf/engine', kind: 'shutdown' });
    // Closing the document stops every media track it holds.
    await chrome.offscreen.closeDocument().catch(() => undefined);
  }
  await setBadge(false);
  return { ok: true, enabled: false };
}

/** After a browser restart or extension reload the engine is gone: make stored state agree. */
async function reconcile(): Promise<void> {
  const enabled = await hasEngine();
  await chrome.storage.local.set({ [RUNTIME_KEY]: { enabled } });
  await setBadge(enabled);
}

chrome.runtime.onStartup.addListener(() => void reconcile());
chrome.runtime.onInstalled.addListener((details) => {
  void reconcile();
  if (details.reason === 'install') void openDashboard('welcome');
});

// ---- browser commands ---------------------------------------------------------------

async function openDashboard(route = ''): Promise<void> {
  const base = chrome.runtime.getURL(DASHBOARD_URL);
  const url = `${base}#/${route}`;
  const existing = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(base));
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true, url });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

async function stepTab(delta: number): Promise<void> {
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true, windowType: 'normal' });
  const index = tabs.findIndex((t) => t.active);
  if (index < 0 || tabs.length < 2) return;
  const next = tabs[(index + delta + tabs.length) % tabs.length];
  if (next.id !== undefined) await chrome.tabs.update(next.id, { active: true });
}

async function runBrowserCommand(cmd: BrowserCommand, number?: number, text?: string): Promise<WorkerResponse> {
  const tab = await activeTab();
  const id = tab?.id;
  switch (cmd) {
    case 'back':
      if (id !== undefined) await chrome.tabs.goBack(id).catch(() => undefined);
      break;
    case 'forward':
      if (id !== undefined) await chrome.tabs.goForward(id).catch(() => undefined);
      break;
    case 'reload':
      if (id !== undefined) await chrome.tabs.reload(id);
      break;
    case 'newTab':
      await chrome.tabs.create({});
      break;
    case 'closeTab':
      if (id !== undefined) await chrome.tabs.remove(id);
      break;
    case 'nextTab':
      await stepTab(1);
      break;
    case 'prevTab':
      await stepTab(-1);
      break;
    case 'switchTab': {
      const tabs = await chrome.tabs.query({ lastFocusedWindow: true, windowType: 'normal' });
      const target = number !== undefined ? tabs[number - 1] : undefined;
      if (target?.id === undefined) return { ok: false, error: `There is no tab ${number ?? ''}.` };
      await chrome.tabs.update(target.id, { active: true });
      break;
    }
    case 'zoomIn':
    case 'zoomOut': {
      if (id === undefined) break;
      const current = await chrome.tabs.getZoom(id);
      const next =
        cmd === 'zoomIn'
          ? ZOOM_STEPS.find((z) => z > current + 0.01) ?? current
          : [...ZOOM_STEPS].reverse().find((z) => z < current - 0.01) ?? current;
      await chrome.tabs.setZoom(id, next).catch(() => undefined);
      break;
    }
    case 'zoomReset':
      if (id !== undefined) await chrome.tabs.setZoom(id, 0).catch(() => undefined);
      break;
    case 'search': {
      const query = (text ?? '').trim();
      if (!query) return { ok: false, error: 'Nothing to search for.' };
      // The query is only ever placed in a search URL, never navigated to directly.
      await chrome.tabs.create({ url: `https://www.google.com/search?q=${encodeURIComponent(query)}` });
      break;
    }
    case 'openUrl':
    case 'navigate': {
      // Only ordinary web addresses: never javascript:, data:, file: or browser-internal URLs.
      if (!text || !isWebUrl(text)) return { ok: false, error: 'That is not a web address.' };
      if (cmd === 'navigate' && id !== undefined) await chrome.tabs.update(id, { url: text });
      else await chrome.tabs.create({ url: text, openerTabId: id });
      break;
    }
    case 'duplicateTab':
      if (id !== undefined) await chrome.tabs.duplicate(id);
      break;
    case 'openDashboard':
      await openDashboard(/^[a-z]+(\?start=1)?$/.test(text ?? '') ? text : '');
      break;
  }
  return { ok: true };
}

// ---- messages -------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const request = parseWorkerRequest(raw);
  // Everything here is privileged: only this extension's own pages may ask.
  if (!request || !isFromExtensionPage(sender)) return false;

  const run = async (): Promise<WorkerResponse> => {
    switch (request.type) {
      case 'hf/enable':
        return enable();
      case 'hf/disable':
        return disable();
      case 'hf/state':
        return { ok: true, enabled: await hasEngine() };
      case 'hf/active-tab':
        return { ok: true, activeTab: describeTab(await activeTab()) };
      case 'hf/settings':
        return { ok: true, settings: await loadSettings() };
      case 'hf/settings-patch':
        // patchSettings merges onto the stored value and sanitizes the result.
        await patchSettings(request.patch as DeepPartial<Settings>);
        return { ok: true };
      case 'hf/engine-error':
        await chrome.storage.local.set({
          [ENGINE_ERROR_KEY]: { where: request.where, message: request.message, at: Date.now() },
        });
        return { ok: true };
      case 'hf/browser':
        return runBrowserCommand(request.cmd, request.number, request.text);
    }
  };
  run().then(sendResponse, (err: unknown) =>
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse),
  );
  return true;
});

// ---- keyboard shortcuts (for carers, setup and recovery) --------------------------------

chrome.commands.onCommand.addListener((command) => {
  void (async () => {
    const running = await hasEngine();
    if (command === 'toggle-handsfree') {
      if (running) await disable();
      else if ((await loadSettings()).onboarded) await enable();
      else await openDashboard('welcome');
    } else if (command === 'toggle-pause' && running) {
      toEngine({ type: 'hf/engine', kind: 'action', action: 'toggle_pause' });
    } else if (command === 'toggle-listening' && running) {
      toEngine({ type: 'hf/engine', kind: 'action', action: 'toggle_listening' });
    }
  })();
});
