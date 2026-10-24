import { describe, expect, it } from "vitest";
import { LazyBrush } from "./lazyBrush";
import { OneEuro } from "./oneEuro";
import { rms, runOneEuro, sample, sine } from "./testSignals";
import { LAZY_RADIUS_DEFAULT, ONE_EURO_DEFAULTS, type TimedPoint } from "./types";

const STEADY_MS = 1000;
const steady = (pts: TimedPoint[]) => pts.filter((p) => p.t >= STEADY_MS);

/** §2 (a): 200 px/s ramp on x with 6 Hz ±5 px jitter on y → RMS y residual at the One Euro output. */
function targetA(beta: number) {
  const input = sample(4, 30, (s) => ({ x: 200 * s, y: 100 + sine(5, 6)(s) }));
  const out = runOneEuro(input, { beta });
  return { input, out, yRms: rms(steady(out).map((p) => p.y - 100)) };
}

/** §2 (b): 2 Hz ±50 px sinusoid on x → output amplitude. */
function targetB(beta: number) {
  const out = runOneEuro(sample(4, 30, (s) => ({ x: 300 + sine(50, 2)(s), y: 100 })), { beta });
  const xs = steady(out).map((p) => p.x - 300);
  return (Math.max(...xs) - Math.min(...xs)) / 2;
}

/** §2 (c): ramp lag = time shift (ms) minimising the x error of a 200 px/s ramp. */
function targetC(beta: number) {
  const out = runOneEuro(sample(4, 30, (s) => ({ x: 200 * s, y: 100 })), { beta });
  let best = 0;
  let bestErr = Infinity;
  for (let lag = 0; lag <= 500; lag++) {
    const e = rms(steady(out).map((p) => p.x - (200 * (p.t - lag)) / 1000));
    if (e < bestErr) {
      bestErr = e;
      best = lag;
    }
  }
  return best;
}

function passes(beta: number) {
  const a = targetA(beta).yRms;
  const b = targetB(beta);
  const c = targetC(beta);
  return { beta, a, b, c, ok: a <= 0.75 && b >= 32.5 && c <= 150, okRelaxed: a <= 1.0 && b >= 32.5 && c <= 150 };
}

describe("One Euro acceptance targets (§2), 30 fps synthetic, steady state after 1 s", () => {
  it("@P0 defaults are mincutoff 0.6 Hz, beta 0.005, dcutoff 1.0", () => {
    expect(ONE_EURO_DEFAULTS).toEqual({ minCutoff: 0.6, beta: 0.005, dCutoff: 1.0 });
  });

  it("@P0 (a) ramp with 6 Hz ±5 px y jitter: RMS y residual ≤ 0.75 px (15 %)", () => {
    const { yRms } = targetA(ONE_EURO_DEFAULTS.beta);
    expect(yRms).toBeLessThanOrEqual(0.75);
  });

  it("@P0 (b) 2 Hz ±50 px sinusoid keeps amplitude ≥ 32.5 px (65 %)", () => {
    expect(targetB(ONE_EURO_DEFAULTS.beta)).toBeGreaterThanOrEqual(32.5);
  });

  it("@P0 (c) ramp lag ≤ 150 ms", () => {
    expect(targetC(ONE_EURO_DEFAULTS.beta)).toBeLessThanOrEqual(150);
  });

  it("@P0 beta sweep 0.003–0.01: defaults pass; smallest passing beta is reported (fallback rule if none)", () => {
    const betas = [0.003, 0.004, 0.005, 0.006, 0.007, 0.008, 0.009, 0.01];
    const results = betas.map(passes);
    const smallest = results.find((r) => r.ok) ?? null;
    // Fallback rule: if no beta satisfies all three, keep (b) and (c) and relax (a) to ≤ 20 %.
    const fallback = smallest ? null : (results.find((r) => r.okRelaxed) ?? null);
    expect(smallest ?? fallback).not.toBeNull();
    // Defaults pass, so beta stays 0.005 (recorded in DECISIONS.md with the measured numbers).
    expect(passes(ONE_EURO_DEFAULTS.beta).ok).toBe(true);
    expect(smallest!.beta).toBeLessThanOrEqual(ONE_EURO_DEFAULTS.beta);
  });

  it("@P0 10 Hz tremor at 15 fps aliases into the drawing band (documents the low-fps failure)", () => {
    // 10 Hz is above the 7.5 Hz Nyquist limit at 15 fps and folds to |10 − 15| = 5 Hz, which the
    // filter passes far more than 10 Hz at 30 fps. This is why low detection fps shows "Weak".
    const at = (fps: number) => {
      const out = runOneEuro(sample(4, fps, (s) => ({ x: 300, y: 100 + sine(5, 10, 0.3)(s) })));
      return rms(steady(out).map((p) => p.y - 100));
    };
    const r30 = at(30);
    const r15 = at(15);
    expect(r15).toBeGreaterThan(1.5 * r30);
    // The sampled 15 fps signal itself oscillates at ~5 Hz (count sign changes over 4 s).
    const s15 = sample(4, 15, (s) => ({ x: 0, y: sine(5, 10, 0.3)(s) }));
    let crossings = 0;
    for (let i = 1; i < s15.length; i++) if (Math.sign(s15[i].y) !== Math.sign(s15[i - 1].y)) crossings++;
    expect(crossings / 2 / 4).toBeGreaterThan(4);
    expect(crossings / 2 / 4).toBeLessThan(6);
  });

  it("@P0 One Euro uses real timestamps: same signal at 30 and 60 fps gives similar output", () => {
    const f30 = new OneEuro();
    const f60 = new OneEuro();
    let y30 = 0;
    let y60 = 0;
    for (let i = 0; i <= 60; i++) y60 = f60.filter(i < 30 ? 0 : 100, (i * 1000) / 60);
    for (let i = 0; i <= 30; i++) y30 = f30.filter(i < 15 ? 0 : 100, (i * 1000) / 30);
    expect(Math.abs(y30 - y60)).toBeLessThan(5);
  });
});

describe("Lazy-brush dead zone (§2), R = 12", () => {
  it("@P0 (i) a stationary point carrying (a)'s filtered y jitter never moves the pointer", () => {
    const { out } = targetA(ONE_EURO_DEFAULTS.beta);
    const lb = new LazyBrush(LAZY_RADIUS_DEFAULT);
    const first = lb.update({ x: 300, y: out[0].y });
    for (const p of out) {
      const q = lb.update({ x: 300, y: p.y });
      expect(q).toEqual(first);
    }
  });

  it("@P0 (ii) a 300 px x-ramp ends exactly 12 px short", () => {
    const lb = new LazyBrush(LAZY_RADIUS_DEFAULT);
    let q = { x: 0, y: 0 };
    for (let x = 0; x <= 300; x += 2.5) q = lb.update({ x, y: 50 });
    expect(q.x).toBeCloseTo(288, 9);
    expect(q.y).toBe(50);
  });

  it("@P0 (iii) during (a)'s ramp the pointer's y RMS ≤ the One Euro output's y RMS", () => {
    const { out, yRms } = targetA(ONE_EURO_DEFAULTS.beta);
    const lb = new LazyBrush(LAZY_RADIUS_DEFAULT);
    const ptr = out.map((p) => ({ t: p.t, ...lb.update(p) }));
    const ptrRms = rms(steady(ptr).map((p) => p.y - 100));
    expect(ptrRms).toBeLessThanOrEqual(yRms);
  });
});
