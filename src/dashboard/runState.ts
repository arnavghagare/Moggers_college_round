import { AWAITING_START, type EngineStatus, type VoiceStatus } from '../shared/types';
import type { Tone } from './components';

/**
 * Plain-language summaries of the two things a user needs to tell apart:
 * whether Handsfree can hear them, and whether it will act on what it hears.
 */

export interface RunState {
  headline: string;
  detail: string;
  tone: Tone;
  /** Actions are locked and the user can unlock them. */
  paused: boolean;
  /** Paused only because "start" has not been said yet. */
  awaitingStart: boolean;
}

export function voiceLabel(voice: VoiceStatus | undefined): [string, Tone] {
  if (!voice) return ['Off', ''];
  switch (voice.state) {
    case 'listening':
      return [voice.dictating ? 'Dictating' : 'Listening', 'live'];
    case 'starting':
      return ['Starting', 'warn'];
    case 'reconnecting':
      return ['Reconnecting', 'warn'];
    case 'muted':
      return ['Not listening', ''];
    case 'error':
      return ['Microphone unavailable', 'bad'];
    default:
      return ['Off', ''];
  }
}

export function describeRun(enabled: boolean, status: EngineStatus | null, modeName: string): RunState {
  const base = { paused: false, awaitingStart: false };
  if (!enabled) return { ...base, headline: 'Handsfree is off', detail: 'Camera and microphone are not in use.', tone: '' };
  if (!status) return { ...base, headline: 'Connecting...', detail: 'Starting the engine.', tone: 'warn' };

  // Chrome ends and restarts a recognition session every few seconds of silence. That brief
  // "starting" is part of normal listening, so the headline does not flip back and forth with it.
  // The Voice tile still shows the exact state.
  const hearing = status.voice.state === 'listening' || status.voice.state === 'starting';
  const prefix = hearing ? 'Listening · ' : '';
  switch (status.phase) {
    case 'error':
      return { ...base, headline: 'Stopped', detail: 'Something went wrong. Details below.', tone: 'bad' };
    case 'loading':
      return { ...base, headline: 'Warming up', detail: 'Starting the camera and loading the tracking models.', tone: 'warn' };
    case 'grace':
      return {
        ...base,
        headline: `Ready in ${Math.ceil(status.graceRemainingMs / 1000)}...`,
        detail: 'The cursor moves, but clicks are locked for a moment so nothing fires by accident.',
        tone: 'warn',
      };
    case 'suspended':
      return {
        ...base,
        paused: true,
        headline: `${status.cursorSource === 'hand' ? 'Hand' : 'Head'} tracking lost · Actions paused`,
        detail: 'Move back into view to carry on. Nothing can be clicked meanwhile.',
        tone: 'warn',
      };
    case 'paused': {
      const awaitingStart = status.pausedReason === AWAITING_START;
      return {
        paused: true,
        awaitingStart,
        headline: `${prefix}Actions paused`,
        detail: awaitingStart
          ? hearing
            ? 'Handsfree hears you but will not act yet. Say "start", or press Start.'
            : 'Press Start to begin. (Saying "start" works once the microphone is listening.)'
          : hearing
            ? 'Nothing is clicked, scrolled, typed or opened. Say "start" or "resume" to carry on.'
            : 'Nothing is clicked, scrolled, typed or opened. Press Resume to carry on.',
        tone: 'warn',
      };
    }
    default:
      return {
        ...base,
        headline: hearing ? 'Voice active · Browsing enabled' : `${modeName} is live · Browsing enabled`,
        detail: hearing ? 'Open any site and go. Say "pause" to stop acting on what you say.' : 'Open any site and go. Alt+Shift+P pauses.',
        tone: 'ok',
      };
  }
}
