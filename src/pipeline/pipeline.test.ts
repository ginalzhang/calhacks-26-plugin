import { describe, expect, it } from "vitest";
import { DwellDetector } from "./dwell";
import { Driver } from "./pipelineDriver";
import { WARMUP_FRAMES } from "./types";

const C = { x: 500, y: 400 };

describe("warm-up gate", () => {
  it("@P0 emits no pointer and no events for the first 10 frames after acquire", () => {
    const d = new Driver();
    const outs = d.hold(C, 1000);
    for (let i = 0; i < WARMUP_FRAMES; i++) {
      expect(outs[i].pointer).toBeNull();
      expect(outs[i].events).toEqual([]);
      expect(outs[i].warmingUp).toBe(true);
    }
    expect(outs[WARMUP_FRAMES].pointer).not.toBeNull();
    expect(outs[WARMUP_FRAMES].warmingUp).toBe(false);
  });
});

describe("pen-down dwell", () => {
  it("@P0 fires exactly once on a still segment", () => {
    const d = new Driver();
    d.hold(C, 3000, { jitter: 1 });
    expect(d.count("down")).toBe(1);
    expect(d.count("up")).toBe(0);
    expect(d.last.pen).toBe("DRAWING");
  });

  it("@P0 never flickers at the r_in / r_out boundary (hysteresis)", () => {
    const det = new DwellDetector();
    const params = { kind: "pen_down" as const, ms: 800, rIn: 15, tight: false };
    let t = 0;
    for (; t < 300; t += 33) det.update(t, { x: 0, y: 0 }, params);
    // Now wobble between 1.2 r_in and 1.9 r_in from the anchor: outside r_in, inside r_out.
    const progress: number[] = [];
    let fired = 0;
    for (let i = 0; t < 1500; t += 33, i++) {
      const r = det.update(t, { x: i % 2 ? 18 : -28, y: 0 }, params);
      if (r.fired) fired++;
      else progress.push(r.progress);
      if (fired) break;
    }
    expect(fired).toBe(1);
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    expect(progress.every((p) => p > 0)).toBe(true);
  });

  it("@P0 a pointer held still for 10 s produces at most one toggle", () => {
    const d = new Driver();
    d.hold(C, 10000, { jitter: 2 });
    expect(d.count("down") + d.count("up")).toBeLessThanOrEqual(1);
  });

  it("@P0 a pointer held still for 10 s after a pen-up does not re-lower (no ink from a resting hand)", () => {
    const d = new Driver();
    d.hold(C, 2000); // down
    d.path(1000, (e) => ({ x: C.x + e * 0.1, y: C.y })); // move 100 units
    d.hold({ x: C.x + 100, y: C.y }, 10000, { jitter: 1 }); // pen-up dwell, then rest
    expect(d.count("down")).toBe(1);
    expect(d.count("up")).toBe(1);
  });
});

describe("pen-up dwell", () => {
  it("@P0 fires after moving > r_in and then holding still (tight test)", () => {
    const d = new Driver();
    d.hold(C, 2000);
    d.path(1000, (e) => ({ x: C.x + e * 0.1, y: C.y }));
    d.hold({ x: C.x + 100, y: C.y }, 2500);
    const up = d.events.find((e) => e.type === "up");
    expect(up && up.type === "up" && up.reason).toBe("dwell");
  });

  it("@P0 a 40 px/s stroke lasting 3 s never triggers pen-up", () => {
    const d = new Driver();
    d.hold(C, 2000);
    expect(d.last.pen).toBe("DRAWING");
    // 40 target units/s with 6 Hz ±4 unit wobble.
    d.path(3000, (e) => ({ x: C.x + 0.04 * e + 4 * Math.sin(2 * Math.PI * 6 * (e / 1000)), y: C.y }));
    expect(d.count("up")).toBe(0);
    expect(d.last.pen).toBe("DRAWING");
  });

  it("@P0 a lift < 80 ms after a down is ignored", () => {
    const d = new Driver();
    d.hold(C, 600); // warm-up done, no dwell yet
    expect(d.action("pen_toggle").map((e) => e.type)).toEqual(["down"]);
    d.hold(C, 50);
    expect(d.action("pen_toggle")).toEqual([]);
    expect(d.pl.snapshot().pen).toBe("DRAWING");
    d.hold(C, 60);
    expect(d.action("pen_toggle").map((e) => e.type)).toEqual(["up"]);
  });

  it("@P0 safety lifts (pause) are never ignored, even < 80 ms after down", () => {
    const d = new Driver();
    d.hold(C, 600);
    d.action("pen_toggle");
    const ev = d.action("pause");
    expect(ev.map((e) => e.type)).toEqual(["up"]);
  });
});

