/**
 * Stroke modes (§3). Pure. Hatch (P2b) is the single named exception to the pen-state law:
 * while the pen is down, only forward passes leave ink.
 *
 * HatchEngine receives the One Euro output mapped to target units (the pre-lazy-brush point;
 * the dead zone would shift the turning points) and decides what reaches the helper through a
 * look-ahead buffer of `lagMs`:
 * - points are forwarded `lagMs` late, and never past the current extremum candidate along
 *   the axis, so no point after the peak is ever sent while the button is down;
 * - a pass ends only once the hand has travelled back more than H = max(25, 3 × restJitterRMS
 *   × gain) along the axis; then moves up to the true peak are flushed and `up` is sent there;
 * - at the next turning point the cursor (button up) is moved to the true trough, `down` is
 *   sent there and the buffered forward points are replayed at once.
 * - Alternate variant: every pass is inked as its own stroke (up at each turn, down at the
 *   turning point), for shading in any direction.
 * The axis is set by voice ("hatch left to right" = +x, "hatch down" = +y) or learned from
 * the first stroke by PCA once it has travelled more than H.
 */
import type { PenEvent, TimedPoint, Vec2 } from "./types";

export interface HatchOptions {
  lagMs: number;
  alternate: boolean;
  rIn: number;
  gain: number;
  restJitterRMS: number;
}

export function hatchMargin(restJitterRMS: number, gain: number): number {
  return Math.max(25, 3 * (restJitterRMS || 0) * (gain || 0));
}

/** Principal axis (unit vector) of a point set; null if degenerate. */
export function pcaAxis(pts: Vec2[]): Vec2 | null {
  if (pts.length < 2) return null;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= pts.length;
  my /= pts.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx + syy === 0) return null;
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { x: Math.cos(theta), y: Math.sin(theta) };
}

type Phase = "forward" | "return";

export class HatchEngine {
  private fixedAxis: Vec2 | null = null;
  private axis: Vec2 | null = null;
  private origin: Vec2 = { x: 0, y: 0 };
  private active = false;
  private phase: Phase = "forward";
  private buttonDown = false;
  private buf: TimedPoint[] = [];
  /** Current extremum candidate along the pass direction. extIdx = -1: already forwarded. */
  private hasExt = false;
  private extIdx = -1;
  private extS = 0;
  private extPoint: Vec2 = { x: 0, y: 0 };
  private firstPass: Vec2[] = [];
  /** Passes completed (for tests/metrics). */
  passes = 0;

  /** Voice-set axis (+x or +y), or null to learn it by PCA. */
  setAxis(axis: Vec2 | null): void {
    this.fixedAxis = axis;
  }

