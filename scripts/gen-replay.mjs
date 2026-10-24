#!/usr/bin/env node
/**
 * Synthesises deterministic replay fixtures for ReplaySource (compact format, see
 * src/tracking/LandmarkSource.ts → ReplayFileCompact).
 *
 *   node scripts/gen-replay.mjs           # writes tests/fixtures/replay/*.json and mirrors to public/replay/*.json
 *   node scripts/gen-replay.mjs --check   # exits 1 if any committed fixture differs from what would be generated
 *
 * Units: camera pixels of a 640×480 frame, 30 fps, landmark 5 (index knuckle), right hand.
 * Every file is fully deterministic (seeded PRNG), so diffs only appear when this script changes.
 *
 * Owner: agent F. No npm dependencies.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIRS = [path.join(ROOT, "tests/fixtures/replay"), path.join(ROOT, "public/replay")];

const FPS = 30;
const DT = 1000 / FPS;
const W = 640;
const H = 480;
const CX = 320;
const CY = 240;
const SCORE_OK = 0.95;
const SCORE_LOST = 0.5; // < 0.6 counts as no detection (§0 rule 10)

// ---------------------------------------------------------------------------
// Deterministic noise
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rand) {
  // Box–Muller
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Builder: appends frames at 30 fps. Every segment receives a time-relative function
 * returning {x, y} (camera px) and optional score. Resting jitter (σ px) is added on top.
 */
