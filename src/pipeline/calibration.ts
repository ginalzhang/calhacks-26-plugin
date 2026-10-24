/**
 * Calibration (§2), ≤ 15 s, implements `Calibrator`. Pure; timestamps injected.
 *  1. "Rest your hand and hold still" 3 s → restJitterRMS (RMS of the One Euro output about its
 *     mean, camera px) and handedness (majority vote).
 *  2. "Slowly draw a circle as big as feels easy" 4 s → active box (bounding box of the One
 *     Euro output, padded 20 %: 10 % each side), gain = target width ÷ box width clamped 2–4×,
 *     kineticJitterRMS (RMS of the One Euro output about its own ±150 ms moving average).
 *  3. (P1) "Move your hand to the right, then away from you" 3 s → flipX if the first half moved
 *     left, flipY if the second half moved down the frame (away should move the pointer up).
 * suggestedSteadiness = clamp(round(8 × max(rest, kinetic)), 10, 90).
 * Each step's clock starts at its first frame with a filtered point.
 */
import { calibratedGain, defaultBox } from "./mapping";
import { suggestedSteadiness } from "./steadiness";
import { ACTIVE_BOX_PAD, CAMERA_H, CAMERA_W, type Calibration, type Calibrator, type Rect, type TimedPoint, type Vec2 } from "./types";

export const STEP_MS: Record<1 | 2 | 3, number> = { 1: 3000, 2: 4000, 3: 3000 };
export const STEP_PROMPTS: Record<1 | 2 | 3, string> = {
  1: "Rest your hand and hold still",
  2: "Slowly draw a circle as big as feels easy",
  3: "Move your hand to the right, then away from you",
};
/** Minimum displacement (camera px) for step 3 to decide an axis direction. */
export const FLIP_MIN_PX = 10;
const KINETIC_HALF_WINDOW_MS = 150;

export interface CalibratorOptions {
  steps: Array<1 | 2 | 3>;
  /** Width of the target (practice canvas px, or Krita canvas width in points). */
  targetWidth: number;
  /** Values for steps not run this time (e.g. step 3 alone). */
  prior?: Calibration | null;
  /** Injected creation time (ms) for `createdAt`. */
  now?: number;
  /**
   * Other hand (P2b): `prior` is the OTHER hand's calibration; it is mirrored (mirrorCalibration)
   * and used for every value the steps run now do not measure (usually steps 1–2 rerun).
   */
  mirrorPrior?: boolean;
  /** Camera frame width for mirroring (default 640). */
  frameW?: number;
}

/**
 * The other hand's calibration as a starting point: the active box is mirrored about the
 * frame's vertical centre line, handedness swapped; jitter, gain and camera flips are kept
 * (flipX/flipY describe the camera, not the hand).
 */
export function mirrorCalibration(c: Calibration, frameW = CAMERA_W): Calibration {
  return {
    ...c,
    box: { x: frameW - (c.box.x + c.box.w), y: c.box.y, w: c.box.w, h: c.box.h },
    handedness: c.handedness === "Left" ? "Right" : "Left",
  };
}

