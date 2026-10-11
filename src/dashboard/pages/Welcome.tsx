import { useEffect, useState, type CSSProperties } from 'react';
import { VOICE_LANGUAGES } from '../../shared/settings';
import { Alert, Chip, Segmented, Slider, Switch, Ticker } from '../components';
import { navigate, requestMedia, useEngine, usePermission, type PermissionValue } from '../engine';
import { MODES, currentMode } from '../modes';

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

  const allow = async (kind: 'video' | 'audio'): Promise<void> => {
    setMessage(null);
    const result = await requestMedia(kind);
    if (!result.ok) setMessage(result.message);
  };

  const finish = async (): Promise<void> => {
    patch({ onboarded: true, ...(mode.id === 'voice' ? { features: { voice: true } } : {}) });
    await engine.enable();
    // Head mode goes straight to calibration; the others to their own page.
    navigate(mode.id === 'head' ? 'head?start=1' : mode.route);
  };

  const cameraReady = !needsCamera || camera === 'granted';
  const micReady = !needsMic || microphone === 'granted';

  return (
    <>
      <Ticker />
      <main className="welcome" style={{ '--mode': mode.color } as CSSProperties}>
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Handsfree</span>
        </div>
        <div className="steps" role="progressbar" aria-label="Setup progress" aria-valuemin={1} aria-valuemax={3} aria-valuenow={step + 1}>
          {[0, 1, 2].map((i) => (
            <span key={i} className={i <= step ? 'done' : ''} />
          ))}
        </div>

        {step === 0 && (
          <>
            <h1 className="hero-title">
              Browse with <span className="hl">zero</span> hands.
            </h1>
            <p className="muted" style={{ fontSize: '1.2rem', maxWidth: '58ch', fontWeight: 600 }}>
              Your head, your hand or your voice becomes the mouse and keyboard. Just a normal webcam and mic. No extra gear.
            </p>
            <div className="feature-list">
              {MODES.map((m) => (
                <div key={m.id} className="card loud" style={{ '--pop': m.color } as CSSProperties}>
                  <span style={{ fontSize: '2.4rem' }} aria-hidden="true">
                    {m.emoji}
                  </span>
                  <h2>{m.name}</h2>
                  <p>{m.tagline}</p>
                </div>
              ))}
            </div>
            <section className="card">
              <h2>The privacy bit</h2>
              <ul className="ticks" style={{ marginTop: 12 }}>
                <li>Camera frames never leave this computer. Nothing is recorded or saved.</li>
                <li>The tracking models ship inside the extension. Nothing is downloaded or uploaded while you use it.</li>
                <li>Voice uses Chrome's speech recognition, which sends mic audio to Google while it is listening. You can skip voice completely.</li>
                <li>Camera and mic are only on while Handsfree is on, and you can always see when.</li>
              </ul>
            </section>
            <div className="row">
              <button type="button" className="btn primary big" onClick={() => setStep(1)}>
                Let's go
              </button>
            </div>
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
                    <button type="button" className="btn" aria-pressed={chosen} onClick={() => patch({ controlMode: m.id })}>
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
                  <Chip tone={camera === 'granted' ? 'ok' : camera === 'denied' ? 'bad' : ''}>{PERMISSION_TEXT[camera]}</Chip>
                  {needsCamera && camera !== 'granted' && (
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
                  <Chip tone={microphone === 'granted' ? 'ok' : microphone === 'denied' ? 'bad' : ''}>{PERMISSION_TEXT[microphone]}</Chip>
                  {needsMic && microphone !== 'granted' && (
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
                Start Handsfree
              </button>
              {(!cameraReady || !micReady) && <span className="muted small">Allow the devices above to continue.</span>}
            </div>
          </>
        )}
      </main>
    </>
  );
}
