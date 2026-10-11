import { useEffect, useRef } from 'react';
import { CALIBRATION_STEPS, calibrationQualityLabel } from '../../core/calibration';
import { CamStage } from '../CamStage';
import { Alert, Chip, Meter, PageHead, Select, Slider, Switch, ms, pct } from '../components';
import { useEngine } from '../engine';
import { GestureGrid } from '../GestureCard';
import { StatusAlerts } from './Home';

const R = 44;
const CIRC = 2 * Math.PI * R;

export function Head({ autoStart }: { autoStart: boolean }) {
  const engine = useEngine();
  const { status, settings, enabled, calibration } = engine;
  const c = settings.cursor;
  const cal = status?.calibration;
  const running = cal?.active ?? false;
  const stored = settings.calibration;
  const isHead = settings.controlMode === 'head' || settings.controlMode === 'hybrid';
  const faceReady = status?.models.face === 'ready' && status.camera.state === 'on';
  const started = useRef(false);

  // Opened by the "recalibrate" voice command: begin as soon as tracking is ready.
  useEffect(() => {
    if (!autoStart || started.current || !faceReady || running) return;
    started.current = true;
    calibration('start');
    window.history.replaceState(null, '', '#/head');
  }, [autoStart, faceReady, running, calibration]);

  // Leaving the page abandons a run in progress.
  useEffect(() => () => calibration('cancel'), [calibration]);

  // Escape always gets a helper out of the full-screen view.
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') calibration('cancel');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, calibration]);

  const stepProgress = cal ? Math.min(1, Math.max(0, cal.progress * cal.totalSteps - cal.stepIndex)) : 0;

  return (
    <>
      <PageHead title="Head mode" lead="Your nose is the mouse. Turn your head to steer, rest on something to click it.">
        {!isHead && (
          <button type="button" className="btn primary big" onClick={() => engine.patch({ controlMode: 'head' })}>
            Use head mode
          </button>
        )}
        {isHead && <span className="sticker lime">{enabled ? 'Live now' : 'Selected'}</span>}
      </PageHead>

      <div className="stack">
        {!enabled && (
          <Alert tone="info" title="Handsfree is off">
            <span className="row between">
              <span>Turn it on to see yourself and calibrate.</span>
              <button type="button" className="btn primary" disabled={engine.busy} onClick={() => void engine.enable()}>
                Turn on
              </button>
            </span>
          </Alert>
        )}
        <StatusAlerts engine={engine} />
        {cal?.phase === 'failed' && (
          <Alert tone="bad" title="Calibration did not finish">
            {cal.message}
          </Alert>
        )}

        <div className="grid two" style={{ alignItems: 'start' }}>
          <div className="stack">
            <CamStage face title="Head tracking" />
            <div className="card flat">
              <dl className="kv">
                <dt>Turn (left / right)</dt>
                <dd>{status?.face.present ? `${status.face.yaw.toFixed(1)}°` : '-'}</dd>
                <dt>Tilt (up / down)</dt>
                <dd>{status?.face.present ? `${status.face.pitch.toFixed(1)}°` : '-'}</dd>
                <dt>Frames without a face</dt>
                <dd>{status ? pct(status.face.lossRate) : '-'}</dd>
                <dt>Jitter</dt>
                <dd>{status ? `${(status.face.jitter * 1000).toFixed(2)} / 1000` : '-'}</dd>
                <dt>Pose from</dt>
                <dd>{status?.face.poseSource === 'matrix' ? 'face geometry' : status?.face.poseSource === 'landmarks' ? 'landmarks (rough)' : '-'}</dd>
              </dl>
            </div>
          </div>

          <div className="stack">
            <section className="card">
              <h2>
                9-point <span className="hl">calibration</span>
              </h2>
              <p>
                Nine dots, one at a time. Point your nose at each and hold still. Handsfree fits a curve through all nine, so it
                learns how your head really moves, then tells you how accurate it is.
              </p>
              {stored ? (
                <div className="stack" style={{ gap: 12 }}>
                  <div className="row">
                    <span className="bigstat">{stored.error !== undefined ? `±${(stored.error * 100).toFixed(1)}%` : calibrationQualityLabel(stored.quality)}</span>
                    <span className="muted small">
                      {stored.error !== undefined ? 'of the screen, measured on dots the fit had not seen' : 'older calibration: run it again for a measured accuracy'}
                    </span>
                  </div>
                  <Meter value={stored.quality} label="Calibration quality" />
                  <div className="row">
                    <Chip tone={stored.quality >= 0.7 ? 'ok' : stored.quality >= 0.45 ? 'warn' : 'bad'}>{calibrationQualityLabel(stored.quality)}</Chip>
                    <Chip>{stored.fit?.pose ? '9-point fit' : 'range only'}</Chip>
                    <span className="muted small">{new Date(stored.createdAt).toLocaleString()}</span>
                  </div>
                </div>
              ) : (
                <p className="muted">Not calibrated yet. Head mode is using a default range around wherever you were looking when it started.</p>
              )}
              <div className="row" style={{ marginTop: 16 }}>
                <button type="button" className="btn primary big" disabled={!faceReady || running} onClick={() => calibration('start')}>
                  {stored ? 'Recalibrate' : 'Calibrate'}
                </button>
                <button type="button" className="btn" disabled={!status} onClick={() => engine.act('recenter')}>
                  Recentre
                </button>
                <button type="button" className="btn" disabled={!stored} onClick={() => engine.patch({ calibration: null })}>
                  Reset
                </button>
              </div>
              {enabled && !faceReady && (
                <p className="muted small" style={{ marginTop: 10 }}>
                  {status?.error
                    ? 'Calibration needs the camera. See the message above.'
                    : !isHead && !settings.features.faceGestures
                      ? 'Face tracking is not running in this mode. Press "Use head mode" to calibrate.'
                      : 'Waiting for the camera and face model...'}
                </p>
              )}
              {!enabled && <p className="muted small" style={{ marginTop: 10 }}>Turn Handsfree on to calibrate.</p>}
            </section>

            <section className="card">
              <h2>Where the cursor is</h2>
              <p>The cursor on the page you are controlling.</p>
              <div className="minimap" aria-hidden="true">
                {status && status.cursorSource !== 'none' && <i style={{ left: `${status.cursor.x * 100}%`, top: `${status.cursor.y * 100}%` }} />}
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                <Chip>{status ? `x ${pct(status.cursor.x)} · y ${pct(status.cursor.y)}` : 'no cursor'}</Chip>
                {status?.cursor.settling && <Chip tone="warn">Settling</Chip>}
              </div>
            </section>
          </div>
        </div>

        <div className="grid two" style={{ alignItems: 'start' }}>
          <section className="card stack">
            <h2>Feel</h2>
            <Slider label="Sensitivity" hint="How far the cursor goes for the same head turn." value={c.sensitivity} min={0.3} max={3} step={0.05} format={(v) => `${v.toFixed(2)}x`} onChange={(sensitivity) => engine.patch({ cursor: { sensitivity } })} />
            <Slider label="Smoothing" hint="Higher is steadier on small targets, a touch slower to follow." value={c.smoothing} min={0} max={1} step={0.05} format={pct} onChange={(smoothing) => engine.patch({ cursor: { smoothing } })} />
            <Slider label="Dead zone" hint="Movement smaller than this is ignored, so tremor does not move the cursor." value={c.deadZone} min={0} max={0.03} step={0.001} format={(v) => `${(v * 100).toFixed(1)}%`} onChange={(deadZone) => engine.patch({ cursor: { deadZone } })} />
            <Slider label="Acceleration" hint="More precision in the middle of the screen, edges still reachable." value={c.acceleration} min={0} max={1} step={0.05} format={pct} onChange={(acceleration) => engine.patch({ cursor: { acceleration } })} />
          </section>

          <section className="card stack">
            <h2>Clicking</h2>
            <Switch label="Dwell click" hint="Rest on a link or button. A ring fills, then it clicks. Move away to cancel." checked={settings.click.dwellEnabled} onChange={(dwellEnabled) => engine.patch({ click: { dwellEnabled } })} />
            <Slider label="Dwell time" value={settings.click.dwellMs} min={400} max={4000} step={50} format={ms} onChange={(dwellMs) => engine.patch({ click: { dwellMs } })} disabled={!settings.click.dwellEnabled} />
            <Switch label="Voice assist" hint='Say "click", "scroll down", "go back" while steering with your head.' checked={settings.features.voice} onChange={(voice) => engine.patch({ features: { voice } })} />
            <Switch label="Hand gestures too" hint="Pinch to click and raise a hand to pause, while your head steers." checked={settings.features.handGestures} onChange={(handGestures) => engine.patch({ features: { handGestures } })} />
          </section>

          <section className="card stack">
            <h2>Advanced</h2>
            <Select
              label="Steer with"
              value={c.headSource}
              options={[
                { value: 'pose', label: 'Head rotation (turning and tilting)' },
                { value: 'position', label: 'Nose position in the picture' },
              ]}
              hint="Rotation needs less movement. Position can suit people who move their whole upper body."
              onChange={(headSource) => engine.patch({ cursor: { headSource } })}
            />
            <Select
              label="Pointer style"
              value={c.dynamics}
              options={[
                { value: 'absolute', label: 'Direct: one head position, one screen position' },
                { value: 'relative', label: 'Mouse-like: movement nudges the cursor' },
              ]}
              onChange={(dynamics) => engine.patch({ cursor: { dynamics } })}
            />
            <Switch label="Flip left / right" checked={c.invertX} onChange={(invertX) => engine.patch({ cursor: { invertX } })} />
            <Switch label="Flip up / down" checked={c.invertY} onChange={(invertY) => engine.patch({ cursor: { invertY } })} />
            <Select
              label="If I shift in my seat"
              value={settings.drift}
              options={[
                { value: 'suggest', label: 'Tell me, and let me recentre' },
                { value: 'auto', label: 'Adapt slowly by itself' },
                { value: 'off', label: 'Do nothing' },
              ]}
              onChange={(drift) => engine.patch({ drift })}
            />
          </section>
        </div>

        <section className="stack">
          <div className="row between">
            <div>
              <h2>Face gestures</h2>
              <p className="muted small">Optional click methods for head mode. Each needs a deliberate, held expression. Natural blinks never do anything.</p>
            </div>
            <div style={{ minWidth: 250 }}>
              <Switch label="Face gestures" checked={settings.features.faceGestures} onChange={(faceGestures) => engine.patch({ features: { faceGestures } })} />
            </div>
          </div>
          {settings.features.faceGestures ? (
            <GestureGrid kinds={['face']} />
          ) : (
            <p className="muted">Off. Turn them on to choose a blink, eyebrow raise, smile or open mouth as a click.</p>
          )}
        </section>
      </div>

      {running && cal && (
        <div className="cal-stage" role="dialog" aria-modal="true" aria-label="Calibration in progress">
          {CALIBRATION_STEPS.map((step, i) => {
            const state = i === cal.stepIndex ? 'current' : i < cal.stepIndex ? 'done' : '';
            return (
              <span key={step.id} className={`cal-dot ${state}`} style={{ left: `${step.target.x * 100}%`, top: `${step.target.y * 100}%` }} aria-hidden="true">
                {i < cal.stepIndex ? '✓' : i + 1}
                {state === 'current' && (
                  <svg className="cal-ring" viewBox="0 0 100 100">
                    <circle cx="50" cy="50" r={R} strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - stepProgress)} />
                  </svg>
                )}
              </span>
            );
          })}
          <div className="cal-center">
            <CamStage face title="Point your nose at the glowing dot" />
            <div className="cal-panel" aria-live="assertive">
              <p className="instruction">{cal.message}</p>
              <Meter value={cal.progress} label="Calibration progress" />
              <div className="row" style={{ justifyContent: 'center' }}>
                <Chip>
                  Dot {Math.min(cal.stepIndex + 1, cal.totalSteps)} of {cal.totalSteps}
                </Chip>
                <Chip tone={status?.face.present ? 'ok' : 'bad'}>{status?.face.present ? 'Face in view' : 'Face not visible'}</Chip>
                <button type="button" className="btn small" onClick={() => calibration('cancel')}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
