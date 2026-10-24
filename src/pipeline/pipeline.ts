/**
 * The §2/§3 pointer pipeline. Pure: no DOM, injected timestamps.
 *
 * landmark pick → mirror/rotate → hand lock (wrist) → score gate / tracking → Simulate tremor
 * → One Euro (camera px) → active box × gain (+ clamp) → [dwell reads here] → lazy brush
 * → pen state machine → PenEvent[] + DwellView.
 *
 * Pen-state law (§0 rule 10): anything lifts; only dwell, the pen key, a pedal or voice
 * "down" lowers; nothing auto-lowers (Latch included). Leaving the canvas rect lifts. The
 * canvas rect gates ink, not movement.
 *
 * Notes for the Worker (B):
 * - `click` events are emitted only when target === "krita" and the helper is connected; with
 *   the practice-canvas target the DwellView still reports kind "click" + progress outside the
 *   canvas so the page can drive its own hover-dwell.
 * - When the tracking word goes Lost → Tracking the pen is always up: show
 *   "Tracking back. Pen is up."
 * - `rects.canvas === null`: target "canvas" treats everything as canvas; target "krita"
 *   allows no ink until the canvas rect is known (corner marking or the plugin).
 * - Dots mode: a pen-down dwell inside the canvas emits `down` immediately followed by `up`
 *   (reason "dwell") and the pen stays up.
 */
import { ACTIONS_BY_ID, BUILD_PHASE, type Phase } from "../actions";
import type { LandmarkFrame } from "../tracking/LandmarkSource";
import { clickZone, DwellDetector, dwellRIn, type DwellParams } from "./dwell";
import { HandLock } from "./handLock";
import { LazyBrush } from "./lazyBrush";
import {
  boxToTarget,
  calibratedGain,
  clampPointer,
  defaultBox,
  inRect,
  pickLandmark,
  rectCenter,
  type BoxMapping,
} from "./mapping";
import { OneEuro2D } from "./oneEuro";
import { clamp, steadinessParams } from "./steadiness";
import { handModeConfig, handPresetSettings, headModeConfig, isHandPreset, type ExtraSettings } from "./presets";
import { handScale, median, REBASELINE_MS, rebaselineScale, rescaleBox, SCALE_SAMPLE_MS } from "./rebaseline";
import { DASH_PAUSE_DEFAULT_MS, DashEngine, HatchEngine, offsetStroke } from "./strokeModes";
import { medianRecent, Tracker, type TrackUpdate } from "./tracking";
import { TremorSim } from "./tremorSim";
import {
  CAMERA_H,
  CAMERA_W,
  CLICK_SUPPRESS_MS,
  DEFAULT_SETTINGS,
  IGNORE_LIFT_AFTER_DOWN_MS,
  ONE_EURO_DEFAULTS,
  REARM_AFTER_UP_MS,
  SCORE_ACCEPT,
  STEADIER_STEP,
  WARMUP_FRAMES,
  type Calibration,
  type DwellView,
  type LiftReason,
  type PenEvent,
  type PenState,
  type Pipeline,
  type PipelineConfig,
  type PipelineOutput,
  type PipelineRects,
  type Rect,
  type SteadySettings,
  type StrokeMode,
  type Target,
  type TimedPoint,
  type Vec2,
} from "./types";

const TRAIL_MS = 3000;
const DEVIATION_HALF_WINDOW_MS = 100;
const STEADIER_DEBOUNCE_MS = 1000;
const USER_LIFTS: LiftReason[] = ["dwell", "pen_key", "voice"];

export interface PipelineOptions {
  /** Build phase for phase-gated behaviour (dwell-click in Krita's window from P2a). Default BUILD_PHASE. */
  phase?: Phase;
}

/** Smoothing presets (§2, P3): Steadiness value and optional lazy-radius cap. */
export const SMOOTHING_PRESETS: Record<string, { name: "sketch" | "ink" | "shade"; steadiness: number; radiusCap: number | null }> = {
  smoothing_sketch: { name: "sketch", steadiness: 25, radiusCap: null },
  smoothing_ink: { name: "ink", steadiness: 70, radiusCap: null },
  smoothing_shade: { name: "shade", steadiness: 10, radiusCap: 5 },
};

/**
 * Pipeline state beyond the `Pipeline.snapshot()` contract (P3 modes). Read with modeState(p).
 * `batch*` flags describe the events returned by the most recent step()/tick()/action()/setTarget().
 */
