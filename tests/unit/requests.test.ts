// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { elementLabel, labelMatchScore, normalizeLabel } from '../../src/agent/dom';
import { HELP_SECTIONS, PHRASE_INDEX } from '../../src/core/voice/commands';
import { normalizeUtterance, parseUtterance, type ParseContext, type ParseResult } from '../../src/core/voice/parser';
import { isWebUrl, resolveSite } from '../../src/core/voice/sites';
import { handOffset } from '../../src/core/cursor/pointer';

/** Things a person plausibly asks for beyond the basic command list. */

const CTX: ParseContext = { hintsShown: false, dictating: false, mode: 'always', wakeWord: 'computer', minConfidence: 0.5, pending: false };
const parse = (text: string, ctx: Partial<ParseContext> = {}): ParseResult => parseUtterance(text, 0.9, { ...CTX, ...ctx });

describe('opening sites by name', () => {
  it('knows common sites', () => {
    expect(resolveSite('youtube')).toEqual({ url: 'https://www.youtube.com/', label: 'youtube' });
    expect(resolveSite('Gmail')?.url).toBe('https://mail.google.com/');
    expect(resolveSite('the wikipedia website')?.url).toBe('https://www.wikipedia.org/');
    expect(resolveSite('stack overflow')?.url).toBe('https://stackoverflow.com/');
  });

  it('understands spoken addresses', () => {
    expect(resolveSite('example dot com')?.url).toBe('https://example.com/');
    expect(resolveSite('news dot bbc dot co dot uk')?.url).toBe('https://news.bbc.co.uk/');
    expect(resolveSite('www.github.com')?.url).toBe('https://github.com/');
    expect(resolveSite('example dot com slash about')?.url).toBe('https://example.com/about');
  });

  it('returns nothing for text that is not a site, so it can be searched instead', () => {
    expect(resolveSite('the best pizza near me')).toBeNull();
    expect(resolveSite('')).toBeNull();
    expect(resolveSite('javascript:alert(1)')).toBeNull();
  });

  it('only ever produces web addresses', () => {
    for (const name of ['youtube', 'maps', 'example dot com', 'a dot b dot c']) {
      const site = resolveSite(name);
      if (site) expect(isWebUrl(site.url), name).toBe(true);
    }
    expect(isWebUrl('https://example.com/x')).toBe(true);
    expect(isWebUrl('javascript:alert(1)')).toBe(false);
    expect(isWebUrl('data:text/html,hi')).toBe(false);
    expect(isWebUrl('file:///C:/secret.txt')).toBe(false);
    expect(isWebUrl('chrome://settings')).toBe(false);
    expect(isWebUrl('not a url')).toBe(false);
  });

  it('"open X" opens a new tab and "go to X" loads it here', () => {
    expect(parse('open youtube')).toMatchObject({ action: 'open_site', params: { text: 'youtube' } });
    expect(parse('Go to wikipedia dot org.')).toMatchObject({ action: 'navigate_site', params: { text: 'wikipedia dot org' } });
    expect(parse('take me to gmail')).toMatchObject({ action: 'navigate_site', params: { text: 'gmail' } });
  });

  it('does not steal existing commands that start the same way', () => {
    expect(parse('open new tab')).toMatchObject({ action: 'new_tab' });
    expect(parse('open settings')).toMatchObject({ action: 'show_settings' });
    expect(parse('open 5')).toMatchObject({ action: 'click_number', params: { number: 5 } });
    expect(parse('go to top')).toMatchObject({ action: 'scroll_top' });
    expect(parse('go to bottom')).toMatchObject({ action: 'scroll_bottom' });
    expect(parse('go to 12')).toMatchObject({ action: 'click_number', params: { number: 12 } });
  });
});

