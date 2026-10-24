import { describe, expect, it } from "vitest";
import { createCalibrator, STEP_PROMPTS } from "./calibration";
import { HandLock } from "./handLock";
import { rng, runOneEuro, sample, hand } from "./testSignals";
import { Tracker } from "./tracking";
import { TremorSim } from "./tremorSim";
import type { Vec2 } from "./types";

function feedSteps(cal: ReturnType<typeof createCalibrator>, pts: Array<{ t: number; x: number; y: number }>, hd: "Left" | "Right" = "Left") {
  let last = 0;
  for (const p of pts) last = cal.feed(p.t, p, p, hd);
  return last;
}

describe("calibration", () => {
  it("@P0 steps 1–2: rest jitter, handedness, padded box, gain clamped 2–4, kinetic jitter, suggestion", () => {
    const cal = createCalibrator({ steps: [1, 2], targetWidth: 300, now: 42 });
    expect(cal.step).toBe(1);
    expect(cal.prompt).toBe(STEP_PROMPTS[1]);
    const r = rng(3);
    // Step 1: 3 s rest with ±2 px noise, through One Euro (calibration reads the filter output).
    const rest = runOneEuro(sample(3.1, 30, () => ({ x: 300 + (r() - 0.5) * 4, y: 200 + (r() - 0.5) * 4 })));
    feedSteps(cal, rest);
    expect(cal.step).toBe(2);
    // Step 2: 4 s circle radius 50 at 0.5 Hz with 6 Hz ±3 px wobble.
    const t0 = rest[rest.length - 1].t + 33;
    const circle = runOneEuro(
      sample(
        4.1,
        30,
        (s) => ({
          x: 320 + 50 * Math.cos(Math.PI * s) + 3 * Math.sin(2 * Math.PI * 6 * s),
          y: 240 + 50 * Math.sin(Math.PI * s),
        }),
        t0,
      ),
    );
    feedSteps(cal, circle);
    const res = cal.result()!;
    expect(res).not.toBeNull();
    expect(cal.step).toBeNull();
    expect(res.handedness).toBe("Left");
    expect(res.restJitterRMS).toBeGreaterThan(0);
    expect(res.restJitterRMS).toBeLessThan(2);
    // Box ≈ circle bounding box (≈ 100 px, a little less after filtering) padded 20 %.
    expect(res.box.w).toBeGreaterThan(90);
    expect(res.box.w).toBeLessThan(130);
    expect(res.gain).toBeCloseTo(300 / res.box.w, 6);
    expect(res.gain).toBeGreaterThanOrEqual(2);
    expect(res.gain).toBeLessThanOrEqual(4);
    expect(res.kineticJitterRMS).toBeGreaterThan(res.restJitterRMS);
    expect(res.suggestedSteadiness).toBe(Math.min(90, Math.max(10, Math.round(8 * Math.max(res.restJitterRMS, res.kineticJitterRMS)))));
    expect(res.createdAt).toBe(42);
    expect(res.flipX).toBe(false);
    expect(res.flipY).toBe(false);
  });

  it("@P0 gain clamps to 4× for a wide target and 2× for a narrow one", () => {
    const run = (w: number) => {
      const cal = createCalibrator({ steps: [2], targetWidth: w });
      feedSteps(cal, sample(4.1, 30, (s) => ({ x: 320 + 50 * Math.cos(Math.PI * s), y: 240 + 50 * Math.sin(Math.PI * s) })));
      return cal.result()!.gain;
    };
    expect(run(2000)).toBe(4);
    expect(run(100)).toBe(2);
  });

  it("@P1 step 3 flips an axis that moves the wrong way", () => {
    const run = (dirX: number, dirY: number) => {
      const cal = createCalibrator({ steps: [3], targetWidth: 800 });
      expect(cal.prompt).toBe(STEP_PROMPTS[3]);
      feedSteps(
        cal,
        sample(3.1, 30, (s) => (s < 1.5 ? { x: 300 + dirX * 40 * s, y: 240 } : { x: 300 + dirX * 60, y: 240 + dirY * 40 * (s - 1.5) })),
      );
      return cal.result()!;
    };
    expect(run(1, -1)).toMatchObject({ flipX: false, flipY: false });
    expect(run(-1, -1)).toMatchObject({ flipX: true, flipY: false });
    expect(run(1, 1)).toMatchObject({ flipX: false, flipY: true });
  });
});

