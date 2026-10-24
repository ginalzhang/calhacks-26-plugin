import { describe, expect, it } from "vitest";
import { createCalibrator, mirrorCalibration } from "./calibration";
import { modeState, panState } from "./pipeline";
import { Driver, TEST_CAL } from "./pipelineDriver";
import { steadinessParams } from "./steadiness";
import { DASH_WINDOW_MS, offsetStroke } from "./strokeModes";
import { sample } from "./testSignals";
import type { PenEvent, Vec2 } from "./types";

type Ev = PenEvent & { t: number };
const C = { x: 500, y: 400 };
const ms = (d: Driver) => modeState(d.pl)!;

describe("smoothing presets", () => {
  it("@P3 Sketch 25, Ink 70, Shade 10 with lazy radius capped at 5", () => {
    const d = new Driver({ phase: "P3" });
    d.hold(C, 100);
    d.action("smoothing_shade");
    expect(d.pl.snapshot().steadiness).toBe(10);
    expect(ms(d).preset).toBe("shade");
    expect(ms(d).lazyRadius).toBe(5);
    d.action("smoothing_ink");
    expect(d.pl.snapshot().steadiness).toBe(70);
    expect(ms(d).lazyRadius).toBeCloseTo(steadinessParams(70).lazyRadius, 9);
    d.action("smoothing_sketch");
    expect(d.pl.snapshot().steadiness).toBe(25);
    expect(ms(d).lazyRadius).toBeCloseTo(8, 9);
  });

  it("@P3 a preset never applies to a stroke in progress; steadier clears the preset", () => {
    const d = new Driver({ phase: "P3" });
    d.hold(C, 2000);
    expect(d.last.pen).toBe("DRAWING");
    d.action("smoothing_shade");
    expect(ms(d).lazyRadius).toBe(12);
    d.path(500, (e) => ({ x: C.x + e * 0.1, y: C.y }));
    d.action("pen_toggle");
    expect(ms(d).lazyRadius).toBe(5);
    d.hold(C, 1100);
    d.action("steadier");
    expect(ms(d).preset).toBeNull();
    expect(d.pl.snapshot().steadiness).toBe(20);
    expect(ms(d).lazyRadius).toBeCloseTo(steadinessParams(20).lazyRadius, 9);
  });
});

describe("Dash mode", () => {
  const MOVE_MS = 1000;
  const PAUSE_MS = 300;
  const CYCLE = MOVE_MS + PAUSE_MS;
  const N = 4;
  const dashPath = (e: number): Vec2 => {
    const k = Math.min(Math.floor(e / CYCLE), N - 1);
    const within = e - k * CYCLE;
    return { x: 200 + k * 40 + 0.04 * Math.min(within, MOVE_MS), y: C.y }; // 40 units/s
  };

  it("@P3 at 40 px/s with 300 ms pauses: one mark per movement, dwell points trimmed", () => {
    const d = new Driver({ phase: "P3" });
    d.hold(dashPath(0), 600);
    d.action("dash");
    expect(d.action("pen_toggle")).toEqual([]); // armed: the button stays up
    expect(d.pl.snapshot().pen).toBe("DRAWING");
    const t0 = d.t;
    d.path(N * CYCLE, dashPath);
    d.hold(dashPath(N * CYCLE), 500); // < the pen-up dwell (which still disarms a longer rest)
    const ev = d.events.filter((e) => e.t >= t0) as Ev[];
    const downs = ev.filter((e) => e.type === "down");
    const ups = ev.filter((e) => e.type === "up");
    expect(downs).toHaveLength(N);
    expect(ups).toHaveLength(N);
    expect(ups.every((u) => u.type === "up" && u.reason === "dash")).toBe(true);
    // Each mark: nothing inked after the hand stopped (beyond the speed window), and the mark
    // ends at its last inked point.
    let down = false;
    let lastInk: Ev | null = null;
    let k = 0;
    for (const e of ev) {
      if (e.type === "down") {
        down = true;
        lastInk = e;
      } else if (e.type === "move" && down) {
        lastInk = e;
      } else if (e.type === "up") {
        down = false;
        const stopT = t0 + k * CYCLE + MOVE_MS;
        expect(lastInk!.t - stopT).toBeLessThanOrEqual(DASH_WINDOW_MS);
        expect(e.x).toBe(lastInk!.x);
        k++;
      }
    }
    expect(d.pl.snapshot().pen).toBe("DRAWING");
  });

  it("@P3 a stationary hand in Dash never adds ink", () => {
    const d = new Driver({ phase: "P3" });
    d.action("dash");
    d.hold(C, 10000, { jitter: 4 });
    expect(d.pl.snapshot().pen).toBe("DRAWING"); // the dwell armed the pen…
    expect(d.count("down")).toBe(0); // …but the button never went down
  });
});

describe("Dash with tremor", () => {
  it("@P3 a resting hand with Simulate tremor (fast raw jitter) never adds ink in Dash", () => {
    const d = new Driver({ phase: "P3", settings: { simulateTremor: true } });
    d.action("dash");
    d.hold(C, 10000);
    expect(d.pl.snapshot().pen).toBe("DRAWING");
    expect(d.count("down")).toBe(0);
  });
});

