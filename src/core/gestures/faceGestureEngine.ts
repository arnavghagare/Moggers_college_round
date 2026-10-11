import type { FaceSignals } from '../face/pose';
import type { GestureEvent } from './handGestureEngine';
import type { GestureConfig } from './registry';
import { DoubleBlinkDetector, SustainTrigger } from './triggers';

const SUSTAINED = ['blink_long', 'wink_left', 'wink_right', 'brow_raise', 'mouth_open', 'smile'] as const;
type SustainedId = (typeof SUSTAINED)[number];

/** Score (0..1) for each facial gesture, from blendshape signals. */
export function scoreFaceGestures(s: FaceSignals): Record<SustainedId | 'eyes_closed', number> {
  return {
    eyes_closed: Math.min(s.blinkLeft, s.blinkRight),
    blink_long: Math.min(s.blinkLeft, s.blinkRight),
    // A wink is one eye closed while the other is clearly open.
    wink_left: s.blinkLeft * (1 - s.blinkRight),
    wink_right: s.blinkRight * (1 - s.blinkLeft),
    brow_raise: s.browUp,
    mouth_open: s.jawOpen,
    smile: s.smile,
  };
}

/**
 * Facial gestures. Every gesture requires a deliberate temporal pattern
 * (sustained for a minimum time, or a double blink), has a refractory period,
 * and must be released before it can fire again. Natural blinks do nothing.
 */
export class FaceGestureEngine {
  private readonly sustained = new Map<SustainedId, SustainTrigger>(
    SUSTAINED.map((id) => [id, new SustainTrigger()]),
  );
  private readonly doubleBlink = new DoubleBlinkDetector();

  constructor(private config: Record<string, GestureConfig>) {}

  setConfig(config: Record<string, GestureConfig>): void {
    this.config = config;
  }

  reset(): void {
    for (const trigger of this.sustained.values()) trigger.reset();
    this.doubleBlink.reset();
  }

  update(t: number, signals: FaceSignals | null): GestureEvent[] {
    if (!signals) {
      // No face (or no blendshapes): never fire from stale state.
      this.reset();
      return [];
    }
    const events: GestureEvent[] = [];
    const scores = scoreFaceGestures(signals);

    for (const id of SUSTAINED) {
      const cfg = this.config[id];
      if (!cfg) continue;
      if (this.sustained.get(id)!.update(scores[id], t, cfg)) {
        events.push({ id, phase: 'trigger', hand: 'face', confidence: scores[id], t });
      }
    }

    const dbl = this.config.double_blink;
    if (dbl && this.doubleBlink.update(scores.eyes_closed, t, dbl)) {
      events.push({ id: 'double_blink', phase: 'trigger', hand: 'face', confidence: dbl.threshold, t });
    }
    return events;
  }
}