describe('clicking things by name', () => {
  it('parses "click <name>"', () => {
    expect(parse('click sign in')).toMatchObject({ action: 'click_text', params: { text: 'sign in' } });
    expect(parse('Click on the Images link.')).toMatchObject({ action: 'click_text', params: { text: 'images' } });
    expect(parse('press the subscribe button')).toMatchObject({ action: 'click_text', params: { text: 'subscribe' } });
  });

  it('keeps the plain click, numbered click and key presses', () => {
    expect(parse('click')).toMatchObject({ action: 'click' });
    expect(parse('click here')).toMatchObject({ action: 'click' });
    expect(parse('click 14')).toMatchObject({ action: 'click_number' });
    expect(parse('press enter')).toMatchObject({ action: 'press_key', params: { key: 'Enter' } });
    expect(parse('press tab')).toMatchObject({ action: 'press_key', params: { key: 'Tab' } });
  });

  it('is typed as text while dictating', () => {
    expect(parse('click sign in', { dictating: true }).status).toBe('unknown');
    expect(parse('open youtube', { dictating: true }).status).toBe('unknown');
  });

  it('scores label matches from exact to loose', () => {
    const score = (label: string, said: string) => labelMatchScore(normalizeLabel(label), normalizeLabel(said));
    expect(score('Sign in', 'sign in')).toBe(1);
    expect(score('Sign in with Google', 'sign in')).toBe(0.8);
    expect(score('Please sign in here', 'sign in')).toBe(0.65);
    expect(score('Settings', 'set')).toBe(0.5);
    expect(score('Create a new account', 'new account')).toBe(0.65);
    expect(score('Account: create new', 'new account')).toBe(0.4);
    expect(score('Home', 'sign in')).toBe(0);
    expect(score('', 'x')).toBe(0);
  });

  it('prefers the exact label over one that merely contains the words', () => {
    const score = (label: string) => labelMatchScore(normalizeLabel(label), 'images');
    expect(score('Images')).toBeGreaterThan(score('Images and videos'));
    expect(score('Images and videos')).toBeGreaterThan(score('All images'));
  });

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reads labels from the associated <label>, placeholder and aria-label', () => {
    document.body.innerHTML = `
      <label for="e">Email address</label><input id="e" type="email" />
      <input id="s" placeholder="Search the site" />
      <button id="b" aria-label="Close dialog">x</button>
      <a id="a" href="#"><img alt="Company home" /></a>
      <input id="g" type="submit" value="Go" />`;
    expect(elementLabel(document.getElementById('e')!)).toBe('Email address');
    expect(elementLabel(document.getElementById('s')!)).toBe('Search the site');
    expect(elementLabel(document.getElementById('b')!)).toBe('Close dialog');
    expect(elementLabel(document.getElementById('a')!)).toBe('Company home');
    expect(elementLabel(document.getElementById('g')!)).toBe('Go');
  });
});

describe('scrolling, media, help and fields', () => {
  it('understands amounts and continuous scrolling', () => {
    expect(parse('scroll down a little')).toMatchObject({ action: 'scroll_down', params: { amount: 0.35 } });
    expect(parse('scroll up a lot')).toMatchObject({ action: 'scroll_up', params: { amount: 3 } });
    expect(parse('keep scrolling')).toMatchObject({ action: 'scroll_auto_down' });
    expect(parse('keep scrolling up')).toMatchObject({ action: 'scroll_auto_up' });
    expect(parse('stop scrolling')).toMatchObject({ action: 'scroll_stop' });
    // "stop" on its own still pauses everything.
    expect(parse('stop')).toMatchObject({ action: 'pause' });
  });

  it('controls video without colliding with pausing Handsfree', () => {
    expect(parse('play video')).toMatchObject({ action: 'media_play' });
    expect(parse('pause video')).toMatchObject({ action: 'media_pause' });
    expect(parse('mute video')).toMatchObject({ action: 'media_mute' });
    expect(parse('unmute video')).toMatchObject({ action: 'media_unmute' });
    expect(parse('pause')).toMatchObject({ action: 'pause' });
  });

  it('offers help and field navigation', () => {
    expect(parse('what can I say?')).toMatchObject({ action: 'show_help' });
    expect(parse('help')).toMatchObject({ action: 'show_help' });
    expect(parse('hide help')).toMatchObject({ action: 'hide_help' });
    expect(parse('next field')).toMatchObject({ action: 'press_key', params: { key: 'Tab' } });
    expect(parse('previous field')).toMatchObject({ action: 'press_key', params: { key: 'ShiftTab' } });
    expect(parse('duplicate tab')).toMatchObject({ action: 'duplicate_tab' });
    expect(parse('go home')).toMatchObject({ action: 'new_tab' });
  });

  it('every phrase on the help sheet is really understood', () => {
    for (const section of HELP_SECTIONS) {
      for (const phrase of section.phrases) {
        const r = parse(phrase, { hintsShown: true });
        expect(r.status, `${section.title}: ${phrase}`).toBe('match');
      }
    }
  });

  it('all new phrases are stored in a form the recogniser output can match', () => {
    for (const phrase of PHRASE_INDEX.keys()) expect(normalizeUtterance(phrase), phrase).toBe(phrase);
  });
});

describe('hand pointer area', () => {
  it('can be centred where the hand rests', () => {
    expect(handOffset({ x: 0.7, y: 0.6 }, 0.5, { x: 0.7, y: 0.6 })).toEqual({ x: 0, y: 0 });
    expect(handOffset({ x: 0.95, y: 0.6 }, 0.5, { x: 0.7, y: 0.6 }).x).toBeCloseTo(1);
    const corner = handOffset({ x: 0.45, y: 0.35 }, 0.5, { x: 0.7, y: 0.6 });
    expect(corner.x).toBeCloseTo(-1);
    expect(corner.y).toBeCloseTo(-1);
  });
});
