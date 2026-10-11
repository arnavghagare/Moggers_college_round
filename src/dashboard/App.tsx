import { useEffect, type CSSProperties } from 'react';
import { Chip, Ticker } from './components';
import { navigate, useAppearance, useEngine, useRoute } from './engine';
import { MODES } from './modes';
import { Benchmark } from './pages/Benchmark';
import { Hand } from './pages/Hand';
import { Head } from './pages/Head';
import { Home } from './pages/Home';
import { Settings } from './pages/Settings';
import { Voice } from './pages/Voice';
import { Welcome } from './pages/Welcome';

const NAV: Array<{ path: string; label: string; emoji: string; color: string }> = [
  { path: '', label: 'Home', emoji: '🏠', color: 'var(--lime)' },
  ...MODES.map((m) => ({ path: m.route, label: m.name, emoji: m.emoji, color: m.color })),
  { path: 'playground', label: 'Playground', emoji: '🎯', color: 'var(--orange)' },
  { path: 'settings', label: 'Settings', emoji: '⚙️', color: 'var(--paper)' },
];

const PHASE_LABEL: Record<string, string> = {
  loading: 'Starting',
  grace: 'Getting ready',
  active: 'Live',
  paused: 'Actions paused',
  suspended: 'Paused: tracking lost',
  error: 'Stopped',
};


export function App() {
  const engine = useEngine();
  const route = useRoute();
  useAppearance(engine.settings);

  // First run: go through setup before anything else.
  useEffect(() => {
    if (engine.loaded && !engine.settings.onboarded && route.path !== 'welcome') navigate('welcome');
  }, [engine.loaded, engine.settings.onboarded, route.path]);

  if (!engine.loaded) {
    return (
      <main className="welcome" aria-busy="true">
        <p className="muted">Loading Handsfree...</p>
      </main>
    );
  }
  if (route.path === 'welcome') return <Welcome />;

  // Older links ("calibration", "voice settings") land on the page that now holds them.
  const path = route.path === 'calibration' ? 'head' : route.path === 'benchmark' ? 'playground' : route.path;
  const mode = MODES.find((m) => m.route === path);
  const page = (() => {
    switch (path) {
      case 'head':
        return <Head autoStart={route.query.get('start') === '1'} />;
      case 'hand':
        return <Hand />;
      case 'voice':
        return <Voice />;
      case 'playground':
        return <Benchmark />;
      case 'settings':
      case 'preferences':
        return <Settings />;
      default:
        return <Home />;
    }
  })();

  const phase = engine.status?.phase;
  return (
    <>
      <Ticker />
      <div className="shell" style={mode ? ({ '--mode': mode.color } as CSSProperties) : undefined}>
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-name">Handsfree</span>
          </div>
          <nav className="nav" aria-label="Sections">
            {NAV.map((item) => (
              <a
                key={item.path}
                href={`#/${item.path}`}
                aria-current={path === item.path || (item.path === 'settings' && path === 'preferences') ? 'page' : undefined}
                style={{ '--nav': item.color } as CSSProperties}
              >
                <span className="emoji" aria-hidden="true">
                  {item.emoji}
                </span>
                {item.label}
              </a>
            ))}
          </nav>
          <div className="sidebar-foot" aria-live="polite">
            <Chip tone={!engine.enabled ? '' : phase === 'active' ? 'ok' : phase === 'error' ? 'bad' : 'warn'}>
              {!engine.enabled ? 'Off' : phase ? PHASE_LABEL[phase] : 'Connecting'}
            </Chip>
            <span className="small muted">
              <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>P</kbd> pauses, any time
            </span>
          </div>
        </aside>
        <main className="main" id="main">
          {page}
        </main>
      </div>
    </>
  );
}
