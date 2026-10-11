import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { SessionStats } from '../../shared/types';
import { Alert, Chip, PageHead } from '../components';
import { agentBus, useEngine, type AgentBusEvent } from '../engine';

interface TaskDef {
  id: string;
  title: string;
  instruction: string;
}

const TASKS: TaskDef[] = [
  { id: 'select', title: 'Select a target', instruction: 'Click the highlighted target. It moves each time; do this four times.' },
  { id: 'link', title: 'Click a link', instruction: 'In the text, click the link called "opening hours".' },
  { id: 'scroll', title: 'Scroll and find an item', instruction: 'Scroll the list and click "Item 32".' },
  { id: 'form', title: 'Fill in a form', instruction: 'Enter any name and any city, then click "Save details".' },
  { id: 'navigate', title: 'Navigate between pages', instruction: 'Go forward to page 3, then come back to page 1.' },
  {
    id: 'cancel',
    title: 'Cancel an unintended interaction',
    instruction:
      'Start to activate "Delete everything" (rest the cursor on it), then stop it: move away or say "cancel click" before the ring completes, or cancel the confirmation if it appears.',
  },
];

interface Counters {
  successfulSelections: number;
  incorrectSelections: number;
  canceledClicks: number;
  accidentalActivations: number;
  handsfreeClicks: number;
  mouseClicks: number;
}

interface TaskRecord extends Counters {
  id: string;
  title: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  outcome: 'completed' | 'skipped';
  failedCommands: number;
  recoveryEvents: number;
}

const zero = (): Counters => ({
  successfulSelections: 0,
  incorrectSelections: 0,
  canceledClicks: 0,
  accidentalActivations: 0,
  handsfreeClicks: 0,
  mouseClicks: 0,
});

const COLUMNS: Array<[keyof TaskRecord, string]> = [
  ['title', 'Task'],
  ['outcome', 'Outcome'],
  ['durationMs', 'Time (ms)'],
  ['successfulSelections', 'Correct'],
  ['incorrectSelections', 'Incorrect'],
  ['canceledClicks', 'Cancelled clicks'],
  ['accidentalActivations', 'Accidental'],
  ['failedCommands', 'Failed commands'],
  ['recoveryEvents', 'Recoveries'],
  ['handsfreeClicks', 'Handsfree clicks'],
  ['mouseClicks', 'Mouse clicks'],
];

