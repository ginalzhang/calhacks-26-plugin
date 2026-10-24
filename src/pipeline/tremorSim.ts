/**
 * Simulate tremor (§9, Demo): band-limited 4–10 Hz noise added to raw landmark camera px
 * BEFORE the One Euro filter. Amplitude ±4 px at rest rising linearly to ±8 px at ≥ 100 px/s
 * of hand speed. Seeded and deterministic: a sum of sinusoids with random frequencies in
 * 4–10 Hz and random phases, normalised so the peak never exceeds the amplitude.
 */
import type { Vec2 } from "./types";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Sinusoid {
  hz: number;
  phase: number;
  w: number;
}

const N_PARTIALS = 6;
export const TREMOR_BAND_HZ: [number, number] = [4, 10];
export const TREMOR_AMP_REST = 4;
export const TREMOR_AMP_FAST = 8;
export const TREMOR_FAST_SPEED = 100; // px/s

export class TremorSim {
  private px: Sinusoid[];
  private py: Sinusoid[];
  private last: { t: number; p: Vec2 } | null = null;
  private speed = 0;

  constructor(seed = 1) {
    const r = mulberry32(seed);
    const make = (): Sinusoid[] => {
      const parts = Array.from({ length: N_PARTIALS }, () => ({
        hz: TREMOR_BAND_HZ[0] + r() * (TREMOR_BAND_HZ[1] - TREMOR_BAND_HZ[0]),
        phase: r() * 2 * Math.PI,
        w: 0.5 + r(),
      }));
      const sum = parts.reduce((s, p) => s + p.w, 0);
      for (const p of parts) p.w /= sum; // peak ≤ 1
      return parts;
    };
    this.px = make();
    this.py = make();
  }

  reset(): void {
    this.last = null;
    this.speed = 0;
  }

  /** Amplitude (px) for a given hand speed (px/s). */
  static amplitude(speed: number): number {
    const f = Math.min(Math.max(speed / TREMOR_FAST_SPEED, 0), 1);
    return TREMOR_AMP_REST + f * (TREMOR_AMP_FAST - TREMOR_AMP_REST);
  }

  /** Unit noise (peak ≤ 1) at time tMs. */
  noise(tMs: number): Vec2 {
    const s = tMs / 1000;
    const ev = (ps: Sinusoid[]) => ps.reduce((acc, p) => acc + p.w * Math.sin(2 * Math.PI * p.hz * s + p.phase), 0);
    return { x: ev(this.px), y: ev(this.py) };
  }

  /** Add simulated tremor to a raw camera-px point. */
  apply(p: Vec2, tMs: number): Vec2 {
    if (this.last) {
      const dt = (tMs - this.last.t) / 1000;
      if (dt > 0) {
        const v = Math.hypot(p.x - this.last.p.x, p.y - this.last.p.y) / dt;
        const a = Math.min(1, dt / 0.15); // ~150 ms smoothing of the speed estimate
        this.speed += a * (v - this.speed);
      }
    }
    this.last = { t: tMs, p: { x: p.x, y: p.y } };
    const amp = TremorSim.amplitude(this.speed);
    const n = this.noise(tMs);
    return { x: p.x + amp * n.x, y: p.y + amp * n.y };
  }
}
