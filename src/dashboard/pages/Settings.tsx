import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { saveSettings } from '../../shared/storage';
import { Alert, PageHead, Segmented, Select, Slider, Switch, ms } from '../components';
import { navigate, useEngine } from '../engine';

function useCameras(refreshKey: unknown): Array<{ value: string; label: string }> {
  const [devices, setDevices] = useState<Array<{ value: string; label: string }>>([]);
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      navigator.mediaDevices
        .enumerateDevices()
        .then((all) => {
          if (!alive) return;
          setDevices(all.filter((d) => d.kind === 'videoinput' && d.deviceId).map((d, i) => ({ value: d.deviceId, label: d.label || `Camera ${i + 1}` })));
        })
        .catch(() => undefined);
    };
    load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => {
      alive = false;
      navigator.mediaDevices.removeEventListener('devicechange', load);
    };
  }, [refreshKey]);
  return devices;
}

const CURSOR_COLORS = ['#ccff00', '#ff4fa3', '#b388ff', '#ff8a00', '#ffffff'];

export function Settings() {
  const engine = useEngine();
  const { settings, status } = engine;
  const k = settings.click;
  const cameras = useCameras(status?.camera.state);
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <>
      <PageHead title="Settings" lead="Looks, clicking, safety and privacy. Mode-specific settings live on each mode's page." />

      <div className="grid two" style={{ alignItems: 'start' }}>
        <section className="card stack">
          <h2>Looks</h2>
          <Segmented
            label="Theme"
            value={settings.theme}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
              { value: 'system', label: 'System' },
            ]}
            onChange={(theme) => engine.patch({ theme })}
          />
          <Slider label="Text size" hint="This dashboard and the status bar on web pages." value={settings.textScale} min={0.85} max={1.6} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(textScale) => engine.patch({ textScale })} />
          <Slider label="Cursor size" value={settings.cursor.size} min={12} max={96} step={2} format={(v) => `${v} px`} onChange={(size) => engine.patch({ cursor: { size } })} />
          <div className="field">
            <label htmlFor="cursor-color">Cursor colour</label>
            <div className="row">
              <input id="cursor-color" type="color" value={settings.cursor.color} onChange={(e) => engine.patch({ cursor: { color: e.target.value } })} />
              {CURSOR_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className="btn small"
                  aria-label={`Use colour ${color}`}
                  aria-pressed={settings.cursor.color.toLowerCase() === color}
                  style={{ background: color, width: 48, borderColor: '#0c0c0c' }}
                  onClick={() => engine.patch({ cursor: { color } })}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="card stack">
          <h2>Clicking</h2>
          <Switch label="Dwell click" hint="Rest the cursor on something to click it." checked={k.dwellEnabled} onChange={(dwellEnabled) => engine.patch({ click: { dwellEnabled } })} />
          <Slider label="Dwell time" value={k.dwellMs} min={400} max={4000} step={50} format={ms} onChange={(dwellMs) => engine.patch({ click: { dwellMs } })} disabled={!k.dwellEnabled} />
          <Slider label="Wobble allowed" hint="How far the cursor may wander during the countdown before it cancels." value={k.dwellRadiusPx} min={10} max={120} step={2} format={(v) => `${v} px`} onChange={(dwellRadiusPx) => engine.patch({ click: { dwellRadiusPx } })} disabled={!k.dwellEnabled} />
          <Switch label="Only on links, buttons and boxes" hint="Recommended. When off, resting anywhere clicks there." checked={k.dwellInteractiveOnly} onChange={(dwellInteractiveOnly) => engine.patch({ click: { dwellInteractiveOnly } })} disabled={!k.dwellEnabled} />
          <Select
            label="Ask before clicking"
            value={k.confirmPolicy}
            options={[
              { value: 'risky', label: 'Risky-looking buttons (delete, buy, submit...)' },
              { value: 'always', label: 'Every click' },
              { value: 'never', label: 'Never' },
            ]}
            hint="Judged from the button's own words. It cannot spot every dangerous button on every site."
            onChange={(confirmPolicy) => engine.patch({ click: { confirmPolicy } })}
          />
          <Slider label="Scroll step" hint='How far "scroll down" goes.' value={k.scrollStepRatio} min={0.2} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}% of a page`} onChange={(scrollStepRatio) => engine.patch({ click: { scrollStepRatio } })} />
          <Slider label="Most numbers on a page" value={settings.hints.maxLabels} min={20} max={400} step={10} onChange={(maxLabels) => engine.patch({ hints: { maxLabels } })} />
        </section>

        <section className="card stack">
          <h2>Safety</h2>
          <Slider label="Warm-up lock" hint="After turning on or resuming, the cursor moves but nothing can be clicked for this long." value={settings.safety.graceMs} min={1000} max={10000} step={500} format={ms} onChange={(graceMs) => engine.patch({ safety: { graceMs } })} />
          <Slider label="Pause when tracking is lost for" hint="Dwell stops the instant tracking is lost. After this long, everything pauses." value={settings.safety.autoPauseMs} min={1500} max={30000} step={500} format={ms} onChange={(autoPauseMs) => engine.patch({ safety: { autoPauseMs } })} />
          <Slider label="Settle time" hint="When tracking comes back the cursor waits this long, then glides. It never jumps." value={settings.safety.settleMs} min={100} max={2000} step={50} format={ms} onChange={(settleMs) => engine.patch({ safety: { settleMs } })} />
          <Select
            label="After an automatic pause"
            value={settings.safety.resumeAfterLoss}
            options={[
              { value: 'auto', label: 'Carry on by itself when tracking is back' },
              { value: 'manual', label: 'Stay paused until I say "resume"' },
            ]}
            onChange={(resumeAfterLoss) => engine.patch({ safety: { resumeAfterLoss } })}
          />
          <ul className="ticks">
            <li>
              Say <span className="say">stop</span> to pause, <span className="say">resume</span> to continue.
            </li>
            <li>
              <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>P</kbd> pause, <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>H</kbd> on / off, <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>L</kbd> mute.
            </li>
            <li>While paused nothing is clicked, scrolled, typed or opened.</li>
          </ul>
        </section>

        <section className="card stack">
          <h2>Camera</h2>
          <Select
            label="Camera"
            value={settings.camera.deviceId ?? ''}
            options={[{ value: '', label: 'Default camera' }, ...cameras]}
            hint={cameras.length === 0 ? 'Names show up once the camera has been allowed.' : undefined}
            onChange={(id) => engine.patch({ camera: { deviceId: id || null } })}
          />
          <Slider label="Top frame rate" hint="Lower is easier on the processor." value={settings.camera.maxFps} min={10} max={60} step={5} format={(v) => `${v} fps`} onChange={(maxFps) => engine.patch({ camera: { maxFps } })} />
          <Select
            label="Run tracking on"
            value={settings.camera.delegate}
            options={[
              { value: 'GPU', label: 'Graphics card (falls back to processor)' },
              { value: 'CPU', label: 'Processor only' },
            ]}
            hint={status ? `Right now: ${status.models.delegate}, ${status.perf.fps.toFixed(0)} fps` : undefined}
            onChange={(delegate) => engine.patch({ camera: { delegate } })}
          />
        </section>

        <section className="card stack">
          <h2>Privacy</h2>
          <ul className="ticks">
            <li>Camera frames are analysed on this computer by models built into the extension. Nothing is saved or sent anywhere.</li>
            <li>The camera views in this dashboard are live only. Not recorded.</li>
            <li>Lighting is judged from the average brightness of a tiny thumbnail that is thrown away at once.</li>
            <li>Voice uses Chrome's speech service: while listening, audio goes to Google. Turn voice off to stop that.</li>
            <li>Settings and calibration stay in this browser.</li>
            <li>New tabs open the Handsfree start page, because Chrome's own new tab page cannot be controlled by any extension.</li>
          </ul>
        </section>

        <section className="card stack">
          <h2>Reset</h2>
          <p className="muted small">Puts every setting, gesture and the calibration back to how they started.</p>
          {confirmReset ? (
            <Alert tone="warn" title="Reset everything?">
              <span className="row">
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => {
                    setConfirmReset(false);
                    void saveSettings({ ...DEFAULT_SETTINGS, onboarded: true });
                  }}
                >
                  Yes, reset
                </button>
                <button type="button" className="btn" onClick={() => setConfirmReset(false)}>
                  Keep my settings
                </button>
              </span>
            </Alert>
          ) : (
            <div className="row">
              <button type="button" className="btn danger" onClick={() => setConfirmReset(true)}>
                Reset all settings
              </button>
              <button type="button" className="btn" onClick={() => navigate('welcome')}>
                Run setup again
              </button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
