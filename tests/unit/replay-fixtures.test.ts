/**
 * Replay fixtures (agent F): valid compact format, 30 fps, strictly increasing t, camera px in range,
 * public/replay mirrors tests/fixtures/replay byte for byte, and the shapes the e2e tests rely on.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ReplayFileCompact } from "../../src/tracking/LandmarkSource";

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "tests/fixtures/replay");
const PUB = path.join(ROOT, "public/replay");
const names = fs.readdirSync(SRC).filter((f) => f.endsWith(".json"));

function load(name: string): ReplayFileCompact & { marks?: Record<string, number> } {
  return JSON.parse(fs.readFileSync(path.join(SRC, name), "utf8"));
}

describe("replay fixtures", () => {
  it("@P0 the required fixtures exist", () => {
    for (const n of [
      "rest-still",
      "calibration-sequence",
      "dwell-stroke-word",
      "tremor-line",
      "tracking-loss-mid-stroke",
      "hand-outside-area",
    ]) {
      expect(names).toContain(`${n}.json`);
    }
  });

  for (const n of names) {
    it(`@P0 ${n} is a valid compact replay mirrored in public/replay`, () => {
      const f = load(n);
      expect(f.format).toBe("compact");
      expect(f.fps).toBe(30);
      expect([f.width, f.height]).toEqual([640, 480]);
      expect(`${f.name}.json`).toBe(n);
      let lastT = -1;
      for (const p of f.points) {
        if (p === null) continue;
        const [t, x, y, score] = p;
        expect(t).toBeGreaterThan(lastT);
        lastT = t;
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(640);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(480);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
      expect(fs.readFileSync(path.join(PUB, n), "utf8")).toBe(fs.readFileSync(path.join(SRC, n), "utf8"));
    });
  }

  it("@P1 tracking-loss-mid-stroke has exactly 1 s of score < 0.6 frames", () => {
    const f = load("tracking-loss-mid-stroke.json");
    const low = f.points.filter((p) => p !== null && p[3] < 0.6);
    expect(low.length).toBe(30);
  });

  it("@P0 rest-still never moves more than 2 px from its centroid", () => {
    const pts = load("rest-still.json").points.filter((p): p is [number, number, number, number] => p !== null);
    const cx = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p[2], 0) / pts.length;
    for (const p of pts) expect(Math.hypot(p[1] - cx, p[2] - cy)).toBeLessThan(2);
  });
});
