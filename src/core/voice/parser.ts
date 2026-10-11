import type { ActionId, ActionParams } from '../../shared/actions';
import { PHRASE_INDEX, PRESSABLE_KEYS, VOICE_COMMANDS, type VoiceCommand } from './commands';

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** Parse a number from 0 to 99 starting at `words[i]`. */
function parseSmall(words: string[], i: number): { value: number; used: number } | null {
  const w = words[i];
  if (w === undefined) return null;
  if (Object.prototype.hasOwnProperty.call(UNITS, w)) return { value: UNITS[w], used: 1 };
  if (Object.prototype.hasOwnProperty.call(TENS, w)) {
    const next = words[i + 1];
    if (next !== undefined && Object.prototype.hasOwnProperty.call(UNITS, next) && UNITS[next] >= 1 && UNITS[next] <= 9) {
      return { value: TENS[w] + UNITS[next], used: 2 };
    }
    return { value: TENS[w], used: 1 };
  }
  return null;
}

/** Convert spoken numbers ("twenty one", "one hundred and five") to digits. */
export function wordsToDigits(text: string): string {
  const words = text.split(' ');
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    const first = parseSmall(words, i);
    if (!first) {
      out.push(words[i]);
      i += 1;
      continue;
    }
    let { value, used } = first;
    // "<n> hundred [and] <m>"
    if (value >= 1 && value <= 9 && used === 1 && words[i + 1] === 'hundred') {
      value *= 100;
      used = 2;
      let j = i + 2;
      if (words[j] === 'and') j += 1;
      const rest = parseSmall(words, j);
      if (rest) {
        value += rest.value;
        used = j - i + rest.used;
      }
    }
    out.push(String(value));
    i += used;
  }
  return out.join(' ');
}

/** Words speech recognisers commonly return in place of a spoken digit. */
const NUMBER_HOMOPHONES: Record<string, number> = { won: 1, to: 2, too: 2, tu: 2, tree: 3, free: 3, for: 4, fore: 4, ate: 8 };

const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

function ordinalNumber(token: string): number | null {
  if (Object.prototype.hasOwnProperty.call(ORDINALS, token)) return ORDINALS[token];
  const m = /^(\d{1,2})(?:st|nd|rd|th)$/.exec(token);
  return m ? Number(m[1]) : null;
}

/**
 * "tab" is very often heard as "tap" ("go to tap to" for "go to tab two").
 * "tap" on its own is a click command, so it is only read as "tab" where a
 * tab is clearly meant: after a word that goes with tabs. Closing a tab is
 * deliberately left out: a command that loses work has to be heard exactly.
 */
const TAB_CONTEXT =
  /\b(next|previous|last|first|second|third|fourth|fifth|new|this|other|another|switch|switch to|switch the|change|change to|duplicate|go to|go to the|move to|jump to|to the|open a new|open new) taps?\b/g;

export function fixTabHomophone(norm: string): string {
  return norm.replace(TAB_CONTEXT, (whole) => whole.replace(/tap(s?)$/, 'tab$1'));
}

const MAIL_HOSTS = /^(?:gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|proton|protonmail|rediffmail|aol|zoho|yandex)$/;
const SPOKEN_SYMBOLS: Record<string, string> = { dot: '.', period: '.', underscore: '_', dash: '-', hyphen: '-', minus: '-', plus: '+' };

/**
 * An email address as a recogniser writes it down ("Arnav 14 Ghagare@gmail.com",
 * "arnav fourteen ghagare at gmail dot com") becomes the address that was
 * meant: one word, lower case ("arnav14ghagare@gmail.com").
 *
 * Only a phrase that is an address from start to finish is touched. Anything
 * else - a sentence that merely ends in a domain, a URL, a query with an "@"
 * in the middle - comes back exactly as it went in.
 */
