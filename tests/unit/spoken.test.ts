import { describe, expect, it } from 'vitest';
import { fixTabHomophone, parseUtterance, tidySpokenEmail, type ParseContext, type ParseResult } from '../../src/core/voice/parser';

const CTX: ParseContext = {
  hintsShown: false,
  dictating: false,
  mode: 'always',
  wakeWord: 'computer',
  minConfidence: 0.5,
  pending: false,
};

const parse = (text: string): ParseResult => parseUtterance(text, 0.9, CTX);

describe('email addresses as the recogniser writes them', () => {
  it('joins the words and lower-cases the address', () => {
    expect(tidySpokenEmail('Arnav Ghagare@gmail.com')).toBe('arnavghagare@gmail.com');
    expect(tidySpokenEmail('Arnav 14 Ghagare@gmail.com')).toBe('arnav14ghagare@gmail.com');
    expect(tidySpokenEmail('Arnav14Ghagare@Gmail.com')).toBe('arnav14ghagare@gmail.com');
    expect(tidySpokenEmail('arnav14ghagare @ gmail.com')).toBe('arnav14ghagare@gmail.com');
  });

  it('understands an address that was spelled out in words', () => {
    expect(tidySpokenEmail('arnav fourteen ghagare at gmail dot com')).toBe('arnav14ghagare@gmail.com');
    expect(tidySpokenEmail('Arnav 14 Ghagare at the rate gmail.com')).toBe('arnav14ghagare@gmail.com');
    expect(tidySpokenEmail('john dot smith at outlook dot com')).toBe('john.smith@outlook.com');
    expect(tidySpokenEmail('john underscore smith plus news at yahoo dot co dot in')).toBe('john_smith+news@yahoo.co.in');
  });

  it('leaves a correct address alone', () => {
    expect(tidySpokenEmail('arnav14ghagare@gmail.com')).toBe('arnav14ghagare@gmail.com');
    expect(tidySpokenEmail('arnav+handsfree@gmail.com')).toBe('arnav+handsfree@gmail.com');
  });

  it('does not touch anything that is not an address from start to finish', () => {
    for (const text of [
      'deals at amazon.com',
      'look at example.com',
      'what is the weather at home',
      'accessibility tools',
      'https://example.com/a-b?x=1&y=two#top',
      'C++ vs. C#: which is faster',
      'send a long message to my friend Arnav about the plan at gmail.com',
      'john@example.com reviews',
    ]) {
      expect(tidySpokenEmail(text), text).toBe(text);
    }
  });

  it('is applied to what is searched for and typed', () => {
    expect(parse('Open tab and search Arnav 14 Ghagare@gmail.com')).toMatchObject({ action: 'search_new_tab', params: { text: 'arnav14ghagare@gmail.com' } });
    expect(parse('Search for Arnav Ghagare@gmail.com')).toMatchObject({ action: 'search', params: { text: 'arnavghagare@gmail.com' } });
    expect(parse('search for arnav fourteen ghagare at gmail dot com')).toMatchObject({ params: { text: 'arnav14ghagare@gmail.com' } });
    expect(parse('type Arnav 14 Ghagare@gmail.com')).toMatchObject({ action: 'type_text', params: { text: 'arnav14ghagare@gmail.com' } });
    // An ordinary search keeps its capitals and spaces.
    expect(parse('Search for Two Rivers museum')).toMatchObject({ params: { text: 'Two Rivers museum' } });
  });
});

describe('tab commands', () => {
  const tab = (text: string): number | null => {
    const r = parse(text);
    return r.status === 'match' && r.action === 'switch_tab' ? (r.params.number ?? null) : null;
  };
  const act = (text: string): string | null => {
    const r = parse(text);
    return r.status === 'match' ? r.action : null;
  };

  it('goes to a tab by number, however it is phrased', () => {
    for (const phrase of ['go to tab 2', 'Go to tab two.', 'switch to tab 2', 'switch to tab number 2', 'open tab 2', 'show tab 2', 'tab 2', 'tab number two', 'move to tab 2', 'jump to tab 2', 'switch tab 2', 'change to tab 2', 'go to the tab 2']) {
      expect(tab(phrase), phrase).toBe(2);
    }
    expect(tab('go to tab 1')).toBe(1);
    expect(tab('go to tab one')).toBe(1);
    expect(tab('switch to tab 10')).toBe(10);
  });

  it('understands what the recogniser really returns for "go to tab two"', () => {
    // Heard from Chrome's recogniser for the spoken phrase "go to tab two".
    expect(tab('go to tap to')).toBe(2);
    expect(tab('go to tab to')).toBe(2);
    expect(tab('go to tab too')).toBe(2);
    expect(tab('go to tap one')).toBe(1);
    expect(tab('switch to tap 3')).toBe(3);
    expect(tab('go to tab for')).toBe(4);
  });

  it('goes to a tab by position word', () => {
    expect(tab('first tab')).toBe(1);
    expect(tab('go to the first tab')).toBe(1);
    expect(tab('switch to the second tab')).toBe(2);
    expect(tab('open the third tab')).toBe(3);
    expect(tab('go to the 4th tab')).toBe(4);
    expect(tab('switch to the first tap')).toBe(1);
  });

  it('steps between tabs with many wordings', () => {
    for (const phrase of ['switch tab', 'switch tabs', 'next tab', 'go to next tab', 'go to the next tab', 'change tab', 'change tabs', 'other tab', 'next tap', 'switch taps', 'move to the next tab']) {
      expect(act(phrase), phrase).toBe('next_tab');
    }
    for (const phrase of ['previous tab', 'go to previous tab', 'go to the previous tab', 'previous tap', 'switch to the previous tab']) {
      expect(act(phrase), phrase).toBe('prev_tab');
    }
    for (const phrase of ['new tab', 'open new tab', 'open a new tab', 'open another tab', 'new tap', 'open new tap']) {
      expect(act(phrase), phrase).toBe('new_tab');
    }
  });

  it('keeps "tap" as a click where no tab is meant', () => {
    expect(fixTabHomophone('tap')).toBe('tap');
    expect(act('tap')).toBe('click');
    expect(parse('tap 14')).toMatchObject({ action: 'click_number', params: { number: 14 } });
    expect(parse('tap sign in')).toMatchObject({ action: 'click_text', params: { text: 'sign in' } });
  });

  it('still needs "close tab" to be heard exactly', () => {
    expect(parse('close tap').status).toBe('rejected');
    expect(act('close tab')).toBe('close_tab');
  });

  it('does not turn a site name into a tab number', () => {
    expect(parse('go to wikipedia')).toMatchObject({ action: 'navigate_site' });
    expect(parse('open youtube')).toMatchObject({ action: 'open_site' });
  });
});
