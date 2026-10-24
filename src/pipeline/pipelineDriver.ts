/**
 * Test driver for the pipeline (Vitest only; not imported by production code).
 * Feeds 30 fps frames for a path given in TARGET units (inverted through the active box).
 */
import type { Phase } from "../actions";
import { createPipeline } from "./pipeline";
import { frame, hand } from "./testSignals";
import {
  DEFAULT_SETTINGS,
  type Calibration,
  type PenEvent,
  type Pipeline,
  type PipelineOutput,
  type PipelineRects,
  type SteadySettings,
  type Target,
  type Vec2,
} from "./types";

export const TEST_CAL: Calibration = {
  restJitterRMS: 0.5,
  kineticJitterRMS: 1,
  box: { x: 220, y: 165, w: 200, h: 150 }, // centre (320, 240)
  gain: 4,
  handedness: "Right",
  flipX: false,
  flipY: false,
  suggestedSteadiness: 10,
  createdAt: 0,
};

export interface DriverOptions {
  target?: Target;
  rects?: Partial<PipelineRects>;
  settings?: Partial<SteadySettings>;
  calibration?: Calibration | null;
  helperConnected?: boolean;
  phase?: Phase;
  fps?: number;
}

export class Driver {
  pl: Pipeline;
  t = 0;
  fps: number;
  outs: PipelineOutput[] = [];
  events: Array<PenEvent & { t: number }> = [];
  cal: Calibration;
  targetCentre: Vec2;

  constructor(o: DriverOptions = {}) {
    const rects: PipelineRects = {
      canvas: { x: 0, y: 0, w: 1000, h: 800 },
      chrome: null,
      krita: null,
      screen: null,
      ...o.rects,
    };
    this.cal = o.calibration === undefined ? TEST_CAL : (o.calibration ?? TEST_CAL);
    const tr = rects.canvas ?? rects.screen ?? { x: 0, y: 0, w: 1280, h: 800 };
    this.targetCentre = { x: tr.x + tr.w / 2, y: tr.y + tr.h / 2 };
    this.fps = o.fps ?? 30;
    this.pl = createPipeline(
      {
        settings: { ...DEFAULT_SETTINGS, ...o.settings },
        calibration: o.calibration === undefined ? TEST_CAL : o.calibration,
        target: o.target ?? "canvas",
        rects,
        helperConnected: o.helperConnected ?? false,
        seed: 7,
      },
      { phase: o.phase ?? "P1" },
    );
  }

  /** Target units → camera px through the calibrated box. */
  cam(p: Vec2): Vec2 {
    const g = this.cal.gain;
    return { x: 320 + (p.x - this.targetCentre.x) / g, y: 240 + (p.y - this.targetCentre.y) / g };
  }

  private record(out: PipelineOutput): PipelineOutput {
    this.outs.push(out);
    for (const e of out.events) this.events.push({ ...e, t: out.t });
    return out;
  }

  /** One frame with the hand at target point p. */
  frameAt(p: Vec2, opts: { score?: number; extraHands?: ReturnType<typeof hand>[]; wristCam?: Vec2 } = {}): PipelineOutput {
    const c = this.cam(p);
    const h = hand(c, { score: opts.score ?? 0.9, wrist: opts.wristCam });
    const out = this.pl.step(frame(this.t, [...(opts.extraHands ?? []), h]));
    this.t += 1000 / this.fps;
    return this.record(out);
  }

  /** Frames following f(elapsedMs) → target point, for `ms`. */
  path(ms: number, f: (elapsed: number) => Vec2, opts: { score?: number } = {}): PipelineOutput[] {
    const outs: PipelineOutput[] = [];
    const t0 = this.t;
    while (this.t - t0 < ms) outs.push(this.frameAt(f(this.t - t0), opts));
    return outs;
  }

  hold(p: Vec2, ms: number, opts: { score?: number; jitter?: number } = {}): PipelineOutput[] {
    const j = opts.jitter ?? 0;
    return this.path(ms, (e) => ({ x: p.x + j * Math.sin(2 * Math.PI * 6 * (e / 1000)), y: p.y + j * Math.cos(2 * Math.PI * 5 * (e / 1000)) }), opts);
  }

  /** Frames with no hand at all. */
  empty(ms: number): PipelineOutput[] {
    const outs: PipelineOutput[] = [];
    const t0 = this.t;
    while (this.t - t0 < ms) {
      outs.push(this.record(this.pl.step(frame(this.t, []))));
      this.t += 1000 / this.fps;
    }
    return outs;
  }

  action(id: string, opts?: { variant?: string; arg?: number | null }): PenEvent[] {
    const ev = this.pl.action(id, this.t, opts);
    for (const e of ev) this.events.push({ ...e, t: this.t });
    return ev;
  }

  count(type: PenEvent["type"]): number {
    return this.events.filter((e) => e.type === type).length;
  }

  get last(): PipelineOutput {
    return this.outs[this.outs.length - 1];
  }
}
