/**
 * Steadiness slider (0–100) → (One Euro minCutoff Hz, lazy-brush radius in target units),
 * piecewise-linear through STEADINESS_KNOTS (§2). 50 is exactly the tested default.
 */
import { STEADINESS_KNOTS } from "./types";

export interface SteadinessParams {
  minCutoff: number;
  lazyRadius: number;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function steadinessParams(steadiness: number): SteadinessParams {
  const s = clamp(Number.isFinite(steadiness) ? steadiness : 50, 0, 100);
  const k = STEADINESS_KNOTS;
  for (let i = 1; i < k.length; i++) {
    const [s0, c0, r0] = k[i - 1];
    const [s1, c1, r1] = k[i];
    if (s <= s1) {
      const f = s1 === s0 ? 0 : (s - s0) / (s1 - s0);
      return { minCutoff: c0 + f * (c1 - c0), lazyRadius: r0 + f * (r1 - r0) };
    }
  }
  const last = k[k.length - 1];
  return { minCutoff: last[1], lazyRadius: last[2] };
}

/** §2: clamp(round(8 × max(restJitterRMS_px, kineticJitterRMS_px)), 10, 90). */
export function suggestedSteadiness(restJitterRMS: number, kineticJitterRMS: number): number {
  return clamp(Math.round(8 * Math.max(restJitterRMS || 0, kineticJitterRMS || 0)), 10, 90);
}