export interface ModeState {
  /** `pan` was said: the next pen-down drags with the MIDDLE button. */
  panArmed: boolean;
  /** A pan drag is in progress (events are middle-button, filter bypassed). */
  panning: boolean;
  /** The last returned down/move/up events belong to a pan drag: send middle_down/middle_up. */
  batchIsPan: boolean;
  /** `pick` was said: the next dwell inside the canvas sends one click (Krita samples). */
  pickArmed: boolean;
  /** One-shot: the last returned batch contains the sampling click; the caller returns to brush. */
  batchPickSampled: boolean;
  /** Active smoothing preset, null once Steadiness is changed any other way. */
  preset: "sketch" | "ink" | "shade" | null;
  /** Lazy radius currently applied (target units). */
  lazyRadius: number;
  /** Dash: the button is physically down (a mark is being inked). */
  dashButtonDown: boolean;
  /** Last inked stroke (target units), for Repeat. */
  lastStroke: Vec2[] | null;
  /** Re-baseline (P4): current active-box scale (1 = as calibrated). */
  boxScale: number;
  /** Head mode (P4): the lock follows the nose tip. */
  headMode: boolean;
}

interface Rearm {
  anchor: Vec2 | null;
  radius: number;
  notBefore: number;
}

const IDLE_DWELL: DwellView = { kind: null, progress: 0, x: 0, y: 0, gated: false };

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

class SteadyPipeline implements Pipeline {
  private settings: SteadySettings;
  private calibration: Calibration | null;
  private target: Target;
  private rects: PipelineRects;
  private helperConnected: boolean;
  private phase: Phase;

  private lock = new HandLock();
  private tracker = new Tracker();
  private euro: OneEuro2D;
  private lazy: LazyBrush;
  private dwell = new DwellDetector();
  private tremor: TremorSim;
  private hatch = new HatchEngine();
  private dash = new DashEngine();

  // P3 modes
  private radiusCap: number | null = null;
  private preset: ModeState["preset"] = null;
  private panArmed = false;
  private panning = false;
  private pickArmed = false;
  private batch = { pan: false, pickSampled: false };
  private ink = { down: false, pts: [] as Vec2[], pan: false };
  private lastStroke: Vec2[] | null = null;
  // P4 re-baseline
  private boxScale = 1;
  private refScale: number | null = null;
  private scaleSamples: TimedPoint[] = []; // x = scale
  private lastRebaselineT: number | null = null;
  private rebaselineDue = false;

  /** Steadiness actually applied to the filters (deferred while a stroke is in progress). */
  private applied: { steadiness: number; cap: number | null; minCutoff: number; lazyRadius: number };

  private pen: PenState = "HOVER";
  private paused = false;
  private mode: StrokeMode = "normal";
  private downT = 0;
  private downAnchor: Vec2 | null = null;
  private upArmed = false;
  private rearm: Rearm | null = null;
  private suppressClicksUntil = -Infinity;
  private lastSteadierT: number | null = null;
  private recenterAt: Vec2 | null = null;
  private wasLost = false;
  private lostSinceAcquire = false;

  private lastT = 0;
  private lastFiltered: Vec2 | null = null;
  private lastPre: Vec2 | null = null;
  private lastEmitted: Vec2 | null = null;
  private frozen: Vec2 | null = null;
  private pointerHist: TimedPoint[] = [];
  private rawTrail: TimedPoint[] = [];
  private smoothTrail: TimedPoint[] = [];
  private lastStrokeMs: number | null = null;
  private frameW = CAMERA_W;
  private frameH = CAMERA_H;