  get isButtonDown(): boolean {
    return this.buttonDown;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** The pipeline already emitted `down` at `at`. */
  start(at: Vec2, _t: number): void {
    this.active = true;
    this.axis = this.fixedAxis;
    this.origin = { ...at };
    this.phase = "forward";
    this.buttonDown = true;
    this.buf = [];
    this.firstPass = [{ ...at }];
    this.passes = 0;
    this.setForwardedExt(at);
  }

  /** Pen lifted by any source: drop the buffer (ink can't be taken back). The pipeline emits `up`. */
  stop(_t: number): PenEvent[] {
    this.active = false;
    this.buttonDown = false;
    this.buf = [];
    this.hasExt = false;
    return [];
  }

  private proj(p: Vec2): number {
    const a = this.axis ?? { x: 1, y: 0 };
    return (p.x - this.origin.x) * a.x + (p.y - this.origin.y) * a.y;
  }

  /** Signed progress along the current pass direction. */
  private s(p: Vec2): number {
    return this.phase === "forward" ? this.proj(p) : -this.proj(p);
  }

  private setForwardedExt(p: Vec2): void {
    this.hasExt = true;
    this.extIdx = -1;
    this.extPoint = { x: p.x, y: p.y };
    this.extS = this.s(p);
  }

  private moves(pts: TimedPoint[]): PenEvent[] {
    return pts.map((p) => ({ type: "move" as const, x: p.x, y: p.y }));
  }

  feed(p: Vec2, t: number, o: HatchOptions): PenEvent[] {
    if (!this.active) return [];
    const out: PenEvent[] = [];
    const H = hatchMargin(o.restJitterRMS, o.gain);
    this.buf.push({ t, x: p.x, y: p.y });

    if (!this.axis) {
      this.firstPass.push({ ...p });
      const d = Math.hypot(p.x - this.origin.x, p.y - this.origin.y);
      const a = d > H ? pcaAxis(this.firstPass) : null;
      if (!a) {
        // No reversal is possible before travelling H: forward with lag.
        out.push(...this.forwardUpTo(t - o.lagMs, this.buf.length - 1));
        if (this.buf.length === 0) this.setForwardedExt(p);
        return out;
      }
      const dot = (p.x - this.origin.x) * a.x + (p.y - this.origin.y) * a.y;
      this.axis = dot >= 0 ? a : { x: -a.x, y: -a.y };
      this.recomputeExtremum();
    }

    const sNew = this.s(p);
    if (!this.hasExt || sNew > this.extS) {
      this.hasExt = true;
      this.extIdx = this.buf.length - 1;
      this.extS = sNew;
      this.extPoint = { x: p.x, y: p.y };
    } else if (this.extS - sNew > H) {
      // Turning point confirmed at the extremum.
      const turn = this.extPoint;
      if (this.extIdx >= 0) {
        out.push(...this.moves(this.buf.slice(0, this.extIdx + 1)));
        this.buf = this.buf.slice(this.extIdx + 1);
      }
      this.passes++;
      const wasForward = this.phase === "forward";
      this.phase = wasForward ? "return" : "forward";
      const inkNext = o.alternate || !wasForward;
      if (this.buttonDown) {
        out.push({ type: "up", x: turn.x, y: turn.y, reason: "hatch_pass" });
        this.buttonDown = false;
      }
      if (inkNext) {
        out.push({ type: "down", x: turn.x, y: turn.y });
        this.buttonDown = true;
        out.push(...this.moves(this.buf));
        const last = this.buf.length ? this.buf[this.buf.length - 1] : turn;
        this.buf = [];
        this.setForwardedExt(last);
        // The replayed points may already contain the new extremum candidate.
        this.extS = Math.max(this.extS, this.s(turn));
      } else {
        this.recomputeExtremum();
      }
      return out;
    }
    // Forward with lag, never past the extremum candidate.
    out.push(...this.forwardUpTo(t - o.lagMs, this.extIdx));
    return out;
  }

  private recomputeExtremum(): void {
    this.hasExt = false;
    this.extIdx = -1;
    for (let i = 0; i < this.buf.length; i++) {
      const s = this.s(this.buf[i]);
      if (!this.hasExt || s > this.extS) {
        this.hasExt = true;
        this.extS = s;
        this.extIdx = i;
        this.extPoint = { x: this.buf[i].x, y: this.buf[i].y };
      }
    }
  }

  /** Forward buffered points with t ≤ tMax and index ≤ maxIdx. */
  private forwardUpTo(tMax: number, maxIdx: number): PenEvent[] {
    let n = 0;
    while (n < this.buf.length && n <= maxIdx && this.buf[n].t <= tMax) n++;
    if (n === 0) return [];
    const sent = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    if (this.extIdx >= 0) this.extIdx = this.extIdx - n;
    if (this.extIdx < -1) this.extIdx = -1;
    return this.moves(sent);
  }
}

// ---------------------------------------------------------------------------
// Dash mode (P3)
// ---------------------------------------------------------------------------

/**
 * Speed hysteresis (target units/s). Speed is measured on the RAW mapped landmark over
 * DASH_SPEED_WINDOW_MS: the One Euro output lags ~250 ms at slow speeds, so a 300 ms pause
 * would never show in it. Ink still follows the One Euro output.
 */
export const DASH_SPEED_ON = 25;
export const DASH_SPEED_OFF = 10;
export const DASH_SPEED_WINDOW_MS = 100;
/** Look-back used to start a mark where the motion started (One Euro points). */
export const DASH_WINDOW_MS = 150;
export const DASH_PAUSE_DEFAULT_MS = 200; // slider 100–600

/**
 * While the pen is held down in Dash mode, ink appears only while the hand moves. The button
 * starts UP. A mark starts when the raw speed exceeds DASH_SPEED_ON AND the One Euro point has
 * left its rest anchor by more than `startR` (so tremor on a resting hand never inks); it starts
 * at the oldest One Euro point of the last DASH_WINDOW_MS, which is replayed. When the raw speed
 * falls below DASH_SPEED_OFF the following points are held back; if the pause lasts `pauseMs`
 * the mark ends at the last inked point and the held (dwell) points are trimmed; if motion
 * resumes first, the held points are flushed and the mark continues.
 */
export class DashEngine {
  private active = false;
  private buttonDown = false;
  private histPre: TimedPoint[] = [];
  private histRaw: TimedPoint[] = [];
  private held: TimedPoint[] = [];
  private slowSince: number | null = null;
  private lastSent: Vec2 | null = null;
  private restAnchor: Vec2 = { x: 0, y: 0 };
  marks = 0;

