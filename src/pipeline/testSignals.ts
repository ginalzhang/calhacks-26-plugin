/**
 * Synthetic-signal helpers for Vitest (pure; no DOM). Not imported by production code.
 */
import type { LandmarkFrame, HandObservation, NormalizedLandmark } from "../tracking/LandmarkSource";
import { CAMERA_H, CAMERA_W, type TimedPoint, type Vec2 } from "./types";
import { OneEuro2D, type OneEuroParams } from "./oneEuro";

/** Timestamps (ms) for `seconds` of samples at `fps`, starting at t0. */
export function times(seconds: number, fps = 30, t0 = 0): number[] {
  const n = Math.round(seconds * fps);
  return Array.from({ length: n }, (_, i) => t0 + (i * 1000) / fps);
}

/** Sample a function of time (s) into timed points. */
export function sample(seconds: number, fps: number, f: (tS: number) => Vec2, t0 = 0): TimedPoint[] {
  return times(seconds, fps, t0).map((t) => ({ t, ...f((t - t0) / 1000) }));
}

export function sine(amp: number, hz: number, phase = 0): (tS: number) => number {
  return (tS) => amp * Math.sin(2 * Math.PI * hz * tS + phase);
}

/** Run points through a fresh One Euro 2D filter. */
export function runOneEuro(pts: TimedPoint[], params: Partial<OneEuroParams> = {}): TimedPoint[] {
  const f = new OneEuro2D(params);
  return pts.map((p) => ({ t: p.t, ...f.filter(p, p.t) }));
}

export function rms(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A resting-hand observation whose landmark `idx` (and all others, offset) sits at camera px p. */
export function hand(
  p: Vec2,
  opts: { score?: number; handedness?: "Left" | "Right"; idx?: number; wrist?: Vec2; w?: number; h?: number } = {},
): HandObservation {
  const w = opts.w ?? CAMERA_W;
  const h = opts.h ?? CAMERA_H;
  const idx = opts.idx ?? 5;
  const wrist = opts.wrist ?? { x: p.x, y: p.y + 60 };
  const landmarks: NormalizedLandmark[] = Array.from({ length: 21 }, (_, i) => {
    if (i === 0) return { x: wrist.x / w, y: wrist.y / h, z: 0 };
    if (i === idx) return { x: p.x / w, y: p.y / h, z: 0 };
    return { x: (p.x + (i % 5) * 4) / w, y: (p.y - Math.floor(i / 5) * 6) / h, z: 0 };
  });
  return { landmarks, score: opts.score ?? 0.9, handedness: opts.handedness ?? "Right" };
}

export function frame(t: number, hands: HandObservation[], luma?: number): LandmarkFrame {
  return { t, width: CAMERA_W, height: CAMERA_H, hands, ...(luma !== undefined ? { luma } : {}) };
}

/** Frames for a camera-px path (one hand at score `score`). */
export function framesFor(pts: TimedPoint[], score = 0.9): LandmarkFrame[] {
  return pts.map((p) => frame(p.t, [hand(p, { score })]));
}
