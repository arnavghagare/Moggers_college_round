import { useEffect, useRef, useState } from 'react';
import { PARAMETER_COMMANDS, VOICE_COMMANDS, type VoiceCommand } from '../../core/voice/commands';
import { VOICE_LANGUAGES } from '../../shared/settings';
import { Alert, Chip, Meter, PageHead, Select, Slider, Switch, pct } from '../components';
import { requestMedia, useEngine, usePermission } from '../engine';
import { modePatch } from '../modes';
import { describeRun, voiceLabel } from '../runState';
import { StatusAlerts } from './Home';

const GROUPS: Array<VoiceCommand['group']> = ['Pointer', 'Numbers', 'Navigation', 'Media', 'Text entry', 'Modes', 'System'];

const RESULT_TEXT: Record<string, string> = {
  executed: 'Done',
  blocked: 'Heard, not carried out',
  pending: 'Confirm?',
  rejected: 'Did not catch that',
  ambiguous: 'Could be two things',
  unknown: 'Not a command',
  dictated: 'Typed it',
};

interface Turn {
  key: string;
  phrase: string;
  reply: string;
  ok: boolean;
}

export function Voice() {
  const engine = useEngine();
  const { settings, status, enabled } = engine;
  const v = settings.voice;
  const voice = status?.voice;
  const microphone = usePermission('microphone');
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // What is being typed. The stored wake word is cleaned as it is saved (no trailing space,
  // never empty), which would otherwise fight the keyboard mid-word.
  const [wakeDraft, setWakeDraft] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const isVoice = settings.controlMode === 'voice';
  const listening = voice?.state === 'listening';
  const run = describeRun(enabled, status, 'Voice mode');
  const [voiceText] = voiceLabel(voice);

  // Build the conversation from each newly handled phrase.
  const handled = (status?.stats.executedCommands ?? 0) + (status?.stats.failedCommands ?? 0);
  const seen = useRef('');
  useEffect(() => {
    if (!voice?.lastPhrase || !voice.lastStatus) return;
    const key = `${handled}|${voice.lastPhrase}|${voice.lastStatus}`;
    if (key === seen.current) return;
    seen.current = key;
    const ok = voice.lastStatus === 'executed' || voice.lastStatus === 'dictated' || voice.lastStatus === 'pending';
    const meant = voice.lastIntent ? `${voice.lastIntent}${voice.lastPayload ? `: ${voice.lastPayload}` : ''}` : '';
    const reply = meant && ok ? `${meant}${voice.lastStatus === 'pending' ? ' - say "confirm"' : ''}` : voice.lastMessage || RESULT_TEXT[voice.lastStatus];
    setTurns((t) => [{ key, phrase: voice.lastPhrase, reply, ok }, ...t].slice(0, 14));
  }, [voice?.lastPhrase, voice?.lastStatus, voice?.lastIntent, voice?.lastMessage, handled]);

  return (
    <>
      <PageHead title="Voice mode" lead="Say it and it happens. Every link gets a number, and you can open sites, scroll, type and switch tabs by talking.">
        {!isVoice && (
          <button type="button" className="btn primary big" onClick={() => engine.patch(modePatch('voice'))}>
            Use voice mode
          </button>
        )}
        {isVoice && <span className="sticker violet">{enabled ? 'Live now' : 'Selected'}</span>}
      </PageHead>

      <div className="stack">
        {!enabled && (
          <Alert tone="info" title="Handsfree is off">
            <span className="row between">
              <span>Turn it on to start talking to your browser.</span>
              <button type="button" className="btn primary" disabled={engine.busy} onClick={() => void engine.enable()}>
                Turn on
              </button>
            </span>
          </Alert>
        )}
        {microphone !== 'granted' && settings.features.voice && (
          <Alert tone="warn" title="The microphone is not allowed yet">
            <span className="row between">
              <span>{permissionMessage ?? 'Voice cannot start until Handsfree may use the microphone.'}</span>
              <button type="button" className="btn primary" onClick={() => void requestMedia('audio').then((r) => setPermissionMessage(r.ok ? null : r.message))}>
                Allow microphone
              </button>
            </span>
          </Alert>
        )}
        {voice?.error && (
          <Alert tone="bad" title={voice.error}>
            {voice.recovery}
          </Alert>
        )}
        {voice?.noisy && (
          <Alert tone="warn" title="It is loud in here">
            The background level is high, so commands now need to be recognised more confidently. Get closer to the mic, or
            switch to wake word or push to talk.
          </Alert>
        )}
        <StatusAlerts engine={engine} />

        <div className="grid two" style={{ alignItems: 'start' }}>
          <section className="card loud">
            <h2>{enabled ? run.headline : 'Off'}</h2>
            <p>{voice?.interim ? `"${voice.interim}"` : !enabled ? 'The microphone is not listening.' : run.detail}</p>
            <dl className="kv" aria-live="polite" style={{ marginBottom: 16 }}>
              <dt>Voice</dt>
              <dd>{enabled ? voiceText : 'Off'}</dd>
              <dt>Heard</dt>
              <dd>{voice?.lastPhrase ? `"${voice.lastPhrase}"` : '-'}</dd>
              <dt>Understood as</dt>
              <dd>{voice?.lastPhrase ? (voice.lastIntent ?? 'Not a command') : '-'}</dd>
              <dt>Value</dt>
              <dd>{voice?.lastPayload || '-'}</dd>
              <dt>Result</dt>
              <dd>{voice?.lastPhrase && voice.lastStatus ? `${RESULT_TEXT[voice.lastStatus]}${voice.lastStatus !== 'executed' && voice.lastMessage ? `: ${voice.lastMessage}` : ''}` : '-'}</dd>
              {voice?.lastNote && (
                <>
                  <dt>Browser said</dt>
                  <dd>{voice.lastNote}</dd>
                </>
              )}
            </dl>
            <div className="stack">
              <div className="field">
                <div className="field-head">
                  <span>Mic level</span>
                  <Chip tone={voice?.micState === 'on' ? 'live' : voice?.micState === 'denied' ? 'bad' : ''}>
                    {voice?.micState === 'on' ? 'mic in use' : voice?.micState === 'denied' ? 'mic blocked' : voice?.micState === 'notfound' ? 'no mic' : 'mic off'}
                  </Chip>
                </div>
                <Meter
                  value={voice ? Math.min(1, voice.micLevel * 6) : 0}
                  mark={voice && voice.micState === 'on' ? Math.min(1, voice.noiseFloor * 6) : undefined}
                  label="Microphone level"
                  warn={voice?.noisy}
                />
                <span className="small" style={{ fontWeight: 600 }}>
                  The pink line is the room's background level. Loudness only: nothing is recorded.
                </span>
              </div>
              <div className="row">
                <button type="button" className={`btn${run.paused ? ' primary' : ''}`} disabled={!status || status.phase === 'error' || status.phase === 'loading'} onClick={() => engine.act('toggle_pause')}>
                  {run.awaitingStart ? 'Start' : run.paused ? 'Resume' : 'Pause'}
                </button>
                <button type="button" className="btn" disabled={!status || !settings.features.voice} onClick={() => engine.act('toggle_listening')}>
                  {listening || voice?.state === 'starting' || voice?.state === 'reconnecting'
                    ? 'Stop listening'
                    : v.mode === 'push'
                      ? 'Listen now'
                      : voice?.state === 'error'
                        ? 'Reconnect voice'
                        : 'Start listening'}
                </button>
                <button type="button" className="btn" disabled={!status || !settings.features.voice} onClick={() => engine.act(voice?.dictating ? 'stop_dictation' : 'start_dictation')}>
                  {voice?.dictating ? 'Stop dictation' : 'Start dictation'}
                </button>
                <button type="button" className="btn" disabled={!status} onClick={() => engine.act('show_help')}>
                  Show cheat sheet
                </button>
              </div>
            </div>
          </section>

          <section className="card">
            <h2>Conversation</h2>
            <p>What it heard, and what it did. Newest first.</p>
            <div className="feed" aria-live="polite">
              {turns.length === 0 && <span className="empty">Nothing yet. Try "scroll down" or "open youtube".</span>}
              {turns.map((turn) => (
                <div key={turn.key} style={{ display: 'contents' }}>
                  <div className="bubble">{turn.phrase}</div>
                  <div className={`bubble reply${turn.ok ? '' : ' blocked'}`}>{turn.reply}</div>
                </div>
              ))}
            </div>
            {voice?.lastConfidence != null && <p className="muted small">Recogniser confidence for the last phrase: {pct(voice.lastConfidence)}</p>}
          </section>
        </div>

        <div className="grid two" style={{ alignItems: 'start' }}>
          <section className="card stack">
            <h2>Settings</h2>
            <Switch
              label="Voice"
              hint={isVoice ? 'Voice mode needs this. Pick head or hand mode to switch voice off.' : 'When off, the microphone is never opened.'}
              checked={settings.features.voice}
              disabled={isVoice && settings.features.voice}
              onChange={(on) => engine.patch({ features: { voice: on } })}
            />
            <Switch
              label="Numbers always on (voice mode)"
              hint="Keeps a number on every link and button so you only have to say it."
              checked={settings.hints.autoInVoiceMode}
              onChange={(autoInVoiceMode) => engine.patch({ hints: { autoInVoiceMode } })}
            />
            <Select
              label="Listening"
              value={v.mode}
              options={[
                { value: 'always', label: 'Always listening for commands' },
                { value: 'wake', label: `Only after the wake word ("${v.wakeWord}")` },
                { value: 'push', label: 'Push to talk: 8 seconds when asked' },
              ]}
              hint={
                v.mode === 'push'
                  ? 'Start with Alt+Shift+L or the button above.'
                  : v.mode === 'wake'
                    ? 'Commands without the wake word are ignored. The recogniser still runs.'
                    : 'Best in a quiet room.'
              }
              onChange={(mode) => engine.patch({ voice: { mode } })}
            />
            {v.mode === 'wake' && (
              <div className="field">
                <label htmlFor="wake-word">Wake word</label>
                <input
                  id="wake-word"
                  type="text"
                  value={wakeDraft ?? v.wakeWord}
                  maxLength={24}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setWakeDraft(e.target.value);
                    engine.patch({ voice: { wakeWord: e.target.value } });
                  }}
                  onBlur={() => setWakeDraft(null)}
                />
                <span className="hint">Letters and spaces only. Say it first, like "{v.wakeWord} scroll down".</span>
              </div>
            )}
            <Select label="Accent" value={v.lang} options={VOICE_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))} hint="Commands are in English." onChange={(lang) => engine.patch({ voice: { lang } })} />
            <Slider label="How sure it must be" hint="Speech recognised below this is ignored. Goes up by itself in a noisy room." value={v.minConfidence} min={0} max={0.9} step={0.05} format={pct} onChange={(minConfidence) => engine.patch({ voice: { minConfidence } })} />
            <Select
              label="Recognition runs"
              value={v.host}
              options={[
                { value: 'offscreen', label: 'In the background (recommended)' },
                { value: 'dashboard', label: 'In this tab (keep it open)' },
              ]}
              onChange={(host) => engine.patch({ voice: { host } })}
            />
          </section>

          <section className="card stack">
            <h2>Try typing by voice</h2>
            <p className="muted small">
              Say <span className="say">show fields</span> and the box's number, then <span className="say">start dictation</span>. Talk. Finish with{' '}
              <span className="say">stop dictation</span>. <span className="say plain">undo that</span> removes the last phrase.
            </p>
            <div className="field">
              <label htmlFor="dictation-test">Practice box</label>
              <textarea id="dictation-test" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Your words land here." />
            </div>
            <Alert tone="info" title="Where your voice goes">
              Speech recognition is Chrome's own. While listening, Chrome sends microphone audio to Google's speech service,
              so it needs the internet. Handsfree does not record or keep audio.
            </Alert>
          </section>
        </div>

        <section className="card stack">
          <h2>
            Everything you can <span className="hl violet">say</span>
          </h2>
          <p className="muted small">Speech is matched against this list and nothing else. Risky ones ("close tab") ask first.</p>
          <div className="commands">
            {GROUPS.map((group) => (
              <div key={group}>
                <h3 style={{ marginBottom: 10 }}>{group}</h3>
                <ul className="clean">
                  {PARAMETER_COMMANDS.filter((c) => c.group === group).map((c) => (
                    <li key={c.canonical} title={c.description}>
                      <span className="say">{c.example}</span>
                    </li>
                  ))}
                  {VOICE_COMMANDS.filter((c) => c.group === group).map((c) => (
                    <li key={c.id} title={c.confirm ? 'Asks you to confirm first' : undefined}>
                      <span className="say">
                        {c.canonical}
                        {c.confirm ? ' ?' : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