function download(name: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const csvCell = (v: unknown): string => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function Benchmark() {
  const engine = useEngine();
  const { status, settings } = engine;
  const [index, setIndex] = useState(-1);
  const [records, setRecords] = useState<TaskRecord[]>([]);
  const [sessionStart, setSessionStart] = useState<string | null>(null);
  const [, bump] = useState(0);

  const counters = useRef<Counters>(zero());
  const startedAt = useRef(0);
  const baseline = useRef<SessionStats | null>(null);
  const statsRef = useRef<SessionStats | null>(null);
  statsRef.current = status?.stats ?? null;
  const arenaRef = useRef<HTMLDivElement>(null);

  // Per-task state
  const [goal, setGoal] = useState(0);
  const [round, setRound] = useState(0);
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [page, setPage] = useState(1);
  const [reached3, setReached3] = useState(false);

  const task = index >= 0 && index < TASKS.length ? TASKS[index] : null;
  const finished = index >= TASKS.length;

  const begin = useCallback((i: number): void => {
    counters.current = zero();
    startedAt.current = performance.now();
    baseline.current = statsRef.current ? { ...statsRef.current } : null;
    setGoal(Math.floor(Math.random() * 8));
    setRound(0);
    setName('');
    setCity('');
    setPage(1);
    setReached3(false);
    setIndex(i);
  }, []);

  const finish = useCallback(
    (outcome: TaskRecord['outcome']): void => {
      if (index < 0 || index >= TASKS.length) return;
      const now = performance.now();
      const def = TASKS[index];
      const before = baseline.current;
      const after = statsRef.current;
      const record: TaskRecord = {
        id: def.id,
        title: def.title,
        startedAt: new Date(Date.now() - (now - startedAt.current)).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Math.round(now - startedAt.current),
        outcome,
        ...counters.current,
        // Engine counters are only available while Handsfree is on.
        failedCommands: before && after ? after.failedCommands - before.failedCommands : 0,
        recoveryEvents: before && after ? after.recoveries + after.autoPauses - (before.recoveries + before.autoPauses) : 0,
      };
      setRecords((r) => [...r, record]);
      begin(index + 1);
    },
    [index, begin],
  );

  // Cancelled dwell clicks and declined confirmations, reported by the page agent.
  useEffect(() => {
    if (!task) return;
    const onAgent = (e: Event): void => {
      const { name: event, element } = (e as AgentBusEvent).detail;
      const inArena = element ? arenaRef.current?.contains(element) : false;
      if (event === 'dwell-cancel' && inArena) {
        counters.current.canceledClicks += 1;
        bump((n) => n + 1);
        if (task.id === 'cancel' && element?.closest('[data-bm="trap"]')) finish('completed');
      } else if (event === 'confirm-declined') {
        counters.current.canceledClicks += 1;
        bump((n) => n + 1);
        if (task.id === 'cancel') finish('completed');
      }
    };
    agentBus.addEventListener('agent', onAgent);
    return () => agentBus.removeEventListener('agent', onAgent);
  }, [task, finish]);

  /** Every click inside the arena is classified by what it landed on. */
  const onArenaClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (!task) return;
    const c = counters.current;
    if (e.nativeEvent.isTrusted) c.mouseClicks += 1;
    else c.handsfreeClicks += 1;
    const marked = (e.target as Element).closest('[data-bm]');
    const role = marked?.getAttribute('data-bm');
    if (role === 'goal') c.successfulSelections += 1;
    else if (role === 'wrong') c.incorrectSelections += 1;
    else if (role === 'neutral') {
      /* typing into a field, paging: neither right nor wrong */
    } else c.accidentalActivations += 1;
    bump((n) => n + 1);
  };

  const start = (): void => {
    setRecords([]);
    setSessionStart(new Date().toISOString());
    begin(0);
  };

  const exportData = (format: 'json' | 'csv'): void => {
    const stamp = (sessionStart ?? new Date().toISOString()).replace(/[:.]/g, '-');
    if (format === 'json') {
      download(
        `handsfree-benchmark-${stamp}.json`,
        'application/json',
        JSON.stringify(
          {
            note: 'Measured values from one benchmark session. Nothing is estimated.',
            sessionStartedAt: sessionStart,
            exportedAt: new Date().toISOString(),
            handsfreeOn: engine.enabled,
            controlMode: settings.controlMode,
            settings: {
              sensitivity: settings.cursor.sensitivity,
              smoothing: settings.cursor.smoothing,
              deadZone: settings.cursor.deadZone,
              dwellEnabled: settings.click.dwellEnabled,
              dwellMs: settings.click.dwellMs,
              confirmPolicy: settings.click.confirmPolicy,
              voice: settings.features.voice,
              handGestures: settings.features.handGestures,
              faceGestures: settings.features.faceGestures,
            },
            viewport: { width: window.innerWidth, height: window.innerHeight },
            userAgent: navigator.userAgent,
            tasks: records,
          },
          null,
          2,
        ),
      );
    } else {
      const keys: Array<keyof TaskRecord> = ['id', 'title', 'outcome', 'startedAt', 'completedAt', 'durationMs', 'successfulSelections', 'incorrectSelections', 'canceledClicks', 'accidentalActivations', 'failedCommands', 'recoveryEvents', 'handsfreeClicks', 'mouseClicks'];
      const lines = [keys.join(','), ...records.map((r) => keys.map((k) => csvCell(r[k])).join(','))];
      download(`handsfree-benchmark-${stamp}.csv`, 'text/csv', lines.join('\n'));
    }
  };

  const c = counters.current;

  return (
    <>
      <PageHead
        title="Playground"
        lead="Six short tasks that exercise real hands-free browsing. Times and counts are measured as you go and can be exported. Nothing is estimated or compared against anything."
      >
        {index >= 0 && (
          <button type="button" className="btn" onClick={start} data-bm="neutral">
            Restart
          </button>
        )}
      </PageHead>

      <div className="stack">
        {!engine.enabled && (
          <Alert tone="info" title="Handsfree is off">
            <span className="row between">
              <span>
                You can run the tasks with a mouse to get a baseline, or turn Handsfree on to measure hands-free use. Each
                click is recorded as mouse or Handsfree.
              </span>
              <button type="button" className="btn primary" disabled={engine.busy} onClick={() => void engine.enable()}>
                Turn on
              </button>
            </span>
          </Alert>
        )}

        <div className="grid two" style={{ alignItems: 'start' }}>
          <section className="card stack">
            <h2>Tasks</h2>
            <ol className="plain task-list">
              {TASKS.map((t, i) => {
                const record = records.find((r) => r.id === t.id);
                return (
                  <li key={t.id} className={i === index ? 'current' : record ? 'done' : ''} aria-current={i === index ? 'step' : undefined}>
                    <span className="num">{i + 1}</span>
                    <span style={{ flex: 1 }}>
                      <strong>{t.title}</strong>
                      {record && (
                        <span className="muted small">
                          {' '}
                          - {record.outcome} in {(record.durationMs / 1000).toFixed(1)} s
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
            {index < 0 && (
              <button type="button" className="btn primary big" onClick={start}>
                Start benchmark
              </button>
            )}
            {task && (
              <dl className="kv" aria-live="polite">
                <dt>Correct selections</dt>
                <dd>{c.successfulSelections}</dd>
                <dt>Incorrect selections</dt>
                <dd>{c.incorrectSelections}</dd>
                <dt>Cancelled clicks</dt>
                <dd>{c.canceledClicks}</dd>
                <dt>Accidental activations</dt>
                <dd>{c.accidentalActivations}</dd>
              </dl>
            )}
            <p className="muted small">
              Correct = the requested target. Incorrect = a different control. Accidental = a click on the "do not click"
              control or on empty space. Cancelled = a dwell countdown or confirmation that was stopped. Failed commands and
              recoveries come from the engine and are only counted while Handsfree is on.
            </p>
          </section>

          <section className="stack">
            {task && (
              <div className="card stack">
                <div className="row between">
                  <h2>
                    Task {index + 1} of {TASKS.length}: {task.title}
                  </h2>
                  <button type="button" className="btn small" onClick={() => finish('skipped')}>
                    Skip task
                  </button>
                </div>
                <p style={{ fontSize: '1.05rem' }}>{task.instruction}</p>

                {/* Capture phase: the click is counted before a task handler can move on to the next task. */}
                <div className="arena" ref={arenaRef} onClickCapture={onArenaClick}>
                  {task.id === 'select' && (
                    <>
                      <Chip>Round {round + 1} of 4</Chip>
                      <div className="targets">
                        {Array.from({ length: 8 }, (_, i) => (
                          <button
                            key={i}
                            type="button"
                            className={i === goal ? 'goal' : ''}
                            data-bm={i === goal ? 'goal' : 'wrong'}
                            onClick={() => {
                              if (i !== goal) return;
                              if (round >= 3) finish('completed');
                              else {
                                setRound(round + 1);
                                setGoal((g) => (g + 1 + Math.floor(Math.random() * 7)) % 8);
                              }
                            }}
                          >
                            {i === goal ? 'Click me' : `Target ${i + 1}`}
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {task.id === 'link' && (
                    <p style={{ fontSize: '1.1rem', lineHeight: 2.2 }}>
                      The community library has moved to a new building. You can read about the{' '}
                      <a href="#move" data-bm="wrong" onClick={(e) => e.preventDefault()}>new location</a>, check the{' '}
                      <a
                        href="#hours"
                        data-bm="goal"
                        onClick={(e) => {
                          e.preventDefault();
                          finish('completed');
                        }}
                      >
                        opening hours
                      </a>
                      , browse the{' '}
                      <a href="#events" data-bm="wrong" onClick={(e) => e.preventDefault()}>events calendar</a> or{' '}
                      <a href="#contact" data-bm="wrong" onClick={(e) => e.preventDefault()}>contact the staff</a>.
                    </p>
                  )}

                  {task.id === 'scroll' && (
                    <div className="scroller" data-bm="neutral" tabIndex={0} aria-label="Items">
                      {Array.from({ length: 40 }, (_, i) => (
                        <button
                          key={i}
                          type="button"
                          data-bm={i + 1 === 32 ? 'goal' : 'wrong'}
                          onClick={() => {
                            if (i + 1 === 32) finish('completed');
                          }}
                        >
                          Item {i + 1}
                        </button>
                      ))}
                    </div>
                  )}

                  {task.id === 'form' && (
                    <div className="stack" style={{ maxWidth: 420 }}>
                      <div className="field" data-bm="neutral">
                        <label htmlFor="bm-name">Name</label>
                        <input id="bm-name" type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
                      </div>
                      <div className="field" data-bm="neutral">
                        <label htmlFor="bm-city">City</label>
                        <input id="bm-city" type="text" value={city} onChange={(e) => setCity(e.target.value)} autoComplete="off" />
                      </div>
                      <div className="row">
                        <button
                          type="button"
                          className="btn primary"
                          data-bm={name.trim().length >= 2 && city.trim().length >= 2 ? 'goal' : 'wrong'}
                          onClick={() => {
                            if (name.trim().length >= 2 && city.trim().length >= 2) finish('completed');
                          }}
                        >
                          Save details
                        </button>
                        {(name.trim().length < 2 || city.trim().length < 2) && <span className="muted small">Both fields are needed first.</span>}
                      </div>
                    </div>
                  )}

                  {task.id === 'navigate' && (
                    <div className="stack">
                      <h3>
                        Page {page} of 3 {reached3 && <Chip tone="ok">Page 3 reached - now return to page 1</Chip>}
                      </h3>
                      <p className="muted">
                        {page === 1 ? 'This is the first page.' : page === 2 ? 'This is the middle page.' : 'This is the last page.'}
                      </p>
                      <div className="row">
                        <button
                          type="button"
                          className="btn"
                          disabled={page === 1}
                          data-bm={reached3 ? 'goal' : 'wrong'}
                          onClick={() => {
                            const next = Math.max(1, page - 1);
                            setPage(next);
                            if (reached3 && next === 1) finish('completed');
                          }}
                        >
                          Previous page
                        </button>
                        <button
                          type="button"
                          className="btn"
                          disabled={page === 3}
                          data-bm={reached3 ? 'wrong' : 'goal'}
                          onClick={() => {
                            const next = Math.min(3, page + 1);
                            setPage(next);
                            if (next === 3) setReached3(true);
                          }}
                        >
                          Next page
                        </button>
                      </div>
                    </div>
                  )}

                  {task.id === 'cancel' && (
                    <div className="stack" style={{ justifyItems: 'start' }}>
                      <button type="button" className="btn danger big" data-bm="trap" onClick={() => undefined}>
                        Delete everything
                      </button>
                      <p className="muted small">
                        This button does nothing, but a completed click on it is recorded as an accidental activation. Using a
                        mouse? This task needs Handsfree; skip it.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {finished && (
              <Alert tone="ok" title="Benchmark complete">
                The results below are the measurements from this run.
              </Alert>
            )}

            {records.length > 0 && (
              <div className="card stack">
                <div className="row between">
                  <h2>Measured results</h2>
                  <div className="row">
                    <button type="button" className="btn small" onClick={() => exportData('csv')}>
                      Export CSV
                    </button>
                    <button type="button" className="btn small" onClick={() => exportData('json')}>
                      Export JSON
                    </button>
                  </div>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="results">
                    <thead>
                      <tr>
                        {COLUMNS.map(([, label]) => (
                          <th key={label} scope="col">
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {records.map((r) => (
                        <tr key={`${r.id}-${r.startedAt}`}>
                          {COLUMNS.map(([key]) => (
                            <td key={key} style={key === 'title' ? { fontFamily: 'inherit' } : undefined}>
                              {String(r[key])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="muted small">
                  Session started {sessionStart ? new Date(sessionStart).toLocaleString() : '-'}. These are actual measurements
                  from this device and this run; they say nothing about other people, devices or input methods.
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
