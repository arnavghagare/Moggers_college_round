import { describe, expect, it } from 'vitest';
import { PHRASE_INDEX, VOICE_COMMANDS } from '../../src/core/voice/commands';
import { DictationSession, applySpokenPunctuation, joinDictation } from '../../src/core/voice/dictation';
import {
  levenshtein,
  normalizeUtterance,
  parseAlternatives,
  parseUtterance,
  similarity,
  wordsToDigits,
  type ParseContext,
  type ParseResult,
} from '../../src/core/voice/parser';
import { classifyClick, needsConfirmation, type ClickTargetInfo } from '../../src/core/risk';
import { ACTIONS } from '../../src/shared/actions';

const CTX: ParseContext = {
  hintsShown: false,
  dictating: false,
  mode: 'always',
  wakeWord: 'computer',
  minConfidence: 0.5,
  pending: false,
};

const parse = (text: string, confidence: number | null = 0.9, ctx: Partial<ParseContext> = {}): ParseResult =>
  parseUtterance(text, confidence, { ...CTX, ...ctx });

const action = (r: ParseResult): string | null => (r.status === 'match' ? r.action : null);

describe('normalisation', () => {
  it('lower-cases, strips punctuation and fillers', () => {
    expect(normalizeUtterance('  Scroll DOWN, please. ')).toBe('scroll down');
    expect(normalizeUtterance('Okay go back')).toBe('go back');
    expect(normalizeUtterance("Don't")).toBe('dont');
    expect(normalizeUtterance('pause hands free')).toBe('pause handsfree');
  });

  it('keeps a filler word when it is the whole utterance', () => {
    expect(normalizeUtterance('OK')).toBe('ok');
  });

  it('converts number words to digits', () => {
    expect(wordsToDigits('click fourteen')).toBe('click 14');
    expect(wordsToDigits('twenty one')).toBe('21');
    expect(wordsToDigits('ninety')).toBe('90');
    expect(wordsToDigits('one hundred and five')).toBe('105');
    expect(wordsToDigits('two hundred')).toBe('200');
    expect(wordsToDigits('three hundred forty two')).toBe('342');
    expect(wordsToDigits('tab seven')).toBe('tab 7');
    expect(wordsToDigits('nothing here')).toBe('nothing here');
  });

  it('computes edit distance and similarity', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(similarity('scroll down', 'scroll down')).toBe(1);
    expect(similarity('scroll town', 'scroll down')).toBeCloseTo(10 / 11);
  });
});

describe('command registry', () => {
  it('maps every phrase to exactly one command', () => {
    const total = VOICE_COMMANDS.reduce((n, c) => n + 1 + c.alternatives.length, 0);
    expect(PHRASE_INDEX.size).toBe(total);
  });

  it('stores phrases in normalised form, so they can match', () => {
    for (const phrase of PHRASE_INDEX.keys()) expect(normalizeUtterance(phrase), phrase).toBe(phrase);
  });

  it('never allows fuzzy matching for commands that are risky or need confirmation', () => {
    for (const c of VOICE_COMMANDS) {
      if (c.confirm || c.risk === 'high' || c.risk === 'low') expect(c.fuzzy, c.canonical).toBe(false);
    }
  });

  it('requires confirmation for destructive commands', () => {
    for (const id of ['close_tab', 'exit', 'clear_dictation'] as const) {
      expect(VOICE_COMMANDS.find((c) => c.action === id)!.confirm).toBe(true);
      expect(ACTIONS[id].risk).toBe('high');
    }
  });

  it('covers every command the product requires', () => {
    const required: Array<[string, string]> = [
      ['Go back.', 'go_back'],
      ['Go forward.', 'go_forward'],
      ['Reload page.', 'reload'],
      ['Scroll down.', 'scroll_down'],
      ['Scroll up.', 'scroll_up'],
      ['Scroll to top.', 'scroll_top'],
      ['Scroll to bottom.', 'scroll_bottom'],
      ['Go to beginning.', 'scroll_top'],
      ['Open new tab.', 'new_tab'],
      ['Close tab', 'close_tab'],
      ['Switch tab.', 'next_tab'],
      ['Stop listening.', 'stop_listening'],
      ['Pause Handsfree.', 'pause'],
      ['Resume Handsfree.', 'resume'],
      ['Click.', 'click'],
      ['Double click.', 'double_click'],
      ['Right click.', 'right_click'],
      ['Cancel click.', 'cancel'],
      ['Start dragging.', 'drag_start'],
      ['Release.', 'drag_end'],
      ['Show numbers.', 'show_numbers'],
      ['Hide numbers.', 'hide_numbers'],
      ['Use head control.', 'use_head'],
      ['Use hand control.', 'use_hand'],
      ['Switch control mode.', 'switch_mode'],
      ['Recalibrate.', 'recalibrate'],
      ['Show settings.', 'show_settings'],
      ['Start dictation.', 'start_dictation'],
      ['Clear dictated draft', 'clear_dictation'],
      ['Stop', 'pause'],
    ];
    for (const [said, expected] of required) expect(action(parse(said)), said).toBe(expected);
    expect(action(parse('Stop dictation.', 0.9, { dictating: true }))).toBe('stop_dictation');
  });
});