class Track {
  constructor({ seed = 1, restSigma = 0.35 } = {}) {
    this.rand = mulberry32(seed);
    this.restSigma = restSigma;
    this.points = [];
    this.frame = 0;
    this.last = { x: CX, y: CY };
    this.marks = {}; // name → t_ms (for documentation / tests)
  }
  get t() {
    return Math.round(this.frame * DT);
  }
  mark(name) {
    this.marks[name] = this.t;
    return this;
  }
  /** Generic segment: fn(u in [0,1), sec since segment start) → {x,y,score?} | null */
  seg(seconds, fn, { sigma = this.restSigma } = {}) {
    const n = Math.round(seconds * FPS);
    for (let i = 0; i < n; i++) {
      const p = fn(i / n, i / FPS);
      if (p === null) {
        this.points.push(null);
      } else {
        const x = p.x + sigma * gauss(this.rand);
        const y = p.y + sigma * gauss(this.rand);
        this.points.push([this.t, r2(x), r2(y), p.score ?? SCORE_OK]);
        if ((p.score ?? SCORE_OK) >= 0.6) this.last = { x: p.x, y: p.y };
      }
      this.frame++;
    }
    return this;
  }
  still(seconds, at = this.last, opts) {
    const p = { ...at };
    return this.seg(seconds, () => p, opts);
  }
  /** Constant-speed polyline through pts (starting from this.last), at speed px/s. */
  path(pts, speed, opts) {
    const all = [this.last, ...pts];
    const lens = [];
    let total = 0;
    for (let i = 1; i < all.length; i++) {
      const l = Math.hypot(all[i].x - all[i - 1].x, all[i].y - all[i - 1].y);
      lens.push(l);
      total += l;
    }
    const seconds = total / speed;
    const at = (d) => {
      for (let i = 0; i < lens.length; i++) {
        if (d <= lens[i] || i === lens.length - 1) {
          const f = lens[i] === 0 ? 1 : Math.min(1, d / lens[i]);
          return {
            x: all[i].x + (all[i + 1].x - all[i].x) * f,
            y: all[i].y + (all[i + 1].y - all[i].y) * f,
          };
        }
        d -= lens[i];
      }
      return all[all.length - 1];
    };
    this.seg(seconds, (u) => at(u * total), opts);
    this.last = { ...all[all.length - 1] };
    return this;
  }
  file(name, description, extra = {}) {
    return {
      format: "compact",
      name,
      description,
      fps: FPS,
      width: W,
      height: H,
      landmark: 5,
      handedness: "Right",
      loop: false,
      marks: this.marks,
      ...extra,
      points: this.points,
    };
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Cursive "mum" as one continuous stroke, ~84 × 28 camera px, starting at its left baseline. */
function wordMum(x0, y0) {
  const h = 28; // x-height
  const pts = [];
  const arch = (xa, w) => {
    // up from baseline at xa, arch over, down to baseline at xa + w
    const n = 10;
    for (let i = 1; i <= n; i++) {
      const a = Math.PI * (i / n);
      pts.push({ x: xa + (w / 2) * (1 - Math.cos(a)), y: y0 - h * Math.sin(a) });
    }
  };
  const cup = (xa, w) => {
    // down from x-height at xa, cup through baseline, up to x-height at xa + w
    const n = 10;
    for (let i = 1; i <= n; i++) {
      const a = Math.PI * (i / n);
      pts.push({ x: xa + (w / 2) * (1 - Math.cos(a)), y: y0 - h + h * Math.sin(a) });
    }
  };
  let x = x0;
  // m: up-stroke then two arches
  pts.push({ x, y: y0 - h });
  pts.push({ x, y: y0 });
  arch(x, 14);
  x += 14;
  arch(x, 14);
  x += 14;
  // u: connector up, cup, down-stroke
  pts.push({ x: x + 4, y: y0 - h });
  x += 4;
  cup(x, 14);
  x += 14;
  pts.push({ x, y: y0 });
  // m
  pts.push({ x: x + 4, y: y0 - h });
  x += 4;
  pts.push({ x, y: y0 });
  arch(x, 14);
  x += 14;
  arch(x, 14);
  x += 14;
  pts.push({ x: x + 6, y: y0 - 8 }); // exit flick
  return pts;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function restStill() {
  const tr = new Track({ seed: 11 });
  tr.still(5);
  return tr.file("rest-still", "Resting hand, 5 s, σ≈0.35 px jitter at the frame centre. A resting hand must never leave ink.");
}

function calibrationSteps(tr) {
  // Step 1: 3 s still.
  tr.mark("step1").still(3);
  // Step 2: 4 s circle, radius 80 px around the centre (start at the rightmost point, one full turn + a bit).
  tr.mark("step2");
  const R = 80;
  tr.seg(0.4, (u) => ({ x: CX + R * u, y: CY })); // ease out to the circle
  tr.seg(3.6, (u) => {
    const a = 2 * Math.PI * u * 1.05;
    return { x: CX + R * Math.cos(a), y: CY - R * Math.sin(a) };
  }, { sigma: 0.8 });
  tr.last = { x: CX + R * Math.cos(2 * Math.PI * 1.05), y: CY - R * Math.sin(2 * Math.PI * 1.05) };
  // Step 3: 3 s: right, then away from you (up in a top-down camera frame).
  tr.mark("step3");
  tr.path([{ x: CX, y: CY }], 400);
  tr.path([{ x: CX + 90, y: CY }], 90);
  tr.path([{ x: CX + 90, y: CY - 90 }], 90);
  // pad to exactly 10 s
  const remaining = 10 - tr.points.length / FPS;
  if (remaining > 0.01) tr.still(remaining);
  return tr;
}

function calibrationSequence() {
  const tr = calibrationSteps(new Track({ seed: 21 }));
  return tr.file(
    "calibration-sequence",
    "Calibration: 0–3 s still (step 1), 3–7 s circle r=80 px (step 2), 7–10 s right then away (step 3). Loops so a late-starting calibration still sees the full sequence.",
    { loop: true },
  );
}

function dwellStrokeWordTrack(tr) {
  const start = { x: CX - 42, y: CY + 14 };
  tr.path([start], 300);
  tr.mark("hold_down").still(2.5); // ≥ 800 ms dwell + warm-up + margin → pen down
  tr.mark("stroke_start").path(wordMum(start.x, start.y), 55);
  tr.mark("hold_up").still(3.5); // ≥ 1.2 s pen-up dwell (+ arming) → pen up
  tr.mark("away").path([{ x: CX, y: CY + 60 }], 60); // move away so the 600 ms re-arm never re-lowers on the same spot
  tr.path([{ x: CX + 40, y: CY + 60 }], 40);
  return tr;
}

function dwellStrokeWord() {
  const tr = dwellStrokeWordTrack(new Track({ seed: 31 }));
  return tr.file(
    "dwell-stroke-word",
    "Hold still 2.5 s (pen down), write cursive 'mum' (~84×28 camera px at 55 px/s), hold still 3.5 s (pen up), drift away slowly.",
  );
}

function calibrateThenWord() {
  const tr = calibrationSteps(new Track({ seed: 41 }));
  tr.mark("calibration_done").path([{ x: CX, y: CY + 40 }], 60);
  dwellStrokeWordTrack(tr);
  return tr.file("calibrate-then-word", "calibration-sequence (10 s) followed by dwell-stroke-word, for a cold start with no stored calibration.");
}

function tremorLine() {
  const tr = new Track({ seed: 51 });
  const start = { x: CX - 100, y: CY };
  tr.path([start], 300);
  tr.mark("hold_down").still(2.5);
  // 200 px horizontal line at 50 px/s with 6 Hz ±5 px jitter on y (§2 target (a) shape).
  tr.mark("stroke_start");
  const secs = 4;
  tr.seg(secs, (_u, s) => ({ x: start.x + 50 * s, y: start.y + 5 * Math.sin(2 * Math.PI * 6 * s) }), { sigma: 0.6 });
  tr.last = { x: start.x + 200, y: start.y };
  tr.mark("hold_up").still(3.5);
  return tr.file("tremor-line", "Hold to lower, 200 px line at 50 px/s with 6 Hz ±5 px y tremor, hold to lift.");
}

function trackingLossMidStroke() {
  const tr = new Track({ seed: 61 });
  const start = { x: CX - 80, y: CY };
  tr.path([start], 300);
  tr.mark("hold_down").still(2.5);
  tr.mark("stroke_start").path([{ x: CX, y: CY - 20 }], 50);
  // 1 s of score-0.5 frames: positions scribble wildly; none may move the pointer or leave ink.
  tr.mark("loss_start");
  const base = { ...tr.last };
  const rand = mulberry32(62);
  tr.seg(1, () => ({ x: base.x + (rand() - 0.5) * 200, y: base.y + (rand() - 0.5) * 160, score: SCORE_LOST }), { sigma: 0 });
  tr.last = base;
  tr.mark("loss_end");
  // Re-acquire and keep moving (never still long enough to dwell): the pen must stay up.
  tr.path([{ x: CX + 60, y: CY - 20 }, { x: CX + 60, y: CY + 40 }], 45);
  return tr.file(
    "tracking-loss-mid-stroke",
    "Hold to lower, stroke 2 s, then 1 s of score-0.5 frames (wild positions), then re-acquire and keep moving. Expect `up` ~300 ms after loss_start and no further `down`.",
  );
}

function handOutsideArea() {
  const tr = new Track({ seed: 71 });
  tr.mark("tracked").still(2);
  // The only detection jumps ~45 % of the frame away: fails the wrist hand lock (25 %).
  tr.mark("outside_start").seg(2.5, () => ({ x: 600, y: 40 }));
  tr.last = { x: CX, y: CY };
  tr.mark("back").still(2.5, { x: CX, y: CY });
  return tr.file(
    "hand-outside-area",
    "Tracked at the centre 2 s, the only detection jumps to (600,40) for 2.5 s (hand-lock reject → reason outside_area, never 'no hand'), then returns.",
  );
}

function noHand() {
  const tr = new Track({ seed: 81 });
  tr.still(1.5);
  tr.mark("gone").seg(2, () => null);
  tr.still(1.5, { x: CX, y: CY });
  return tr.file("no-hand", "1.5 s tracked, 2 s with no detection at all (null frames), 1.5 s tracked.");
}

/**
 * Probe for Playwright's dwell-on-tile tests: holds at three known camera points (A, B, C) so a
 * test can fit the camera-px → target-units mapping from window.__steady.state().pointer, then
 * serve a route-generated fixture that holds still over a specific tile. Movement between stations
 * is fast and short so no dwell fires on the way.
 */
function probe() {
  const tr = new Track({ seed: 91, restSigma: 0.2 });
  tr.mark("A").still(2.5, { x: CX - 60, y: CY - 40 });
  tr.path([{ x: CX + 60, y: CY - 40 }], 400);
  tr.mark("B").still(2.5);
  tr.path([{ x: CX + 60, y: CY + 40 }], 400);
  tr.mark("C").still(2.5);
  return tr.file("probe", "Holds 2.5 s at A(260,200), B(380,200), C(380,280) so tests can fit the camera→target mapping.", {
    stations: { A: { x: CX - 60, y: CY - 40 }, B: { x: CX + 60, y: CY - 40 }, C: { x: CX + 60, y: CY + 40 } },
  });
}

/** Slow wandering (never still for a dwell), used as the lead-in of dynamic dwell-on-tile fixtures. */
function wander() {
  const tr = new Track({ seed: 101 });
  tr.seg(20, (_u, s) => ({ x: CX + 50 * Math.sin(2 * Math.PI * 0.11 * s), y: CY + 30 * Math.sin(2 * Math.PI * 0.07 * s) }));
  return tr.file("wander", "20 s of slow wandering (≤ 35 px/s, never still): no dwell may fire.", { loop: true });
}

export const FIXTURES = [
  restStill,
  calibrationSequence,
  dwellStrokeWord,
  calibrateThenWord,
  tremorLine,
  trackingLossMidStroke,
  handOutsideArea,
  noHand,
  probe,
  wander,
];

/**
 * Build a compact fixture that wanders for `leadSeconds`, then glides to `at` and holds still for
 * `holdSeconds`. Used by Playwright via page.route() to dwell on a tile. Exported for tests.
 */
export function dwellAt(at, { leadSeconds = 3, holdSeconds = 12, seed = 7, name = "dwell-at" } = {}) {
  const tr = new Track({ seed, restSigma: 0.2 });
  tr.seg(leadSeconds, (_u, s) => ({ x: CX + 40 * Math.sin(2 * Math.PI * 0.15 * s), y: CY + 25 * Math.sin(2 * Math.PI * 0.1 * s) }));
  tr.last = { x: CX + 40 * Math.sin(2 * Math.PI * 0.15 * leadSeconds), y: CY + 25 * Math.sin(2 * Math.PI * 0.1 * leadSeconds) };
  tr.path([at], 150);
  tr.mark("hold").still(holdSeconds, at);
  return tr.file(name, `Wander ${leadSeconds} s, glide to (${r2(at.x)},${r2(at.y)}), hold ${holdSeconds} s.`);
}

/** Generic stations fixture (hold at each point for `hold` s). Exported for tests. */
export function stations(points, { hold = 2.5, seed = 9, name = "stations" } = {}) {
  const tr = new Track({ seed, restSigma: 0.2 });
  points.forEach((p, i) => {
    if (i === 0) tr.last = { ...p };
    else tr.path([p], 400);
    tr.mark(`S${i}`).still(hold, p);
  });
  return tr.file(name, `Stations ${points.map((p) => `(${p.x},${p.y})`).join(" ")}`);
}

function main() {
  const check = process.argv.includes("--check");
  let drift = false;
  for (const dir of OUT_DIRS) fs.mkdirSync(dir, { recursive: true });
  for (const make of FIXTURES) {
    const f = make();
    const json = JSON.stringify(f) + "\n";
    for (const dir of OUT_DIRS) {
      const file = path.join(dir, `${f.name}.json`);
      if (check) {
        const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
        if (cur !== json) {
          console.error(`drift: ${path.relative(ROOT, file)}`);
          drift = true;
        }
      } else {
        fs.writeFileSync(file, json);
      }
    }
    if (!check) console.log(`${f.name}: ${f.points.length} frames (${(f.points.length / FPS).toFixed(1)} s)`);
  }
  if (check && drift) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
