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

/** A single hand that keeps failing the lock but holds steady this long becomes the new reference (re-lock). */
export const RELOCK_MS = 700;
/** "Holds steady": stays within this normalised distance of where it first failed the lock. */
export const RELOCK_RADIUS = 0.08;

export class HandLock {
  ref: Vec2 | null = null;
  fraction: number;
  /** Re-lock candidate: one hand outside the lock, first seen at (x, y) at time t. */
  private cand: { x: number; y: number; t: number } | null = null;

  constructor(fraction = HAND_LOCK_FRACTION) {
    this.fraction = fraction;
  }

  reset(): void {
    this.ref = null;
    this.cand = null;
  }

  /**
   * Choose the hand to track. Does NOT move the reference; call accept() once the frame is accepted.
   * Re-lock (real-Mac fix, 18:50 Sat): with numHands 1 the lock can only ever see ONE hand, so after the hand
   * leaves the view and comes back elsewhere it was refused forever ("Hand outside the tracked area" until
   * Recenter). If exactly one hand fails the lock but stays within RELOCK_RADIUS for RELOCK_MS, it becomes the
   * reference. A second hand / cup appearing next to the tracked one still never steals the lock, because the
   * tracked hand keeps passing (which clears the candidate). `now` (ms) enables re-lock; omit it to disable.
   */
  choose(hands: HandObservation[], t: CameraTransform, lockLandmark = 0, now?: number): LockResult {
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
    if (best) {
      this.cand = null;
      return { hand: best.hand, wrist: best.wrist, reason: null };
    }
    if (now !== undefined && hands.length === 1) {
      const h = hands[0];
      const w0 = h.landmarks[lockLandmark] ?? h.landmarks[0];
      if (w0) {
        const wrist = transformNormalized(w0, t);
        const c = this.cand;
        if (!c || Math.hypot(wrist.x - c.x, wrist.y - c.y) > RELOCK_RADIUS) {
          this.cand = { x: wrist.x, y: wrist.y, t: now };
        } else if (now - c.t >= RELOCK_MS) {
          this.cand = null;
          this.ref = { x: wrist.x, y: wrist.y };
          return { hand: h, wrist, reason: null };
        }
      }
    } else {
      this.cand = null;
    }
    return { hand: null, wrist: null, reason: "outside_area" };
  }

  /** The reference follows the last accepted wrist. */
  accept(wrist: Vec2): void {
    this.ref = { x: wrist.x, y: wrist.y };
  }
}