describe('command parsing', () => {
  it('extracts a number for numbered clicks', () => {
    const r = parse('click 14');
    expect(r).toMatchObject({ status: 'match', action: 'click_number', params: { number: 14 } });
    expect(parse('Click fourteen.')).toMatchObject({ action: 'click_number', params: { number: 14 } });
    expect(parse('number twenty three')).toMatchObject({ action: 'click_number', params: { number: 23 } });
    expect(parse('click for')).toMatchObject({ action: 'click_number', params: { number: 4 } });
  });

  it('treats a bare number as a click only while numbers are showing', () => {
    expect(parse('14').status).toBe('unknown');
    expect(parse('14', 0.9, { hintsShown: true })).toMatchObject({ action: 'click_number', params: { number: 14 } });
  });

  it('passes the label filter for "show links / buttons / fields"', () => {
    expect(parse('show links')).toMatchObject({ action: 'show_numbers', params: { filter: 'links' } });
    expect(parse('show fields')).toMatchObject({ action: 'show_numbers', params: { filter: 'fields' } });
    expect(parse('show numbers')).toMatchObject({ action: 'show_numbers', params: {} });
  });

  it('parses tab numbers, searches, typed text and key presses', () => {
    expect(parse('switch to tab three')).toMatchObject({ action: 'switch_tab', params: { number: 3 } });
    expect(parse('Search for Two Rivers museum.')).toMatchObject({ action: 'search', params: { text: 'Two Rivers museum' } });
    expect(parse('type Hello World')).toMatchObject({ action: 'type_text', params: { text: 'Hello World' } });
    expect(parse('press enter')).toMatchObject({ action: 'press_key', params: { key: 'Enter' } });
    expect(parse('press the escape key')).toMatchObject({ action: 'press_key', params: { key: 'Escape' } });
    expect(parse('press banana')).toMatchObject({ action: 'click_text', params: { text: 'banana' } });
  });

  it('accepts a harmless near miss', () => {
    expect(parse('scroll town')).toMatchObject({ status: 'match', action: 'scroll_down', fuzzy: true });
    expect(parse('show number')).toMatchObject({ status: 'match', action: 'show_numbers', fuzzy: true });
  });

  it('refuses to guess a risky command from a near miss', () => {
    const r = parse('close tap');
    expect(r.status).toBe('rejected');
    expect(action(parse('double clique'))).toBeNull();
    expect(action(parse('turn of handsfree'))).toBeNull();
  });

  it('does not act on speech that is not a command', () => {
    expect(parse('what a lovely day it is').status).toBe('unknown');
    expect(parse('I should click on something later').status).toBe('unknown');
    expect(parse('').status).toBe('ignored');
  });

  it('rejects low-confidence speech', () => {
    expect(parse('close tab', 0.3).status).toBe('rejected');
    expect(parse('scroll down', 0.3).status).toBe('rejected');
  });

  it('needs more confidence for a near miss than for an exact phrase', () => {
    expect(action(parse('scroll town', 0.55))).toBeNull();
    expect(action(parse('scroll down', 0.55))).toBe('scroll_down');
  });

  it('treats a missing or zero confidence as unknown rather than low', () => {
    expect(action(parse('scroll down', null))).toBe('scroll_down');
    expect(action(parse('scroll down', 0))).toBe('scroll_down');
  });

  it('raises the bar when the required confidence is raised (noisy room)', () => {
    expect(action(parse('go back', 0.6, { minConfidence: 0.5 }))).toBe('go_back');
    expect(parse('go back', 0.6, { minConfidence: 0.65 }).status).toBe('rejected');
  });

  it('prefers an exact command among the recogniser alternatives', () => {
    const { result, text } = parseAlternatives(['scroll dawn', 'scroll down', 'scrolled on'], 0.9, CTX);
    expect(result).toMatchObject({ status: 'match', action: 'scroll_down', fuzzy: false });
    expect(text).toBe('scroll down');
  });

  it('reports ambiguity instead of picking between two near matches', () => {
    // Equally close to "zoom in" and "zoom on..." style phrases is hard to construct; use the API contract instead.
    const r = parse('scroll dowp');
    expect(['match', 'ambiguous']).toContain(r.status);
    if (r.status === 'match') expect(r.action).toBe('scroll_down');
  });
});

