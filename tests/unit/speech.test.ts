import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSpeechProvider } from '../../src/engine/speech';
import type { SpeechEvent } from '../../src/shared/messages';

/**
 * The speech provider against a scripted stand-in for the browser's
 * recogniser. This checks the lifecycle (one session at a time, restarts,
 * backoff, stale events); it says nothing about real recognition quality.
 */
class FakeRecognition {
  static created: FakeRecognition[] = [];
  static live = 0;
  static maxLive = 0;
  static failStart = false;

  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((ev: { error: string }) => void) | null = null;
  onresult: ((ev: unknown) => void) | null = null;
  running = false;

  constructor() {
    FakeRecognition.created.push(this);
  }
  start(): void {
    if (FakeRecognition.failStart) throw new Error('InvalidStateError');
    this.running = true;
    FakeRecognition.live += 1;
    FakeRecognition.maxLive = Math.max(FakeRecognition.maxLive, FakeRecognition.live);
  }
  stop(): void {
    this.finish();
  }
  abort(): void {
    this.finish();
  }
  /** The browser ending the session. */
  finish(): void {
    if (!this.running) return;
    this.running = false;
    FakeRecognition.live -= 1;
    this.onend?.();
  }
  say(text: string, isFinal = true, index = 0): void {
    const result = Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal });
    const results: Record<number, unknown> & { length: number } = { length: index + 1 };
    results[index] = result;
    this.onresult?.({ resultIndex: index, results });
  }
}

const latest = (): FakeRecognition => FakeRecognition.created[FakeRecognition.created.length - 1];

let events: Array<{ event: SpeechEvent; key?: string }>;
let provider: WebSpeechProvider;
const states = (): string[] => events.filter((e) => e.event.kind === 'state').map((e) => (e.event as { state: string }).state);
const finals = (): string[] => events.filter((e) => e.event.kind === 'final').map((e) => (e.event as { text: string }).text);

beforeEach(() => {
  vi.useFakeTimers();
  FakeRecognition.created = [];
  FakeRecognition.live = 0;
  FakeRecognition.maxLive = 0;
  FakeRecognition.failStart = false;
  vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
  // No microphone in the test environment: the level meter reports that and stays out of the way.
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.reject(new Error('no device')) } });
  events = [];
  provider = new WebSpeechProvider((event, key) => events.push({ event, key }));
});

