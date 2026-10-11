/**
 * Dictation: turning recognised speech into text for a focused field.
 *
 * The engine owns the mode (command vs dictation) and the list of phrases it
 * has sent; the page agent owns the actual insertion, because only it can see
 * the field. The pure helpers here are shared by both.
 */

const SPOKEN_PUNCTUATION: Array<[RegExp, string]> = [
  [/\s*\b(?:new paragraph)\b\s*/gi, '\n\n'],
  [/\s*\b(?:new line|newline|next line)\b\s*/gi, '\n'],
  [/\s*\b(?:full stop|period)\b/gi, '.'],
  [/\s*\b(?:question mark)\b/gi, '?'],
  [/\s*\b(?:exclamation mark|exclamation point)\b/gi, '!'],
  [/\s*\b(?:comma)\b/gi, ','],
  [/\s*\b(?:semicolon|semi colon)\b/gi, ';'],
  [/\s*\b(?:colon)\b/gi, ':'],
];

/** Replace spoken punctuation ("comma", "new line") with the characters. */
export function applySpokenPunctuation(text: string): string {
  let out = text.trim();
  for (const [pattern, replacement] of SPOKEN_PUNCTUATION) out = out.replace(pattern, replacement);
  return out;
}

const SENTENCE_END = /[.!?]\s*$/;

/**
 * Prepare a phrase for insertion after `before` (the text in front of the
 * caret): add a separating space when needed and capitalise the start of a
 * sentence. Existing text is never altered.
 */
export function joinDictation(before: string, phrase: string): string {
  if (!phrase) return '';
  let text = phrase;
  const startsSentence = before.trim() === '' || SENTENCE_END.test(before) || /\n\s*$/.test(before);
  if (startsSentence) text = text.replace(/^(\s*)([a-z])/, (_, ws: string, ch: string) => ws + ch.toUpperCase());
  const last = before.slice(-1);
  const needsSpace = last !== '' && !/\s/.test(last) && !/^[\s.,!?;:]/.test(text) && !/[([{"'‘“]$/.test(last);
  return (needsSpace ? ' ' : '') + text;
}

export type DictationMode = 'command' | 'dictation';

export interface DictationSegment {
  id: string;
  text: string;
  /** The page agent confirmed that this text was inserted. */
  inserted: boolean;
}

/**
 * Tracks the dictation mode and what has been dictated in this session.
 *
 * - Speech is only typed while the mode is `dictation`; commands are only
 *   executed in `command` mode (apart from the few escape commands).
 * - Each final transcript has an id. A final that was already handled is
 *   ignored, so the same phrase is never inserted twice.
 */
export class DictationSession {
  private current: DictationMode = 'command';
  private segments: DictationSegment[] = [];
  private readonly handled = new Set<string>();
  private counter = 0;

  get mode(): DictationMode {
    return this.current;
  }

  get active(): boolean {
    return this.current === 'dictation';
  }

  get draft(): DictationSegment[] {
    return this.segments;
  }

  get insertedCount(): number {
    return this.segments.filter((s) => s.inserted).length;
  }

  start(): boolean {
    if (this.current === 'dictation') return false;
    this.current = 'dictation';
    this.segments = [];
    return true;
  }

  stop(): boolean {
    if (this.current === 'command') return false;
    this.current = 'command';
    return true;
  }

  /**
   * Register a final transcript for typing.
   * @param resultKey stable identity of the recognition result, used to drop duplicates.
   * @returns the segment to insert, or null when it must not be typed.
   */
  accept(text: string, resultKey?: string): DictationSegment | null {
    if (this.current !== 'dictation') return null;
    const formatted = applySpokenPunctuation(text);
    if (!formatted) return null;
    if (resultKey !== undefined) {
      if (this.handled.has(resultKey)) return null;
      this.handled.add(resultKey);
      if (this.handled.size > 200) this.handled.delete(this.handled.values().next().value as string);
    }
    const segment: DictationSegment = { id: `d${++this.counter}`, text: formatted, inserted: false };
    this.segments.push(segment);
    return segment;
  }

  /** The page agent reported the outcome of an insertion. */
  resolve(id: string, inserted: boolean): void {
    const index = this.segments.findIndex((s) => s.id === id);
    if (index < 0) return;
    if (inserted) this.segments[index].inserted = true;
    else this.segments.splice(index, 1);
  }

  /** Remove the most recent inserted phrase. Returns it so the page can delete it. */
  undoLast(): DictationSegment | null {
    for (let i = this.segments.length - 1; i >= 0; i--) {
      if (this.segments[i].inserted) return this.segments.splice(i, 1)[0];
    }
    return null;
  }

  /** Forget the whole draft. Returns how many inserted phrases the page should remove. */
  clear(): number {
    const count = this.insertedCount;
    this.segments = [];
    return count;
  }
}
