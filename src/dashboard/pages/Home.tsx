import type { CSSProperties } from 'react';
import { Alert, Chip, Tile, qualityText, qualityTone, type Tone } from '../components';
import { describeRun, voiceLabel } from '../runState';
import { navigate, useEngine, type EngineApi } from '../engine';
import { MODES, currentMode, modePatch } from '../modes';
import { Orb3D } from '../Orb3D';

const CAMERA_TEXT: Record<string, [string, Tone]> = {
  off: ['Off', ''],
  starting: ['Starting', 'warn'],
  on: ['On', 'live'],
  denied: ['Blocked', 'bad'],
  notfound: ['Not found', 'bad'],
  error: ['Error', 'bad'],
};

/** Problems and nudges, shown on every page that needs them. */
export function StatusAlerts({ engine }: { engine: EngineApi }) {
  const { status } = engine;
  return (
    <>
      {engine.lastError && (
        <Alert tone="bad" title="That did not work">
          <span className="row between">
            <span>{engine.lastError}</span>
            <button type="button" className="btn small" onClick={engine.clearError}>
              Dismiss
            </button>
          </span>
        </Alert>
      )}
      {engine.engineError && (
        <Alert tone="bad" title="The engine stopped unexpectedly">
          {engine.engineError} Turn Handsfree off and on again. If it keeps happening, reload the extension.
        </Alert>
      )}
      {status?.error && (
        <Alert tone="bad" title={status.error.message}>
          {status.error.recovery}
        </Alert>
      )}
      {status && !status.page.controllable && status.phase !== 'error' && (
        <Alert tone="warn" title="The tab you are on cannot be controlled">
          {status.page.reason}
        </Alert>
      )}
      {status?.lighting.advice && (
        <Alert tone="warn" title="Lighting">
          {status.lighting.advice}
        </Alert>
      )}
      {status?.postureShifted && (
        <Alert tone="warn" title="You seem to have shifted in your seat">
          <span className="row between">
            <span>The cursor may feel off-centre. Recentre it to match how you are sitting now.</span>
            <button type="button" className="btn small" onClick={() => engine.act('recenter')}>
              Recentre
            </button>
          </span>
        </Alert>
      )}
      {status?.perf.degraded && (
        <Alert tone="warn" title="Running in a lighter mode">
          Frames are taking longer than the budget, so hand tracking now runs every {status.perf.handEvery} frames.
        </Alert>
      )}
    </>
  );
}

