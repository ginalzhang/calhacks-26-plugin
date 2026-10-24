/**
 * Re-baseline (P4, §2): every 10 min, re-measure hand scale from the landmark bounding box and
 * rescale the active box about its centre, so the same arm movement keeps mapping to the same
 * distance on the canvas when the hand's apparent size changes (swelling, the hand drifting
 * nearer/farther, a nudged camera). Pure.
 */
import type { NormalizedLandmark } from "../tracking/LandmarkSource";
import type { Rect } from "./types";

export const REBASELINE_MS = 10 * 60 * 1000;
/** Samples used for each measurement (median), and how long to collect the reference. */
export const SCALE_SAMPLE_MS = 2000;
/** Ignore changes smaller than this; clamp the overall scale to [MIN, MAX]. */
export const REBASELINE_DEADBAND = 0.05;
export const BOX_SCALE_MIN = 0.5;
export const BOX_SCALE_MAX = 2;

/** Hand scale (camera px): diagonal of the bounding box of all landmarks. */
export function handScale(landmarks: NormalizedLandmark[], width: number, height: number): number {
  if (landmarks.length < 2) return 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const l of landmarks) {
    x0 = Math.min(x0, l.x * width);
    x1 = Math.max(x1, l.x * width);
    y0 = Math.min(y0, l.y * height);
    y1 = Math.max(y1, l.y * height);
  }
  return Math.hypot(x1 - x0, y1 - y0);
}

export function median(vs: number[]): number {
  if (vs.length === 0) return 0;
  const s = [...vs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** New overall box scale from the reference and current hand scale (dead-banded, clamped). */
export function rebaselineScale(refScale: number, nowScale: number, currentScale = 1): number {
  if (!(refScale > 0) || !(nowScale > 0)) return currentScale;
  const target = Math.min(Math.max(nowScale / refScale, BOX_SCALE_MIN), BOX_SCALE_MAX);
  return Math.abs(target / currentScale - 1) < REBASELINE_DEADBAND ? currentScale : target;
}

/** Rescale a rect about its centre. */
export function rescaleBox(box: Rect, scale: number): Rect {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const w = box.w * scale;
  const h = box.h * scale;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}
