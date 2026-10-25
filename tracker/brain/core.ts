/**
 * Steady brain core (agent B): the old Worker + page dispatcher with all I/O removed.
 *
 * `createBrain(send)` returns an object whose `handle(msg)` takes one ToBrain message
 * (tracker/brain/protocol.ts) and calls `send` with zero or more FromBrain messages. Pure apart
 * from `Date.now()` for Calibration.createdAt; every other time comes from the messages
 * (`frame.frame.t`, `tick.now`, `action.now`, ... must all share the tracker's monotonic ms clock).
 *
 * Never throws out of `handle`: each message is wrapped; on an internal error the brain lifts the
 * pen first (pipeline force-lift, then a raw `up` if the button is still believed held) and emits
 * `error`.
 */
import { ACTIONS_BY_ID, HOTKEY_TO_ACTION, type Action } from "../../src/actions";
import { buildLookups, kritaConnectMessages, kritaMessageFor, type KritaOutMsg } from "../../src/desktop/krita";
import type { KritaCommand } from "../../src/desktop/protocol";
import { createCalibrator, mirrorCalibration, type StepCalibrator } from "../../src/pipeline/calibration";
import { parseCommand, validateAlias } from "../../src/pipeline/grammar";
import { createPipeline, forceLift as pipelineForceLift, modeState, panState, setCalibrating } from "../../src/pipeline/pipeline";
import { handPresetSettings, isHandPreset, type ExtraSettings } from "../../src/pipeline/presets";
import { parseProfiles, saveProfile, useProfile as profileFromStore, type ProfileStore } from "../../src/pipeline/profiles";
import {
  DEFAULT_SETTINGS,
  MENU_BAR_PT,
  STEADIER_STEP,
  type Calibration,
  type LandmarkFrame,
  type LiftReason,
  type MirrorState,
  type PenEvent,
  type Pipeline,
  type PipelineOutput,
  type PipelineRects,
  type Rect,
  type SteadySettings,
  type StrokeMode,
} from "../../src/pipeline/types";
import type { FromBrain, PanelState, ToBrain } from "./protocol";

export const BRAIN_VERSION = "steady-brain 0.1.0";

/** Brain-only keys carried inside `settings` (see DECISIONS.md, Agent B (brain)). */
export interface BrainExtras {
  /** User aliases: word → Krita preset name ("call this brush fluffy"). Persist to aliases.json. */
  aliases?: Record<string, string>;
  /** Profiles store (src/pipeline/profiles.ts). Persist to profiles.json. */
  profiles?: ProfileStore;
  /** Saved skin swatch "#rrggbb" ("save skin"). */
  skinHex?: string | null;
}
export type BrainSettings = SteadySettings & ExtraSettings & BrainExtras;

type Hand = "Left" | "Right";
type WireEvent = Extract<FromBrain, { t: "pen" }>["events"][number];
type Source = Extract<ToBrain, { t: "action" }>["source"];

export interface BrainOptions {
  version?: string;
  /** stderr logger (never stdout). */
  log?: (text: string) => void;
  /** Called after `shutdown` has lifted the pen and emitted its last messages. */
  onShutdown?: () => void;
}

export interface Brain {
  handle(msg: unknown): void;
  /** Lift the pen now (uncaught-exception path of the entry point). Never throws. */
  emergencyLift(why: string): void;
  readonly shutDown: boolean;
}

// ----------------------------------------------------------------------------- constants
const STATE_MIN_MS = 1000 / 15; // ≤ 15 Hz
const TRAIL_MAX = 90;
const KRITA_TIMEOUT_MS = 3000;
const TICK_LOSS_GAP_MS = 100; // pipeline.tick only when frames have stopped (Worker behaviour)
const UNDO_SPACING_MS = 50;
const UNDO_MAX = 20;
const STEADIER_DEBOUNCE_MS = 1000;
const DIALOG_PREFIX = "b-dlg-";
const BRAIN_ONLY_KEYS = ["aliases", "profiles", "skinHex"] as const;

/** Actions the pipeline runs itself (same set the page posted to the Worker). */
const PIPELINE_ACTIONS = new Set([
  "pen_toggle",
  "pen_down",
  "pen_up",
  "pause",
  "latch",
  "recenter",
  "dots",
  "hatch",
  "hatch_lr",
  "hatch_down",
  "hatch_alternate",
  "stop_hatching",
  "brush",
  "dash",
  "repeat",
  "pan",
  "pick",
  "line",
]);

/** Not available in the plugin build: the action answers with a status line. */
const UNSUPPORTED: Record<string, string> = {
  head_mode: "Head mode isn't in the Krita panel yet. Track your hand.",
  eyebrow_lift: "Eyebrow lift isn't in the Krita panel yet.",
  pick_sticker_colour: "The colour sticker isn't in the Krita panel yet.",
  lock_exposure: "Exposure lock isn't in the Krita panel yet.",
  clear_practice: "There is no practice canvas in the Krita panel.",
  app_profile: "The Krita panel always drives Krita.",
};

const RELEASE_TEXT: Record<string, string> = {
  watchdog: "the pointer lost contact for 300 ms",
  pause: "paused",
  hotkey: "pen key",
  ptt: "push-to-talk",
  exception: "tracker error",
  other: "tracker",
};