describe("tracking word and reasons", () => {
  it("@P0 score ≥ 0.75 Tracking, 0.6–0.75 Weak, detection fps < 20 Weak (low_fps)", () => {
    const tr = new Tracker();
    let u = tr.frame(0, { accepted: true, score: 0.9, outsideArea: false });
    for (let t = 33; t < 1000; t += 33) u = tr.frame(t, { accepted: true, score: 0.9, outsideArea: false });
    expect(u.word).toBe("Tracking");
    u = tr.frame(1033, { accepted: true, score: 0.7, outsideArea: false });
    expect(u.word).toBe("Weak");
    const slow = new Tracker();
    for (let t = 0; t < 2000; t += 66) u = slow.frame(t, { accepted: true, score: 0.9, outsideArea: false });
    expect(u.word).toBe("Weak");
    expect(u.reason).toBe("low_fps");
  });

  it("@P0 Lost after 300 ms without an accepted frame; too dark reason from luma", () => {
    const tr = new Tracker();
    for (let t = 0; t < 500; t += 33) tr.frame(t, { accepted: true, score: 0.9, outsideArea: false, luma: 120 });
    let u = tr.frame(700, { accepted: false, score: 0.3, outsideArea: false, luma: 20 });
    expect(u.word).toBe("Weak");
    u = tr.frame(800, { accepted: false, score: 0.3, outsideArea: false, luma: 20 });
    expect(u.becameLost).toBe(true);
    expect(u.word).toBe("Lost");
    expect(u.reason).toBe("too_dark");
  });
});

describe("hand lock (unit)", () => {
  const tf = { mirror: false, rotate: false };
  it("@P1 uses the wrist only, within 25 % of the frame, following the accepted wrist", () => {
    const lock = new HandLock();
    const a = hand({ x: 300, y: 200 }, { wrist: { x: 300, y: 300 } });
    const r1 = lock.choose([a], tf);
    expect(r1.hand).toBe(a);
    lock.accept(r1.wrist!);
    // A second detection far away is rejected even with a higher score.
    const cup = { ...hand({ x: 600, y: 50 }, { wrist: { x: 620, y: 60 } }), score: 0.99 };
    expect(lock.choose([cup, a], tf).hand).toBe(a);
    expect(lock.choose([cup], tf)).toMatchObject({ hand: null, reason: "outside_area" });
    // Fingers can be anywhere: only the wrist matters.
    const curled = hand({ x: 600, y: 50 }, { wrist: { x: 330, y: 310 } });
    expect(lock.choose([curled], tf).hand).toBe(curled);
    lock.reset();
    expect(lock.choose([cup], tf).hand).toBe(cup);
  });
});

describe("Simulate tremor", () => {
  const amp = (s: TremorSim, path: (t: number) => Vec2, from = 1000, to = 5000) => {
    let peak = 0;
    let sq = 0;
    let n = 0;
    for (let t = 0; t < to; t += 1000 / 30) {
      const p = path(t);
      const q = s.apply(p, t);
      if (t >= from) {
        const d = Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y));
        peak = Math.max(peak, d);
        sq += (q.x - p.x) ** 2;
        n++;
      }
    }
    return { peak, rms: Math.sqrt(sq / n) };
  };
  it("@P1 ±4 px at rest rising to ±8 px above 100 px/s; deterministic per seed", () => {
    const rest = amp(new TremorSim(5), () => ({ x: 300, y: 200 }));
    expect(rest.peak).toBeLessThanOrEqual(4 + 1e-9);
    expect(rest.peak).toBeGreaterThan(1.5);
    const fast = amp(new TremorSim(5), (t) => ({ x: 100 + 0.15 * t, y: 200 })); // 150 px/s
    expect(fast.peak).toBeLessThanOrEqual(8 + 1e-9);
    expect(fast.rms).toBeGreaterThan(1.6 * rest.rms);
    expect(TremorSim.amplitude(0)).toBe(4);
    expect(TremorSim.amplitude(50)).toBe(6);
    expect(TremorSim.amplitude(250)).toBe(8);
    const a = new TremorSim(9).noise(1234);
    const b = new TremorSim(9).noise(1234);
    expect(a).toEqual(b);
  });
  it("@P1 noise is band-limited to 4–10 Hz", () => {
    const s = new TremorSim(11);
    // Count zero crossings of x over 10 s at 1 kHz: mean frequency must lie in the band.
    let crossings = 0;
    let prev = s.noise(0).x;
    for (let t = 1; t < 10000; t++) {
      const v = s.noise(t).x;
      if (Math.sign(v) !== Math.sign(prev)) crossings++;
      prev = v;
    }
    const hz = crossings / 2 / 10;
    expect(hz).toBeGreaterThanOrEqual(4);
    expect(hz).toBeLessThanOrEqual(10);
  });
});