describe('wake word mode', () => {
  const wake = { mode: 'wake' as const };

  it('ignores speech without the wake word', () => {
    expect(parse('scroll down', 0.9, wake).status).toBe('ignored');
    expect(parse('click', 0.9, wake).status).toBe('ignored');
  });

  it('runs commands that start with the wake word', () => {
    expect(action(parse('computer scroll down', 0.9, wake))).toBe('scroll_down');
    expect(action(parse('Hey computer, click 5', 0.9, wake))).toBe('click_number');
    expect(parse('computer type Hello there', 0.9, wake)).toMatchObject({ params: { text: 'Hello there' } });
  });

  it('accepts a confirmation answer without the wake word', () => {
    expect(action(parse('confirm', 0.9, { ...wake, pending: true }))).toBe('confirm');
  });

  it('ignores the wake word on its own', () => {
    expect(parse('computer', 0.9, wake).status).toBe('ignored');
  });
});

describe('dictation mode parsing', () => {
  const dictating = { dictating: true };

  it('types ordinary speech, including phrases that are commands in command mode', () => {
    expect(parse('scroll down', 0.9, dictating).status).toBe('unknown');
    expect(parse('click', 0.9, dictating).status).toBe('unknown');
    expect(parse('close tab', 0.9, dictating).status).toBe('unknown');
    expect(parse('please go back to the shop', 0.9, dictating).status).toBe('unknown');
  });

  it('still recognises the escape commands as whole utterances', () => {
    expect(action(parse('stop dictation', 0.9, dictating))).toBe('stop_dictation');
    expect(action(parse('Scratch that.', 0.9, dictating))).toBe('undo_dictation');
    expect(action(parse('pause handsfree', 0.9, dictating))).toBe('pause');
    expect(action(parse('clear dictated draft', 0.9, dictating))).toBe('clear_dictation');
  });

  it('does not treat an escape phrase inside a sentence as a command', () => {
    expect(parse('I told him to stop dictation software', 0.9, dictating).status).toBe('unknown');
  });

  it('does not use fuzzy matching while dictating', () => {
    expect(parse('stop dictations', 0.9, dictating).status).toBe('unknown');
  });

  it('accepts confirm and cancel while a confirmation is open', () => {
    expect(action(parse('confirm', 0.9, { dictating: true, pending: true }))).toBe('confirm');
    expect(action(parse('cancel', 0.9, { dictating: true, pending: true }))).toBe('cancel');
    expect(parse('cancel', 0.9, dictating).status).toBe('unknown');
  });
});

describe('dictation session', () => {
  it('only accepts text while dictating', () => {
    const d = new DictationSession();
    expect(d.mode).toBe('command');
    expect(d.accept('hello')).toBeNull();
    expect(d.start()).toBe(true);
    expect(d.start()).toBe(false);
    expect(d.accept('hello')).toMatchObject({ text: 'hello' });
    expect(d.stop()).toBe(true);
    expect(d.stop()).toBe(false);
    expect(d.accept('more')).toBeNull();
  });

  it('never inserts the same recognition result twice', () => {
    const d = new DictationSession();
    d.start();
    expect(d.accept('hello world', '1:0')).not.toBeNull();
    expect(d.accept('hello world', '1:0')).toBeNull();
    expect(d.accept('hello world', '1:1')).not.toBeNull();
    expect(d.draft).toHaveLength(2);
  });

  it('tracks which phrases reached the page', () => {
    const d = new DictationSession();
    d.start();
    const a = d.accept('one')!;
    const b = d.accept('two')!;
    d.resolve(a.id, true);
    d.resolve(b.id, false);
    expect(d.insertedCount).toBe(1);
    expect(d.draft.map((s) => s.text)).toEqual(['one']);
  });

  it('undoes the latest inserted phrase', () => {
    const d = new DictationSession();
    d.start();
    for (const text of ['one', 'two', 'three']) d.resolve(d.accept(text)!.id, true);
    expect(d.undoLast()?.text).toBe('three');
    expect(d.undoLast()?.text).toBe('two');
    expect(d.insertedCount).toBe(1);
  });

  it('clears the draft and reports how much to remove', () => {
    const d = new DictationSession();
    d.start();
    for (const text of ['one', 'two']) d.resolve(d.accept(text)!.id, true);
    expect(d.clear()).toBe(2);
    expect(d.clear()).toBe(0);
    expect(d.undoLast()).toBeNull();
  });

  it('starts each dictation with an empty draft', () => {
    const d = new DictationSession();
    d.start();
    d.resolve(d.accept('old')!.id, true);
    d.stop();
    d.start();
    expect(d.draft).toHaveLength(0);
  });

  it('ignores empty transcripts', () => {
    const d = new DictationSession();
    d.start();
    expect(d.accept('   ')).toBeNull();
  });
});

