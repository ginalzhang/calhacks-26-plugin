/**
 * Hand lock (§2): accept only a detection whose WRIST landmark is within 25 % of the frame
 * (normalised Euclidean distance) of the lock reference; the reference follows the last
 * accepted wrist. Never looks at fingers. Recenter / Other hand call reset().
 */
import type { HandObservation } from "../tracking/LandmarkSource";
import { HAND_LOCK_FRACTION, type Vec2 } from "./types";
import { transformNormalized, type CameraTransform } from "./mapping";

export interface LockResult {
  hand: HandObservation | null;
  /** Normalised wrist (after transform) of the chosen hand. */
  wrist: Vec2 | null;
  /** "outside_area" when hands were seen but none passed the lock. */
  reason: "outside_area" | null;
}

export class HandLock {
  ref: Vec2 | null = null;
  fraction: number;

  constructor(fraction = HAND_LOCK_FRACTION) {
    this.fraction = fraction;
  }

  reset(): void {
    this.ref = null;
  }

  /** Choose the hand to track. Does NOT move the reference; call accept() once the frame is accepted. */
  choose(hands: HandObservation[], t: CameraTransform, lockLandmark = 0): LockResult {
    if (hands.length === 0) return { hand: null, wrist: null, reason: null };
    let best: { hand: HandObservation; wrist: Vec2; d: number } | null = null;
    for (const h of hands) {
      // Wrist (0) in Hand mode; the nose tip (1) in Head mode.
      const w0 = h.landmarks[lockLandmark] ?? h.landmarks[0];
      if (!w0) continue;
      const wrist = transformNormalized(w0, t);
      const d = this.ref ? Math.hypot(wrist.x - this.ref.x, wrist.y - this.ref.y) : -h.score;
      if (this.ref && d > this.fraction) continue;
      if (!best || d < best.d) best = { hand: h, wrist, d };
    }
    if (!best) return { hand: null, wrist: null, reason: "outside_area" };
    return { hand: best.hand, wrist: best.wrist, reason: null };
  }

  /** The reference follows the last accepted wrist. */
  accept(wrist: Vec2): void {
    this.ref = { x: wrist.x, y: wrist.y };
  }
}