describe("tracking loss", () => {
  it("@P0 a 2 s run of score-0.5 frames releases the pen at 300 ms; warm-up re-applies on recovery", () => {
    const d = new Driver();
    d.hold(C, 2000);
    d.path(500, (e) => ({ x: C.x + e * 0.1, y: C.y }));
    expect(d.last.pen).toBe("DRAWING");
    const lastGood = d.t - 1000 / 30;
    const lostOuts = d.path(2000, () => ({ x: C.x + 300, y: C.y + 200 }), { score: 0.5 });
    const ups = d.events.filter((e) => e.type === "up");
    expect(ups).toHaveLength(1);
    const up = ups[0];
    expect(up.type === "up" && up.reason).toBe("tracking_lost");
    expect(up.t - lastGood).toBeGreaterThanOrEqual(300);
    expect(up.t - lastGood).toBeLessThan(300 + 34);
    // Before release the pointer is frozen (never follows the low-score frames).
    for (const o of lostOuts) if (o.pointer) expect(o.pointer.x).toBeLessThan(C.x + 60);
    expect(d.last.tracking).toBe("Lost");
    expect(d.last.pen).toBe("HOVER");
    // Recovery: 10 frames of warm-up, pen stays up.
    const back = d.hold({ x: C.x + 50, y: C.y }, 600);
    for (let i = 0; i < WARMUP_FRAMES; i++) expect(back[i].pointer).toBeNull();
    expect(back[WARMUP_FRAMES].pointer).not.toBeNull();
    expect(back.every((o) => o.pen === "HOVER")).toBe(true);
    expect(d.last.tracking).toBe("Tracking");
  });

  it("@P0 during the 300 ms grace period the pointer is frozen at the median of the last 100 ms", () => {
    const d = new Driver();
    d.hold(C, 1000);
    const before = d.last.pointer!;
    const outs = d.empty(250);
    for (const o of outs) {
      expect(o.pointer).not.toBeNull();
      expect(Math.abs(o.pointer!.x - before.x)).toBeLessThan(1e-6);
    }
    const lost = d.empty(200);
    expect(lost[lost.length - 1].pointer).toBeNull();
    expect(lost[lost.length - 1].tracking).toBe("Lost");
  });

  it("@P0 tick() drives the loss timer without frames", () => {
    const d = new Driver();
    d.hold(C, 2000);
    expect(d.last.pen).toBe("DRAWING");
    const out = d.pl.tick(d.t + 400);
    expect(out.events.map((e) => e.type)).toContain("up");
    expect(out.tracking).toBe("Lost");
  });
});

describe("Latch", () => {
  it("@P0 Latch disables the pen-up dwell; canvas exit lifts and re-entry does not lower", () => {
    const d = new Driver({ settings: { latch: true } });
    d.hold(C, 2000);
    d.path(1000, (e) => ({ x: C.x + e * 0.1, y: C.y }));
    d.hold({ x: C.x + 100, y: C.y }, 4000);
    expect(d.count("up")).toBe(0);
    // Leave the canvas (x > 1000) and come back.
    d.path(1000, (e) => ({ x: 600 + e * 0.6, y: C.y }));
    const ups = d.events.filter((e) => e.type === "up");
    expect(ups).toHaveLength(1);
    expect(ups[0].type === "up" && ups[0].reason).toBe("left_canvas");
    const downsBefore = d.count("down");
    d.path(1000, (e) => ({ x: 1200 - e * 0.6, y: C.y }));
    expect(d.count("down")).toBe(downsBefore);
    expect(d.last.pen).toBe("HOVER");
  });

  it("@P0 Latch toggles via action and Pause lifts while latched", () => {
    const d = new Driver();
    d.action("latch");
    expect(d.pl.snapshot().latch).toBe(true);
    d.hold(C, 2000);
    expect(d.last.pen).toBe("DRAWING");
    expect(d.action("pause").map((e) => e.type)).toEqual(["up"]);
    expect(d.pl.snapshot().paused).toBe(true);
  });
});

