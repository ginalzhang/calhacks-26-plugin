/**
 * Tracking state (§0 rule 10). Defined once:
 * - a frame whose score is < 0.6 (SCORE_ACCEPT) counts as no detection;
 * - word: Tracking ≥ 0.75 · Weak 0.6–0.75 or detection fps < 20 · Lost after 300 ms without
 *   an accepted frame;
 * - during those 300 ms the pipeline freezes the pointer at the median of the last 100 ms of
 *   accepted points (medianRecent), then releases;
 * - warm-up gate: no pointer output until 10 accepted frames have been seen after (re)acquire.
 */
import {
  DETECTION_FPS_WEAK,
  FREEZE_MEDIAN_MS,
  LOST_AFTER_MS,
  SCORE_TRACKING,
  WARMUP_FRAMES,
  type LostReason,
  type TimedPoint,
  type TrackingWord,
  type Vec2,
} from "./types";

export const TOO_DARK_LUMA = 40;
export const LOW_FPS_LOST = 10;

export type TrackPhase = "init" | "tracking" | "holding" | "lost";

export interface TrackUpdate {
  /** First accepted frame after init or after Lost: reset filters, apply warm-up, suppress clicks. */
  acquired: boolean;
  /** Became Lost on this update (300 ms without an accepted frame): release the pen. */
  becameLost: boolean;
  /** Within the 300 ms grace period (pointer frozen). */
  holding: boolean;
  warmingUp: boolean;
  word: TrackingWord;
  reason: LostReason;
}

export class Tracker {
  phase: TrackPhase = "init";
  lastAcceptT: number | null = null;
  acceptedSinceAcquire = 0;
  private frameTimes: number[] = [];
  private lastScore = 0;
  private lastLuma: number | undefined;
  private lastOutside = false;

  reset(): void {
    this.phase = "init";
    this.lastAcceptT = null;
    this.acceptedSinceAcquire = 0;
    this.frameTimes = [];
  }

  /** Detection fps over the last second (null until enough history). */
  fps(): number | null {
    const ft = this.frameTimes;
    if (ft.length < 5) return null;
    const span = ft[ft.length - 1] - ft[0];
    if (span < 500) return null;
    return ((ft.length - 1) * 1000) / span;
  }

  /** One detection result. `accepted` = a hand passed the lock and score ≥ 0.6. */
  frame(t: number, f: { accepted: boolean; score: number; outsideArea: boolean; luma?: number }): TrackUpdate {
    this.frameTimes.push(t);
    while (this.frameTimes.length && this.frameTimes[0] < t - 1000) this.frameTimes.shift();
    this.lastScore = f.score;
    this.lastLuma = f.luma;
    this.lastOutside = f.outsideArea;
    if (f.accepted) {
      const acquired = this.phase === "init" || this.phase === "lost";
      if (acquired) this.acceptedSinceAcquire = 0;
      this.phase = "tracking";
      this.lastAcceptT = t;
      this.acceptedSinceAcquire++;
      return this.view(acquired, false);
    }
    return this.tick(t);
  }

  /** Advance time without an accepted frame. */
  tick(t: number): TrackUpdate {
    let becameLost = false;
    if (this.phase === "tracking" || this.phase === "holding") {
      const since = t - (this.lastAcceptT ?? t);
      if (since >= LOST_AFTER_MS) {
        this.phase = "lost";
        becameLost = true;
      } else if (since > 0) {
        this.phase = "holding";
      }
    }
    return this.view(false, becameLost);
  }

  private view(acquired: boolean, becameLost: boolean): TrackUpdate {
    const fps = this.fps();
    const lowFps = fps !== null && fps < DETECTION_FPS_WEAK;
    const dark = this.lastLuma !== undefined && this.lastLuma < TOO_DARK_LUMA;
    let word: TrackingWord;
    let reason: LostReason = null;
    if (this.phase === "lost" || this.phase === "init") {
      word = "Lost";
      if (this.lastOutside) reason = "outside_area";
      else if (dark) reason = "too_dark";
      else if (fps !== null && fps < LOW_FPS_LOST) reason = "low_fps";
      else reason = "no_hand";
    } else {
      word = this.lastScore >= SCORE_TRACKING && !lowFps && this.phase === "tracking" ? "Tracking" : "Weak";
      if (lowFps) reason = "low_fps";
      else if (dark) reason = "too_dark";
    }
    return {
      acquired,
      becameLost,
      holding: this.phase === "holding",
      warmingUp: this.phase === "tracking" ? this.acceptedSinceAcquire <= WARMUP_FRAMES : this.phase !== "holding",
      word,
      reason,
    };
  }
}

/** Per-axis median of the points within the last `windowMs` (default 100 ms) of the newest point. */
export function medianRecent(points: TimedPoint[], windowMs = FREEZE_MEDIAN_MS): Vec2 | null {
  if (points.length === 0) return null;
  const tEnd = points[points.length - 1].t;
  const recent = points.filter((p) => p.t >= tEnd - windowMs);
  const med = (vs: number[]) => {
    const s = [...vs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  return { x: med(recent.map((p) => p.x)), y: med(recent.map((p) => p.y)) };
}