function rmsAboutMean(pts: Vec2[]): number {
  if (pts.length === 0) return 0;
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return Math.sqrt(pts.reduce((s, p) => s + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / pts.length);
}

export function kineticJitter(pts: TimedPoint[], halfWindowMs = KINETIC_HALF_WINDOW_MS): number {
  if (pts.length < 3) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < pts.length; i++) {
    const t = pts[i].t;
    // Only points whose window is complete (skip the edges).
    if (t - pts[0].t < halfWindowMs || pts[pts.length - 1].t - t < halfWindowMs) continue;
    let cx = 0;
    let cy = 0;
    let k = 0;
    for (const q of pts) {
      if (q.t >= t - halfWindowMs && q.t <= t + halfWindowMs) {
        cx += q.x;
        cy += q.y;
        k++;
      }
    }
    sum += (pts[i].x - cx / k) ** 2 + (pts[i].y - cy / k) ** 2;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

export function paddedBox(pts: Vec2[], pad = ACTIVE_BOX_PAD): Rect {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  return { x: x0 - (w * pad) / 2, y: y0 - (h * pad) / 2, w: w * (1 + pad), h: h * (1 + pad) };
}

export class StepCalibrator implements Calibrator {
  private steps: Array<1 | 2 | 3>;
  private idx = 0;
  private stepStart: number | null = null;
  private pts: Record<1 | 2 | 3, TimedPoint[]> = { 1: [], 2: [], 3: [] };
  private hands: Record<"Left" | "Right", number> = { Left: 0, Right: 0 };
  private done: Calibration | null = null;
  private opts: CalibratorOptions;

  constructor(opts: CalibratorOptions) {
    this.opts =
      opts.mirrorPrior && opts.prior ? { ...opts, prior: mirrorCalibration(opts.prior, opts.frameW ?? CAMERA_W) } : opts;
    this.steps = [...new Set(opts.steps)].sort() as Array<1 | 2 | 3>;
    if (this.steps.length === 0) this.finish();
  }

  get step(): 1 | 2 | 3 | null {
    return this.done ? null : (this.steps[this.idx] ?? null);
  }

  get prompt(): string {
    const s = this.step;
    return s ? STEP_PROMPTS[s] : "";
  }

  feed(t: number, _raw: Vec2 | null, filtered: Vec2 | null, handedness: "Left" | "Right" | null): number {
    const s = this.step;
    if (!s) return 1;
    if (!filtered) return this.stepStart === null ? 0 : Math.min(1, (t - this.stepStart) / STEP_MS[s]);
    if (this.stepStart === null) this.stepStart = t;
    if (handedness) this.hands[handedness]++;
    this.pts[s].push({ t, x: filtered.x, y: filtered.y });
    const progress = Math.min(1, (t - this.stepStart) / STEP_MS[s]);
    if (progress >= 1) {
      this.idx++;
      this.stepStart = null;
      if (this.idx >= this.steps.length) this.finish();
      return 1;
    }
    return progress;
  }

  result(): Calibration | null {
    return this.done;
  }

  private finish(): void {
    const prior = this.opts.prior ?? null;
    const ran = new Set(this.steps);
    const rest = ran.has(1) ? rmsAboutMean(this.pts[1]) : (prior?.restJitterRMS ?? 0);
    let box: Rect = prior?.box ?? defaultBox(CAMERA_W, CAMERA_H);
    let kinetic = prior?.kineticJitterRMS ?? 0;
    if (ran.has(2) && this.pts[2].length >= 3) {
      box = paddedBox(this.pts[2]);
      kinetic = kineticJitter(this.pts[2]);
    }
    const gain = ran.has(2) || !prior ? calibratedGain(this.opts.targetWidth, box.w) : prior.gain;
    let flipX = prior?.flipX ?? false;
    let flipY = prior?.flipY ?? false;
    if (ran.has(3) && this.pts[3].length >= 4) {
      const p = this.pts[3];
      const t0 = p[0].t;
      const mid = t0 + STEP_MS[3] / 2;
      const first = p.filter((q) => q.t <= mid);
      const second = p.filter((q) => q.t >= mid);
      const dx = first[first.length - 1].x - first[0].x;
      const dy = second.length >= 2 ? second[second.length - 1].y - second[0].y : 0;
      if (Math.abs(dx) >= FLIP_MIN_PX) flipX = dx < 0;
      if (Math.abs(dy) >= FLIP_MIN_PX) flipY = dy > 0;
    }
    const handedness: "Left" | "Right" =
      this.hands.Left + this.hands.Right === 0 ? (prior?.handedness ?? "Right") : this.hands.Left > this.hands.Right ? "Left" : "Right";
    this.done = {
      restJitterRMS: rest,
      kineticJitterRMS: kinetic,
      box,
      gain,
      handedness,
      flipX,
      flipY,
      suggestedSteadiness: suggestedSteadiness(rest, kinetic),
      createdAt: this.opts.now ?? 0,
    };
  }
}

export function createCalibrator(opts: CalibratorOptions): Calibrator {
  return new StepCalibrator(opts);
}
