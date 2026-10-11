/**
 * Turning a spoken site name into a URL for "open youtube" / "go to example dot com".
 *
 * Only http(s) URLs are ever produced: either from the fixed list below or
 * from text that has the shape of a domain name. Anything else is handed to
 * a web search instead of being navigated to.
 */

const KNOWN: Record<string, string> = {
  google: 'https://www.google.com/',
  youtube: 'https://www.youtube.com/',
  gmail: 'https://mail.google.com/',
  mail: 'https://mail.google.com/',
  maps: 'https://www.google.com/maps',
  'google maps': 'https://www.google.com/maps',
  drive: 'https://drive.google.com/',
  'google drive': 'https://drive.google.com/',
  docs: 'https://docs.google.com/',
  'google docs': 'https://docs.google.com/',
  calendar: 'https://calendar.google.com/',
  translate: 'https://translate.google.com/',
  wikipedia: 'https://www.wikipedia.org/',
  reddit: 'https://www.reddit.com/',
  github: 'https://github.com/',
  'stack overflow': 'https://stackoverflow.com/',
  stackoverflow: 'https://stackoverflow.com/',
  amazon: 'https://www.amazon.com/',
  flipkart: 'https://www.flipkart.com/',
  twitter: 'https://x.com/',
  x: 'https://x.com/',
  instagram: 'https://www.instagram.com/',
  facebook: 'https://www.facebook.com/',
  whatsapp: 'https://web.whatsapp.com/',
  linkedin: 'https://www.linkedin.com/',
  netflix: 'https://www.netflix.com/',
  spotify: 'https://open.spotify.com/',
  twitch: 'https://www.twitch.tv/',
  discord: 'https://discord.com/app',
  pinterest: 'https://www.pinterest.com/',
  chatgpt: 'https://chatgpt.com/',
  bing: 'https://www.bing.com/',
  duckduckgo: 'https://duckduckgo.com/',
  news: 'https://news.google.com/',
  weather: 'https://www.google.com/search?q=weather',
};

export interface ResolvedSite {
  url: string;
  label: string;
}

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

export function resolveSite(spoken: string): ResolvedSite | null {
  let name = spoken
    .toLowerCase()
    .replace(/^(?:the|my)\s+/, '')
    .replace(/\s+(?:website|site|page|app|dot com please)$/, '')
    .trim();
  if (!name) return null;

  if (Object.prototype.hasOwnProperty.call(KNOWN, name)) return { url: KNOWN[name], label: name };

  // "example dot com", "news dot bbc dot co dot uk"
  name = name
    .replace(/\s+dot\s+/g, '.')
    .replace(/\s+slash\s+/g, '/')
    .replace(/^www\./, '');
  const [host, ...path] = name.split('/');
  const compact = host.replace(/\s+/g, '');
  if (DOMAIN.test(compact)) {
    const tail = path.join('/').replace(/\s+/g, '');
    return { url: `https://${compact}/${tail}`, label: compact };
  }
  return null;
}

/** Only web URLs may be opened on behalf of a page or a voice command. */
export function isWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export const KNOWN_SITE_NAMES = Object.keys(KNOWN);
