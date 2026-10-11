/**
 * One Euro Filter (Casiez, Roussel, Vogel - CHI 2012).
 *
 * An adaptive low-pass filter: at low speeds the cutoff is low, which removes
 * jitter; at high speeds the cutoff rises, which removes lag. This is what
 * lets a noisy head pose hold a cursor still on a small target and still
 * cross the screen quickly.
 */

function alpha(cutoffHz: number, dtSec: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
}

export interface OneEuroParams {
  /** Cutoff at rest, in Hz. Lower = steadier but laggier. */
  minCutoff: number;
  /** How quickly the cutoff rises with speed. Higher = less lag when moving. */
  beta: number;
  /** Cutoff for the derivative estimate, in Hz. */
  dCutoff: number;
}

export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private lastT = 0;

  constructor(private params: OneEuroParams) {}

  setParams(params: OneEuroParams): void {
    this.params = params;
  }

  reset(): void {
    this.x = null;
    this.dx = 0;
  }

  get value(): number | null {
    return this.x;
  }

  /** @param tMs timestamp in milliseconds */
  filter(value: number, tMs: number): number {
    if (this.x === null) {
      this.x = value;
      this.dx = 0;
      this.lastT = tMs;
      return value;
    }
    const dt = (tMs - this.lastT) / 1000;
    // Ignore duplicate or out-of-order timestamps instead of dividing by zero.
    if (dt <= 0) return this.x;
    this.lastT = tMs;

    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.params.dCutoff, dt) * (rawDx - this.dx);

    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

export class OneEuroFilter2D {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;

  constructor(params: OneEuroParams) {
    this.fx = new OneEuroFilter(params);
    this.fy = new OneEuroFilter(params);
  }

  setParams(params: OneEuroParams): void {
    this.fx.setParams(params);
    this.fy.setParams(params);
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }

  filter(x: number, y: number, tMs: number): { x: number; y: number } {
    return { x: this.fx.filter(x, tMs), y: this.fy.filter(y, tMs) };
  }
}

/**
 * Map the user-facing "smoothing" slider (0 = raw, 1 = heaviest) to filter
 * parameters. Inputs are expected in screen-relative units (1 = full screen),
 * so speeds are in screens per second.
 */
export function smoothingToParams(smoothing: number): OneEuroParams {
  const s = Math.min(1, Math.max(0, smoothing));
  return {
    minCutoff: 0.12 + 3.2 * (1 - s) ** 2,
    beta: 1.2 + 5 * (1 - s),
    dCutoff: 1,
  };
}
