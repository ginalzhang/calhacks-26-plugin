/**
 * Camera transforms, landmark pick and active-box → target mapping (§1, §2). Pure.
 *
 * Mapping model: uniform scale `gain` (target units per camera px) about the active-box
 * centre, which maps onto the target (canvas) rect's centre. With the calibrated gain
 * (target width ÷ box width) the box's width maps exactly onto the canvas width; outside
 * the box the mapping extrapolates linearly. Uniform scale keeps circles round.
 * The pointer is clamped only to the screen bounds (or to Chrome's rect while paused).
 */
import type { HandObservation, NormalizedLandmark } from "../tracking/LandmarkSource";
import { CAMERA_H, CAMERA_W, GAIN_CAL_MAX, GAIN_MIN, type Rect, type Vec2 } from "./types";

export interface CameraTransform {
  mirror: boolean;
  rotate: boolean;
}

/** Mirror: x → 1 − x. Rotate (180°): x → 1 − x, y → 1 − y. Both compose. Normalised coords. */
export function transformNormalized(p: { x: number; y: number }, t: CameraTransform): Vec2 {
  let x = p.x;
  let y = p.y;
  if (t.mirror) x = 1 - x;
  if (t.rotate) {
    x = 1 - x;
    y = 1 - y;
  }
  return { x, y };
}

/** Landmark `idx` of a hand → camera px (after mirror/rotate). Falls back to the wrist if idx is missing. */
export function pickLandmark(
  hand: HandObservation,
  idx: number,
  t: CameraTransform,
  width = CAMERA_W,
  height = CAMERA_H,
): Vec2 {
  const lm: NormalizedLandmark | undefined = hand.landmarks[idx] ?? hand.landmarks[0];
  const n = transformNormalized(lm ?? { x: 0.5, y: 0.5 }, t);
  return { x: n.x * width, y: n.y * height };
}

export function rectCenter(r: Rect): Vec2 {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function inRect(p: Vec2, r: Rect | null | undefined): boolean {
  if (!r) return false;
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function clampToRect(p: Vec2, r: Rect | null | undefined): Vec2 {
  if (!r) return { x: p.x, y: p.y };
  return {
    x: Math.min(Math.max(p.x, r.x), r.x + r.w),
    y: Math.min(Math.max(p.y, r.y), r.y + r.h),
  };
}

/** Default active box before calibration: the central half of the camera frame. */
export function defaultBox(width = CAMERA_W, height = CAMERA_H): Rect {
  return { x: width / 4, y: height / 4, w: width / 2, h: height / 2 };
}

/** Calibrated gain: target width ÷ box width, clamped 2–4×. */
export function calibratedGain(targetWidth: number, boxWidth: number): number {
  if (!(boxWidth > 0) || !(targetWidth > 0)) return GAIN_CAL_MAX;
  return Math.min(Math.max(targetWidth / boxWidth, GAIN_MIN), GAIN_CAL_MAX);
}

export interface BoxMapping {
  /** Active box in camera px. */
  box: Rect;
  /** Target rect (canvas px or screen points). The box centre maps onto its centre. */
  target: Rect;
  /** Target units per camera px. */
  gain: number;
  flipX?: boolean;
  flipY?: boolean;
}

/** Camera px → target units, linear, extrapolating beyond the box. No clamping. */
export function boxToTarget(p: Vec2, m: BoxMapping): Vec2 {
  const bc = rectCenter(m.box);
  const tc = rectCenter(m.target);
  let dx = p.x - bc.x;
  let dy = p.y - bc.y;
  if (m.flipX) dx = -dx;
  if (m.flipY) dy = -dy;
  return { x: tc.x + dx * m.gain, y: tc.y + dy * m.gain };
}

/** Clamp to the screen bounds, or to Chrome's window rect while paused. */
export function clampPointer(p: Vec2, opts: { screen: Rect | null; chrome: Rect | null; paused: boolean }): Vec2 {
  if (opts.paused && opts.chrome) return clampToRect(p, opts.chrome);
  return clampToRect(p, opts.screen);
}
