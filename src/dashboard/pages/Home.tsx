import type { CSSProperties } from 'react';
import { Alert, Chip, Tile, qualityText, qualityTone, type Tone } from '../components';
import { navigate, useEngine, type EngineApi } from '../engine';
import { MODES, currentMode } from '../modes';

const CAMERA_TEXT: Record<string, [string, Tone]> = {
  off: ['Off', ''],
  starting: ['Starting', 'warn'],
  on: ['On', 'live'],
  denied: ['Blocked', 'bad'],
  notfound: ['Not found', 'bad'],
  error: ['Error', 'bad'],
};

const VOICE_TEXT: Record<string, [string, Tone]> = {
  off: ['Off', ''],
  starting: ['Starting', 'warn'],
  listening: ['Listening', 'live'],
  muted: ['Muted', ''],
  error: ['Error', 'bad'],
};

/** Problems and nudges, shown on every page that needs them. */
export function StatusAlerts({ engine }: { engine: EngineApi }) {
  const { status } = engine;
  return (
    <>
      {engine.lastError && (
        <Alert tone="bad" title="That did not work">
          {engine.lastError}
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
  const paused = status?.phase === 'paused' || status?.phase === 'suspended';
  const active = currentMode(settings.controlMode);
  const camera = CAMERA_TEXT[status?.camera.state ?? 'off'];
  const voice = VOICE_TEXT[status?.voice.state ?? 'off'];

  const headline = !enabled
    ? 'Handsfree is off'
    : !status
      ? 'Connecting...'
      : paused
        ? 'Paused'
        : status.phase === 'grace'
          ? `Ready in ${Math.ceil(status.graceRemainingMs / 1000)}...`
          : status.phase === 'loading'
            ? 'Warming up'
            : status.phase === 'error'
              ? 'Stopped'
              : `${active.name} is live`;

  const detail = !enabled
    ? 'Camera and microphone are not in use.'
    : !status
      ? 'Starting the engine.'
      : paused
        ? `${status.pausedReason ?? 'Paused'}. Nothing can be clicked until you resume.`
        : status.phase === 'grace'
          ? 'The cursor moves, but clicks are locked for a moment so nothing fires by accident.'
          : status.phase === 'loading'
            ? 'Starting the camera and loading the tracking models.'
            : status.phase === 'error'
              ? 'Something went wrong. Details below.'
              : 'Open any site and go. Say "stop" to pause.';

  return (
    <div className="stack" style={{ gap: 30 }}>
      <header className="hero">
        <span className="eyebrow">Hands-free browsing</span>
        <h1>
          No hands. No mouse. <span className="hl pink">No problem.</span>
        </h1>
      </header>

      <section className={`power${enabled ? ' on' : ''}`} aria-label="Handsfree power">
        <div style={{ flex: '1 1 280px' }}>
          <h2>{headline}</h2>
          <p className="muted" style={{ fontWeight: 600 }}>
            {detail}
          </p>
        </div>
        <div className="row">
          {enabled && status && status.phase !== 'error' && status.phase !== 'loading' && (
            <button type="button" className="btn big" onClick={() => engine.act('toggle_pause')}>
              {paused ? 'Resume' : 'Pause'}
            </button>
          )}
          <button
            type="button"
            className={`btn big ${enabled ? 'danger' : 'primary'}`}
            disabled={engine.busy}
            onClick={() => void (enabled ? engine.disable() : engine.enable())}
          >
            {enabled ? 'Turn off' : 'Turn on'}
          </button>
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
                      engine.patch({ controlMode: mode.id });
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
        <Tile label="Microphone" value={voice[0]} tone={voice[1]} detail={status?.voice.error ?? (status?.voice.dictating ? 'Dictating' : undefined)} />
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
        <Tile label="Clicks" value={status?.stats.clicks ?? 0} detail={`${status?.stats.canceledClicks ?? 0} cancelled`} />
        <Tile label="Speed" value={status && status.camera.state === 'on' ? `${status.perf.fps.toFixed(0)} fps` : '-'} detail={status && status.camera.state === 'on' ? `${status.perf.frameMs.toFixed(0)} ms a frame` : undefined} />
      </section>

      <section className="card">
        <h2>Three ways to stop</h2>
        <p>Whatever mode you are in, these always work.</p>
        <div className="row">
          <span className="say">say "stop"</span>
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
