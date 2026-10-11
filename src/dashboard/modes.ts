import type { ControlMode } from '../shared/types';

/** The three ways to use Handsfree. Everything in the UI is organised around these. */
export interface ModeInfo {
  id: Exclude<ControlMode, 'hybrid'>;
  route: string;
  name: string;
  emoji: string;
  color: string;
  tagline: string;
  how: string[];
  needs: string;
}

export const MODES: ModeInfo[] = [
  {
    id: 'head',
    route: 'head',
    name: 'Head mode',
    emoji: '🙂',
    color: 'var(--lime)',
    tagline: 'Your nose is the mouse.',
    how: ['Turn your head to move the cursor', 'Rest on something to click it', 'Calibrate once, about 17 seconds'],
    needs: 'Camera',
  },
  {
    id: 'hand',
    route: 'hand',
    name: 'Hand mode',
    emoji: '✋',
    color: 'var(--pink)',
    tagline: 'Point, pinch, done.',
    how: ['Point or open your hand to move', 'Pinch to click, hold the pinch to drag', 'Two fingers scroll, a fist freezes'],
    needs: 'Camera',
  },
  {
    id: 'voice',
    route: 'voice',
    name: 'Voice mode',
    emoji: '🎙️',
    color: 'var(--violet)',
    tagline: 'Say it and it happens.',
    how: ['Every link gets a number: just say it', '"Open youtube", "scroll down", "go back"', 'Dictate into any text box'],
    needs: 'Microphone + internet',
  },
];

/** A stored "hybrid" setting from an older version behaves as head mode in this UI. */
export const currentMode = (mode: ControlMode): ModeInfo => MODES.find((m) => m.id === mode) ?? MODES[0];