export function Home() {
  const engine = useEngine();
  const { status, settings, enabled } = engine;
  const active = currentMode(settings.controlMode);
  const run = describeRun(enabled, status, active.name);
  const { paused, headline, detail } = run;
  const camera = CAMERA_TEXT[status?.camera.state ?? 'off'];
  const voice = voiceLabel(status?.voice);
  const hearing = status?.voice.state === 'listening' || status?.voice.state === 'starting' || status?.voice.state === 'reconnecting';

  return (
    <div className="stack" style={{ gap: 30 }}>
      <div className="hero-showcase">
        <header className="hero hero-editorial">
          <span className="eyebrow">HANDSFREE STUDIO · NEURAL VISION</span>
          <h1>
            The Hands-Free <span className="serif-accent hl">Experience</span>
          </h1>
          <p className="subhead">
            Zero physical touch. Absolute intent. Navigate, scroll, click and dictate across the web using standard webcam computer vision and speech recognition.
          </p>
          <div className="row" style={{ marginTop: 8 }}>
            <Chip tone="ok">Local Model Inference</Chip>
            <Chip tone="info">Up to 60 FPS Tracking</Chip>
            <Chip>Zero Footage Stored</Chip>
          </div>
        </header>

        <div className="orb-wrap" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <Orb3D size={280} interactive={true} />
        </div>
      </div>

      <section className={`power${enabled ? ' on' : ''}`} aria-label="Handsfree power">
        <div style={{ flex: '1 1 300px' }}>
          <h2>{headline}</h2>
          <p className="muted" style={{ fontWeight: 500, fontSize: '0.98rem' }}>
            {detail}
          </p>
        </div>
        <div className="row">
          {enabled && status && status.phase !== 'error' && status.phase !== 'loading' && (
            <button type="button" className={`btn big${paused ? ' primary' : ''}`} onClick={() => engine.act('toggle_pause')}>
              {run.awaitingStart ? 'Start' : paused ? 'Resume' : 'Pause'}
            </button>
          )}
          {enabled && status && settings.features.voice && (
            <button type="button" className="btn big" onClick={() => engine.act('toggle_listening')}>
              {hearing ? 'Stop listening' : status.voice.state === 'error' ? 'Reconnect voice' : 'Start listening'}
            </button>
          )}
          <button
            type="button"
            className={`btn big ${enabled ? 'danger' : 'primary'}`}
            disabled={engine.busy}
            onClick={() => void (enabled ? engine.disable() : engine.enable())}
          >
            {engine.busy ? (enabled ? 'Turning off...' : 'Turning on...') : enabled ? 'Turn off' : 'Turn on'}
          </button>
          {enabled && status?.phase === 'active' && (
            <button type="button" className="btn big" onClick={() => navigate('playground')}>
              Try the playground
            </button>
          )}
        </div>
      </section>

      <StatusAlerts engine={engine} />

      <section className="stack" aria-label="Choose a mode">
        <h2>
          Pick your <span className="hl">mode</span>
        </h2>
        <div className="modes">
          {MODES.map((mode) => {
            const isCurrent = active.id === mode.id;
            return (
              <article key={mode.id} className={`mode-card${isCurrent ? ' current' : ''}`} style={{ '--mode': mode.color } as CSSProperties} aria-label={mode.name}>
                {isCurrent && <span className="sticker">{enabled ? 'Live now' : 'Selected'}</span>}
                <span className="emoji" aria-hidden="true">
                  {mode.emoji}
                </span>
                <h2>{mode.name}</h2>
                <p>{mode.tagline}</p>
                <ul className="ticks">
                  {mode.how.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <span className="small" style={{ fontWeight: 800 }}>
                  Needs: {mode.needs}
                </span>
                <div className="row">
                  <button
                    type="button"
                    className="btn"
                    aria-pressed={isCurrent}
                    onClick={() => {
                      engine.patch(modePatch(mode.id));
                      navigate(mode.route);
                    }}
                  >
                    {isCurrent ? 'Open' : `Use ${mode.name}`}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="grid tiles" aria-label="Live status">
        <Tile label="Camera" value={camera[0]} tone={camera[1]} detail={status?.camera.label || undefined} />
        <Tile label="Voice" value={voice[0]} tone={voice[1]} detail={status?.voice.error ?? status?.voice.recovery ?? undefined} />
        <Tile
          label="Browsing actions"
          value={!status ? 'Off' : status.phase === 'active' ? 'Enabled' : status.phase === 'grace' ? 'Unlocking' : 'Paused'}
          tone={!status ? '' : status.phase === 'active' ? 'ok' : 'warn'}
          detail={status?.phase === 'paused' || status?.phase === 'suspended' ? (status.pausedReason ?? undefined) : undefined}
        />
        {settings.controlMode !== 'voice' && (
          <Tile
            label={settings.controlMode === 'hand' ? 'Hand tracking' : 'Face tracking'}
            value={
              !status
                ? 'Off'
                : settings.controlMode === 'hand'
                  ? status.hands.length
                    ? `${status.hands.length} in view`
                    : 'No hand'
                  : qualityText(status.face.quality)
            }
            tone={!status ? '' : settings.controlMode === 'hand' ? (status.hands.length ? qualityTone(status.handQuality) : '') : qualityTone(status.face.quality)}
          />
        )}
        <Tile
          label="Last heard"
          value={status?.voice.lastPhrase ? `"${status.voice.lastPhrase}"` : 'Nothing yet'}
          detail={status?.voice.lastStatus ? `${status.voice.lastIntent ?? 'not a command'} · ${status.voice.lastStatus}` : undefined}
        />
        <Tile label="Last command done" value={status?.voice.lastExecuted || 'Nothing yet'} />
        <Tile label="Clicks" value={status?.stats.clicks ?? 0} detail={`${status?.stats.canceledClicks ?? 0} cancelled`} />
        <Tile label="Speed" value={status && status.camera.state === 'on' ? `${status.perf.fps.toFixed(0)} fps` : '-'} detail={status && status.camera.state === 'on' ? `${status.perf.frameMs.toFixed(0)} ms a frame` : undefined} />
      </section>

      <section className="card">
        <h2>Three ways to stop</h2>
        <p>Whatever mode you are in, these always work.</p>
        <div className="row">
          <span className="say">say "pause" or "stop"</span>
          <span className="say plain">
            <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>P</kbd>
          </span>
          <span className="say plain">the Pause button up top</span>
          {status?.pending && <Chip tone="warn">Waiting for you: {status.pending.prompt}</Chip>}
        </div>
      </section>
    </div>
  );
}
