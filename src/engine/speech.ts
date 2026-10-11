import type { SpeechEvent } from '../shared/messages';

/* Minimal typings for the Web Speech API (prefixed in Chromium). */
interface RecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface RecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: RecognitionAlternative;
}
interface RecognitionEvent {
  resultIndex: number;
  results: { length: number; [index: number]: RecognitionResult };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onresult: ((ev: RecognitionEvent) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

/** A source of speech events. The engine does not care which recogniser is behind it. */
export interface SpeechProvider {
  readonly supported: boolean;
  start(lang: string): void;
  stop(): void;
  dispose(): void;
}

export type SpeechListener = (event: SpeechEvent, resultKey?: string) => void;

export function recognitionAvailable(): boolean {
  const g = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return typeof (g.SpeechRecognition ?? g.webkitSpeechRecognition) === 'function';
}

const FATAL = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported']);

/**
 * Speech recognition through the browser's Web Speech API.
 *
 * In Chrome this API sends microphone audio to a Google speech service, so
 * it needs an internet connection and is disclosed to the user before voice
 * is enabled. The recogniser only runs between `start()` and `stop()`.
 */
export class WebSpeechProvider implements SpeechProvider {
  private recognition: Recognition | null = null;
  private wanted = false;
  private lang = 'en-US';
  private session = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private readonly meter: MicMeter;
  readonly supported = recognitionAvailable();

  constructor(private readonly emit: SpeechListener) {
    this.meter = new MicMeter(emit);
  }

  start(lang: string): void {
    if (!this.supported) {
      this.emit({ kind: 'error', code: 'unsupported' });
      return;
    }
    const changed = lang !== this.lang;
    this.lang = lang;
    if (this.wanted && !changed) return;
    this.wanted = true;
    this.failures = 0;
    void this.meter.start();
    if (this.recognition && changed) {
      // onend restarts it with the new language.
      this.recognition.abort();
      return;
    }
    this.begin();
  }

  stop(): void {
    this.wanted = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.meter.stop();
    const r = this.recognition;
    this.recognition = null;
    if (r) {
      r.onend = r.onerror = r.onresult = r.onstart = null;
      try {
        r.abort();
      } catch {
        /* not started */
      }
    }
    this.emit({ kind: 'state', state: 'stopped' });
  }

  dispose(): void {
    this.stop();
  }

  private begin(): void {
    if (!this.wanted || this.recognition) return;
    const g = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    const Ctor = g.SpeechRecognition ?? g.webkitSpeechRecognition;
    if (!Ctor) return;

    const r = new Ctor();
    const session = ++this.session;
    r.lang = this.lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 3;

    r.onstart = () => {
      this.emit({ kind: 'state', state: 'listening' });
    };
    r.onresult = (ev) => {
      this.failures = 0;
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        if (!result || result.length === 0) continue;
        if (result.isFinal) {
          const alternatives: string[] = [];
          for (let a = 0; a < result.length; a++) alternatives.push(result[a].transcript.trim());
          // The session and result index identify this result exactly once.
          this.emit(
            { kind: 'final', text: alternatives[0], confidence: result[0].confidence ?? null, alternatives },
            `${session}:${i}`,
          );
        } else {
          interim += result[0].transcript;
        }
      }
      this.emit({ kind: 'interim', text: interim.trim() });
    };
    r.onerror = (ev) => {
      this.emit({ kind: 'error', code: ev.error });
      if (FATAL.has(ev.error)) {
        this.wanted = false;
        this.meter.stop();
      } else if (ev.error !== 'no-speech' && ev.error !== 'aborted') {
        this.failures += 1;
      }
    };
    r.onend = () => {
      if (this.recognition === r) this.recognition = null;
      if (!this.wanted) {
        this.emit({ kind: 'state', state: 'stopped' });
        return;
      }
      // Chrome ends continuous recognition after silence; restart, backing off on repeated errors.
      this.emit({ kind: 'state', state: 'starting' });
      const delay = Math.min(5000, 250 * 2 ** Math.min(this.failures, 5));
      this.restartTimer = setTimeout(() => this.begin(), delay);
    };

    this.recognition = r;
    this.emit({ kind: 'state', state: 'starting' });
    try {
      r.start();
    } catch {
      this.recognition = null;
      this.failures += 1;
      this.restartTimer = setTimeout(() => this.begin(), 1000);
    }
  }
}

/**
 * Microphone level meter. It measures loudness only: samples are reduced to a
 * single RMS value in memory and discarded, and nothing is recorded. The
 * stream is opened when listening starts and closed when it stops.
 */
export class MicMeter {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private floor = 0;
  private starting = false;

  constructor(private readonly emit: SpeechListener) {}

  async start(): Promise<void> {
    if (this.stream || this.starting) return;
    this.starting = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (!this.starting) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      const context = new AudioContext();
      this.context = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      if (context.state === 'suspended') await context.resume().catch(() => undefined);
      const buffer = new Float32Array(analyser.fftSize);
      this.floor = 0;
      let ticks = 0;
      this.emit({ kind: 'mic', state: 'on' });
      this.timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
        const level = Math.sqrt(sum / buffer.length);
        // Noise floor: drops quickly to quiet moments, rises only slowly, so speech does not raise it.
        this.floor = this.floor === 0 ? level : level < this.floor ? this.floor + (level - this.floor) * 0.3 : this.floor + (level - this.floor) * 0.01;
        if (++ticks % 2 === 0) this.emit({ kind: 'level', level, noiseFloor: this.floor });
      }, 120);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      this.emit({
        kind: 'mic',
        state: name === 'NotAllowedError' ? 'denied' : name === 'NotFoundError' ? 'notfound' : 'error',
      });
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    this.starting = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.emit({ kind: 'mic', state: 'off' });
    this.emit({ kind: 'level', level: 0, noiseFloor: 0 });
  }
}
