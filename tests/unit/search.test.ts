import { describe, expect, it } from 'vitest';
import { PHRASE_INDEX } from '../../src/core/voice/commands';
import { parseSearchCommand, parseUtterance, type ParseContext, type ParseResult } from '../../src/core/voice/parser';

const CTX: ParseContext = {
  hintsShown: false,
  dictating: false,
  mode: 'always',
  wakeWord: 'computer',
  minConfidence: 0.5,
  pending: false,
};

const parse = (text: string, ctx: Partial<ParseContext> = {}): ParseResult => parseUtterance(text, 0.9, { ...CTX, ...ctx });

describe('search intent parsing', () => {
  it('keeps only the query from "open tab and search <email>"', () => {
    expect(parseSearchCommand('Open tab and search arnav14ghagare@gmail.com')).toEqual({
      intent: 'search_new_tab',
      query: 'arnav14ghagare@gmail.com',
    });
    expect(parse('Open tab and search arnav14ghagare@gmail.com')).toMatchObject({
      status: 'match',
      action: 'search_new_tab',
      params: { text: 'arnav14ghagare@gmail.com' },
    });
  });

  it('accepts the usual ways of asking for a new tab', () => {
    for (const phrase of [
      'Open a new tab and search for accessibility tools',
      'open new tab and search accessibility tools',
      'New tab, search for accessibility tools.',
      'Open tab then google accessibility tools',
      'In a new tab search for accessibility tools',
      'Please open a tab and look up accessibility tools',
    ]) {
      expect(parseSearchCommand(phrase), phrase).toEqual({ intent: 'search_new_tab', query: 'accessibility tools' });
    }
  });

  it('searches without a new tab unless one was asked for', () => {
    expect(parse('Search for accessibility tools.')).toMatchObject({ action: 'search', params: { text: 'accessibility tools' } });
    expect(parse('search accessibility tools')).toMatchObject({ action: 'search', params: { text: 'accessibility tools' } });
    expect(parse('Google the weather in Pune')).toMatchObject({ action: 'search', params: { text: 'the weather in Pune' } });
  });

  it('parses a search aimed at the current tab', () => {
    expect(parse('Search this tab for React tutorials.')).toMatchObject({ action: 'search_here', params: { text: 'React tutorials' } });
    expect(parse('search this page for pricing')).toMatchObject({ action: 'search_here', params: { text: 'pricing' } });
    expect(parse('search here for pricing')).toMatchObject({ action: 'search_here', params: { text: 'pricing' } });
    expect(parse('search for pricing in this tab')).toMatchObject({ action: 'search_here', params: { text: 'pricing' } });
  });

  it('preserves email addresses, plus signs, URLs and punctuation inside the query', () => {
    expect(parse('search for arnav+handsfree@gmail.com')).toMatchObject({ params: { text: 'arnav+handsfree@gmail.com' } });
    expect(parse('Open tab and search https://example.com/a-b?x=1&y=two#top')).toMatchObject({
      action: 'search_new_tab',
      params: { text: 'https://example.com/a-b?x=1&y=two#top' },
    });
    expect(parse('search for C++ vs. C#: which is faster?')).toMatchObject({ params: { text: 'C++ vs. C#: which is faster' } });
    // Number words are part of the query, not converted.
    expect(parse('search for twenty one pilots')).toMatchObject({ params: { text: 'twenty one pilots' } });
  });

  it('treats command words inside the query as ordinary words', () => {
    expect(parse('search for how to open a tab')).toMatchObject({ action: 'search', params: { text: 'how to open a tab' } });
    expect(parse('search open tab shortcuts')).toMatchObject({ action: 'search', params: { text: 'open tab shortcuts' } });
    expect(parse('open tab and search search engines')).toMatchObject({ action: 'search_new_tab', params: { text: 'search engines' } });
    expect(parse('search for for loops')).toMatchObject({ action: 'search', params: { text: 'for loops' } });
    // "this page" / "here" belong to the query unless "for" follows them.
    expect(parse('search this page intentionally left blank')).toMatchObject({ action: 'search', params: { text: 'this page intentionally left blank' } });
    expect(parse('search here comes the sun')).toMatchObject({ action: 'search', params: { text: 'here comes the sun' } });
  });

  it('never leaves command words in the query', () => {
    for (const phrase of ['Open tab and search cats', 'Open a new tab and search for cats', 'Search this tab for cats', 'Search for cats', 'Look up cats']) {
      const r = parse(phrase);
      expect(r.status === 'match' ? r.params.text : null, phrase).toBe('cats');
    }
  });

  it('asks for the query instead of guessing when none was said', () => {
    for (const phrase of ['search', 'search for', 'open tab and search', 'search this tab', 'search this tab for', 'google']) {
      expect(parse(phrase), phrase).toMatchObject({ status: 'rejected' });
    }
  });

  it('does not mistake other phrases for searches', () => {
    expect(parseSearchCommand('open youtube')).toBeNull();
    expect(parseSearchCommand('open tab')).toBeNull();
    expect(parseSearchCommand('researching cats')).toBeNull();
    expect(parseSearchCommand('searching for cats')).toBeNull();
    expect(parse('Open YouTube.')).toMatchObject({ action: 'open_site', params: { text: 'youtube' } });
    expect(parse('open tab')).toMatchObject({ action: 'new_tab' });
  });

  it('keeps the original wording for typed text', () => {
    expect(parse('Type hello, how are you?')).toMatchObject({ action: 'type_text', params: { text: 'hello, how are you?' } });
  });

  it('types a search phrase instead of running it while dictating', () => {
    expect(parse('search for cats', { dictating: true })).toMatchObject({ status: 'unknown' });
    expect(parse('open tab and search cats', { dictating: true })).toMatchObject({ status: 'unknown' });
  });
});

describe('control and browser phrases', () => {
  it('"start" and "resume" both resume, and only when said exactly', () => {
    expect(parse('start')).toMatchObject({ action: 'resume', fuzzy: false });
    expect(parse('Resume.')).toMatchObject({ action: 'resume' });
    expect(PHRASE_INDEX.get('start')?.fuzzy).toBe(false);
    // Words that merely sound like it never unlock browsing.
    for (const near of ['star', 'smart', 'started', 'restart', 'stark', 'resumes', 'resumed']) {
      const r = parse(near);
      expect(r.status === 'match' ? r.action : null, near).not.toBe('resume');
    }
  });

  it('"pause", "stop" and "emergency stop" all pause', () => {
    for (const phrase of ['pause', 'stop', 'stop browsing', 'emergency stop']) expect(parse(phrase), phrase).toMatchObject({ action: 'pause' });
    expect(parse('stop listening')).toMatchObject({ action: 'stop_listening' });
  });

  it('opens browser settings and an incognito window by name', () => {
    expect(parse('open browser settings')).toMatchObject({ action: 'browser_settings' });
    expect(parse('open incognito window')).toMatchObject({ action: 'incognito_window' });
    expect(parse('Open an incognito window.')).toMatchObject({ action: 'incognito_window' });
    // The Handsfree dashboard keeps its own phrase.
    expect(parse('open settings')).toMatchObject({ action: 'show_settings' });
  });
});
