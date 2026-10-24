/**
 * One Euro filter (Casiez et al. 2012), one instance per axis. Pure; timestamps injected in ms.
 * Runs on raw landmark camera pixels (filter before gain, §0 rule 3).
 */
import { ONE_EURO_DEFAULTS, type Vec2 } from "./types";

export interface OneEuroParams {
  minCutoff: number; // Hz
  beta: number; // 1/px
  dCutoff: number; // Hz
}

function alpha(cutoffHz: number, dtS: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtS);
}

export class OneEuro {
  params: OneEuroParams;
  private x: number | null = null;
  private dx = 0;
  private lastT: number | null = null;

  constructor(params: Partial<OneEuroParams> = {}) {
    this.params = { ...ONE_EURO_DEFAULTS, ...params };
  }

  reset(): void {
    this.x = null;
    this.dx = 0;
    this.lastT = null;
  }

  /** Filter one sample. tMs = timestamp in milliseconds (strictly increasing). */
  filter(value: number, tMs: number): number {
    if (this.x === null || this.lastT === null) {
      this.x = value;
      this.dx = 0;
      this.lastT = tMs;
      return value;
    }
    let dt = (tMs - this.lastT) / 1000;
    if (!(dt > 0)) dt = 1 / 30; // non-increasing timestamp: assume one 30 fps frame
    this.lastT = tMs;
    const rawDx = (value - this.x) / dt;
    this.dx = this.dx + alpha(this.params.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(this.dx);
    this.x = this.x + alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/** Two independent One Euro filters (x, y). */
export class OneEuro2D {
  readonly fx: OneEuro;
  readonly fy: OneEuro;
  constructor(params: Partial<OneEuroParams> = {}) {
    this.fx = new OneEuro(params);
    this.fy = new OneEuro(params);
  }
  setParams(p: Partial<OneEuroParams>): void {
    Object.assign(this.fx.params, p);
    Object.assign(this.fy.params, p);
  }
  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }
  filter(p: Vec2, tMs: number): Vec2 {
    return { x: this.fx.filter(p.x, tMs), y: this.fy.filter(p.y, tMs) };
  }
}