describe("Repeat stroke", () => {
  it("@P3 repeat copies the last stroke's points exactly, offset to the cursor", () => {
    const d = new Driver({ phase: "P3" });
    d.hold(C, 2000);
    const t0 = d.t;
    d.path(1000, (e) => ({ x: C.x + 0.15 * e, y: C.y + 0.05 * e * Math.sin(e / 200) }));
    d.action("pen_toggle");
    const original = (d.events as Ev[]).filter((e) => e.t >= t0 - 2000 && (e.type === "down" || e.type === "move"));
    const firstDown = original.findIndex((e) => e.type === "down");
    const inked = original.slice(firstDown).filter((e) => e.t <= d.t).map((e) => ({ x: e.x, y: e.y }));
    const stroke = ms(d).lastStroke!;
    expect(stroke).toEqual(inked);
    // Move away and stamp.
    d.path(800, (e) => ({ x: C.x + 150 - 0.3 * e, y: C.y + 0.2 * e }));
    d.hold({ x: C.x - 90, y: C.y + 160 }, 300);
    const cursor = d.last.pointer!;
    const ev = d.action("repeat");
    expect(ev[0].type).toBe("down");
    expect(ev[ev.length - 1].type).toBe("up");
    const stamped = ev.filter((e) => e.type !== "up").map((e) => ({ x: e.x, y: e.y }));
    expect(stamped).toEqual(offsetStroke(stroke, cursor));
    expect(stamped[0]).toEqual(cursor);
    expect(d.pl.snapshot().pen).toBe("HOVER");
    // A resting hand after the stamp is not re-lowered by dwell.
    d.hold({ x: C.x - 90, y: C.y + 160 }, 5000);
    expect(d.events.filter((e) => e.type === "down")).toHaveLength(2);
  });

  it("@P3 repeat clips at the canvas rect and does nothing without a previous stroke", () => {
    const d = new Driver({ phase: "P3" });
    d.hold(C, 600);
    expect(d.action("repeat")).toEqual([]);
    d.action("pen_toggle");
    d.path(1000, (e) => ({ x: C.x + 0.3 * e, y: C.y }));
    d.action("pen_toggle");
    d.path(1000, (e) => ({ x: C.x + 300 - 0.1 * e, y: C.y }));
    d.hold({ x: C.x + 200, y: C.y }, 300);
    const ev = d.action("repeat");
    for (const e of ev) expect(e.x).toBeLessThanOrEqual(1000);
    expect(ev[ev.length - 1].type).toBe("up");
  });
});

describe("Pan and Pick", () => {
  it("@P3 pan: the next pen-down is a middle-button drag, filter bypassed, exits on lift", () => {
    const d = new Driver({ phase: "P3" });
    d.hold(C, 600);
    d.action("pan");
    expect(panState(d.pl)).toMatchObject({ armed: true, active: false });
    const down = d.action("pen_toggle");
    expect(down.map((e) => e.type)).toEqual(["down"]);
    expect(panState(d.pl)).toEqual({ armed: true, active: true, batchIsPan: true });
    // Raw (unfiltered) path: a sharp zigzag is followed exactly.
    const outs = d.path(600, (e) => ({ x: C.x + (Math.floor(e / 100) % 2 ? 40 : 0), y: C.y }));
    for (const o of outs) {
      const mv = o.events.filter((e) => e.type === "move");
      for (const m of mv) expect([C.x, C.x + 40].some((x) => Math.abs(m.x - x) < 1e-6)).toBe(true);
    }
    expect(panState(d.pl).batchIsPan).toBe(true);
    const up = d.action("pen_toggle");
    expect(up.map((e) => e.type)).toEqual(["up"]);
    expect(panState(d.pl)).toEqual({ armed: false, active: false, batchIsPan: true });
    d.hold(C, 100);
    expect(panState(d.pl).batchIsPan).toBe(false);
    expect(ms(d).lastStroke).toBeNull(); // a pan is never repeated as ink
  });

  it("@P3 pick: the next dwell inside the canvas is one sampling click (one-shot flag), then back to normal", () => {
    const rects = {
      screen: { x: 0, y: 0, w: 1440, h: 900 },
      chrome: { x: 0, y: 0, w: 320, h: 900 },
      canvas: { x: 400, y: 100, w: 900, h: 700 },
      krita: { x: 330, y: 0, w: 1110, h: 900 },
    };
    const d = new Driver({ phase: "P3", target: "krita", rects, helperConnected: true });
    d.hold({ x: 850, y: 450 }, 600);
    d.action("pick");
    expect(ms(d).pickArmed).toBe(true);
    let sampledBatches = 0;
    const outs = d.hold({ x: 850, y: 450 }, 4000);
    for (const o of outs) if (o.events.some((e) => e.type === "click")) sampledBatches++;
    expect(sampledBatches).toBe(1);
    expect(d.count("click")).toBe(1);
    expect(d.count("down")).toBe(0); // the resting hand does not then lower the pen
    expect(ms(d).pickArmed).toBe(false);
    // The one-shot flag was set only on the batch with the click.
    expect(ms(d).batchPickSampled).toBe(false);
  });
});

describe("Other hand", () => {
  it("@P2b mirrorCalibration mirrors the box about the frame centre and swaps handedness", () => {
    const m = mirrorCalibration(TEST_CAL, 640);
    expect(m.box).toEqual({ x: 640 - (220 + 200), y: 165, w: 200, h: 150 });
    expect(m.handedness).toBe("Left");
    expect(m.gain).toBe(TEST_CAL.gain);
    expect(m.flipX).toBe(TEST_CAL.flipX);
    expect(mirrorCalibration(m, 640)).toEqual(TEST_CAL);
  });

  it("@P2b the calibrator can start from the other hand's mirrored calibration", () => {
    const cal = createCalibrator({ steps: [1], targetWidth: 800, prior: TEST_CAL, mirrorPrior: true, frameW: 640 });
    for (const p of sample(3.1, 30, () => ({ x: 200, y: 240 }))) cal.feed(p.t, p, p, "Left");
    const r = cal.result()!;
    expect(r.box).toEqual(mirrorCalibration(TEST_CAL).box);
    expect(r.handedness).toBe("Left");
    expect(r.restJitterRMS).toBe(0);
  });
});