describe("Steadiness actions", () => {
  it("@P0 steadier/looser move ±10, debounced to once per second", () => {
    const d = new Driver();
    d.hold(C, 100);
    d.action("steadier");
    d.action("steadier");
    expect(d.pl.snapshot().steadiness).toBe(60);
    d.hold(C, 1000);
    d.action("looser");
    expect(d.pl.snapshot().steadiness).toBe(50);
  });

  it("@P0 a Steadiness change never applies to a stroke in progress", () => {
    const d = new Driver();
    d.hold(C, 2000);
    expect(d.last.pen).toBe("DRAWING");
    d.pl.setSettings({ steadiness: 100 }); // radius 30 if applied
    const outs = d.path(1500, (e) => ({ x: C.x + e * 0.2, y: C.y }));
    const lagDuring = outs[outs.length - 1].pre!.x - outs[outs.length - 1].pointer!.x;
    expect(lagDuring).toBeCloseTo(12, 0);
    d.action("pen_toggle"); // lift → deferred change applies
    d.hold({ x: 900, y: C.y }, 1500);
    const o2 = d.path(1500, (e) => ({ x: 900 - e * 0.2, y: C.y }));
    const lagAfter = o2[o2.length - 1].pointer!.x - o2[o2.length - 1].pre!.x;
    expect(lagAfter).toBeCloseTo(30, 0);
  });
});

describe("rect gates ink, not movement (@P1)", () => {
  const rects = { canvas: { x: 250, y: 200, w: 500, h: 400 } }; // centre (500, 400)

  it("@P1 pen-down is refused outside the canvas rect, but the pointer still moves there", () => {
    const d = new Driver({ rects });
    d.hold({ x: 150, y: 400 }, 3000);
    expect(d.count("down")).toBe(0);
    expect(d.last.pointer!.x).toBeLessThan(250);
    expect(d.action("pen_toggle")).toEqual([]);
    expect(d.last.dwell.kind).toBe("click");
  });

  it("@P1 leaving the canvas releases the pen before the pointer moves out", () => {
    const d = new Driver({ rects });
    d.hold(C, 2000);
    expect(d.last.pen).toBe("DRAWING");
    d.path(1500, (e) => ({ x: C.x + e * 0.3, y: C.y }));
    const upIdx = d.events.findIndex((e) => e.type === "up");
    expect(upIdx).toBeGreaterThan(-1);
    const up = d.events[upIdx];
    expect(up.type === "up" && up.reason).toBe("left_canvas");
    expect(up.x).toBeLessThanOrEqual(750);
    // Every move before the up is inside the rect.
    for (const e of d.events.slice(0, upIdx)) if (e.type === "move") expect(e.x).toBeLessThanOrEqual(750);
  });
});

describe("hand lock (@P1)", () => {
  it("@P1 follows the accepted wrist (slow creep) and rejects a second detection", () => {
    const d = new Driver();
    d.hold(C, 600);
    // Creep 400 target units (= 100 camera px ≈ 0.16 of the frame) over 4 s while a cup-like
    // second detection with a higher score sits 250 px away.
    const other = (wx: number) => ({
      landmarks: Array.from({ length: 21 }, () => ({ x: wx / 640, y: 0.15, z: 0 })),
      score: 0.99,
      handedness: "Left" as const,
    });
    const t0 = d.t;
    while (d.t - t0 < 4000) {
      const e = d.t - t0;
      d.frameAt({ x: C.x - 0.1 * e, y: C.y }, { extraHands: [other(600)] });
    }
    expect(d.last.tracking).not.toBe("Lost");
    expect(d.last.pointer!.x).toBeLessThan(C.x - 300);
    // Only the other hand: no detection → Lost with reason outside_area.
    const t1 = d.t;
    while (d.t - t1 < 500) {
      const out = d.pl.step({ t: d.t, width: 640, height: 480, hands: [other(600)] });
      d.outs.push(out);
      d.t += 1000 / 30;
    }
    expect(d.last.tracking).toBe("Lost");
    expect(d.last.reason).toBe("outside_area");
    // Recenter resets the lock: the other hand is accepted.
    d.action("recenter");
    const out = d.pl.step({ t: d.t, width: 640, height: 480, hands: [other(600)] });
    expect(out.tracking).not.toBe("Lost");
  });
});

