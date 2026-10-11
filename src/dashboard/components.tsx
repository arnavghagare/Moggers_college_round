import { useId, type ReactNode } from 'react';
import type { Quality } from '../shared/types';

export function Switch(props: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label className="switch" htmlFor={id}>
      <span className="text">
        <span>{props.label}</span>
        {props.hint && <small>{props.hint}</small>}
      </span>
      <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
        <span className="state" aria-hidden="true">
          {props.checked ? 'On' : 'Off'}
        </span>
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={props.checked}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.checked)}
        />
        <span className="track" aria-hidden="true" />
      </span>
    </label>
  );
}

export function Slider(props: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?(value: number): string;
  onChange(value: number): void;
  disabled?: boolean;
}) {
  const id = useId();
  const text = props.format ? props.format(props.value) : String(props.value);
  return (
    <div className="field">
      <div className="field-head">
        <label htmlFor={id}>{props.label}</label>
        <output htmlFor={id}>{text}</output>
      </div>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        aria-valuetext={text}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      {props.hint && <span className="hint">{props.hint}</span>}
    </div>
  );
}

export function Select<T extends string>(props: {
  label: string;
  hint?: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange(value: T): void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <select id={id} value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {props.hint && <span className="hint">{props.hint}</span>}
    </div>
  );
}

export function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; detail?: string }>;
  onChange(value: T): void;
}) {
  return (
    <div className="field" role="group" aria-label={props.label}>
      <span className="label">{props.label}</span>
      <div className="segmented">
        {props.options.map((o) => (
          <button key={o.value} type="button" aria-pressed={props.value === o.value} onClick={() => props.onChange(o.value)}>
            {o.label}
            {o.detail && <small>{o.detail}</small>}
          </button>
        ))}
      </div>
    </div>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'live' | 'info' | '';

export function Chip({ tone = '', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`chip ${tone}`.trim()}>{children}</span>;
}

export function Tile(props: { label: string; value: ReactNode; detail?: ReactNode; tone?: Tone }) {
  return (
    <div className="tile">
      <span className="label">{props.label}</span>
      <span className="value">{props.tone !== undefined ? <Chip tone={props.tone}>{props.value}</Chip> : props.value}</span>
      {props.detail && <span className="detail">{props.detail}</span>}
    </div>
  );
}

export function Meter(props: { value: number; label: string; mark?: number; warn?: boolean }) {
  const pct = Math.round(Math.min(1, Math.max(0, props.value)) * 100);
  return (
    <div
      className={`meter${props.warn ? ' warn' : ''}`}
      role="meter"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <span style={{ width: `${pct}%` }} />
      {props.mark !== undefined && <i className="mark" style={{ left: `${Math.min(100, Math.max(0, props.mark * 100))}%` }} />}
    </div>
  );
}

export function Alert(props: { tone: 'warn' | 'bad' | 'ok' | 'info'; title: string; children?: ReactNode }) {
  return (
    <div className={`alert ${props.tone === 'info' ? '' : props.tone}`} role={props.tone === 'bad' ? 'alert' : 'status'}>
      <strong>{props.title}</strong>
      {props.children && <span>{props.children}</span>}
    </div>
  );
}

export function PageHead(props: { title: string; lead: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{props.title}</h1>
        <p>{props.lead}</p>
      </div>
      {props.children && <div className="row">{props.children}</div>}
    </header>
  );
}

export const qualityTone = (q: Quality): Tone => (q === 'good' ? 'ok' : q === 'fair' ? 'warn' : q === 'off' ? '' : 'bad');
export const qualityText = (q: Quality): string =>
  ({ good: 'Good', fair: 'Fair', poor: 'Poor', lost: 'Not detected', off: 'Off' })[q];

export const pct = (v: number): string => `${Math.round(v * 100)}%`;
export const ms = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

/** Offered when a page needs the engine but Handsfree is off. */
export function NeedsEngine(props: { enabled: boolean; onEnable(): void; busy: boolean; what: string }) {
  if (props.enabled) return null;
  return (
    <Alert tone="info" title="Handsfree is off">
      <span className="row between">
        <span>Turn Handsfree on to {props.what}.</span>
        <button type="button" className="btn primary" onClick={props.onEnable} disabled={props.busy}>
          Turn on Handsfree
        </button>
      </span>
    </Alert>
  );
}

const TICKER = ['No hands', 'No mouse', 'No problem', 'Head mode', 'Hand mode', 'Voice mode', 'Say "stop" to pause', 'Nothing is recorded'];

/** The scrolling strip across the top. Decorative, so hidden from screen readers. */
export function Ticker() {
  // The list is rendered twice so the loop is seamless.
  return (
    <div className="ticker" aria-hidden="true">
      <div>
        {[...TICKER, ...TICKER].map((text, i) => (
          <span key={i}>{text}</span>
        ))}
      </div>
    </div>
  );
}