const DIALOG_ACTIONS = new Set(["yes", "no", "cancel", "choice_one", "choice_two", "choice_three"]);

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const inRect = (r: Rect | null | undefined, x: number, y: number) => !!r && x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
const isRect = (v: unknown): v is Rect =>
  !!v && typeof v === "object" && ["x", "y", "w", "h"].every((k) => typeof (v as Record<string, unknown>)[k] === "number");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function lostReasonText(r: MirrorState["reason"]): string {
  switch (r) {
    case "too_dark":
      return "Tracking lost: too dark. Add light on the desk.";
    case "low_fps":
      return "Tracking lost: the camera is too slow.";
    case "outside_area":
      return "Hand outside the tracked area: say recenter or press F5.";
    default:
      return "Tracking lost: no hand in view.";
  }
}

function modeText(mode: StrokeMode, hatchLagMs: number): string {
  switch (mode) {
    case "hatch":
    case "hatch_alternate":
      return `Hatch: forward passes only (lag ${hatchLagMs} ms).`;
    case "dots":
      return "Dots: each hold stamps one dot.";
    case "dash":
      return "Dash: ink only while moving.";
    default:
      return "Normal strokes.";
  }
}

type PendingKind =
  | { kind: "connect"; cmd: string }
  | { kind: "action"; action: Action; arg: number | null | undefined }
  | { kind: "name_brush"; word: string }
  | { kind: "numbers" }
  | { kind: "alias"; preset: string };

interface NumberItem {
  n: number;
  label: string;
  rect: Rect;
}

