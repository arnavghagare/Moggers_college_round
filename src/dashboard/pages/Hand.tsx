import { gestureName } from '../../core/gestures/registry';
import { CamStage } from '../CamStage';
import { Alert, Chip, PageHead, Select, Slider, pct } from '../components';
import { useEngine } from '../engine';
import { GestureGrid, resetGestures } from '../GestureCard';
import { StatusAlerts } from './Home';

const FINGER_LABELS = ['T', 'I', 'M', 'R', 'L'];

export function Hand() {
  const engine = useEngine();
  const { status, settings, enabled } = engine;
  const c = settings.cursor;
  const isHand = settings.controlMode === 'hand';
  const hand = status?.hands[0];
  const log = status?.gestureLog ?? [];

  return (
    <>
      <PageHead title="Hand mode" lead="Point, pinch, done. Your hand moves the cursor and gestures do the rest.">
        {!isHand && (
          <button type="button" className="btn primary big" onClick={() => engine.patch({ controlMode: 'hand' })}>
            Use hand mode
          </button>
        )}
        {isHand && <span className="sticker">{enabled ? 'Live now' : 'Selected'}</span>}
      </PageHead>

      <div className="stack">
        {!enabled && (
          <Alert tone="info" title="Handsfree is off">
            <span className="row between">
              <span>Turn it on to see your hand tracked here.</span>
              <button type="button" className="btn primary" disabled={engine.busy} onClick={() => void engine.enable()}>
                Turn on
              </button>
            </span>
          </Alert>
        )}
        {enabled && !isHand && !settings.features.handGestures && (
          <Alert tone="info" title="Hand tracking is not running">
            You are in another mode with hand gestures switched off. Press "Use hand mode" to try it.
          </Alert>
        )}
        <StatusAlerts engine={engine} />

        <div className="grid two" style={{ alignItems: 'start' }}>
          <div className="stack">
            <CamStage hands mono title="Hand gesture detection" overlay={{ handArea: { cx: c.handCenterX, cy: c.handCenterY, size: c.handArea } }} />
            <section className="card">
              <h2>Set your reach</h2>
              <p>The dashed box is the part of the picture that maps to your whole screen. Put it where your hand is comfortable.</p>
              <div className="stack">
                <div className="row">
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!hand}
                    onClick={() => hand && engine.patch({ cursor: { handCenterX: hand.palm.x, handCenterY: hand.palm.y } })}
                  >
                    Centre the box on my hand
                  </button>
                  <button type="button" className="btn" onClick={() => engine.patch({ cursor: { handCenterX: 0.5, handCenterY: 0.55, handArea: 0.6 } })}>
                    Reset
                  </button>
                  {!hand && <span className="muted small">Hold a hand up first.</span>}
                </div>
                <Slider label="Box size" hint="Smaller = less arm movement to cross the screen, but twitchier." value={c.handArea} min={0.3} max={0.95} step={0.05} format={pct} onChange={(handArea) => engine.patch({ cursor: { handArea } })} />
                <Select
                  label="The cursor follows my"
                  value={c.handAnchor}
                  options={[
                    { value: 'knuckle', label: 'Index knuckle (steadiest when pinching)' },
                    { value: 'indexTip', label: 'Index fingertip' },
                    { value: 'palm', label: 'Palm' },
                  ]}
                  onChange={(handAnchor) => engine.patch({ cursor: { handAnchor } })}
                />
                <Slider label="Smoothing" value={c.smoothing} min={0} max={1} step={0.05} format={pct} onChange={(smoothing) => engine.patch({ cursor: { smoothing } })} />
              </div>
            </section>
          </div>

          <div className="stack">
            <section className="card">
              <h2>Gesture output</h2>
              <p>What your hand just said, and what Handsfree did about it. Newest first.</p>
              <div className="feed" aria-live="polite">
                {log.length === 0 && <span className="empty">Nothing yet. Try a pinch, a fist, or two fingers.</span>}
                {log.map((g, i) => (
                  <div key={`${g.t}-${g.id}-${i}`} style={{ display: 'contents' }}>
                    <div className="bubble">
                      {g.name}
                      <small>{pct(g.confidence)} sure</small>
                    </div>
                    <div className={`bubble reply${g.executed ? '' : ' blocked'}`}>
                      {g.executed ? g.action : `Blocked: ${g.reason ?? 'not allowed right now'}`}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="card">
              <h2>Right now</h2>
              <p>Read straight from the landmarks in the current frame.</p>
              {status && status.hands.length > 0 ? (
                <div className="stack">
                  {status.hands.map((h) => (
                    <div key={h.handedness} className="stack" style={{ gap: 10 }}>
                      <div className="row between">
                        <strong>{h.handedness} hand</strong>
                        <Chip tone={h.pose ? 'ok' : ''}>{h.pose ? gestureName(h.pose) : 'no gesture'}</Chip>
                      </div>
                      <div className="row">
                        <div className="fingers" aria-label="Extended fingers">
                          {FINGER_LABELS.map((label, i) => (
                            <span key={label} className={h.extension[i] > 0.6 ? 'up' : ''}>
                              {label}
                            </span>
                          ))}
                        </div>
                        <span className="small muted">{h.candidate ? `looks like ${gestureName(h.candidate)} (${pct(h.candidateConfidence)})` : 'no candidate'}</span>
                      </div>
                      <dl className="kv">
                        <dt>Pinch gap</dt>
                        <dd>{h.pinchDistance.toFixed(2)} hand lengths</dd>
                        <dt>Moving</dt>
                        <dd>
                          {h.direction} at {h.speed.toFixed(2)} /s
                        </dd>
                        <dt>Rotation</dt>
                        <dd>
                          {h.rollDeg.toFixed(0)}°, palm to {h.palmFacing}
                        </dd>
                        <dt>Toward camera (guess)</dt>
                        <dd>{h.depthTrend > 0.25 ? 'coming closer' : h.depthTrend < -0.25 ? 'moving away' : 'steady'}</dd>
                      </dl>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">{status?.models.hand === 'ready' ? 'No hand in view.' : 'Hand tracking is off.'}</p>
              )}
            </section>
          </div>
        </div>

        <section className="stack">
          <div className="row between">
            <div>
              <h2>
                Your <span className="hl">gestures</span>
              </h2>
              <p className="muted small">Change what each one does. A card lights up when the gesture is really detected.</p>
            </div>
            <button type="button" className="btn" onClick={() => engine.patch({ gestures: resetGestures(['hand-pose', 'hand-motion', 'two-hand']) })}>
              Reset all
            </button>
          </div>
          <GestureGrid kinds={['hand-pose']} />
          <h2>Movements</h2>
          <p className="muted small">Swipes, a raised hand and pushes are ignored while your hand is steering the cursor, so pointing never counts as a swipe.</p>
          <GestureGrid kinds={['hand-motion', 'two-hand']} />
        </section>
      </div>
    </>
  );
}
