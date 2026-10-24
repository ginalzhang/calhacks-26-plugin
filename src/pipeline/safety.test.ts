import { describe, expect, it } from "vitest";
import { setCalibrating } from "./pipeline";
import { Driver, TEST_CAL } from "./pipelineDriver";
import { clickZone } from "./dwell";

const C = { x: 500, y: 400 };

describe("R3: calibration and the pen", () => {
  it("@P1 pen-down from any source is refused while calibration runs", () => {
    const d = new Driver();
    d.hold(C, 600);
    setCalibrating(d.pl, true);
    expect(d.action("pen_toggle")).toEqual([]);
    expect(d.action("pen_down")).toEqual([]);
    d.hold(C, 4000); // a still hand (calibration step 1) never dwells the pen down
    d.action("dots");
    d.hold({ x: C.x + 60, y: C.y }, 3000);
    expect(d.count("down")).toBe(0);
    expect(d.pl.snapshot().pen).toBe("HOVER");
    setCalibrating(d.pl, false);
    expect(d.action("pen_toggle").map((e) => e.type)).toContain("down");
  });

  it("@P1 starting calibration mid-stroke lifts the pen on the next frame", () => {
    const d = new Driver();
    d.hold(C, 2000);
    expect(d.last.pen).toBe("DRAWING");
    setCalibrating(d.pl, true);
    const out = d.frameAt(C);
    expect(out.events.map((e) => e.type)).toEqual(["up"]);
    expect(out.pen).toBe("HOVER");
  });

  it("@P1 setCalibration mid-stroke: up is emitted before any move at the new mapping", () => {
    const d = new Driver();
    d.hold(C, 2000);
    d.path(300, (e) => ({ x: C.x + 0.1 * e, y: C.y }));
    expect(d.last.pen).toBe("DRAWING");
    const before = d.last.pointer!;
    const n = d.events.length;
    // New calibration: very different box and gain.
    d.pl.setCalibration({ ...TEST_CAL, box: { x: 100, y: 100, w: 150, h: 120 }, gain: 2 });
    d.hold({ x: C.x + 30, y: C.y }, 1000);
    const after = d.events.slice(n);
    expect(after[0].type).toBe("up");
    expect(after[0].type === "up" && after[0].reason).toBe("mode_change");
    expect(Math.hypot(after[0].x - before.x, after[0].y - before.y)).toBeLessThan(1e-6);
    expect(after.filter((e) => e.type === "down")).toHaveLength(0); // re-armed: no dwell re-lower in place
    expect(d.pl.snapshot().pen).toBe("HOVER");
  });

  it("@P1 tick() also delivers the pending lift (no frames needed)", () => {
    const d = new Driver();
    d.hold(C, 2000);
    d.pl.setCalibration({ ...TEST_CAL, gain: 3 });
    const out = d.pl.tick(d.t);
    expect(out.events.map((e) => e.type)).toEqual(["up"]);
  });
});

describe("R8: dwell-clicks only inside the usable area (no Dock)", () => {
  const rects = {
    screen: { x: 0, y: 0, w: 1440, h: 900 },
    chrome: { x: 0, y: 0, w: 320, h: 900 },
    canvas: { x: 400, y: 100, w: 900, h: 600 },
    krita: { x: 330, y: 0, w: 1110, h: 900 },
    usable: { x: 0, y: 25, w: 1440, h: 805 }, // Dock along the bottom 70 pt
  };

  it("@P2a clickZone rejects points outside rects.usable", () => {
    expect(clickZone({ x: 600, y: 860 }, rects, "P2a")).toBeNull(); // over the Dock, inside Krita's window
    expect(clickZone({ x: 600, y: 800 }, rects, "P2a")).toBe("krita");
    expect(clickZone({ x: 160, y: 860 }, rects, "P2a")).toBeNull(); // Chrome's window under the Dock
    expect(clickZone({ x: 600, y: 860 }, { ...rects, usable: null }, "P2a")).toBe("krita");
  });

  it("@P2a a dwell over the Dock inside Krita's window never clicks", () => {
    const d = new Driver({ target: "krita", rects, helperConnected: true, phase: "P2a" });
    d.hold({ x: 600, y: 860 }, 3000);
    expect(d.count("click")).toBe(0);
    expect(d.last.dwell.gated).toBe(true);
  });
});

describe("R4: pen-down presses exactly where the down is reported", () => {
  it("@P2b in Hatch the down is preceded by a move to the same point", () => {
    const d = new Driver({ phase: "P2b" });
    d.hold(C, 600);
    d.path(300, (e) => ({ x: C.x + 0.2 * e, y: C.y })); // lazy pointer now lags the pre-point
    d.action("hatch_lr");
    const ev = d.action("pen_toggle");
    const i = ev.findIndex((e) => e.type === "down");
    expect(i).toBeGreaterThan(0);
    expect(ev[i - 1]).toEqual({ type: "move", x: ev[i].x, y: ev[i].y });
  });
});
