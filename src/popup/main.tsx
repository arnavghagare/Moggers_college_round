import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { modeLabel } from '../core/handsfreeCore';
import { Alert, Chip, Segmented } from '../dashboard/components';
import { EngineProvider, useAppearance, useEngine } from '../dashboard/engine';
import { MODES, currentMode, modePatch } from '../dashboard/modes';
import { describeRun } from '../dashboard/runState';
import '../dashboard/styles.css';

function openDashboard(route: string): void {
  void chrome.runtime.sendMessage({ type: 'hf/browser', cmd: 'openDashboard', text: route });
  window.close();
}

function Popup() {
  const engine = useEngine();
  const { status, enabled, settings } = engine;
  useAppearance(settings);
  const run = describeRun(enabled, status, currentMode(settings.controlMode).name);
  const paused = run.paused;

  if (!engine.loaded) return <div className="popup-root muted">Loading...</div>;

  return (
    <div className="popup-root">
      <div className="brand" style={{ padding: 0 }}>
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">Handsfree</span>
      </div>

      <div className="row">
        <Chip tone={!enabled ? '' : status?.phase === 'active' ? 'ok' : status?.phase === 'error' ? 'bad' : 'warn'}>
          {!enabled ? 'Off' : status ? (paused ? 'Actions paused' : status.phase === 'active' ? 'Browsing enabled' : status.phase === 'error' ? 'Stopped' : 'Starting') : 'Connecting'}
        </Chip>
        {enabled && <Chip>{modeLabel(settings.controlMode)}</Chip>}
        {status?.camera.state === 'on' && <Chip tone="live">Camera on</Chip>}
        {status?.voice.state === 'listening' && <Chip tone="live">Mic listening</Chip>}
      </div>

      {status?.error && (
        <Alert tone="bad" title={status.error.message}>
          {status.error.recovery}
        </Alert>
      )}
      {status && !status.error && !status.page.controllable && (
        <Alert tone="warn" title="This tab cannot be controlled">
          {status.page.reason}
        </Alert>
      )}
      {engine.lastError && (
        <Alert tone="bad" title="Could not change the Handsfree state">
          {engine.lastError}
        </Alert>
      )}

      {!settings.onboarded ? (
        <button type="button" className="btn primary big" onClick={() => openDashboard('welcome')}>
          Set up Handsfree
        </button>
      ) : (
        <button
          type="button"
          className={`btn big ${enabled ? 'danger' : 'primary'}`}
          disabled={engine.busy}
          onClick={() => void (enabled ? engine.disable() : engine.enable())}
        >
          {engine.busy ? (enabled ? 'Turning off...' : 'Turning on...') : enabled ? 'Turn off' : 'Turn on Handsfree'}
        </button>
      )}
      {settings.onboarded && (
        <Segmented
          label="Mode"
          value={currentMode(settings.controlMode).id}
          options={MODES.map((m) => ({ value: m.id, label: `${m.emoji} ${m.name.replace(' mode', '')}` }))}
          onChange={(id) => engine.patch(modePatch(id))}
        />
      )}
      {enabled && status && status.phase !== 'error' && status.phase !== 'loading' && (
        <button type="button" className={`btn${paused ? ' primary' : ''}`} onClick={() => engine.act('toggle_pause')}>
          {run.awaitingStart ? 'Start browsing' : paused ? 'Resume' : 'Pause'}
        </button>
      )}
      <button type="button" className="btn" onClick={() => openDashboard('')}>
        Open dashboard
      </button>
      <p className="muted small" style={{ margin: 0 }}>
        <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> pauses at any time.
      </p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* The popup shows status only; it is not a page for the cursor to control. */}
    <EngineProvider controllable={false}>
      <Popup />
    </EngineProvider>
  </StrictMode>,
);