  get isActive(): boolean {
    return this.active;
  }

  get isButtonDown(): boolean {
    return this.buttonDown;
  }

  /** Pen armed (pipeline DRAWING) at `at`; the button stays up until the hand moves. */
  start(at: Vec2, t: number): void {
    this.active = true;
    this.buttonDown = false;
    this.histPre = [{ t, x: at.x, y: at.y }];
    this.histRaw = [];
    this.held = [];
    this.slowSince = null;
    this.lastSent = { ...at };
    this.restAnchor = { ...at };
    this.marks = 0;
  }

  stop(_t: number): PenEvent[] {
    this.active = false;
    this.buttonDown = false;
    this.held = [];
    this.slowSince = null;
    return [];
  }

  /** Raw speed over the last DASH_SPEED_WINDOW_MS (target units/s). */
  speed(): number {
    const h = this.histRaw;
    if (h.length < 2) return 0;
    const a = h[0];
    const b = h[h.length - 1];
    const dt = (b.t - a.t) / 1000;
    return dt > 0 ? Math.hypot(b.x - a.x, b.y - a.y) / dt : 0;
  }

  private send(out: PenEvent[], e: PenEvent): void {
    out.push(e);
    if (e.type !== "up") this.lastSent = { x: e.x, y: e.y };
  }

  private static trim(h: TimedPoint[], t: number, windowMs: number): void {
    while (h.length > 2 && h[1].t <= t - windowMs) h.shift();
  }

  feed(p: Vec2, raw: Vec2, t: number, o: { pauseMs: number; startR: number }): PenEvent[] {
    if (!this.active) return [];
    const out: PenEvent[] = [];
    this.histPre.push({ t, x: p.x, y: p.y });
    this.histRaw.push({ t, x: raw.x, y: raw.y });
    DashEngine.trim(this.histPre, t, DASH_WINDOW_MS);
    DashEngine.trim(this.histRaw, t, DASH_SPEED_WINDOW_MS);
    const v = this.speed();
    if (!this.buttonDown) {
      const away = Math.hypot(p.x - this.restAnchor.x, p.y - this.restAnchor.y) > o.startR;
      if (v > DASH_SPEED_ON && away) {
        const [first, ...rest] = this.histPre;
        this.send(out, { type: "move", x: first.x, y: first.y });
        this.send(out, { type: "down", x: first.x, y: first.y });
        for (const q of rest) this.send(out, { type: "move", x: q.x, y: q.y });
        this.buttonDown = true;
        this.slowSince = null;
        this.held = [];
        this.marks++;
      } else {
        this.send(out, { type: "move", x: p.x, y: p.y }); // hover, button up
      }
      return out;
    }
    if (this.slowSince === null) {
      if (v < DASH_SPEED_OFF) {
        this.slowSince = t;
        this.held = [{ t, x: p.x, y: p.y }];
      } else {
        this.send(out, { type: "move", x: p.x, y: p.y });
      }
      return out;
    }
    if (v > DASH_SPEED_ON) {
      // Motion resumed before the pause elapsed: same mark continues.
      for (const q of this.held) this.send(out, { type: "move", x: q.x, y: q.y });
      this.send(out, { type: "move", x: p.x, y: p.y });
      this.held = [];
      this.slowSince = null;
      return out;
    }
    this.held.push({ t, x: p.x, y: p.y });
    if (t - this.slowSince >= o.pauseMs) {
      const end = this.lastSent ?? p;
      out.push({ type: "up", x: end.x, y: end.y, reason: "dash" });
      this.buttonDown = false;
      this.held = []; // dwell points trimmed
      this.slowSince = null;
      this.restAnchor = { x: end.x, y: end.y };
      this.send(out, { type: "move", x: p.x, y: p.y });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Repeat stroke (P3)
// ---------------------------------------------------------------------------

/** Copy of `stroke` with its first point moved to `cursor` (every point offset identically). */
export function offsetStroke(stroke: Vec2[], cursor: Vec2): Vec2[] {
  if (stroke.length === 0) return [];
  const dx = cursor.x - stroke[0].x;
  const dy = cursor.y - stroke[0].y;
  return stroke.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}
