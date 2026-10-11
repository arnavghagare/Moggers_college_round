import { StrictMode, useState, type CSSProperties, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { resolveSite } from '../core/voice/sites';
import { Chip, Ticker } from '../dashboard/components';
import { EngineProvider, useAppearance, useEngine } from '../dashboard/engine';
import { currentMode } from '../dashboard/modes';
import '../dashboard/styles.css';

/**
 * The new tab page. Chrome's own new tab page cannot be touched by any
 * extension, which would leave a hands-free user stranded every time they
 * open a tab. This page is part of Handsfree, so the cursor, numbers, voice
 * and dictation all work on it.
 */
const SITES: Array<{ name: string; url: string; emoji: string; color: string }> = [
  { name: 'YouTube', url: 'https://www.youtube.com/', emoji: '▶️', color: 'var(--pink)' },
  { name: 'Google', url: 'https://www.google.com/', emoji: '🔎', color: 'var(--lime)' },
  { name: 'Gmail', url: 'https://mail.google.com/', emoji: '✉️', color: 'var(--violet)' },
  { name: 'Wikipedia', url: 'https://www.wikipedia.org/', emoji: '📚', color: 'var(--orange)' },
  { name: 'Reddit', url: 'https://www.reddit.com/', emoji: '👽', color: 'var(--lime)' },
  { name: 'GitHub', url: 'https://github.com/', emoji: '🐙', color: 'var(--violet)' },
  { name: 'Maps', url: 'https://www.google.com/maps', emoji: '🗺️', color: 'var(--pink)' },
  { name: 'News', url: 'https://news.google.com/', emoji: '📰', color: 'var(--orange)' },
];

function NewTab() {
  const engine = useEngine();
  const { settings, status, enabled } = engine;
  useAppearance(settings);
  const [query, setQuery] = useState('');
  const mode = currentMode(settings.controlMode);

  const go = (e: FormEvent): void => {
    e.preventDefault();
    const text = query.trim();
    if (!text) return;
    // A site name or address goes straight there; anything else is a search.
    const site = resolveSite(text);
    window.location.href = site ? site.url : `https://www.google.com/search?q=${encodeURIComponent(text)}`;
  };

  return (
    <>
      <Ticker />
      <main className="newtab" style={{ '--mode': mode.color } as CSSProperties}>
        <div className="newtab-inner">
          <h1>
            Where to, <span className="hl">no hands?</span>
          </h1>
          <form className="search" role="search" onSubmit={go}>
            <input
              type="search"
              aria-label="Search or type a site"
              placeholder='Search, or a site like "youtube"'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            <button type="submit" className="btn primary big">
              Go
            </button>
          </form>
          <nav className="sites" aria-label="Sites">
            {SITES.map((site) => (
              <a key={site.name} className="site" href={site.url} style={{ '--tile': site.color } as CSSProperties}>
                <span className="emoji" aria-hidden="true">
                  {site.emoji}
                </span>
                {site.name}
              </a>
            ))}
          </nav>
          <div className="row" style={{ justifyContent: 'center' }}>
            <Chip tone={enabled ? (status?.phase === 'active' ? 'ok' : 'warn') : ''}>{enabled ? `${mode.name} ${status?.phase === 'active' ? 'live' : 'starting'}` : 'Handsfree is off'}</Chip>
            {enabled ? (
              <>
                <span className="say">say "open youtube"</span>
                <span className="say plain">say "what can I say"</span>
              </>
            ) : (
              <button type="button" className="btn primary" disabled={engine.busy} onClick={() => void engine.enable()}>
                Turn on Handsfree
              </button>
            )}
            <a className="btn small" href={chrome.runtime.getURL('dashboard.html')}>
              Dashboard
            </a>
          </div>
        </div>
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EngineProvider>
      <NewTab />
    </EngineProvider>
  </StrictMode>,
);