describe("dwell-click outside the canvas (@P1, target krita)", () => {
  const rects = {
    screen: { x: 0, y: 0, w: 1440, h: 900 },
    chrome: { x: 0, y: 0, w: 320, h: 900 },
    canvas: { x: 400, y: 100, w: 900, h: 700 }, // centre (850, 450)
    krita: { x: 330, y: 0, w: 1110, h: 900 },
  };
  const make = (o: { helper?: boolean; phase?: "P1" | "P2a" } = {}) =>
    new Driver({ target: "krita", rects, helperConnected: o.helper ?? true, phase: o.phase ?? "P1" });

  it("@P1 dwell inside the canvas toggles the pen (no click)", () => {
    const d = make();
    d.hold({ x: 850, y: 450 }, 2500);
    expect(d.count("down")).toBe(1);
    expect(d.count("click")).toBe(0);
  });

  it("@P1 dwell inside Chrome's rect sends exactly one click there", () => {
    const d = make();
    d.hold({ x: 160, y: 400 }, 4000);
    expect(d.count("click")).toBe(1);
    const c = d.events.find((e) => e.type === "click")!;
    expect(Math.abs(c.x - 160)).toBeLessThan(15);
    expect(Math.abs(c.y - 400)).toBeLessThan(15);
    expect(d.count("down")).toBe(0);
  });

  it("@P1 no click without a helper (the page's own hover-dwell handles tiles)", () => {
    const d = make({ helper: false });
    d.hold({ x: 160, y: 400 }, 3000);
    expect(d.count("click")).toBe(0);
    expect(d.outs.some((o) => o.dwell.kind === "click" && o.dwell.progress > 0.5)).toBe(true);
  });

  it("@P1 dwell in Krita's window outside the canvas never clicks in P1 (ring grey)", () => {
    const d = make();
    d.hold({ x: 360, y: 300 }, 3000);
    expect(d.count("click")).toBe(0);
    expect(d.last.dwell.gated).toBe(true);
  });

  it("@P1 never clicks in the menu bar (top 40 pt) or elsewhere on screen", () => {
    const d = make({ phase: "P2a" });
    d.hold({ x: 160, y: 20 }, 3000);
    expect(d.count("click")).toBe(0);
    expect(d.last.dwell.gated).toBe(true);
  });

  it("@P1 clicks are suppressed for 500 ms after a mode switch", () => {
    const d = make();
    d.hold({ x: 160, y: 400 }, 700);
    d.action("latch");
    const t0 = d.t;
    d.hold({ x: 160, y: 400 }, 3000);
    const c = d.events.find((e) => e.type === "click")!;
    expect(c.t - t0).toBeGreaterThanOrEqual(500);
  });

  it("@P1 while paused the pointer is clamped to Chrome's rect and the Resume tile is dwell-clickable", () => {
    const d = make();
    d.hold({ x: 850, y: 450 }, 2000);
    expect(d.last.pen).toBe("DRAWING");
    d.action("pause");
    expect(d.last.pen === "DRAWING" ? d.pl.snapshot().pen : "HOVER").toBe("HOVER");
    d.hold({ x: 850, y: 450 }, 1000);
    expect(d.last.pointer!.x).toBeLessThanOrEqual(320);
    expect(d.count("down")).toBe(1);
    expect(d.action("pen_toggle")).toEqual([]); // ink impossible while paused
    d.path(1000, (e) => ({ x: 850 - 0.69 * e, y: 450 - 0.05 * e })); // hand slides left to (160, 400)
    d.hold({ x: 160, y: 400 }, 3000);
    expect(d.events.filter((e) => e.type === "click" && e.x < 300)).toHaveLength(1);
    d.action("pause", { variant: "resume" });
    expect(d.pl.snapshot().paused).toBe(false);
  });
});

describe("@P2a dwell-click extends to Krita's window", () => {
  it("@P2a dwell outside the canvas clicks only inside the Krita rect (or Chrome's)", () => {
    const rects = {
      screen: { x: 0, y: 0, w: 1440, h: 900 },
      chrome: { x: 0, y: 0, w: 320, h: 900 },
      canvas: { x: 400, y: 100, w: 900, h: 700 },
      krita: { x: 330, y: 0, w: 1000, h: 900 },
    };
    const d = new Driver({ target: "krita", rects, helperConnected: true, phase: "P2a" });
    d.hold({ x: 360, y: 300 }, 3000);
    expect(d.count("click")).toBe(1);
    const e = new Driver({ target: "krita", rects, helperConnected: true, phase: "P2a" });
    e.hold({ x: 1380, y: 500 }, 3000); // right of Krita's window: another app
    expect(e.count("click")).toBe(0);
  });
});

describe("pause clamp edge (@P1)", () => {
  it("@P1 a hand outside Chrome's rect while paused never dwell-clicks at the clamped edge", () => {
    const rects = {
      screen: { x: 0, y: 0, w: 1440, h: 900 },
      chrome: { x: 0, y: 0, w: 320, h: 900 },
      canvas: { x: 400, y: 100, w: 900, h: 700 },
      krita: { x: 330, y: 0, w: 1110, h: 900 },
    };
    const d = new Driver({ target: "krita", rects, helperConnected: true, phase: "P2a" });
    d.hold({ x: 850, y: 450 }, 600);
    d.action("pause");
    d.hold({ x: 850, y: 450 }, 4000);
    expect(d.last.pointer!.x).toBe(320);
    expect(d.count("click")).toBe(0);
    expect(d.last.dwell.gated).toBe(true);
  });
});
