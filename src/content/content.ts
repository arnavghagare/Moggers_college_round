import { PageAgent } from '../agent/agent';
import { loadRuntime, onRuntimeChanged } from '../shared/storage';

/**
 * Content script entry. It stays dormant (no DOM changes, no listeners on the
 * page) until Handsfree is switched on, and removes everything again when it
 * is switched off.
 */
declare global {
  interface Window {
    __handsfreeAgentLoaded?: boolean;
  }
}

function main(): void {
  // Only the top frame hosts the cursor; same-origin frames are reached from it.
  if (window.top !== window) return;
  // The script can arrive twice (manifest + on-demand injection into open tabs).
  if (window.__handsfreeAgentLoaded) return;
  window.__handsfreeAgentLoaded = true;

  const agent = new PageAgent({ kind: 'content' });
  const apply = (enabled: boolean): void => {
    if (enabled) void agent.start();
    else agent.stop();
  };

  try {
    onRuntimeChanged((state) => apply(state.enabled));
    void loadRuntime().then(
      (state) => apply(state.enabled),
      () => undefined,
    );
  } catch {
    // Extension context is gone (reloaded or removed): nothing to do.
  }
}

main();
