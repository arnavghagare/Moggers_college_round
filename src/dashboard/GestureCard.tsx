import { GESTURES, type GestureConfig, type GestureDefinition, type GestureKind } from '../core/gestures/registry';
import { ACTIONS, ACTION_IDS, type ActionId } from '../shared/actions';
import type { EngineStatus } from '../shared/types';
import { Chip, Meter, Select, Slider, Switch, ms, pct } from './components';
import { useEngine } from './engine';

const FACE_SIGNAL: Record<string, (s: EngineStatus['face']['signals']) => number> = {
  blink_long: (s) => Math.min(s.blinkLeft, s.blinkRight),
  double_blink: (s) => Math.min(s.blinkLeft, s.blinkRight),
  wink_left: (s) => s.blinkLeft * (1 - s.blinkRight),
  wink_right: (s) => s.blinkRight * (1 - s.blinkLeft),
  brow_raise: (s) => s.browUp,
  mouth_open: (s) => s.jawOpen,
  smile: (s) => s.smile,
};

/** Live evidence for one gesture: current confidence (when measurable per frame) and whether it is held. */
function live(def: GestureDefinition, status: EngineStatus | null): { level: number | null; held: boolean; fired: boolean } {
  if (!status) return { level: null, held: false, fired: false };
  const fired = status.gestureLog.some((g) => g.id === def.id && status.t - g.t < 1500);
  if (def.kind === 'face') {
    const read = FACE_SIGNAL[def.id];
    return { level: status.face.present && read ? read(status.face.signals) : null, held: false, fired };
  }
  if (def.kind === 'hand-pose') {
    let level: number | null = null;
    let held = false;
    for (const hand of status.hands) {
      if (hand.pose === def.id) {
        held = true;
        level = Math.max(level ?? 0, hand.poseConfidence);
      } else if (hand.candidate === def.id || (def.id === 'pinch_hold' && hand.candidate === 'pinch')) {
        level = Math.max(level ?? 0, hand.candidateConfidence);
      }
    }
    return { level: status.hands.length ? (level ?? 0) : null, held, fired };
  }
  return { level: null, held: false, fired };
}

function GestureCard({ def, config, status, onChange }: {
  def: GestureDefinition;
  config: GestureConfig;
  status: EngineStatus | null;
  onChange(patch: Partial<GestureConfig>): void;
}) {
  const { level, held, fired } = live(def, status);
  const actions = ACTION_IDS.filter((id) => ACTIONS[id].assignable && (!def.oneshotOnly || ACTIONS[id].kind === 'oneshot'));
  const dirty = JSON.stringify(config) !== JSON.stringify(def.defaults);
  const usesThreshold = def.id !== 'pinch_hold';
  const lit = config.enabled && (held || fired);

  return (
    <article className={`card gesture${lit ? ' active' : ''}`} aria-label={def.name}>
      <div className="row between">
        <h3>{def.name}</h3>
        <span className="row" style={{ gap: 6 }}>
          {def.evidence === 'inferred' && <Chip tone="info">Less reliable</Chip>}
          {lit && <span className="sticker lime">{fired ? 'Detected' : 'Held'}</span>}
        </span>
      </div>
      <p className="muted small">{def.description}</p>

      <Switch label="Recognise it" checked={config.enabled} onChange={(enabled) => onChange({ enabled })} />
      <Select
        label="It does"
        value={config.action}
        options={actions.map((id) => ({ value: id, label: ACTIONS[id].label }))}
        onChange={(action: ActionId) => onChange({ action })}
        disabled={!config.enabled}
      />

      {level !== null && config.enabled && (
        <div className="field">
          <div className="field-head">
            <span className="small muted">Live confidence (pink line = needed)</span>
            <output>{pct(level)}</output>
          </div>
          <Meter value={level} label={`${def.name} confidence`} mark={usesThreshold ? config.threshold : undefined} />
        </div>
      )}

      <details>
        <summary>Tune it</summary>
        <div className="tune">
          <p className="muted small">Needs: {def.requires}.</p>
          {usesThreshold && (
            <>
              <Slider
                label="Confidence needed"
                hint="Higher = fewer accidents, but the shape must be clearer."
                value={config.threshold}
                min={0.3}
                max={0.95}
                step={0.05}
                format={pct}
                onChange={(threshold) => onChange({ threshold, releaseThreshold: Math.min(config.releaseThreshold, threshold) })}
              />
              <Slider
                label="Let go below"
                hint="A held gesture ends when confidence drops under this."
                value={config.releaseThreshold}
                min={0.1}
                max={config.threshold}
                step={0.05}
                format={pct}
                onChange={(releaseThreshold) => onChange({ releaseThreshold })}
              />
            </>
          )}
          <Slider
            label="Hold for at least"
            value={config.minDurationMs}
            min={0}
            max={2500}
            step={50}
            format={ms}
            onChange={(minDurationMs) => onChange({ minDurationMs })}
          />
          <Slider
            label="Cooldown"
            hint="Shortest gap between two activations."
            value={config.cooldownMs}
            min={0}
            max={5000}
            step={100}
            format={ms}
            onChange={(cooldownMs) => onChange({ cooldownMs })}
          />
          <div className="row">
            <button type="button" className="btn small" disabled={!dirty} onClick={() => onChange({ ...def.defaults })}>
              Reset this one
            </button>
          </div>
        </div>
      </details>
    </article>
  );
}

/** Cards for every gesture of the given kinds, generated from the gesture registry. */
export function GestureGrid({ kinds }: { kinds: GestureKind[] }) {
  const engine = useEngine();
  return (
    <div className="grid two">
      {GESTURES.filter((g) => kinds.includes(g.kind)).map((def) => (
        <GestureCard
          key={def.id}
          def={def}
          config={engine.settings.gestures[def.id]}
          status={engine.status}
          onChange={(patch) => engine.patch({ gestures: { [def.id]: patch } })}
        />
      ))}
    </div>
  );
}

export function resetGestures(kinds: GestureKind[]): Record<string, GestureConfig> {
  const out: Record<string, GestureConfig> = {};
  for (const g of GESTURES) if (kinds.includes(g.kind)) out[g.id] = { ...g.defaults };
  return out;
}
