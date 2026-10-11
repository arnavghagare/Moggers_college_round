import { Engine } from '../engine/engine';
import type { WorkerRequest } from '../shared/messages';

/**
 * Offscreen document entry. The service worker creates this document when
 * Handsfree is switched on and closes it when it is switched off; closing it
 * releases the camera and microphone.
 */
const engine = new Engine();

/**
 * This document has no visible console, so fatal errors are handed to the
 * service worker, which stores them where the dashboard can show them.
 */
function report(where: string, err: unknown): void {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`[handsfree] ${where}`, err);
  const request: WorkerRequest = { type: 'hf/engine-error', where, message: message.slice(0, 2000) };
  chrome.runtime.sendMessage(request).catch(() => undefined);
}

window.addEventListener('error', (e) => report('uncaught error', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => report('unhandled rejection', e.reason));

engine.start().catch((err) => report('engine failed to start', err));

// The document is being torn down: stop media tracks and tell pages to clean up.
window.addEventListener('pagehide', () => engine.shutdown());
