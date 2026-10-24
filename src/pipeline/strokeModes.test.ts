import { describe, expect, it } from "vitest";
import { Driver } from "./pipelineDriver";
import { HatchEngine, pcaAxis } from "./strokeModes";
import type { PenEvent } from "./types";

type Ev = PenEvent & { t: number };

const START = { x: 300, y: 400 };
const AMP = 400; // target units per pass (100 camera px at gain 4)
const PASS_MS = 500;

/** Triangle zigzag along x with 6 Hz ±5 camera px (= ±20 units) tremor on both axes. */
function zigzag(passes: number) {
  return (e: number) => {
    const k = Math.min(Math.floor(e / PASS_MS), passes - 1);
    const f = Math.min(1, (e - k * PASS_MS) / PASS_MS);
    const x = k % 2 === 0 ? START.x + AMP * f : START.x + AMP * (1 - f);
    const s = e / 1000;
    return { x: x + 20 * Math.sin(2 * Math.PI * 6 * s), y: START.y + 20 * Math.sin(2 * Math.PI * 6 * s + 1) };
  };
}

function runHatch(variant: "hatch_lr" | "hatch_alternate" | "hatch", passes = 5) {
  const d = new Driver({ phase: "P2b" });
  d.hold(START, 600);
  d.action(variant);
  d.action("pen_toggle");
  expect(d.pl.snapshot().pen).toBe("DRAWING");
  const t0 = d.t;
  d.path(passes * PASS_MS, zigzag(passes));
  const last = zigzag(passes)(passes * PASS_MS);
  d.hold(last, 1000);
  return { d, t0, events: d.events.filter((e) => e.t >= t0 - 1) as Ev[] };
}

function segments(events: Ev[]) {
  const segs: Ev[][] = [];
  let cur: Ev[] | null = null;
  for (const e of events) {
    if (e.type === "down") {
      cur = [e];
      segs.push(cur);
    } else if (cur) {
      cur.push(e);
      if (e.type === "up") cur = null;
    }
  }
  return segs;
}

describe("Hatch mode (§3)", () => {
  it("@P2b a 6 Hz ±5 px tremor on a 5-pass zigzag gives exactly 3 forward strokes", () => {
    const { d } = runHatch("hatch_lr");
    expect(d.count("down")).toBe(3);
    const passUps = d.events.filter((e) => e.type === "up" && e.reason === "hatch_pass");
    expect(passUps).toHaveLength(2);
    expect(d.pl.snapshot().pen).toBe("DRAWING");
    expect(d.pl.snapshot().mode).toBe("hatch");
  });

  it("@P2b the alternate variant gives 5 strokes (every pass inked separately)", () => {
    const { d } = runHatch("hatch_alternate");
    expect(d.count("down")).toBe(5);
  });

  it("@P2b the axis is learned from the first stroke by PCA when not set by voice", () => {
    const { d } = runHatch("hatch");
    expect(d.count("down")).toBe(3);
    const a = pcaAxis([
      { x: 0, y: 0 },
      { x: 10, y: 1 },
      { x: 20, y: -1 },
      { x: 30, y: 0 },
    ])!;
    expect(Math.abs(a.x)).toBeGreaterThan(0.99);
  });

  it("@P2b each pass ends within 2 px of the true peak and no move after the peak is sent while down", () => {
    const { d, events } = runHatch("hatch_lr");
    const segs = segments(events).filter((s) => s[s.length - 1].type === "up");
    expect(segs.length).toBeGreaterThanOrEqual(2);
    for (const s of segs) {
      const up = s[s.length - 1];
      const moves = s.filter((e) => e.type === "move");
      const lastMove = moves[moves.length - 1];
      // The last thing sent before up is the peak itself: nothing after the peak while down.
      expect(lastMove.x).toBe(up.x);
      expect(Math.max(...moves.map((m) => m.x))).toBe(up.x);
      // True peak of the One Euro output (pre-point) around this pass.
      const pres = d.outs.filter((o) => o.pre && o.t <= up.t && o.t >= up.t - 600).map((o) => o.pre!.x);
      expect(Math.abs(Math.max(...pres) - up.x)).toBeLessThanOrEqual(2);
    }
  });

  it("@P2b the replayed start of the next pass begins within 2 px of the turning point", () => {
    const { d, events } = runHatch("hatch_lr");
    const downs = events.filter((e) => e.type === "down").slice(1);
    expect(downs).toHaveLength(2);
    for (const dn of downs) {
      const pres = d.outs.filter((o) => o.pre && o.t <= dn.t && o.t >= dn.t - 600).map((o) => o.pre!.x);
      expect(Math.abs(Math.min(...pres) - dn.x)).toBeLessThanOrEqual(2);
      // The move right after down replays buffered forward points (≥ the turning point).
      const i = events.indexOf(dn);
      const next = events[i + 1];
      if (next && next.type === "move") expect(next.x).toBeGreaterThanOrEqual(dn.x);
    }
  });

  it("@P2b a stationary hand in Hatch never adds ink", () => {
    const d = new Driver({ phase: "P2b" });
    d.hold(START, 600);
    d.action("hatch_lr");
    const t0 = d.t;
    d.hold(START, 10000, { jitter: 4 });
    const ev = d.events.filter((e) => e.t >= t0);
    const downs = ev.filter((e) => e.type === "down");
    expect(downs.length).toBeLessThanOrEqual(1); // at most the one explicit dwell pen-down
    expect(ev.filter((e) => e.type === "up" && e.reason === "hatch_pass")).toHaveLength(0);
    if (downs.length) {
      const dn = downs[0];
      const after = ev.filter((e) => e.type === "move" && e.t >= dn.t);
      for (const m of after) expect(Math.hypot(m.x - dn.x, m.y - dn.y)).toBeLessThanOrEqual(6);
    }
  });

  it("@P2b any lift source still lifts in Hatch; stop hatching and the pen key exit", () => {
    const { d } = runHatch("hatch_lr");
    expect(d.action("pause").some((e) => e.type === "up")).toBe(true);
    expect(d.pl.snapshot().mode).toBe("normal");
    const h = new HatchEngine();
    h.start({ x: 0, y: 0 }, 0);
    expect(h.isActive).toBe(true);
    h.stop(10);
    expect(h.isActive).toBe(false);
  });

  it("@P2b Dots mode: a dwell stamps one dot (down+up) and the pen stays up", () => {
    const d = new Driver({ phase: "P2b" });
    d.action("dots");
    d.hold(START, 5000);
    expect(d.count("down")).toBe(1);
    expect(d.count("up")).toBe(1);
    expect(d.pl.snapshot().pen).toBe("HOVER");
  });
});
