import { useEffect, useState, type CSSProperties } from 'react';
import { VOICE_LANGUAGES } from '../../shared/settings';
import { Alert, Chip, Segmented, Slider, Switch, Ticker } from '../components';
import { navigate, requestMedia, useEngine, usePermission, type PermissionValue } from '../engine';
import { MODES, currentMode, modePatch } from '../modes';
import { Orb3D } from '../Orb3D';

const PERMISSION_TEXT: Record<PermissionValue, string> = {
  granted: 'Allowed',
  denied: 'Blocked',
  prompt: 'Not asked yet',
  unknown: 'Unknown',
};

export function Welcome() {
  const engine = useEngine();
  const { settings, patch, loaded } = engine;
  const [step, setStep] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const camera = usePermission('camera');
  const microphone = usePermission('microphone');
  const mode = currentMode(settings.controlMode);
  const needsCamera = mode.id !== 'voice';
  const needsMic = mode.id === 'voice' || settings.features.voice;
  const onboarded = settings.onboarded;

  // First run only: match the speech accent to the browser's English variant, if it is one we offer.
  useEffect(() => {
    if (!loaded || onboarded) return;
    const match = VOICE_LANGUAGES.find((l) => l.code.toLowerCase() === navigator.language.toLowerCase());
    if (match) patch({ voice: { lang: match.code } });
  }, [loaded, onboarded, patch]);

  // Devices that opened successfully here, for browsers that cannot report the permission state.
  const [opened, setOpened] = useState({ video: false, audio: false });

  const allow = async (kind: 'video' | 'audio'): Promise<void> => {
    setMessage(null);
    const result = await requestMedia(kind);
    if (result.ok) setOpened((o) => ({ ...o, [kind]: true }));
    else setMessage(result.message);
  };

  const finish = async (): Promise<void> => {
    patch({ onboarded: true, ...modePatch(mode.id) });
    // If it could not start, stay here: the reason is shown above the button.
    if (!(await engine.enable())) return;
    // Head mode goes straight to calibration; the others to their own page.
    navigate(mode.id === 'head' ? 'head?start=1' : mode.route);
  };

  const cameraOk = camera === 'granted' || (camera === 'unknown' && opened.video);
  const micOk = microphone === 'granted' || (microphone === 'unknown' && opened.audio);
  const cameraReady = !needsCamera || cameraOk;
  const micReady = !needsMic || micOk;

  return (
    <>
      <Ticker />
      <main className="welcome" style={{ '--mode': mode.color } as CSSProperties}>
        <div className="row between">
          <div className="brand" style={{ padding: 0 }}>
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-name">Handsfree</span>
          </div>
          {/* Running setup again is optional: there is always a way back. */}
          {onboarded && (
            <button type="button" className="btn small" onClick={() => navigate('')}>
              Back to dashboard
            </button>
          )}
        </div>
        <div className="steps" role="progressbar" aria-label="Setup progress" aria-valuemin={1} aria-valuemax={3} aria-valuenow={step + 1}>
          {[0, 1, 2].map((i) => (
            <span key={i} className={i <= step ? 'done' : ''} />
          ))}
        </div>

        {step === 0 && (
          <>
            <div className="hero-showcase">
              <div className="hero hero-editorial">
                <span className="eyebrow">HANDSFREE ONBOARDING</span>
                <h1 className="hero-title">
                  Browse with <span className="serif-accent hl">Zero</span> hands.
                </h1>
                <p className="muted" style={{ fontSize: '1.15rem', maxWidth: '58ch', lineHeight: 1.6 }}>
                  Your head, your hand or your voice becomes the mouse and keyboard. Vision runs entirely on-device from a standard webcam; voice uses Chrome's speech recognition.
                </p>
                <div className="row" style={{ marginTop: 8 }}>
                  <button type="button" className="btn primary big" onClick={() => setStep(1)}>
                    Get Started →
                  </button>
                </div>
              </div>
              <div className="orb-wrap" style={{ display: 'flex', justifyContent: 'center' }}>
                <Orb3D size={260} interactive={true} />
              </div>
            </div>

            <div className="feature-list">
              {MODES.map((m) => (
                <div key={m.id} className="card" style={{ '--mode': m.color } as CSSProperties}>
                  <span style={{ fontSize: '2.4rem' }} aria-hidden="true">
                    {m.emoji}
                  </span>
                  <h2>{m.name}</h2>
                  <p className="muted">{m.tagline}</p>
                </div>
              ))}
            </div>

            <section className="card">
              <h2>Your Privacy Architecture</h2>
              <ul className="ticks" style={{ marginTop: 12 }}>
                <li>Camera frames never leave this computer. All neural processing runs locally in memory. Nothing is recorded or stored.</li>
                <li>The vision models ship inside the extension package. Zero external network telemetry for vision.</li>
                <li>Voice uses Chrome's built-in speech recognition, which sends mic audio to Google while it is listening. You can run completely without voice if preferred.</li>
                <li>Camera and mic indicators are always visible, and you can pause or disconnect anytime.</li>
              </ul>
            </section>
          </>
        )}

        {step === 1 && (
          <>
            <h1>
              Pick your <span className="hl">mode</span>
            </h1>
            <p className="muted">Start with one. You can switch any time, even by voice.</p>
            <div className="modes">
              {MODES.map((m) => {
                const chosen = mode.id === m.id;
                return (
                  <article key={m.id} className={`mode-card${chosen ? ' current' : ''}`} style={{ '--mode': m.color } as CSSProperties} aria-label={m.name}>
                    {chosen && <span className="sticker">Picked</span>}
                    <span className="emoji" aria-hidden="true">
                      {m.emoji}
                    </span>
                    <h2>{m.name}</h2>
                    <p>{m.tagline}</p>
                    <ul className="ticks">
                      {m.how.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                    <button type="button" className="btn" aria-pressed={chosen} onClick={() => patch(modePatch(m.id))}>
                      {chosen ? 'Picked' : `Pick ${m.name}`}
                    </button>
                  </article>
                );
              })}
            </div>
            <section className="card stack">
              <h2>Make it comfy</h2>
              {mode.id !== 'voice' && (
                <Switch
                  label="Voice assist"
                  hint='Also say "click", "scroll down", "go back". The quickest way to pause is saying "stop".'
                  checked={settings.features.voice}
                  onChange={(voice) => patch({ features: { voice } })}
                />
              )}
              <Slider label="Text size" value={settings.textScale} min={0.85} max={1.6} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(textScale) => patch({ textScale })} />
              <Segmented
                label="Theme"
                value={settings.theme}
                options={[
                  { value: 'dark', label: 'Dark' },
                  { value: 'light', label: 'Light' },
                  { value: 'system', label: 'System' },
                ]}
                onChange={(theme) => patch({ theme })}
              />
            </section>
            <div className="row">
              <button type="button" className="btn" onClick={() => setStep(0)}>
                Back
              </button>
              <button type="button" className="btn primary big" onClick={() => setStep(2)}>
                Continue
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1>
              Say <span className="hl">yes</span> to Chrome
            </h1>
            <p className="muted">Chrome asks once. Access is only used while Handsfree is on.</p>
            <section className="card stack">
              <div className="row between">
                <div>
                  <h3>Camera</h3>
                  <p className="muted small">{needsCamera ? 'Follows your head or hand. Frames stay on this computer.' : `Not needed for ${mode.name.toLowerCase()}.`}</p>
                </div>
                <div className="row">
                  <Chip tone={cameraOk ? 'ok' : camera === 'denied' ? 'bad' : ''}>{cameraOk ? 'Allowed' : PERMISSION_TEXT[camera]}</Chip>
                  {needsCamera && !cameraOk && (
                    <button type="button" className="btn primary" onClick={() => void allow('video')}>
                      Allow camera
                    </button>
                  )}
                </div>
              </div>
              <div className="divider" />
              <div className="row between">
                <div>
                  <h3>Microphone</h3>
                  <p className="muted small">{needsMic ? "For voice commands and dictation, through Chrome's speech recognition." : 'Voice is off, so the mic is not needed.'}</p>
                </div>
                <div className="row">
                  <Chip tone={micOk ? 'ok' : microphone === 'denied' ? 'bad' : ''}>{micOk ? 'Allowed' : PERMISSION_TEXT[microphone]}</Chip>
                  {needsMic && !micOk && (
                    <button type="button" className="btn primary" onClick={() => void allow('audio')}>
                      Allow microphone
                    </button>
                  )}
                </div>
              </div>
            </section>
            {message && (
              <Alert tone="bad" title="Permission problem">
                {message}
              </Alert>
            )}
            {engine.lastError && (
              <Alert tone="bad" title="Handsfree could not start">
                {engine.lastError}
              </Alert>
            )}
            <section className="card">
              <h2>Good to know</h2>
              <ul className="ticks" style={{ marginTop: 12 }}>
                <li>For the first 3 seconds the cursor moves but nothing can be clicked.</li>
                <li>
                  Say <span className="say">stop</span> or press <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>P</kbd> to pause at any moment.
                </li>
                <li>If tracking is lost for 5 seconds, Handsfree pauses itself.</li>
                <li>New tabs open a Handsfree start page, so the cursor keeps working there.</li>
              </ul>
            </section>
            <div className="row">
              <button type="button" className="btn" onClick={() => setStep(1)}>
                Back
              </button>
              <button type="button" className="btn primary big" disabled={!cameraReady || !micReady || engine.busy} onClick={() => void finish()}>
                {engine.busy ? 'Starting...' : 'Start Handsfree'}
              </button>
              {(!cameraReady || !micReady) && <span className="muted small">Allow the devices above to continue.</span>}
            </div>
          </>
        )}
      </main>
    </>
  );
}