  constructor(config: PipelineConfig, opts: PipelineOptions = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...config.settings };
    this.calibration = config.calibration;
    this.target = config.target;
    this.rects = { ...config.rects };
    this.helperConnected = config.helperConnected;
    this.phase = opts.phase ?? BUILD_PHASE;
    const sp = steadinessParams(this.settings.steadiness);
    this.applied = { steadiness: this.settings.steadiness, cap: null, ...sp };
    this.euro = new OneEuro2D({ ...ONE_EURO_DEFAULTS, minCutoff: sp.minCutoff });
    this.lazy = new LazyBrush(sp.lazyRadius);
    this.tremor = new TremorSim(config.seed ?? 1);
  }

  // ---------------------------------------------------------------- helpers

  /** Gain after re-baseline: a hand that looks s× bigger moves s× more camera px for the same arm movement. */
  private gain(): number {
    return this.baseGain() / this.boxScale;
  }

  private baseGain(): number {
    if (this.settings.gainOverride != null) return this.settings.gainOverride;
    if (this.calibration) return this.calibration.gain;
    return calibratedGain(this.targetRect().w, defaultBox(this.frameW, this.frameH).w);
  }

  private box(): Rect {
    const b0 = this.calibration?.box ?? defaultBox(this.frameW, this.frameH);
    const b = this.boxScale === 1 ? b0 : rescaleBox(b0, this.boxScale);
    if (!this.recenterAt) return b;
    return { x: this.recenterAt.x - b.w / 2, y: this.recenterAt.y - b.h / 2, w: b.w, h: b.h };
  }

  private targetRect(): Rect {
    return this.rects.canvas ?? this.rects.screen ?? { x: 0, y: 0, w: 1280, h: 800 };
  }

  private mapping(): BoxMapping {
    return {
      box: this.box(),
      target: this.targetRect(),
      gain: this.gain(),
      flipX: this.calibration?.flipX ?? false,
      flipY: this.calibration?.flipY ?? false,
    };
  }

  private toTarget(p: Vec2): Vec2 {
    return this.clampOnly(boxToTarget(p, this.mapping()));
  }

  private clampOnly(p: Vec2): Vec2 {
    return clampPointer(p, {
      screen: this.rects.screen,
      chrome: this.target === "krita" ? this.rects.chrome : null,
      paused: this.paused,
    });
  }

  private rIn(): number {
    const floor = this.extra().dwellRadius;
    const r = dwellRIn(this.applied.lazyRadius, this.calibration?.restJitterRMS ?? 0, this.gain());
    return typeof floor === "number" && floor > r ? floor : r;
  }

  private inkAllowedAt(p: Vec2 | null): boolean {
    if (!p || this.paused) return false;
    if (!this.rects.canvas) return this.target === "canvas";
    return inRect(p, this.rects.canvas);
  }

  private currentPointer(): Vec2 | null {
    if (this.tracker.phase === "holding") return this.frozen ?? this.lastEmitted;
    if (this.tracker.phase !== "tracking" || this.tracker.acceptedSinceAcquire <= WARMUP_FRAMES) return null;
    return this.lazy.pointer;
  }

  private applySteadinessIfIdle(): void {
    if (this.pen === "DRAWING") return;
    if (this.applied.steadiness === this.settings.steadiness && this.applied.cap === this.radiusCap) return;
    const sp = steadinessParams(this.settings.steadiness);
    if (this.radiusCap !== null) sp.lazyRadius = Math.min(sp.lazyRadius, this.radiusCap);
    this.applied = { steadiness: this.settings.steadiness, cap: this.radiusCap, ...sp };
    this.euro.setParams({ minCutoff: sp.minCutoff });
    this.lazy.radius = sp.lazyRadius;
  }

  private suppressClicks(t: number): void {
    this.suppressClicksUntil = t + CLICK_SUPPRESS_MS;
  }

  private setRearm(t: number, delayMs: number, anchor: Vec2 | null): void {
    this.rearm = { anchor: anchor ? { ...anchor } : null, radius: 2 * this.rIn(), notBefore: t + delayMs };
  }

  // ---------------------------------------------------------------- pen

  private lower(t: number, atPointer: Vec2, events: PenEvent[]): boolean {
    if (this.pen === "DRAWING") return false;
    const hatching = !this.panArmed && (this.mode === "hatch" || this.mode === "hatch_alternate");
    const dashing = !this.panArmed && this.mode === "dash";
    const at = (hatching || dashing) && this.lastPre ? { ...this.lastPre } : atPointer;
    if (!this.inkAllowedAt(at)) return false;
    this.pen = "DRAWING";
    this.downT = t;
    this.downAnchor = this.lastPre ? { ...this.lastPre } : { ...at };
    this.upArmed = false;
    this.rearm = null;
    this.dwell.cancel();
    if (this.panArmed) {
      this.panning = true;
      this.batch.pan = true;
    }
    if (dashing) {
      // Dash: the pen is armed; the engine presses the button only while the hand moves.
      this.dash.start(at, t);
      this.lastEmitted = { ...at };
      return true;
    }
    events.push({ type: "down", x: at.x, y: at.y });
    if (hatching) {
      this.hatch.start(at, t);
      this.lastEmitted = { ...at };
    }
    return true;
  }

  private lift(t: number, reason: LiftReason, events: PenEvent[], at?: Vec2 | null): boolean {
    if (this.pen !== "DRAWING") return false;
    if (USER_LIFTS.includes(reason) && t - this.downT < IGNORE_LIFT_AFTER_DOWN_MS) return false;
    const p = at ?? this.lastEmitted ?? this.lastPre ?? { x: 0, y: 0 };
    let buttonDown = true;
    if (this.hatch.isActive) {
      buttonDown = this.hatch.isButtonDown;
      events.push(...this.hatch.stop(t));
    }
    if (this.dash.isActive) {
      buttonDown = this.dash.isButtonDown;
      events.push(...this.dash.stop(t));
    }
    this.pen = "HOVER";
    this.lastStrokeMs = t - this.downT;
    this.dwell.cancel();
    if (this.panning) {
      // Pan exits on lift.
      this.batch.pan = true;
      this.panning = false;
      this.panArmed = false;
    }
    if (buttonDown) events.push({ type: "up", x: p.x, y: p.y, reason });
    this.setRearm(t, REARM_AFTER_UP_MS, this.lastPre);
    this.applySteadinessIfIdle();
    return true;
  }

  // ---------------------------------------------------------------- frames

  step(frame: LandmarkFrame): PipelineOutput {
    const t = frame.t;
    this.lastT = t;
    this.frameW = frame.width || CAMERA_W;
    this.frameH = frame.height || CAMERA_H;
    const events: PenEvent[] = [];
    this.beginBatch();
    if (this.pendingLift) {
      this.pendingLift = false;
      this.lift(t, "mode_change", events);
      this.euro.reset();
      this.lazy.reset();
      this.dwell.reset();
      this.tracker.acceptedSinceAcquire = 0; // warm-up re-applies
      this.setRearm(t, 0, null);
    }
    const tf = { mirror: this.settings.mirrorCamera, rotate: this.settings.rotateCamera };
    const choice = this.settings.inputs.camera
      ? this.lock.choose(frame.hands, tf, this.extra().lockLandmark ?? 0)
      : { hand: null, wrist: null, reason: null as null };
    const hand = choice.hand;
    const score = hand?.score ?? 0;
    const accepted = !!hand && score >= SCORE_ACCEPT && !!choice.wrist;
    const upd = this.tracker.frame(t, {
      accepted,
      score,
      outsideArea: choice.reason === "outside_area",
      luma: frame.luma,
    });
    if (!accepted || !hand || !choice.wrist) return this.noFrame(t, upd, events, score);

    this.lock.accept(choice.wrist);
    this.frozen = null;
    if (upd.acquired) {
      this.euro.reset();
      this.tremor.reset();
      this.lazy.reset();
      this.dwell.reset();
      this.pointerHist = [];
      this.frozen = null;
      this.suppressClicks(t);
      this.lostSinceAcquire = this.wasLost;
      // After a loss the pen stays up until an explicit pen-down; a resting hand must move
      // away before the dwell can lower it again (no ink from the hand that was just lost).
      if (this.wasLost) this.setRearm(t, 0, null);
    }

    this.sampleScale(t, hand.landmarks);
    const raw = pickLandmark(hand, this.settings.landmark, tf, this.frameW, this.frameH);
    const sim = this.settings.simulateTremor ? this.tremor.apply(raw, t) : raw;
    const filtered = this.euro.filter(sim, t);
    this.lastFiltered = filtered;
    const unclamped = boxToTarget(filtered, this.mapping());
    const pre = this.clampOnly(unclamped);
    this.pinned = pre.x !== unclamped.x || pre.y !== unclamped.y;
    this.lastPre = pre;
    this.pushTrail(this.rawTrail, t, this.toTarget(sim));

    if (upd.warmingUp) {
      return this.output(t, { raw: sim, filtered, pre, pointer: null, events, dwell: IDLE_DWELL, upd, score });
    }

    if (this.rearm && !this.rearm.anchor) this.rearm.anchor = { ...pre };
    let pointer = this.lazy.update(pre);
    const clamped = this.clampOnly(pointer);
    if (clamped.x !== pointer.x || clamped.y !== pointer.y) {
      // The dead zone must not leave the pointer outside the clamp (e.g. right after Pause).
      pointer = clamped;
      this.lazy.reset(clamped);
    }
    this.pushTrail(this.pointerHist, t, pointer, 400);
    this.pushTrail(this.smoothTrail, t, pointer);

    // Leaving the canvas lifts before the pointer is moved out.
    const engine = this.hatch.isActive || this.dash.isActive;
    const rawTarget = this.toTarget(sim);
    const inkPt = engine ? pre : this.panning ? rawTarget : pointer;
    if (this.pen === "DRAWING" && !this.inkAllowedAt(inkPt)) this.lift(t, "left_canvas", events, this.lastEmitted);

    // Pan drags bypass the filter (raw landmark mapped to target units).
    let movePoints: Vec2[] = [this.panning ? rawTarget : pointer];
    if (this.pen === "DRAWING" && this.dash.isActive) {
      const dev = this.dash.feed(pre, rawTarget, t, { pauseMs: this.dashPauseMs(), startR: this.rIn() / 2 });
      events.push(...dev);
      movePoints = [];
      const lastMove = [...dev].reverse().find((e) => e.type === "move" || e.type === "down");
      if (lastMove) this.lastEmitted = { x: lastMove.x, y: lastMove.y };
    } else if (this.pen === "DRAWING" && this.hatch.isActive) {
      // Hatch: the look-ahead buffer decides what is forwarded (moves, ups and downs). It works
      // on the pre-lazy-brush point so turning points are not shifted by the dead zone.
      const hev = this.hatch.feed(pre, t, {
        lagMs: this.settings.hatchLagMs,
        alternate: this.mode === "hatch_alternate",
        rIn: this.rIn(),
        gain: this.gain(),
        restJitterRMS: this.calibration?.restJitterRMS ?? 0,
      });
      events.push(...hev);
      movePoints = [];
      const lastMove = [...hev].reverse().find((e) => e.type === "move" || e.type === "down");
      if (lastMove) this.lastEmitted = { x: lastMove.x, y: lastMove.y };
    }
    for (const mp of movePoints) {
      if (!this.lastEmitted || mp.x !== this.lastEmitted.x || mp.y !== this.lastEmitted.y) {
        events.push({ type: "move", x: mp.x, y: mp.y });
        this.lastEmitted = { x: mp.x, y: mp.y };
      }
    }

    if (this.panning) this.batch.pan = true;
    const dwell = this.runDwell(t, pre, pointer, events);
    return this.output(t, { raw: sim, filtered, pre, pointer, events, dwell, upd, score });
  }

  tick(t: number): PipelineOutput {
    this.lastT = t;
    this.beginBatch();
    const upd = this.tracker.tick(t);
    return this.noFrame(t, upd, [], 0);
  }

  private noFrame(t: number, upd: TrackUpdate, events: PenEvent[], score: number): PipelineOutput {
    let pointer: Vec2 | null = null;
    if (upd.holding) {
      if (!this.frozen) this.frozen = medianRecent(this.pointerHist) ?? this.lastEmitted;
      pointer = this.frozen;
      if (pointer && (!this.lastEmitted || pointer.x !== this.lastEmitted.x || pointer.y !== this.lastEmitted.y)) {
        events.push({ type: "move", x: pointer.x, y: pointer.y });
        this.lastEmitted = { ...pointer };
      }
    }
    if (upd.becameLost) {
      this.lift(t, "tracking_lost", events, this.frozen ?? this.lastEmitted);
      this.euro.reset();
      this.lazy.reset();
      this.dwell.reset();
      this.frozen = null;
      this.wasLost = true;
    }
    this.dwell.cancel();
    return this.output(t, {
      raw: null,
      filtered: null,
      pre: null,
      pointer,
      events,
      dwell: IDLE_DWELL,
      upd,
      score,
    });
  }

  private runDwell(t: number, pre: Vec2, pointer: Vec2, events: PenEvent[]): DwellView {
    const rIn = this.rIn();
    if (this.rearm && t >= this.rearm.notBefore && this.rearm.anchor && dist(pre, this.rearm.anchor) > this.rearm.radius) {
      this.rearm = null;
    }
    if (this.pen === "DRAWING" && !this.upArmed && this.downAnchor && dist(pre, this.downAnchor) > rIn) {
      this.upArmed = true;
    }
    if (!this.settings.inputs.dwell) {
      this.dwell.update(t, pre, null);
      return { ...IDLE_DWELL, x: pointer.x, y: pointer.y };
    }
    const inCanvas = this.inkAllowedAt(pointer);
    let params: DwellParams | null = null;
    let kind: DwellView["kind"] = null;
    let gated = false;
    if (inCanvas && this.pen === "HOVER" && this.pickArmed) {
      // Pick: the next dwell inside the canvas is one sampling click.
      kind = "click";
      if (!this.rearm && t >= this.suppressClicksUntil) params = { kind, ms: this.settings.dwellDownMs, rIn, tight: false };
    } else if (inCanvas) {
      if (this.pen === "HOVER") {
        kind = "pen_down";
        if (!this.rearm) params = { kind, ms: this.settings.dwellDownMs, rIn, tight: false };
      } else {
        kind = "pen_up";
        const hatching = this.mode === "hatch" || this.mode === "hatch_alternate";
        if (this.upArmed && !this.settings.latch && !hatching) {
          params = { kind, ms: this.settings.dwellUpMs, rIn, tight: true };
        }
      }
    } else {
      kind = "click";
      const zoneOk = this.target === "canvas" ? true : clickZone(pointer, this.rects, this.phase) !== null;
      gated = !zoneOk || !this.settings.dwellClickEnabled || this.pinned;
      if (!gated && !this.rearm && t >= this.suppressClicksUntil) {
        params = { kind, ms: this.settings.dwellDownMs, rIn, tight: false };
      }
    }
    const r = this.dwell.update(t, pre, params);
    if (r.fired && params) {
      if (params.kind === "pen_down") {
        if (this.mode === "dots") {
          events.push({ type: "down", x: pointer.x, y: pointer.y }, { type: "up", x: pointer.x, y: pointer.y, reason: "dwell" });
          this.setRearm(t, REARM_AFTER_UP_MS, pre);
        } else {
          this.lower(t, pointer, events);
        }
      } else if (params.kind === "pen_up") {
        this.lift(t, "dwell", events, pointer);
      } else if (params.kind === "click" && this.pickArmed && inCanvas) {
        // Sampling click: Krita's sampler (target krita, via the helper) or the practice canvas.
        if (this.target === "canvas" || this.helperConnected) events.push({ type: "click", x: pointer.x, y: pointer.y });
        this.pickArmed = false;
        this.batch.pickSampled = true;
        this.setRearm(t, 0, pre);
      } else if (params.kind === "click") {
        if (this.helperConnected && this.target === "krita") events.push({ type: "click", x: pointer.x, y: pointer.y });
        this.setRearm(t, 0, pre);
      }
    }
    const a = r.anchor ?? pointer;
    return { kind, progress: r.progress, x: a.x, y: a.y, gated };
  }

  private pushTrail(arr: TimedPoint[], t: number, p: Vec2, keepMs = TRAIL_MS): void {
    arr.push({ t, x: p.x, y: p.y });
    while (arr.length && arr[0].t < t - keepMs) arr.shift();
  }

  private output(
    t: number,
    o: {
      raw: Vec2 | null;
      filtered: Vec2 | null;
      pre: Vec2 | null;
      pointer: Vec2 | null;
      events: PenEvent[];
      dwell: DwellView;
      upd: TrackUpdate;
      score: number;
    },
  ): PipelineOutput {
    this.trackInk(o.events);
    return {
      t,
      raw: o.raw,
      filtered: o.filtered,
      pre: o.pre,
      pointer: o.pointer,
      pen: this.pen,
      events: o.events,
      dwell: o.dwell,
      tracking: o.upd.word,
      reason: o.upd.reason,
      score: o.score,
      warmingUp: o.upd.warmingUp,
    };
  }

  // ---------------------------------------------------------------- actions

  action(id: string, t: number, opts: { variant?: string; arg?: number | null } = {}): PenEvent[] {
    const events: PenEvent[] = [];
    this.beginBatch();
    this.lastT = Math.max(this.lastT, t);
    const pointer = this.currentPointer();
    const def = ACTIONS_BY_ID[id];
    if (def?.modeChanging || id === "pause") this.suppressClicks(t);
    switch (id) {
      case "pen_toggle":
        if (this.pen === "DRAWING") {
          const wasHatching = this.hatch.isActive;
          // Pen key exits Hatch (§3).
          if (this.lift(t, "pen_key", events) && wasHatching) this.mode = "normal";
        }
        else if (pointer && this.tracker.phase === "tracking") this.lower(t, pointer, events);
        break;
      case "pen_down":
        if (pointer && this.tracker.phase === "tracking") this.lower(t, pointer, events);
        break;
      case "pen_up":
        this.lift(t, "voice", events);
        break;
      case "ptt":
      case "mic":
        this.lift(t, "ptt", events);
        break;
      case "pause": {
        const v = opts.variant ?? (this.paused ? "resume" : "pause");
        if (v === "pause") {
          this.lift(t, "pause", events);
          if (this.mode === "hatch" || this.mode === "hatch_alternate") this.mode = "normal";
          this.paused = true;
        } else {
          this.paused = false;
        }
        break;
      }
      case "latch":
        this.settings.latch = opts.variant === "on" ? true : opts.variant === "off" ? false : !this.settings.latch;
        break;
      case "recenter":
        this.lift(t, "mode_change", events);
        this.recenterAt = this.lastFiltered ? { ...this.lastFiltered } : null;
        this.lock.reset();
        this.lazy.reset();
        this.dwell.reset();
        this.setRearm(t, 0, null);
        break;
      case "steadier":
      case "looser": {
        if (this.lastSteadierT !== null && t - this.lastSteadierT < STEADIER_DEBOUNCE_MS) break;
        this.lastSteadierT = t;
        const d = id === "steadier" ? STEADIER_STEP : -STEADIER_STEP;
        this.settings.steadiness = clamp(this.settings.steadiness + d, 0, 100);
        this.radiusCap = null;
        this.preset = null;
        this.applySteadinessIfIdle();
        break;
      }
      case "smoothing_sketch":
      case "smoothing_ink":
      case "smoothing_shade": {
        // Applied at the next pen-up, like steadier/looser.
        const pr = SMOOTHING_PRESETS[id];
        this.settings.steadiness = pr.steadiness;
        this.radiusCap = pr.radiusCap;
        this.preset = pr.name;
        this.applySteadinessIfIdle();
        break;
      }
      case "eyebrow_raise":
        // Eyebrow pen-up (P4): can only lift, never lower.
        this.lift(t, "pen_key", events);
        break;
      case "head_mode": {
        this.lift(t, "mode_change", events);
        const on = opts.variant === "on" ? true : opts.variant === "off" ? false : !this.isHeadMode();
        this.setSettings(on ? headModeConfig() : handModeConfig());
        break;
      }
      case "rebaseline":
        // Measure a fresh 2 s window, then rescale (still never mid-stroke).
        this.rebaselineDue = true;
        this.scaleSamples = [];
        break;
      case "dash":
        this.lift(t, "mode_change", events);
        this.mode = this.mode === "dash" ? "normal" : "dash";
        break;
      case "repeat":
        this.stampRepeat(t, pointer, events);
        break;
      case "pan":
        this.lift(t, "mode_change", events);
        this.panArmed = !this.panArmed;
        break;
      case "pick":
        this.lift(t, "mode_change", events);
        this.pickArmed = true;
        break;
      case "simulate_tremor":
        this.settings.simulateTremor = !this.settings.simulateTremor;
        this.tremor.reset();
        break;
      case "dots":
        this.lift(t, "mode_change", events);
        this.mode = this.mode === "dots" ? "normal" : "dots";
        break;
      case "hatch":
      case "hatch_lr":
      case "hatch_down":
      case "hatch_alternate": {
        this.lift(t, "mode_change", events);
        const want: StrokeMode = id === "hatch_alternate" ? "hatch_alternate" : "hatch";
        if (id === "hatch" && this.mode === "hatch") {
          this.mode = "normal";
        } else {
          this.mode = want;
          this.hatch.setAxis(id === "hatch_lr" ? { x: 1, y: 0 } : id === "hatch_down" ? { x: 0, y: 1 } : null);
        }
        break;
      }
      case "stop_hatching":
        this.lift(t, "mode_change", events);
        if (this.mode === "hatch" || this.mode === "hatch_alternate") this.mode = "normal";
        break;
      case "brush":
        if (this.mode === "hatch" || this.mode === "hatch_alternate") {
          this.lift(t, "mode_change", events);
          this.mode = "normal";
        }
        break;
      case "other_hand":
      case "recalibrate":
      case "next_judge":
        this.lift(t, "mode_change", events);
        this.lock.reset();
        break;
      default:
        if (isHandPreset(id)) {
          const { tip: _tip, ...ps } = handPresetSettings(id);
          this.setSettings(ps as Partial<SteadySettings>);
        }
        break;
    }
    this.trackInk(events);
    return events;
  }

  private extra(): ExtraSettings {
    return this.settings as unknown as ExtraSettings;
  }

  private dashPauseMs(): number {
    const v = (this.settings as Partial<{ dashPauseMs: number }>).dashPauseMs;
    return typeof v === "number" && v > 0 ? v : DASH_PAUSE_DEFAULT_MS;
  }

  /** Repeat stroke: stamp a copy of the last stroke with its first point at the cursor. */
  private stampRepeat(t: number, cursor: Vec2 | null, events: PenEvent[]): void {
    if (this.pen === "DRAWING" || !cursor || !this.lastStroke || this.tracker.phase !== "tracking") return;
    const pts = offsetStroke(this.lastStroke, cursor);
    if (!this.inkAllowedAt(pts[0])) return;
    events.push({ type: "down", x: pts[0].x, y: pts[0].y });
    let last = pts[0];
    for (const q of pts.slice(1)) {
      if (!this.inkAllowedAt(q)) break; // ink stays inside the canvas rect
      events.push({ type: "move", x: q.x, y: q.y });
      last = q;
    }
    events.push({ type: "up", x: last.x, y: last.y, reason: "pen_key" });
    // The next frame moves the pointer back to the cursor (button up).
    this.lastEmitted = { ...last };
    this.setRearm(t, REARM_AFTER_UP_MS, this.lastPre);
  }

  private isHeadMode(): boolean {
    return (this.extra().lockLandmark ?? 0) !== 0;
  }

  /** Re-baseline: collect hand-scale samples; every 10 min (never mid-stroke) rescale the box. */
  private sampleScale(t: number, landmarks: { x: number; y: number; z: number }[]): void {
    const sc = handScale(landmarks, this.frameW, this.frameH);
    if (!(sc > 0)) return;
    this.scaleSamples.push({ t, x: sc, y: 0 });
    while (this.scaleSamples.length && this.scaleSamples[0].t < t - SCALE_SAMPLE_MS) this.scaleSamples.shift();
    const full = this.scaleSamples.length >= 5 && t - this.scaleSamples[0].t >= SCALE_SAMPLE_MS * 0.9;
    if (!full) return;
    const now = median(this.scaleSamples.map((p) => p.x));
    if (this.refScale === null) {
      this.refScale = now;
      this.lastRebaselineT = t;
      return;
    }
    const due = this.rebaselineDue || (this.lastRebaselineT !== null && t - this.lastRebaselineT >= REBASELINE_MS);
    if (!due || this.pen === "DRAWING") return; // never during a stroke: retried on the next frame
    this.boxScale = rebaselineScale(this.refScale, now, this.boxScale);
    this.lastRebaselineT = t;
    this.rebaselineDue = false;
  }

  private resetBaseline(): void {
    this.boxScale = 1;
    this.refScale = null;
    this.scaleSamples = [];
    this.lastRebaselineT = null;
    this.rebaselineDue = false;
  }

  private beginBatch(): void {
    this.batch = { pan: this.panning, pickSampled: false };
  }

  /** Record the inked path (any source: normal, Hatch, Dash, Dots, Repeat; not pan) for Repeat. */
  private trackInk(events: PenEvent[]): void {
    for (const e of events) {
      if (e.type === "down") {
        this.ink = { down: true, pts: [{ x: e.x, y: e.y }], pan: this.batch.pan };
      } else if (e.type === "move" && this.ink.down) {
        this.ink.pts.push({ x: e.x, y: e.y });
      } else if (e.type === "up" && this.ink.down) {
        if (!this.ink.pan && this.ink.pts.length) this.lastStroke = this.ink.pts;
        this.ink = { down: false, pts: [], pan: false };
      }
    }
  }

  modeState(): ModeState {
    return {
      panArmed: this.panArmed,
      panning: this.panning,
      batchIsPan: this.batch.pan,
      pickArmed: this.pickArmed,
      batchPickSampled: this.batch.pickSampled,
      preset: this.preset,
      lazyRadius: this.applied.lazyRadius,
      dashButtonDown: this.dash.isButtonDown,
      lastStroke: this.lastStroke ? this.lastStroke.map((p) => ({ ...p })) : null,
      boxScale: this.boxScale,
      headMode: this.isHeadMode(),
    };
  }

  setSettings(s: Partial<SteadySettings>): void {
    const prev = this.settings;
    this.settings = { ...prev, ...s, inputs: { ...prev.inputs, ...(s.inputs ?? {}) } };
    if (s.simulateTremor !== undefined && s.simulateTremor !== prev.simulateTremor) this.tremor.reset();
    if (s.steadiness !== undefined && s.steadiness !== prev.steadiness) {
      this.radiusCap = null;
      this.preset = null;
    }
    const geometryChanged =
      (s.landmark !== undefined && s.landmark !== prev.landmark) ||
      (s.mirrorCamera !== undefined && s.mirrorCamera !== prev.mirrorCamera) ||
      (s.rotateCamera !== undefined && s.rotateCamera !== prev.rotateCamera) ||
      ((s as ExtraSettings).lockLandmark !== undefined &&
        (s as ExtraSettings).lockLandmark !== (prev as unknown as ExtraSettings).lockLandmark);
    if (geometryChanged) {
      // The tracked point jumps: lift, restart the filter and the warm-up gate. The lift
      // event is delivered with the next frame's events via pendingEvents.
      this.pendingLift = true;
      this.lock.reset();
      this.resetBaseline(); // a different landmark set has a different scale
    }
    this.applySteadinessIfIdle();
  }

  private pendingLift = false;
  /** The pre-point is pinned at a clamp edge (screen, or Chrome's rect while paused): no dwell-click. */
  private pinned = false;

  setCalibration(c: Calibration | null): void {
    this.calibration = c;
    this.recenterAt = null;
    this.resetBaseline();
    this.lazy.reset();
    this.lock.reset();
  }

  setRects(r: Partial<PipelineRects>): void {
    this.rects = { ...this.rects, ...r };
  }

  setTarget(target: Target): PenEvent[] {
    const events: PenEvent[] = [];
    this.beginBatch();
    if (target === this.target) return events;
    this.lift(this.lastT, "mode_change", events);
    this.target = target;
    this.lazy.reset();
    this.dwell.reset();
    this.suppressClicks(this.lastT);
    this.setRearm(this.lastT, 0, null);
    this.trackInk(events);
    return events;
  }

  setHelperConnected(connected: boolean): void {
    this.helperConnected = connected;
  }

  snapshot() {
    return {
      pen: this.pen,
      paused: this.paused,
      latch: this.settings.latch,
      mode: this.mode,
      steadiness: this.settings.steadiness,
      gain: this.gain(),
      deviationPx: this.deviation(),
      rawTrail: this.rawTrail.filter((p) => p.t >= this.lastT - TRAIL_MS).map((p) => ({ x: p.x, y: p.y })),
      lastStrokeMs: this.lastStrokeMs,
    };
  }

  /**
   * Live deviation (target units): RMS distance of the drawn (smoothed) path from its own
   * ±100 ms moving average over the last 3 s, i.e. how much shake survives smoothing.
   * Drops as Steadiness rises. null when fewer than 5 points.
   */
  private deviation(): number | null {
    const pts = this.smoothTrail.filter((p) => p.t >= this.lastT - TRAIL_MS);
    if (pts.length < 5) return null;
    let sum = 0;
    let j0 = 0;
    for (let i = 0; i < pts.length; i++) {
      while (pts[j0].t < pts[i].t - DEVIATION_HALF_WINDOW_MS) j0++;
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (let j = j0; j < pts.length && pts[j].t <= pts[i].t + DEVIATION_HALF_WINDOW_MS; j++) {
        cx += pts[j].x;
        cy += pts[j].y;
        n++;
      }
      sum += (pts[i].x - cx / n) ** 2 + (pts[i].y - cy / n) ** 2;
    }
    return Math.sqrt(sum / pts.length);
  }
}

export function createPipeline(config: PipelineConfig, opts: PipelineOptions = {}): Pipeline {
  return new SteadyPipeline(config, opts);
}

/** P3 mode state of a pipeline made by createPipeline (null for any other Pipeline). */
export function modeState(p: Pipeline): ModeState | null {
  return p instanceof SteadyPipeline ? p.modeState() : null;
}

/** Pan helper for the Worker: true when the last returned events must use the MIDDLE button. */
export function panState(p: Pipeline): { armed: boolean; active: boolean; batchIsPan: boolean } {
  const m = modeState(p);
  return { armed: m?.panArmed ?? false, active: m?.panning ?? false, batchIsPan: m?.batchIsPan ?? false };
}

export { rectCenter };