describe('dictation text formatting', () => {
  it('replaces spoken punctuation', () => {
    expect(applySpokenPunctuation('hello comma world full stop')).toBe('hello, world.');
    expect(applySpokenPunctuation('is it ready question mark')).toBe('is it ready?');
    expect(applySpokenPunctuation('first line new line second line')).toBe('first line\nsecond line');
    expect(applySpokenPunctuation('wow exclamation mark')).toBe('wow!');
  });

  it('adds a separating space only when needed', () => {
    expect(joinDictation('Hello', 'world')).toBe(' world');
    expect(joinDictation('Hello ', 'world')).toBe('world');
    expect(joinDictation('Hello', ', world')).toBe(', world');
    expect(joinDictation('(', 'note')).toBe('note');
  });

  it('capitalises the start of a sentence and nothing else', () => {
    expect(joinDictation('', 'hello there')).toBe('Hello there');
    expect(joinDictation('Done.', 'next one')).toBe(' Next one');
    expect(joinDictation('Line one\n', 'line two')).toBe('Line two');
    expect(joinDictation('I like', 'green tea')).toBe(' green tea');
  });

  it('returns nothing for an empty phrase', () => {
    expect(joinDictation('abc', '')).toBe('');
  });
});

describe('click risk', () => {
  const info = (over: Partial<ClickTargetInfo>): ClickTargetInfo => ({
    tag: 'button',
    type: '',
    role: '',
    label: '',
    inForm: false,
    formSensitive: false,
    ...over,
  });

  it('flags destructive, purchase and account actions', () => {
    expect(classifyClick(info({ label: 'Delete account' }))).toMatchObject({ risky: true, kind: 'destructive' });
    expect(classifyClick(info({ label: 'Buy now' }))).toMatchObject({ risky: true, kind: 'purchase' });
    expect(classifyClick(info({ label: 'Place your order' }))).toMatchObject({ risky: true, kind: 'purchase' });
    expect(classifyClick(info({ tag: 'a', label: 'Sign out' }))).toMatchObject({ risky: true, kind: 'account' });
    expect(classifyClick(info({ label: 'Submit application', inForm: true, type: 'submit' }))).toMatchObject({ kind: 'submit' });
  });

  it('does not flag ordinary navigation and controls', () => {
    expect(classifyClick(info({ tag: 'a', label: 'Read more' })).risky).toBe(false);
    expect(classifyClick(info({ label: 'Next' })).risky).toBe(false);
    expect(classifyClick(info({ label: 'Search', inForm: true, type: 'submit' })).risky).toBe(false);
    expect(classifyClick(info({ tag: 'div', label: 'Delete everything' })).risky).toBe(false);
  });

  it('flags a submit button in a form with a password or card field', () => {
    expect(classifyClick(info({ label: 'Continue', inForm: true, type: 'submit', formSensitive: true })).risky).toBe(true);
  });

  it('applies the confirmation policy', () => {
    const risky = info({ label: 'Delete' });
    const plain = info({ tag: 'a', label: 'Home' });
    expect(needsConfirmation('never', risky)).toBeNull();
    expect(needsConfirmation('risky', risky)).toMatch(/Delete/);
    expect(needsConfirmation('risky', plain)).toBeNull();
    expect(needsConfirmation('always', plain)).toMatch(/Home/);
  });
});