export function tidySpokenEmail(text: string): string {
  const raw = text.trim();
  const m = /^(.+?)(\s*@\s*|\s+at(?:\s+the\s+rate(?:\s+of)?)?\s+)((?:[a-z0-9-]+\s*(?:\.|\bdot\b)\s*)+[a-z]{2,})$/i.exec(raw);
  if (!m) return text;
  const host = m[3].toLowerCase().replace(/\s*\bdot\b\s*/g, '.').replace(/\s+/g, '');
  // "deals at amazon.com" is not an address: a spoken "at" only counts in front of a mail provider.
  if (!m[2].includes('@') && !MAIL_HOSTS.test(host.split('.')[0])) return text;
  const words = wordsToDigits(m[1].toLowerCase().trim().replace(/\s+/g, ' ')).split(' ');
  if (words.length > 6) return text;
  const local = words.map((w) => (Object.prototype.hasOwnProperty.call(SPOKEN_SYMBOLS, w) ? SPOKEN_SYMBOLS[w] : w)).join('');
  const address = `${local}@${host}`;
  return /^[a-z0-9][a-z0-9._+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(address) ? address : text;
}

function slotNumber(token: string): number | null {
  if (/^\d{1,3}$/.test(token)) return Number(token);
  return Object.prototype.hasOwnProperty.call(NUMBER_HOMOPHONES, token) ? NUMBER_HOMOPHONES[token] : null;
}

const FILLER_START = /^(?:(?:please|hey|ok|okay|um|uh|er|so|and|now|can you|could you|would you)\s+)+/;
const FILLER_END = /(?:\s+(?:please|now|thanks|thank you))+$/;

/** Lower-case, strip punctuation and fillers, and convert number words. */
export function normalizeUtterance(text: string): string {
  let s = text
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/\bhands free\b/g, 'handsfree');
  // Keep fillers when they are the whole utterance ("ok" is a command).
  const stripped = s.replace(FILLER_START, '').replace(FILLER_END, '').trim();
  if (stripped) s = stripped;
  return wordsToDigits(s);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

/** Minimum similarity for a fuzzy match. */
export const FUZZY_MIN = 0.84;
/** The best fuzzy match must beat the runner-up (a different command) by this much. */
export const FUZZY_MARGIN = 0.06;

export interface ParseContext {
  /** Numbered labels are on screen, so a bare number means "click that number". */
  hintsShown: boolean;
  dictating: boolean;
  mode: 'always' | 'wake' | 'push';
  wakeWord: string;
  minConfidence: number;
  /** A confirmation prompt is open: bare "yes" / "no" are meaningful. */
  pending: boolean;
}

export type ParseResult =
  | {
      status: 'match';
      commandId: string;
      action: ActionId;
      params: ActionParams;
      phrase: string;
      fuzzy: boolean;
      confirm: boolean;
    }
  | { status: 'ambiguous'; candidates: string[]; reason: string }
  | { status: 'rejected'; reason: string }
  /** Not a command. In dictation mode this is text to type. */
  | { status: 'unknown'; normalized: string }
  /** Wake-word mode and the wake word was not spoken: not addressed to us. */
  | { status: 'ignored' };

const match = (command: VoiceCommand, phrase: string, fuzzy: boolean, params: ActionParams = {}): ParseResult => ({
  status: 'match',
  commandId: command.id,
  action: command.action,
  params: { ...command.params, ...params },
  phrase,
  fuzzy,
  confirm: command.confirm,
});

const synthetic = (action: ActionId, phrase: string, params: ActionParams): ParseResult => ({
  status: 'match',
  commandId: action,
  action,
  params,
  phrase,
  fuzzy: false,
  confirm: false,
});

/** Sentence punctuation a recogniser adds after the last word. Characters inside the value are kept. */
const TRAILING_PUNCTUATION = /[.?!,;]+$/;

const SEARCH_VERB = String.raw`(?:search(?:\s+the\s+web)?|google|look\s+up)`;
const THIS_TAB = String.raw`(?:this|the\s+current|current)\s+(?:tab|page|site|website)|here`;
// A new tab has to be asked for in so many words: "open tab", "open a new tab", "new tab".
const NEW_TAB = /^(?:(?:open|create|make|start)\s+(?:a\s+|the\s+|another\s+)?(?:new\s+)?|(?:a\s+)?new\s+)tab\s*,?\s+(?:(?:and|then|to)\s+)*/i;
const IN_NEW_TAB = /^(?:in|on)\s+(?:a\s+|the\s+)?new\s+tab\s*,?\s+/i;
const SEARCH_PLAIN = new RegExp(String.raw`^${SEARCH_VERB}(?:\s+for)?(?:\s+(.*))?$`, 'i');
// "this tab" only counts as the destination when "for" follows it; otherwise the words belong to the query.
const SEARCH_THIS_TAB = new RegExp(String.raw`^${SEARCH_VERB}\s+(?:in\s+|on\s+)?(?:${THIS_TAB})(?:\s+for(?:\s+(.*))?)?$`, 'i');
const SEARCH_THIS_TAB_SUFFIX = new RegExp(String.raw`^${SEARCH_VERB}(?:\s+for)?\s+(.+?)\s+(?:in|on)\s+(?:this|the\s+current|current)\s+tab$`, 'i');

export type SearchIntent = 'search' | 'search_new_tab' | 'search_here';

export interface SearchCommand {
  intent: SearchIntent;
  /** Exactly what to search for: the user's own words, without the command around them. Empty when none was said. */
  query: string;
}

/**
 * Split a spoken search instruction into what to do and what to search for.
 *
 *   "Open tab and search arnav14ghagare@gmail.com" -> new tab, "arnav14ghagare@gmail.com"
 *   "Search this tab for React tutorials"          -> this tab, "React tutorials"
 *   "Search for how to open a tab"                 -> search,   "how to open a tab"
 *
 * Only the command words at the front are removed. Everything after them is
 * the query, word for word, so an email address, a URL or a query that itself
 * contains "open", "search" or "tab" survives untouched.
 *
 * @returns null when the phrase is not a search instruction at all.
 */
export function parseSearchCommand(raw: string): SearchCommand | null {
  const text = raw.trim().replace(/^(?:(?:please|hey|ok|okay|can you|could you|would you)\s+)+/i, '');
  const clean = (q: string | undefined): string => (q ?? '').trim().replace(TRAILING_PUNCTUATION, '').trim();

  // "open [a new] tab and search [for] <query>", "new tab search <query>", "in a new tab search for <query>"
  for (const prefix of [NEW_TAB, IN_NEW_TAB]) {
    const lead = prefix.exec(text);
    if (!lead) continue;
    const m = SEARCH_PLAIN.exec(text.slice(lead[0].length));
    if (m) return { intent: 'search_new_tab', query: clean(m[1]) };
  }

  let m = SEARCH_THIS_TAB.exec(text);
  if (m) return { intent: 'search_here', query: clean(m[1]) };
  m = SEARCH_THIS_TAB_SUFFIX.exec(text);
  if (m) return { intent: 'search_here', query: clean(m[1]) };

  m = SEARCH_PLAIN.exec(text);
  if (m) return { intent: 'search', query: clean(m[1]) };
  return null;
}

/** Commands that carry a spoken parameter. `raw` keeps the original casing for typed text. */
function parseParameterCommand(norm: string, raw: string, ctx: ParseContext): ParseResult | null {
  let m = /^(?:click|select|choose|open|tap|number|press|go to|focus)(?: number| on)? (\S+)$/.exec(norm);
  if (m) {
    const n = slotNumber(m[1]);
    if (n !== null) return synthetic('click_number', norm, { number: n });
  }

  if (ctx.hintsShown && /^\d{1,3}$/.test(norm)) return synthetic('click_number', norm, { number: Number(norm) });

  // "go to tab 2", "switch to tab number 2", "open tab 2", "tab 2"
  m = /^(?:(?:switch|go|change|move|jump|take me|get) (?:over )?to (?:the )?tabs?|(?:switch|change|open|show|select|choose|activate) (?:the )?tabs?|tabs?)(?: number| no)? (\S+)$/.exec(norm);
  if (m) {
    const n = slotNumber(m[1]) ?? ordinalNumber(m[1]);
    if (n !== null && n >= 1 && n <= 99) return synthetic('switch_tab', norm, { number: n });
  }
  // "first tab", "go to the second tab", "switch to the 3rd tab"
  m = /^(?:(?:(?:switch|go|change|move|jump|take me|get) (?:over )?to|open|show|select|choose|activate) )?(?:the )?(\S+) tabs?$/.exec(norm);
  if (m) {
    const n = ordinalNumber(m[1]);
    if (n !== null && n >= 1 && n <= 99) return synthetic('switch_tab', norm, { number: n });
  }

  // Searches are parsed from the original words: number conversion and
  // punctuation stripping must never rewrite a query.
  const search = parseSearchCommand(raw);
  if (search) {
    if (!search.query) return { status: 'rejected', reason: 'Say what to search for, like "search for train times".' };
    return synthetic(search.intent, norm, { text: tidySpokenEmail(search.query) });
  }

  m = /^press (?:the )?(.+?)(?: key)?$/.exec(norm);
  if (m && m[1] in PRESSABLE_KEYS) return synthetic('press_key', norm, { key: PRESSABLE_KEYS[m[1]] });

  if (/^(?:type|write|enter text) .+/.test(norm)) {
    const text = raw.replace(/^\s*(?:please\s+)?(?:type|write|enter text)\s+/i, '').trim();
    if (text) return synthetic('type_text', norm, { text: tidySpokenEmail(text) });
  }

  // "open youtube" opens a new tab; "go to youtube" loads it in this one.
  m = /^(?:open|launch|open up) (.+)$/.exec(norm);
  if (m) return synthetic('open_site', norm, { text: m[1] });
  m = /^(?:go to|goto|navigate to|visit|take me to|load) (.+)$/.exec(norm);
  if (m) return synthetic('navigate_site', norm, { text: m[1] });

  // "click sign in": activate a control by what it says.
  m = /^(?:click|press|tap|select|choose|hit)(?: on)?(?: the)? (.+?)(?: button| link| tab| icon)?$/.exec(norm);
  if (m && m[1].length >= 2) return synthetic('click_text', norm, { text: m[1] });
  return null;
}

function fuzzyMatch(norm: string): ParseResult | null {
  if (norm.length < 5) return null;
  let best: { command: VoiceCommand; phrase: string; score: number } | null = null;
  let runnerUp = 0;
  for (const [phrase, command] of PHRASE_INDEX) {
    const score = similarity(norm, phrase);
    if (!best || score > best.score) {
      if (best && best.command.id !== command.id) runnerUp = Math.max(runnerUp, best.score);
      best = { command, phrase, score };
    } else if (command.id !== best.command.id) {
      runnerUp = Math.max(runnerUp, score);
    }
  }
  if (!best || best.score < FUZZY_MIN) return null;
  if (!best.command.fuzzy) {
    return {
      status: 'rejected',
      reason: `That sounded like "${best.command.canonical}", but it has to be said exactly.`,
    };
  }
  if (best.score - runnerUp < FUZZY_MARGIN) {
    return {
      status: 'ambiguous',
      candidates: [best.command.canonical],
      reason: 'That could have been more than one command. Please repeat it.',
    };
  }
  return match(best.command, best.phrase, true);
}

/**
 * Interpret one final transcript.
 *
 * @param confidence recogniser confidence (0..1), or null when not reported.
 *   Chrome sometimes reports 0, which also means "unknown".
 */
export function parseUtterance(text: string, confidence: number | null, ctx: ParseContext): ParseResult {
  let norm = fixTabHomophone(normalizeUtterance(text));
  let raw = text.trim();
  if (!norm) return { status: 'ignored' };

  if (ctx.mode === 'wake') {
    const wake = ctx.wakeWord.toLowerCase();
    const prefix = new RegExp(`^(?:hey |ok |okay )?${wake.replace(/[^a-z ]/g, '')}\\b\\s*`, 'i');
    // Confirmation answers and dictation do not need the wake word again.
    if (!prefix.test(norm) && !ctx.pending && !ctx.dictating) return { status: 'ignored' };
    norm = norm.replace(prefix, '').trim();
    raw = raw.replace(new RegExp(`^\\s*(?:hey |ok |okay )?${wake}\\b[\\s,.!]*`, 'i'), '');
    if (!norm) return { status: 'ignored' };
  }

  const known = confidence !== null && confidence > 0;

  if (ctx.dictating) {
    // While dictating, only the escape commands are commands - and only as a whole utterance.
    const command = PHRASE_INDEX.get(norm);
    if (command && command.inDictation) return match(command, norm, false);
    if (ctx.pending && command && (command.action === 'confirm' || command.action === 'cancel')) {
      return match(command, norm, false);
    }
    return { status: 'unknown', normalized: norm };
  }

  if (known && confidence < ctx.minConfidence) {
    return { status: 'rejected', reason: 'I did not hear that clearly enough. Please repeat it.' };
  }

  const exact = PHRASE_INDEX.get(norm);
  if (exact) return match(exact, norm, false);

  const parameterised = parseParameterCommand(norm, raw, ctx);
  if (parameterised) return parameterised;

  // A near miss must clear a higher confidence bar than an exact phrase.
  if (known && confidence < Math.min(0.95, ctx.minConfidence + 0.15)) return { status: 'unknown', normalized: norm };
  return fuzzyMatch(norm) ?? { status: 'unknown', normalized: norm };
}

/**
 * Try the recogniser's alternatives in order. An exact command anywhere in
 * the list wins over a fuzzy match on the first entry.
 */
export function parseAlternatives(
  alternatives: string[],
  confidence: number | null,
  ctx: ParseContext,
): { result: ParseResult; text: string } {
  const first = alternatives[0] ?? '';
  const primary = parseUtterance(first, confidence, ctx);
  if (ctx.dictating || primary.status === 'ignored') return { result: primary, text: first };
  if (primary.status === 'match' && !primary.fuzzy) return { result: primary, text: first };
  for (const alt of alternatives.slice(1)) {
    const r = parseUtterance(alt, confidence, ctx);
    if (r.status === 'match' && !r.fuzzy) return { result: r, text: alt };
  }
  return { result: primary, text: first };
}

export function commandById(id: string): VoiceCommand | undefined {
  return VOICE_COMMANDS.find((c) => c.id === id);
}