// ----------------------------------------------------------------------------- brain
export function createBrain(send: (m: FromBrain) => void, opts: BrainOptions = {}): Brain {
  const log = opts.log ?? (() => undefined);

  let settings: BrainSettings = { ...DEFAULT_SETTINGS };
  let calibration: Calibration | null = null;
  const calibrations: Partial<Record<Hand, Calibration>> = {};
  let rects: PipelineRects = { canvas: null, chrome: null, krita: null, screen: null, usable: null };
  let pipeline: Pipeline = makePipeline();
  let initialised = false;
  let shutDown = false;

  let clock = 0;
  let last: PipelineOutput | null = null;
  let lastFrameT: number | null = null;
  const frameStamps: number[] = [];
  let cameraFps: number | null = null;
  let lastTracking: MirrorState["tracking"] | null = null;
  let everTracked = false;

  let calibrator: StepCalibrator | null = null;
  let calibratorSteps: Array<1 | 2 | 3> = [];
  let lastCalibProgress = 0;
  let lastCalibStep: number | null = null;

  let kritaConnected = false;
  let lookups: Record<string, string> = {};
  let presets: string[] = [];
  const pending = new Map<string, PendingKind & { at: number }>();
  let smoothingNoticeShown = false;
  let idSeq = 0;

  let numbers: NumberItem[] | null = null;
  let dialog: { id: string; text: string; onConfirm: () => void } | null = null;
  let dialogSeq = 0;
  let micOpen = false;
  let undoLabel: string | null = null;
  let lastSteadierAt = -Infinity;
  const tipsShown = new Set<string>();
  let profiles: ProfileStore = parseProfiles(null);

  /** What the tracker's pointer holds, mirrored from the events we sent. */
  let held: null | "left" | "middle" = null;
  let lastPos: { x: number; y: number } | null = null;

  let currentAlert = "";
  let lastStateKey = "";
  let lastState: PanelState | null = null;
  let lastStateAt = -Infinity;

  const tasks: Array<{ at: number; run: () => void }> = [];

  // --------------------------------------------------------------------------- basics
  function makePipeline(): Pipeline {
    return createPipeline({
      settings: pipelineSettings(settings),
      calibration,
      target: "krita",
      rects,
      helperConnected: true, // the tracker's pointer performs every dwell-click
    });
  }

  function pipelineSettings(s: Partial<BrainSettings>): Partial<SteadySettings> & SteadySettings {
    const copy = { ...s } as Record<string, unknown>;
    for (const k of BRAIN_ONLY_KEYS) delete copy[k];
    delete copy.headMode;
    delete copy.eyebrowLift;
    return copy as unknown as SteadySettings;
  }

  function nextId(prefix = "b"): string {
    idSeq += 1;
    return `${prefix}${idSeq}`;
  }

  function status(text: string, level: "status" | "alert" = "status") {
    if (level === "alert") currentAlert = text;
    send({ t: "status", text, level });
  }

  /** Persistent alert, deduplicated (not overwritten by routine status). */
  function alert(text: string) {
    if (text === currentAlert) return;
    status(text, "alert");
  }

  function clearAlert() {
    if (!currentAlert) return;
    currentAlert = "";
    send({ t: "status", text: "", level: "alert" });
  }

  function speak(text: string) {
    if (settings.quiet || !settings.tts || settings.inputs?.voice === false) return;
    send({ t: "speak", text });
  }

  function actT(): number {
    return Math.max(clock, last?.t ?? 0);
  }

  function changeSettings(patch: Partial<BrainSettings>, opts2: { emit?: boolean } = {}) {
    settings = {
      ...settings,
      ...patch,
      inputs: { ...settings.inputs, ...(patch.inputs ?? {}) },
    };
    pipeline.setSettings(pipelineSettings(patch));
    if (opts2.emit !== false) send({ t: "settings_changed", settings: patch as Partial<SteadySettings> });
  }

  // --------------------------------------------------------------------------- pen events
  function clickAllowed(x: number, y: number): boolean {
    const top = rects.screen?.y ?? 0;
    if (y < top + MENU_BAR_PT) return false;
    if (rects.usable && !inRect(rects.usable, x, y)) return false;
    return true;
  }

  /** Pipeline events → wire events (move before every down; pan → middle button). */
  function emitPen(events: PenEvent[], pan: boolean) {
    const out: WireEvent[] = [];
    for (const e of events) {
      const x = r1(e.x);
      const y = r1(e.y);
      if (e.type === "move") {
        out.push({ type: "move", x, y });
      } else if (e.type === "down") {
        if (held) continue; // never press twice
        const prev = out[out.length - 1];
        if (!(prev && prev.type === "move" && prev.x === x && prev.y === y)) out.push({ type: "move", x, y });
        if (pan) {
          out.push({ type: "middle_down", x, y });
          held = "middle";
        } else {
          out.push({ type: "down", x, y });
          held = "left";
        }
      } else if (e.type === "up") {
        if (held === "middle") out.push({ type: "middle_up", x, y });
        else out.push({ type: "up", x, y, reason: e.reason });
        held = null;
      } else if (e.type === "click") {
        if (!clickAllowed(x, y)) continue;
        out.push({ type: "move", x: Math.round(x), y: Math.round(y) }, { type: "click", x: Math.round(x), y: Math.round(y) });
      }
      lastPos = { x, y };
    }
    if (out.length) send({ t: "pen", events: out });
  }

  /** Forward the events of the pipeline call that just returned. */
  function forward(events: PenEvent[]) {
    const pan = panState(pipeline).batchIsPan;
    emitPen(events, pan);
    const ms = modeState(pipeline);
    if (ms?.batchPickSampled) {
      status("Colour picked. Back to the brush.");
      kritaDispatch(ACTIONS_BY_ID.brush);
    }
  }

  /** Safety lift without the 80 ms user-lift guard. Returns true when the pen was down. */
  function forceLiftNow(reason: LiftReason): boolean {
    let wasDrawing = false;
    try {
      if (pipeline.snapshot().pen === "DRAWING") {
        wasDrawing = true;
        forward(pipelineForceLift(pipeline, reason, actT()));
      }
    } finally {
      rawRelease(reason);
    }
    return wasDrawing;
  }

  /** If the tracker still holds a button by our account, release it directly. */
  function rawRelease(reason: LiftReason) {
    if (!held) return;
    const p = lastPos ?? { x: 0, y: 0 };
    const ev: WireEvent = held === "middle" ? { type: "middle_up", x: p.x, y: p.y } : { type: "up", x: p.x, y: p.y, reason };
    held = null;
    send({ t: "pen", events: [ev] });
  }

  // --------------------------------------------------------------------------- state
  function trail(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
    const ox = rects.canvas?.x ?? 0;
    const oy = rects.canvas?.y ?? 0;
    const step = Math.max(1, Math.ceil(points.length / TRAIL_MAX));
    const out: Array<{ x: number; y: number }> = [];
    for (let i = points.length - 1; i >= 0 && out.length < TRAIL_MAX; i -= step) out.push({ x: r1(points[i].x - ox), y: r1(points[i].y - oy) });
    return out.reverse();
  }

  function panelState(): PanelState {
    const snap = pipeline.snapshot();
    const o = last;
    const det = frameStamps.length;
    return {
      pen: snap.pen,
      tracking: o?.tracking ?? "Lost",
      reason: o?.reason ?? "no_hand",
      paused: snap.paused,
      latch: snap.latch,
      mode: snap.mode,
      steadiness: snap.steadiness,
      gain: r2(snap.gain),
      calibrated: !!calibration,
      calibrating:
        calibrator && calibrator.step ? { step: calibrator.step, progress: r2(lastCalibProgress), prompt: calibrator.prompt } : null,
      cameraFps: cameraFps ?? det,
      detectionFps: det,
      kritaConnected,
      micOpen,
      quiet: !!settings.quiet,
      deviationPx: snap.deviationPx == null ? null : r1(snap.deviationPx),
      rawTrail: trail(snap.rawTrail),
      undoLabel,
      settings: settings as SteadySettings,
    };
  }

  /** ≤ 15 Hz and only on change; pen / pause / mic / Krita / calibrating changes go out at once. */
  function maybeState(force = false) {
    const s = panelState();
    const key = JSON.stringify(s);
    if (key === lastStateKey && !force) return;
    const p = lastState;
    const urgent =
      force ||
      !p ||
      p.pen !== s.pen ||
      p.paused !== s.paused ||
      p.micOpen !== s.micOpen ||
      p.kritaConnected !== s.kritaConnected ||
      (p.calibrating === null) !== (s.calibrating === null) ||
      p.tracking !== s.tracking;
    if (!urgent && clock - lastStateAt < STATE_MIN_MS) return;
    lastStateKey = key;
    lastState = s;
    lastStateAt = clock;
    send({ t: "state", state: s });
  }

  // --------------------------------------------------------------------------- frames
  function onFrame(frame: LandmarkFrame, camFps?: unknown) {
    if (!frame || typeof frame.t !== "number" || !Array.isArray(frame.hands)) throw new Error("frame: bad LandmarkFrame");
    if (!initialised) return;
    if (settings.inputs?.camera === false) return;
    if (last && frame.t <= last.t) return; // stale / out of order
    clock = Math.max(clock, frame.t);
    if (typeof camFps === "number" && Number.isFinite(camFps)) cameraFps = Math.round(camFps);
    lastFrameT = frame.t;
    frameStamps.push(frame.t);
    while (frameStamps.length && frameStamps[0] < frame.t - 1000) frameStamps.shift();
    handleOutput(pipeline.step(frame), frame);
  }

  function handleOutput(out: PipelineOutput, frame: LandmarkFrame | null) {
    last = out;
    if (calibrator && frame) feedCalibrator(out, frame);

    if (out.tracking !== lastTracking) {
      if (out.tracking === "Lost" && everTracked) alert(lostReasonText(out.reason));
      else if (lastTracking === "Lost" && out.tracking !== "Lost" && everTracked) {
        if (currentAlert.startsWith("Tracking lost") || currentAlert.startsWith("Hand outside") || currentAlert.startsWith("Pen lifted"))
          clearAlert();
        status("Tracking back. Pen is up.");
      }
      if (out.tracking !== "Lost") everTracked = true;
      lastTracking = out.tracking;
    }
    for (const e of out.events) {
      if (e.type === "up" && e.reason === "tracking_lost") alert("Pen lifted: tracking lost mid-stroke.");
      if (e.type === "up" && e.reason === "left_canvas") status("Pen lifted: the pointer left the canvas.");
    }
    forward(out.events);
    maybeState();
  }

  function feedCalibrator(out: PipelineOutput, frame: LandmarkFrame) {
    if (!calibrator) return;
    const hand = frame.hands[0];
    const ok = !!hand && hand.score >= 0.6;
    lastCalibProgress = calibrator.feed(out.t, out.raw, out.filtered, ok ? hand.handedness : null);
    if (ok) calibrator.recordHand(hand.landmarks, frame.width, frame.height);
    if (calibrator.step && calibrator.step !== lastCalibStep) {
      lastCalibStep = calibrator.step;
      status(`Step ${calibratorSteps.indexOf(calibrator.step) + 1} of ${calibratorSteps.length}: ${calibrator.prompt}`);
    }
    const res = calibrator.result();
    if (!res) return;
    calibrator = null;
    setCalibrating(pipeline, false);
    useCalibration(res, false);
    send({ t: "calibration", calibration: res });
    const flips = [res.flipX ? "left-right" : null, res.flipY ? "up-down" : null].filter(Boolean);
    const flipText = flips.length ? ` I flipped ${flips.join(" and ")} to match your hand.` : "";
    // Never auto-change Steadiness: show the suggestion only.
    status(
      `Calibration done.${flipText} Suggested Steadiness: ${res.suggestedSteadiness} (now ${settings.steadiness}). Use the slider or say steadier / looser.`,
    );
  }

  function useCalibration(c: Calibration, emit: boolean) {
    calibration = c;
    calibrations[c.handedness] = c;
    pipeline.setCalibration(c);
    if (emit) send({ t: "calibration", calibration: c });
  }

  function startCalibration(steps: Array<1 | 2 | 3>, prior: Calibration | null = calibration) {
    const allowed = (steps.length ? steps : [1, 2, 3]).filter((s) => s === 1 || s === 2 || s === 3) as Array<1 | 2 | 3>;
    calibratorSteps = [...new Set(allowed)].sort() as Array<1 | 2 | 3>;
    const target = rects.canvas ?? rects.screen ?? { x: 0, y: 0, w: 1280, h: 800 };
    setCalibrating(pipeline, true);
    calibrator = createCalibrator({ steps: calibratorSteps, targetWidth: target.w, prior, now: Date.now() });
    lastCalibProgress = 0;
    lastCalibStep = null;
    if (calibrator.step) {
      lastCalibStep = calibrator.step;
      status(`Step 1 of ${calibratorSteps.length}: ${calibrator.prompt}`);
    }
    maybeState(true);
  }

  // --------------------------------------------------------------------------- tick
  function onTick(now: number) {
    clock = Math.max(clock, now);
    runDue();
    if (initialised && lastFrameT !== null && clock - lastFrameT > TICK_LOSS_GAP_MS && clock > (last?.t ?? -Infinity)) {
      handleOutput(pipeline.tick(clock), null);
    }
    for (const [id, p] of pending) {
      if (clock - p.at < KRITA_TIMEOUT_MS) continue;
      pending.delete(id);
      if (p.kind === "connect") {
        if (p.cmd === "canvas_rect" && !rects.canvas) status("Krita's canvas was not found. Open a document in Krita.");
      } else status("Krita did not answer.");
    }
    while (frameStamps.length && frameStamps[0] < clock - 1000) frameStamps.shift();
    maybeState();
  }

  function schedule(at: number, run: () => void) {
    tasks.push({ at, run });
    tasks.sort((a, b) => a.at - b.at);
  }

  function runDue() {
    while (tasks.length && tasks[0].at <= clock) {
      const task = tasks.shift()!;
      task.run();
    }
  }

  // --------------------------------------------------------------------------- Krita
  function sendKrita(msg: KritaOutMsg, p: PendingKind | null): string {
    const id = nextId();
    if (msg.t === "keys") {
      send({ t: "keys", id, combo: msg.combo });
      return id;
    }
    const { t: _t, fallback_keys, ...cmd } = msg as KritaOutMsg & { fallback_keys?: string };
    void _t;
    send({ t: "krita", id, cmd: cmd as KritaCommand, ...(fallback_keys ? { fallback_keys } : {}) });
    if (p) pending.set(id, { ...p, at: clock });
    return id;
  }

  function sendKritaCmd(cmd: KritaCommand, p: PendingKind | null): string {
    return sendKrita({ t: "krita", ...cmd } as KritaOutMsg, p);
  }

  function kritaDispatch(a: Action, arg?: number | null) {
    const built = kritaMessageFor(a, { arg, pluginConnected: kritaConnected, lookups, skinHex: settings.skinHex ?? null });
    if ("error" in built) {
      status(
        built.error === "needs_plugin"
          ? "That needs the Krita plugin."
          : built.error === "no_skin"
            ? "Pick a colour, then say save skin."
            : `${a.label} is not available in Krita.`,
      );
      return;
    }
    sendKrita(built.msg, { kind: "action", action: a, arg });
    if (a.id !== "undo" && a.id !== "redo" && a.id !== "save_skin") undoLabel = a.label;
  }

  function onKritaConnected(connected: boolean) {
    const was = kritaConnected;
    kritaConnected = connected;
    if (connected && !was) {
      for (const m of kritaConnectMessages()) {
        const cmd = m.t === "krita" ? (m as { cmd: string }).cmd : "keys";
        sendKrita(m, { kind: "connect", cmd });
      }
      status("Krita plugin connected.");
    } else if (!connected && was) {
      if (numbers) hideNumbers(null);
      status("Krita plugin disconnected: keystroke fallbacks only.");
    }
    maybeState(true);
  }

  function onKritaReply(data: Record<string, unknown>) {
    if (!smoothingNoticeShown && data.smoothing_changed === true) {
      smoothingNoticeShown = true;
      status("Krita's brush smoothing set to None — Steady does the smoothing");
    }
    if (Array.isArray(data.actions)) lookups = buildLookups(data.actions as Array<{ id: string; text: string }>);
    if (Array.isArray(data.presets)) presets = (data.presets as unknown[]).filter((p): p is string => typeof p === "string");
    const id = typeof data.id === "string" ? data.id : null;
    const p = id ? pending.get(id) : undefined;
    if (!id || !p) return;
    pending.delete(id);
    const ok = data.ok !== false;
    const error = typeof data.error === "string" ? data.error : undefined;
    const failText = () =>
      error === "plugin_down" ? "That needs the Krita plugin." : error === "krita_not_running" ? "Krita is not running." : `Krita: ${error ?? "failed"}`;
    switch (p.kind) {
      case "connect":
        if (p.cmd === "canvas_rect") {
          if (ok && isRect(data.rect)) setRects({ canvas: data.rect });
          else if (!rects.canvas) status("Krita's canvas was not found. Open a document in Krita.");
        }
        return;
      case "action": {
        if (!ok) {
          status(failText());
          return;
        }
        const a = p.action;
        if (a.id === "save_skin") {
          if (typeof data.color === "string") {
            changeSettings({ skinHex: data.color });
            status("Skin colour saved.");
            speak("Skin colour saved");
          } else status("Krita did not say the colour.");
        } else if (a.id === "save") {
          status("Saved.");
          speak("Saved");
        } else if (a.id === "new_layer") speak("New layer");
        return;
      }
      case "name_brush": {
        const preset = ok ? data.preset : null;
        if (typeof preset !== "string" || !preset) {
          status(ok ? "Krita did not say which brush is active." : failText());
          return;
        }
        const aliases = { ...(settings.aliases ?? {}), [p.word]: preset };
        changeSettings({ aliases });
        status(`Say ${p.word} to pick ${preset}.`);
        speak("Brush named");
        return;
      }
      case "numbers": {
        const widgets = ok && Array.isArray(data.widgets) ? (data.widgets as unknown[]).filter(isNumberItem) : [];
        if (!widgets.length) {
          status(ok ? "Krita listed no buttons to number." : error === "plugin_down" ? "Show numbers needs the Krita plugin." : failText());
          return;
        }
        numbers = widgets;
        const list = widgets
          .slice(0, 40)
          .map((w) => `${w.n} ${w.label}`)
          .join(", ");
        status(`Numbers: ${list}${widgets.length > 40 ? ", …" : ""}. Say click and a number.`);
        return;
      }
      case "alias":
        if (!ok) status(failText());
        else undoLabel = p.preset;
        return;
    }
  }

  function isNumberItem(v: unknown): v is NumberItem {
    const o = v as Record<string, unknown>;
    return !!o && typeof o.n === "number" && typeof o.label === "string" && isRect(o.rect);
  }

  function hideNumbers(why: string | null) {
    const had = numbers !== null;
    numbers = null;
    if (why && had) status(why);
  }

  function clickNumber(n: number) {
    const item = numbers?.find((i) => i.n === n);
    if (!item) {
      status(numbers ? `No number ${n}.` : "Show numbers first.");
      return;
    }
    if (pipeline.snapshot().paused) {
      status("Paused: resume to click in Krita.");
      return;
    }
    const x = Math.round(item.rect.x + item.rect.w / 2);
    const y = Math.round(item.rect.y + item.rect.h / 2);
    const top = rects.screen?.y ?? 0;
    if (y < top + MENU_BAR_PT || (rects.krita && !inRect(rects.krita, x, y)) || (rects.usable && !inRect(rects.usable, x, y))) {
      status(`Number ${n} is outside Krita's window.`);
      return;
    }
    forceLiftNow("mode_change");
    emitPen([{ type: "click", x, y }], false);
    undoLabel = item.label;
    status(`Clicked ${n}: ${item.label}.`);
  }

  function nameBrush(wordIn: string) {
    const word = wordIn.trim().toLowerCase();
    if (!word || /\s/.test(word)) {
      status("Use one word for the brush name.");
      return;
    }
    if (validateAlias(word) === "taken") {
      status("That word is taken.");
      speak("That word is taken");
      return;
    }
    if (!kritaConnected) {
      status("Naming a brush needs the Krita plugin.");
      return;
    }
    sendKritaCmd({ cmd: "get_state" }, { kind: "name_brush", word });
  }

  // --------------------------------------------------------------------------- dialogs
  function openConfirm(text: string, onConfirm: () => void) {
    dialogSeq += 1;
    const id = `${DIALOG_PREFIX}${dialogSeq}`;
    dialog = { id, text, onConfirm };
    send({
      t: "dialog",
      dialog_id: id,
      kind: "confirm",
      text,
      options: [
        { id: "confirm", label: "Confirm" },
        { id: "cancel", label: "Cancel" },
      ],
    });
  }

  /** answer: "confirm"/"yes" runs it; anything else cancels. fromPanel=false → tell the panel to close it. */
  function answerDialog(dialogId: string | null, answer: string, fromPanel: boolean) {
    if (!dialog) {
      if (!fromPanel) status("No question is open.");
      return;
    }
    if (dialogId && dialogId !== dialog.id) {
      if (dialogId.startsWith(DIALOG_PREFIX)) status("That question is no longer open.");
      return; // not ours (e.g. a Claude clarify owned by the Python side)
    }
    const d = dialog;
    dialog = null;
    if (!fromPanel) send({ t: "dialog", dialog_id: d.id, kind: "confirm", text: "", options: [] }); // empty options = closed
    if (answer === "confirm" || answer === "yes") d.onConfirm();
    else status("Cancelled.");
  }

  // --------------------------------------------------------------------------- mic
  function openMic(reason: "ptt" | "tile") {
    if (settings.quiet) {
      status("Quiet mode is on: the mic stays off.");
      return;
    }
    if (settings.inputs?.voice === false) {
      status("Voice is switched off in Settings.");
      return;
    }
    // Push-to-talk / mic start lifts the pen (pen-state law).
    forward(pipeline.action("ptt", actT()));
    if (!micOpen) {
      micOpen = true;
      send({ t: "mic", open: true, reason });
    }
    maybeState(true);
  }

  function closeMic(reason: "ptt" | "tile" | "quiet" | "dialog") {
    if (!micOpen) return;
    micOpen = false;
    send({ t: "mic", open: false, reason });
    maybeState(true);
  }

  // --------------------------------------------------------------------------- actions
  function pipelineAction(id: string, variant?: string, arg?: number | null) {
    const before = pipeline.snapshot();
    const panBefore = panState(pipeline).armed;
    forward(pipeline.action(id, actT(), { variant, arg }));
    const after = pipeline.snapshot();
    if (id === "latch" && after.latch !== settings.latch) {
      changeSettings({ latch: after.latch });
      status(after.latch ? "Latch on: holding still won't lift the pen." : "Latch off.");
    }
    if (after.paused !== before.paused) {
      if (after.paused) {
        if (numbers) hideNumbers("Numbers hidden while paused.");
        status("Paused. The pen is up and the pointer stays in the Steady panel. Resume to draw.");
      } else {
        if (currentAlert.startsWith("Paused:") || currentAlert.startsWith("Steady is paused")) clearAlert();
        status("Resumed. Pen is up.");
      }
    }
    if (after.mode !== before.mode) status(modeText(after.mode, settings.hatchLagMs));
    const panAfter = panState(pipeline).armed;
    if (id === "pan" && panAfter !== panBefore)
      status(panAfter ? "Pan: the next pen-down drags the canvas." : "Pan off.");
    if (id === "pick") status("Pick: hold still on the colour to sample it.");
    if (id === "recenter") status("Recentred on your hand.");
    maybeState(true);
  }

  function runAction(id: string, variant: string | undefined, arg: number | null | undefined, source: Source) {
    if (DIALOG_ACTIONS.has(id)) {
      answerDialog(null, id === "yes" ? "confirm" : id, false);
      return;
    }
    if (id === "alias") {
      // Grammar-only id: a user alias → choose the stored preset by name.
      if (!variant) return;
      if (!kritaConnected) {
        status("That needs the Krita plugin.");
        return;
      }
      sendKritaCmd({ cmd: "preset", name: variant }, { kind: "alias", preset: variant });
      return;
    }
    const a = ACTIONS_BY_ID[id];
    if (!a) {
      status(`Unknown action: ${id}.`);
      return;
    }

    if ((id === "undo" || id === "redo") && arg != null && arg > 1) {
      // Coalesced "undo that undo that": N commands, 50 ms apart.
      const n = Math.min(UNDO_MAX, Math.round(arg));
      for (let i = 0; i < n; i++) schedule(clock + i * UNDO_SPACING_MS, () => runAction(id, undefined, null, source));
      runDue();
      return;
    }

    if (isHandPreset(id)) {
      const { tip, ...preset } = handPresetSettings(id);
      changeSettings(preset as Partial<BrainSettings>);
      status(`${a.label}: Steadiness ${preset.steadiness}.`);
      if (tip && !tipsShown.has(id)) {
        tipsShown.add(id);
        status(tip.replace(/\*/g, ""));
      }
      maybeState(true);
      return;
    }

    if (UNSUPPORTED[id]) {
      status(UNSUPPORTED[id]);
      return;
    }

    switch (id) {
      case "undo":
      case "redo":
        kritaDispatch(a);
        return;
      case "steadier":
      case "looser": {
        if ((source === "voice" || source === "claude") && clock - lastSteadierAt < STEADIER_DEBOUNCE_MS) return;
        lastSteadierAt = clock;
        const v = clamp(settings.steadiness + (id === "steadier" ? STEADIER_STEP : -STEADIER_STEP), 0, 100);
        changeSettings({ steadiness: v });
        status(`Steadiness ${v}.`);
        maybeState(true);
        return;
      }
      case "smoothing_sketch":
      case "smoothing_ink":
      case "smoothing_shade": {
        forward(pipeline.action(id, actT()));
        const v = pipeline.snapshot().steadiness;
        // The pipeline keeps its radius cap; persist only the Steadiness value (no setSettings round trip).
        settings = { ...settings, steadiness: v };
        send({ t: "settings_changed", settings: { steadiness: v } });
        status(`${a.label}: Steadiness ${v}.`);
        maybeState(true);
        return;
      }
      case "simulate_tremor": {
        const on = !settings.simulateTremor;
        changeSettings({ simulateTremor: on });
        status(on ? "Simulated tremor on." : "Simulated tremor off.");
        return;
      }
      case "recalibrate":
      case "next_judge":
        forward(pipeline.action(id, actT()));
        startCalibration([1, 2, 3]);
        return;
      case "quiet": {
        const on = variant === "on" ? true : variant === "off" ? false : !settings.quiet;
        changeSettings({ quiet: on });
        if (on) closeMic("quiet");
        status(on ? "Quiet mode on: mic, spoken replies and click sounds off." : "Quiet mode off.");
        maybeState(true);
        return;
      }
      case "mic":
        // variant "opened"/"closed": the Python side reports a change it made itself (no reply).
        if (variant === "closed") {
          micOpen = false;
          maybeState(true);
        } else if (variant === "opened") {
          micOpen = true;
          forward(pipeline.action("ptt", actT()));
          maybeState(true);
        } else if (variant === "off" || (variant !== "on" && micOpen)) closeMic("tile");
        else openMic("tile");
        return;
      case "later":
        status("Break reminder: later.");
        return;
      case "other_hand": {
        forward(pipeline.action("other_hand", actT()));
        const cur: Hand = calibration?.handedness ?? "Right";
        const other: Hand = cur === "Right" ? "Left" : "Right";
        const mine = calibrations[other];
        if (mine) {
          useCalibration(mine, true);
          status(`Using your ${other.toLowerCase()} hand setup.`);
        } else {
          const prior = calibration ? mirrorCalibration(calibration) : null;
          if (prior) {
            calibration = prior;
            pipeline.setCalibration(prior);
          }
          startCalibration([1, 2], prior);
          status(`${other} hand: rest it and hold still.`);
        }
        maybeState(true);
        return;
      }
      case "use_profile":
      case "save_profile": {
        const name = variant?.trim();
        if (!name) {
          status(id === "use_profile" ? "Say or type the profile's name, e.g. use profile shaky day." : "Say or type a name, e.g. save profile evening.");
          return;
        }
        if (id === "use_profile") {
          const r = profileFromStore(profiles, name);
          if (!r) {
            status(`No profile called ${name}.`);
            return;
          }
          profiles = r.store;
          changeSettings({ ...(r.profile.settings as Partial<BrainSettings>), profiles });
          const cal = r.profile.calibration;
          const c = cal ? (cal[calibration?.handedness ?? "Right"] ?? cal.Right ?? cal.Left) : null;
          if (c) useCalibration(c, true);
          status(`Profile: ${r.profile.name}.`);
        } else {
          const cals = Object.keys(calibrations).length ? { ...calibrations } : undefined;
          profiles = saveProfile(profiles, name, settings as unknown as Record<string, unknown>, cals);
          changeSettings({ profiles });
          status(`Saved profile ${profiles.active}.`);
        }
        maybeState(true);
        return;
      }
      case "show_numbers":
        if (!kritaConnected) {
          status("Show numbers needs the Krita plugin.");
          return;
        }
        sendKritaCmd({ cmd: "list_widgets" }, { kind: "numbers" });
        return;
      case "hide_numbers":
        if (numbers) hideNumbers("Numbers hidden.");
        else status("No numbers are shown.");
        return;
      case "click_number": {
        const n = arg ?? (variant ? Number(variant) : NaN);
        if (n == null || !Number.isFinite(n)) status(numbers ? "Say click and a number." : "Show numbers first.");
        else clickNumber(Number(n));
        return;
      }
      case "name_brush":
        if (variant) nameBrush(variant);
        else status("Say call this brush and one word, or type alias and the word.");
        return;
      default:
        break;
    }

    if (PIPELINE_ACTIONS.has(id)) pipelineAction(id, variant, arg);
    if (a.destructive && a.krita) {
      openConfirm(`${a.label}? Krita's Undo can bring it back.`, () => kritaDispatch(a, arg));
      return;
    }
    if (a.krita && a.scope !== "canvas") kritaDispatch(a, arg);
  }

  function onHotkey(key: string) {
    if (key === "ptt_up") {
      closeMic("ptt");
      return;
    }
    if (settings.inputs?.keys === false) {
      status("Keys are switched off in Settings.");
      return;
    }
    if (key === "ptt_down") {
      openMic("ptt");
      return;
    }
    const action = HOTKEY_TO_ACTION[key];
    if (!action) {
      status(`Unknown key: ${key}.`);
      return;
    }
    runAction(action, undefined, null, "hotkey");
  }

  function onHelperEvent(event: string, data: Record<string, unknown>) {
    switch (event) {
      case "released": {
        // The pointer let go on its own (watchdog, exception…): lift our pen to match.
        const wasDrawing = pipeline.snapshot().pen === "DRAWING";
        held = null; // already released physically
        forceLiftNow("socket");
        held = null;
        const reason = typeof data.reason === "string" ? data.reason : "other";
        if (wasDrawing) alert(`Pen released: ${RELEASE_TEXT[reason] ?? reason}.`);
        maybeState(true);
        return;
      }
      case "refused_down": {
        forceLiftNow("socket");
        const code = typeof data.code === "string" ? data.code : "";
        const which = data.which === "input_monitoring" ? "Input Monitoring" : "Accessibility";
        alert(
          code === "paused"
            ? "Steady is paused: press Resume (F9) to draw in Krita."
            : code === "permission"
              ? `Krita isn't receiving the pen: grant ${which} to Steady Tracker.`
              : `The pointer refused to press${typeof data.message === "string" ? `: ${data.message}` : "."}`,
        );
        maybeState(true);
        return;
      }
      case "krita_state":
        onKritaConnected(data.connected === true);
        if (isRect(data.window_rect)) setRects({ krita: data.window_rect });
        return;
      case "krita_reply":
        onKritaReply(data);
        return;
      default:
        log(`helper_event: unknown event ${event}`);
    }
  }

  function setRects(r: Partial<PipelineRects> & { panel?: Rect | null }) {
    const next: Partial<PipelineRects> = {};
    for (const k of ["canvas", "chrome", "krita", "screen", "usable"] as const) if (k in r) next[k] = r[k] ?? null;
    if ("panel" in r) next.chrome = r.panel ?? null; // the panel plays the old Chrome-window role
    if (
      numbers &&
      "krita" in next &&
      rects.krita &&
      JSON.stringify(next.krita) !== JSON.stringify(rects.krita)
    )
      hideNumbers("Krita moved: say show numbers again.");
    rects = { ...rects, ...next };
    pipeline.setRects(next);
  }

  function onInit(m: Extract<ToBrain, { t: "init" }> & { calibrations?: Partial<Record<Hand, Calibration>> }) {
    if (initialised) forceLiftNow("mode_change");
    settings = { ...DEFAULT_SETTINGS, ...(m.settings ?? {}), inputs: { ...DEFAULT_SETTINGS.inputs, ...(m.settings?.inputs ?? {}) } };
    profiles = parseProfiles(settings.profiles ? JSON.stringify(settings.profiles) : null);
    calibration = m.calibration ?? null;
    for (const h of ["Left", "Right"] as const) {
      const c = m.calibrations?.[h];
      if (c) calibrations[h] = c;
    }
    if (calibration) calibrations[calibration.handedness] = calibration;
    clock = Math.max(clock, typeof m.now === "number" ? m.now : 0);
    calibrator = null;
    last = null;
    lastFrameT = null;
    held = null;
    pipeline = makePipeline();
    initialised = true;
    send({ t: "ready", version: opts.version ?? BRAIN_VERSION });
    const s = m.settings as Partial<BrainSettings> | undefined;
    if (s?.headMode) status(UNSUPPORTED.head_mode);
    maybeState(true);
  }

  function onSettings(patch: Partial<BrainSettings>) {
    if (!patch || typeof patch !== "object") throw new Error("settings: not an object");
    if (patch.headMode) status(UNSUPPORTED.head_mode);
    if (patch.eyebrowLift) status(UNSUPPORTED.eyebrow_lift);
    changeSettings(patch, { emit: false });
    if (patch.profiles) profiles = parseProfiles(JSON.stringify(patch.profiles));
    if (patch.quiet) closeMic("quiet");
    if (patch.inputs?.voice === false) closeMic("tile");
    maybeState(true);
  }

  // --------------------------------------------------------------------------- dispatch
  function dispatch(m: ToBrain) {
    const now = (m as { now?: unknown }).now;
    if (typeof now === "number" && Number.isFinite(now) && m.t !== "tick") clock = Math.max(clock, now);
    switch (m.t) {
      case "init":
        onInit(m);
        return;
      case "frame":
        onFrame(m.frame, (m as { cameraFps?: unknown }).cameraFps);
        return;
      case "tick":
        onTick(m.now);
        return;
      case "action":
        runAction(m.action, m.variant, m.arg, m.source);
        maybeState();
        return;
      case "settings":
        onSettings(m.settings as Partial<BrainSettings>);
        return;
      case "rects":
        setRects(m.rects as Partial<PipelineRects> & { panel?: Rect | null });
        return;
      case "calibrate":
        forward(pipeline.action("recalibrate", actT()));
        startCalibration(Array.isArray(m.steps) ? m.steps : [1, 2, 3]);
        return;
      case "parse": {
        const o = m.opts ?? { mode: "typed" };
        const result = parseCommand(String(m.text ?? ""), {
          ...o,
          mode: o.mode === "voice" ? "voice" : "typed",
          aliases: { ...(settings.aliases ?? {}), ...(o.aliases ?? {}) },
          dialogOpen: o.dialogOpen ?? !!dialog,
        });
        send({ t: "parsed", id: m.id, result });
        return;
      }
      case "hotkey":
        onHotkey(m.key);
        maybeState();
        return;
      case "helper_event":
        onHelperEvent(m.event, (m.data ?? {}) as Record<string, unknown>);
        return;
      case "dialog_answer":
        answerDialog(m.dialog_id, m.answer, true);
        return;
      case "shutdown":
        try {
          forceLiftNow("socket");
        } finally {
          closeMic("tile");
          shutDown = true;
          maybeState(true);
          opts.onShutdown?.();
        }
        return;
      default:
        throw new Error(`unknown message t=${String((m as { t?: unknown }).t)}`);
    }
  }

  function emergencyLift(why: string) {
    try {
      forceLiftNow("socket");
    } catch (e) {
      log(`emergency lift failed: ${errText(e)}`);
      try {
        rawRelease("socket");
      } catch {
        /* nothing left to do */
      }
    }
    try {
      send({ t: "error", text: why });
    } catch {
      /* ignore */
    }
  }

  return {
    handle(msg: unknown) {
      if (shutDown) return;
      const t = msg && typeof msg === "object" ? (msg as { t?: unknown }).t : undefined;
      try {
        if (typeof t !== "string") throw new Error("message without t");
        dispatch(msg as ToBrain);
      } catch (e) {
        log(`brain error on ${String(t)}: ${errText(e)}`);
        emergencyLift(`${String(t)}: ${errText(e)}`);
      }
    },
    emergencyLift,
    get shutDown() {
      return shutDown;
    },
  };
}