afterEach(() => {
  provider.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('speech recognition lifecycle', () => {
  it('starts one continuous session and reports listening only once it has started', () => {
    provider.start('en-US');
    expect(FakeRecognition.created).toHaveLength(1);
    expect(latest().continuous).toBe(true);
    expect(latest().interimResults).toBe(true);
    expect(states()).toEqual(['starting']);
    latest().onstart?.();
    expect(states()).toEqual(['starting', 'listening']);
  });

  it('restarts after the browser ends a session, without overlapping sessions', () => {
    provider.start('en-US');
    latest().onstart?.();
    // Eight quiet seconds, then Chrome ends the session with "no-speech".
    vi.advanceTimersByTime(8000);
    latest().onerror?.({ error: 'no-speech' });
    latest().finish();
    // The next session starts in the same instant, with no timer to wait for.
    expect(FakeRecognition.created).toHaveLength(2);
    expect(latest().running).toBe(true);
    expect(states().slice(-1)).toEqual(['starting']);
    latest().onstart?.();
    expect(states().slice(-1)).toEqual(['listening']);
    expect(FakeRecognition.maxLive).toBe(1);
  });

  it('keeps listening through a long silence, one session after another', () => {
    provider.start('en-US');
    for (let i = 0; i < 12; i++) {
      latest().onstart?.();
      vi.advanceTimersByTime(8000);
      latest().onerror?.({ error: 'no-speech' });
      latest().finish();
      // Never a moment without a running session.
      expect(FakeRecognition.live).toBe(1);
    }
    expect(FakeRecognition.created).toHaveLength(13);
    expect(FakeRecognition.maxLive).toBe(1);
    latest().onstart?.();
    latest().say('scroll down');
    expect(finals()).toEqual(['scroll down']);
  });

  it('waits before retrying a session that ends the moment it begins', () => {
    provider.start('en-US');
    latest().onstart?.();
    latest().finish();
    expect(FakeRecognition.created).toHaveLength(1);
    expect(states().slice(-1)).toEqual(['starting']);
    vi.advanceTimersByTime(600);
    expect(FakeRecognition.created).toHaveLength(2);
  });

  it('backs off instead of looping when sessions keep failing', () => {
    provider.start('en-US');
    for (let i = 0; i < 6; i++) {
      latest().onerror?.({ error: 'network' });
      latest().finish();
      vi.advanceTimersByTime(260);
    }
    // Six failures in about 1.5 s must not mean six restarts.
    expect(FakeRecognition.created.length).toBeLessThan(5);
    vi.advanceTimersByTime(6000);
    expect(latest().running).toBe(true);
    expect(FakeRecognition.maxLive).toBe(1);
  });

  it('does not restart after a fatal permission error', () => {
    provider.start('en-US');
    latest().onerror?.({ error: 'not-allowed' });
    latest().finish();
    vi.advanceTimersByTime(60000);
    expect(FakeRecognition.created).toHaveLength(1);
    expect(events.some((e) => e.event.kind === 'error' && e.event.code === 'not-allowed')).toBe(true);
    expect(states().slice(-1)).toEqual(['stopped']);
  });

  it('does not restart after listening is switched off', () => {
    provider.start('en-US');
    latest().onstart?.();
    provider.stop();
    vi.advanceTimersByTime(120000);
    expect(FakeRecognition.created).toHaveLength(1);
    expect(FakeRecognition.live).toBe(0);
    expect(states().slice(-1)).toEqual(['stopped']);
  });

  it('never runs two sessions when switched off and on quickly', () => {
    for (let i = 0; i < 10; i++) {
      provider.start('en-US');
      provider.stop();
    }
    provider.start('en-US');
    vi.advanceTimersByTime(10000);
    expect(FakeRecognition.maxLive).toBe(1);
    expect(FakeRecognition.live).toBe(1);
  });

  it('ignores results from a session that has been stopped', () => {
    provider.start('en-US');
    const old = latest();
    old.onstart?.();
    const handler = old.onresult;
    provider.stop();
    // A late callback from the old session, as the browser may still deliver.
    old.onresult = handler;
    old.say('open youtube');
    expect(finals()).toEqual([]);
  });

  it('gives every final result an identity, and never emits an interim as final', () => {
    provider.start('en-US');
    latest().onstart?.();
    latest().say('scroll', false);
    expect(finals()).toEqual([]);
    latest().say('scroll down', true, 0);
    latest().say('go back', true, 1);
    expect(finals()).toEqual(['scroll down', 'go back']);
    const keys = events.filter((e) => e.event.kind === 'final').map((e) => e.key);
    expect(new Set(keys).size).toBe(2);
  });

  it('retries a session that never starts', () => {
    provider.start('en-US');
    // No onstart, no error, no end: the session is stuck.
    vi.advanceTimersByTime(15000);
    expect(FakeRecognition.created.length).toBeGreaterThan(1);
    expect(FakeRecognition.maxLive).toBe(1);
  });

  it('restarts a session that goes silent without ending', () => {
    provider.start('en-US');
    latest().onstart?.();
    vi.advanceTimersByTime(60000);
    expect(FakeRecognition.created).toHaveLength(1);
    vi.advanceTimersByTime(60000);
    expect(FakeRecognition.created.length).toBeGreaterThan(1);
    expect(FakeRecognition.maxLive).toBe(1);
  });

  it('recovers when starting throws', () => {
    FakeRecognition.failStart = true;
    provider.start('en-US');
    FakeRecognition.failStart = false;
    vi.advanceTimersByTime(1500);
    expect(latest().running).toBe(true);
  });
});
