/**
 * Dwell detection (§3) on the pre-lazy-brush point, target units. Pure; injected timestamps.
 *
 * - Pen-down dwell and click dwell: a dwell STARTS when every point of the last 250 ms lies
 *   within r_in of their centroid (the anchor); it is CANCELLED only beyond r_out = 2 × r_in
 *   from the anchor (hysteresis, no flicker). Progress counts from the first point of the
 *   still window, so the hand is still for ≈ `ms` in total.
 * - Pen-up dwell (tight): starts when the last 250 ms lie within r_in/2 of their centroid and
 *   is cancelled as soon as any point leaves r_in/2 of the anchor (no hysteresis).
 * - Arming (pen-up armed only after moving > r_in from the down anchor; 600 ms + move-away
 *   after a lift) is the pipeline's job; it passes `null` params while a kind is unarmed.
 */
import { phaseAtMost, type Phase } from "../actions";
import { inRect } from "./mapping";
import {
  DWELL_R_IN_MIN,
  DWELL_STILL_WINDOW_MS,
  MENU_BAR_PT,
  type DwellKind,
  type PipelineRects,
  type Rect,
  type TimedPoint,
  type Vec2,
} from "./types";

/** Title bars are never dwell-clicked (§3). macOS standard title bar height, points. */
export const TITLE_BAR_PT = 28;

export interface DwellParams {
  kind: Exclude<DwellKind, null>;
  ms: number;
  rIn: number;
  /** Pen-up rule: r_in/2, no hysteresis. */
  tight: boolean;
}

export interface DwellStep {
  progress: number;
  fired: boolean;
  anchor: Vec2 | null;
}

/** r_in = max(15, lazyRadius/2, 3 × restJitterRMS_px × gain). */
export function dwellRIn(lazyRadius: number, restJitterRMS: number, gain: number): number {
  return Math.max(DWELL_R_IN_MIN, lazyRadius / 2, 3 * (restJitterRMS || 0) * (gain || 0));
}

export class DwellDetector {
  private hist: TimedPoint[] = [];
  private active: { kind: DwellParams["kind"]; startT: number; anchor: Vec2 } | null = null;

  reset(): void {
    this.hist = [];
    this.active = null;
  }

  /** Cancel the current dwell but keep history. */
  cancel(): void {
    this.active = null;
  }

  update(t: number, p: Vec2, params: DwellParams | null): DwellStep {
    this.hist.push({ t, x: p.x, y: p.y });
    while (this.hist.length && this.hist[0].t < t - DWELL_STILL_WINDOW_MS) this.hist.shift();
    if (!params) {
      this.active = null;
      return { progress: 0, fired: false, anchor: null };
    }
    if (this.active && this.active.kind !== params.kind) this.active = null;
    if (this.active) {
      const cancelR = params.tight ? params.rIn / 2 : 2 * params.rIn;
      if (Math.hypot(p.x - this.active.anchor.x, p.y - this.active.anchor.y) > cancelR) this.active = null;
    }
    if (!this.active) {
      const w = this.hist;
      const span = w.length ? w[w.length - 1].t - w[0].t : 0;
      if (w.length >= 3 && span >= DWELL_STILL_WINDOW_MS * 0.8) {
        const c = { x: 0, y: 0 };
        for (const q of w) {
          c.x += q.x;
          c.y += q.y;
        }
        c.x /= w.length;
        c.y /= w.length;
        const r = params.tight ? params.rIn / 2 : params.rIn;
        if (w.every((q) => Math.hypot(q.x - c.x, q.y - c.y) <= r)) {
          this.active = { kind: params.kind, startT: w[0].t, anchor: c };
        }
      }
    }
    if (!this.active) return { progress: 0, fired: false, anchor: null };
    const progress = Math.min(1, (t - this.active.startT) / Math.max(1, params.ms));
    const anchor = this.active.anchor;
    if (progress >= 1) {
      this.active = null;
      return { progress: 1, fired: true, anchor };
    }
    return { progress, fired: false, anchor };
  }
}

export type ClickZone = "anywhere" | "chrome" | "krita" | null;

/**
 * Where a dwell-click is allowed (screen points): inside Chrome's own window (P1) or, from
 * P2a, Krita's main window; never in the menu bar (top 40 pt), title bars, outside the usable
 * area (`rects.usable`, the screen's visible frame: no Dock) when known, or anywhere else.
 */
export function clickZone(p: Vec2, rects: PipelineRects, phase: Phase, anywhere = false): ClickZone {
  if (anywhere) {
    // settings.clickAnywhere: any point on any screen (the pointer is already clamped to the screens).
    const inBody = (r: Rect | null) => !!r && inRect(p, r) && p.y >= r.y + TITLE_BAR_PT;
    if (inBody(rects.chrome)) return "chrome";
    if (inBody(rects.krita)) return "krita";
    return "anywhere";
  }
  const screenTop = rects.screen?.y ?? 0;
  if (p.y < screenTop + MENU_BAR_PT) return null;
  // The helper's visible frame excludes the menu bar and the Dock (R8).
  if (rects.usable && !inRect(p, rects.usable)) return null;
  const inBody = (r: Rect | null) => !!r && inRect(p, r) && p.y >= r.y + TITLE_BAR_PT;
  if (inBody(rects.chrome)) return "chrome";
  if (phaseAtMost("P2a", phase) && inBody(rects.krita)) return "krita";
  return null;
}
