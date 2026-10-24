/// <reference lib="webworker" />
/**
 * Steady tracking Worker (§1). Owned by B.
 *
 * Reads camera frames (or a replay file), runs HandLandmarker + A's pipeline, owns the helper
 * WebSocket (C's helperClient), posts a `frame` per frame and a 30 Hz `state` mirror to the page.
 * Runs off the page's render loop so the pointer keeps moving when Chrome is occluded.
 *
 * Target units: "canvas" = page viewport CSS px (the practice canvas rect is reported in viewport
 * px, so the pointer can leave the canvas and hover the side panel's tiles); "krita" = Quartz
 * screen points.
 */
import { HOTKEY_TO_ACTION } from "../actions";
import { createCalibrator } from "../pipeline/calibration";
import { createPipeline } from "../pipeline/pipeline";
import {
  DEFAULT_SETTINGS,
  type Calibration,
  type Calibrator,
  type MirrorState,
  type PageToWorker,
  type PenEvent,
  type Pipeline,
  type PipelineOutput,
  type PipelineRects,
  type Rect,
  type SteadySettings,
  type Target,
  type WorkerToPage,
} from "../pipeline/types";
import { createHelperClient } from "../desktop/helperClient";
import {
  PING_EVERY_MS,
  type HelperClient,
  type HelperConnState,
  type HelperToWorker,
  type WorkerToHelper,
} from "../desktop/protocol";
import type { LandmarkFrame, LandmarkSource } from "./LandmarkSource";
import { ReplaySource } from "./ReplaySource";
import type { MediaPipeSource } from "./MediaPipeSource";
import { SENT_CHANNEL, type SentRecord } from "./sentChannel";

declare const self: DedicatedWorkerGlobalScope;

const now = () => performance.now();
/** Calibration steps 1–2 (P0) and 3 (P1, auto-flips a wrong axis). */
const CALIBRATION_STEPS: Array<1 | 2 | 3> = [1, 2, 3];
const post = (msg: WorkerToPage, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

// ----------------------------------------------------------------------------- state
let settings: SteadySettings = { ...DEFAULT_SETTINGS };
let calibration: Calibration | null = null;
let pipeline: Pipeline | null = null;
let calibrator: Calibrator | null = null;
let calibratorSteps: Array<1 | 2 | 3> = [];
let source: LandmarkSource | null = null;
let mediapipe: MediaPipeSource | null = null;
let helper: HelperClient | null = null;
let helperState: HelperConnState = "closed";
let helperHello: Extract<HelperToWorker, { t: "hello" }> | null = null;
let kritaConnected = false;
let kritaWindowRect: Rect | null = null;
let kritaCanvasRect: Rect | null = null;
let target: Target = "canvas";
let demo = false;
let status: string | null = null;
let windowRect: Rect | null = null; // the page viewport in screen points
let practiceRect: Rect | null = null; // the practice canvas, viewport px
let last: PipelineOutput | null = null;
let lastFrameAt = 0;
let lastMoveSentAt = 0;
let lastSentAt = 0;
let lastClickProgress = 0;
const frameStamps: number[] = [];
let lastTracking: MirrorState["tracking"] | null = null;
let everTracked = false;

const sentLog: SentRecord[] = [];
const sentChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(SENT_CHANNEL) : null;

// ----------------------------------------------------------------------------- helpers
function setStatus(text: string, level: "status" | "alert" = "status") {
  status = text;
  post({ type: "status", text, level });
}

function viewportRect(): Rect {
  return { x: 0, y: 0, w: windowRect?.w ?? 1280, h: windowRect?.h ?? 800 };
}

function rectsFor(t: Target): PipelineRects {
  if (t === "canvas") {
    const vp = viewportRect();
    return { canvas: practiceRect, chrome: vp, krita: null, screen: vp };
  }
  const scr = helperHello ? { x: 0, y: 0, w: helperHello.screen.w, h: helperHello.screen.h } : null;
  return { canvas: kritaCanvasRect, chrome: windowRect, krita: kritaWindowRect, screen: scr };
}

function applyRects() {
  pipeline?.setRects(rectsFor(target));
}

function helperOpen(): boolean {
  return helperState === "open" && !!helper;
}

type Outgoing = Parameters<HelperClient["send"]>[0];

function sendHelper(msg: Outgoing): string | null {
  if (!helper || helperState !== "open") return null;
  const id = helper.send(msg);
  if (id) {
    const t = now();
    lastSentAt = t;
    if (msg.t === "move") lastMoveSentAt = t;
    const rec: SentRecord = { ...(msg as object), id, at: t } as SentRecord;
    sentLog.push(rec);
    if (sentLog.length > 500) sentLog.shift();
    sentChannel?.postMessage(rec);
  }
  return id;
}

function viewportToScreen(x: number, y: number): { x: number; y: number } {
  return { x: (windowRect?.x ?? 0) + x, y: (windowRect?.y ?? 0) + y };
}

function inside(r: Rect | null, x: number, y: number) {
  return !!r && x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
}

/** Forward pipeline pen events: to the helper for the Krita target; the page draws the practice canvas itself. */
function forward(events: PenEvent[]) {
  if (target !== "krita" || !helperOpen()) return;
  for (const e of events) {
    if (e.type === "move") sendHelper({ t: "move", x: Math.round(e.x * 10) / 10, y: Math.round(e.y * 10) / 10 });
    else if (e.type === "down") sendHelper({ t: "down" });
    else if (e.type === "up") sendHelper({ t: "up", reason: e.reason });
    else if (e.type === "click")
      sendHelper({ t: "click", x: Math.round(e.x), y: Math.round(e.y), reactivate_krita: inside(windowRect, e.x, e.y) });
  }
}

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

// ----------------------------------------------------------------------------- frames
function onFrame(frame: LandmarkFrame) {
  if (!pipeline) return;
  lastFrameAt = now();
  frameStamps.push(lastFrameAt);
  while (frameStamps.length && frameStamps[0] < lastFrameAt - 1000) frameStamps.shift();
  const out = pipeline.step(frame);
  handleOutput(out, frame);
}

function handleOutput(out: PipelineOutput, frame: LandmarkFrame | null) {
  last = out;
  // Calibration runs on the same frames.
  if (calibrator && frame) {
    const hand = frame.hands[0];
    lastCalibProgress = calibrator.feed(out.t, out.raw, out.filtered, hand && hand.score >= 0.6 ? hand.handedness : null);
    const res = calibrator.result();
    if (res) {
      calibrator = null;
      calibration = res;
      pipeline?.setCalibration(res);
      post({ type: "calibration", calibration: res });
      const flips = [res.flipX ? "left-right" : null, res.flipY ? "up-down" : null].filter(Boolean);
      setStatus(
        flips.length
          ? `Calibration done. I flipped ${flips.join(" and ")} to match your hand.`
          : "Calibration done. Hold still on the canvas to start drawing.",
      );
    }
  }

  // Tracking transitions → status / alert.
  if (out.tracking !== lastTracking) {
    if (out.tracking === "Lost" && everTracked) setStatus(lostReasonText(out.reason), "alert");
    else if (lastTracking === "Lost" && out.tracking !== "Lost" && everTracked) setStatus("Tracking back. Pen is up.");
    if (out.tracking !== "Lost") everTracked = true;
    lastTracking = out.tracking;
  }
  for (const e of out.events) {
    if (e.type === "up" && e.reason === "tracking_lost") setStatus("Pen lifted: tracking lost mid-stroke.", "alert");
    if (e.type === "up" && e.reason === "left_canvas") setStatus("Pen lifted: the pointer left the canvas.");
  }

  forward(out.events);

  // Practice target + helper: the helper performs the real dwell-click on Chrome's tiles (§3).
  const d = out.dwell;
  if (d.kind === "click" && d.progress >= 1 && lastClickProgress < 1 && target === "canvas" && helperOpen() && !d.gated) {
    const s = viewportToScreen(d.x, d.y);
    sendHelper({ t: "click", x: Math.round(s.x), y: Math.round(s.y) });
  }
  lastClickProgress = d.kind === "click" ? d.progress : 0;

  post({ type: "frame", out });
}

// ----------------------------------------------------------------------------- mirror
function mirror(): MirrorState {
  const snap = pipeline?.snapshot();
  const o = last;
  const detFps = source?.fps?.() ?? frameStamps.length;
  const camFps = mediapipe ? mediapipe.cameraFps() : frameStamps.length;
  return {
    t: now(),
    target,
    pen: snap?.pen ?? "HOVER",
    tracking: o?.tracking ?? "Lost",
    reason: o?.reason ?? "no_hand",
    score: o?.score ?? 0,
    pointer: o?.pointer ?? null,
    dwell: o?.dwell ?? { kind: null, progress: 0, x: 0, y: 0, gated: false },
    paused: snap?.paused ?? false,
    latch: snap?.latch ?? settings.latch,
    mode: snap?.mode ?? "normal",
    steadiness: snap?.steadiness ?? settings.steadiness,
    gain: snap?.gain ?? 0,
    calibrated: !!calibration,
    calibrating: calibrator && calibrator.step
      ? { step: calibrator.step, progress: lastCalibProgress, prompt: calibrator.prompt }
      : null,
    cameraFps: camFps,
    detectionFps: detFps,
    helper: helperState,
    helperRttMs: helper?.rttMs() ?? null,
    helperHello,
    kritaConnected,
    kritaWindowRect,
    deviationPx: snap?.deviationPx ?? null,
    lastStrokeMs: snap?.lastStrokeMs ?? null,
    simulateTremor: settings.simulateTremor,
    rawTrail: snap?.rawTrail ?? [],
    status,
  };
}
let lastCalibProgress = 0;

setInterval(() => post({ type: "state", state: mirror() }), 33);

// Loss timer when frames stop entirely (camera stall), and the 100 ms keep-alive ping.
setInterval(() => {
  const t = now();
  if (pipeline && lastFrameAt && t - lastFrameAt > 100) {
    const out = pipeline.tick(t);
    handleOutput(out, null);
  }
  if (helperOpen() && t - lastMoveSentAt >= PING_EVERY_MS && t - lastSentAt >= PING_EVERY_MS) {
    sendHelper({ t: "ping" });
  }
}, 50);

// ----------------------------------------------------------------------------- actions
const WORKER_ACTIONS = new Set([
  "pen_toggle",
  "pen_down",
  "pen_up",
  "pause",
  "latch",
  "recenter",
  "steadier",
  "looser",
  "dots",
  "hatch",
  "hatch_lr",
  "hatch_down",
  "hatch_alternate",
  "stop_hatching",
  "brush",
  "other_hand",
  "recalibrate",
  "next_judge",
  "ptt",
  "mic",
]);

function runAction(id: string, variant?: string, arg?: number | null) {
  if (!pipeline) return;
  const wasPaused = pipeline.snapshot().paused;
  const t = Math.max(now(), last?.t ?? 0);
  const events = pipeline.action(id, t, { variant, arg });
  if (id === "simulate_tremor") settings = { ...settings, simulateTremor: !settings.simulateTremor };
  if (id === "latch") settings = { ...settings, latch: pipeline.snapshot().latch };
  forward(events);
  if (events.length) post({ type: "frame", out: { ...(last ?? emptyOutput()), events, pen: pipeline.snapshot().pen } });
  const paused = pipeline.snapshot().paused;
  if (paused !== wasPaused) {
    if (paused) {
      if (windowRect) sendHelper({ t: "chrome_rect", rect: windowRect });
      sendHelper({ t: "pause" });
      setStatus("Paused. The pen is up and the pointer stays in Steady. Resume to draw.");
    } else {
      sendHelper({ t: "resume" });
      setStatus("Resumed. Pen is up.");
    }
  }
}

function emptyOutput(): PipelineOutput {
  return {
    t: now(),
    raw: null,
    filtered: null,
    pre: null,
    pointer: null,
    pen: "HOVER",
    events: [],
    dwell: { kind: null, progress: 0, x: 0, y: 0, gated: false },
    tracking: "Lost",
    reason: "no_hand",
    score: 0,
    warmingUp: false,
  };
}

function startCalibration(steps: Array<1 | 2 | 3>) {
  const allowed = steps.length ? steps : CALIBRATION_STEPS;
  calibratorSteps = allowed;
  const targetRect = rectsFor(target).canvas ?? rectsFor(target).screen ?? viewportRect();
  calibrator = createCalibrator({ steps: allowed, targetWidth: targetRect.w, prior: calibration, now: Date.now() });
  lastCalibProgress = 0;
  setStatus(calibrator.prompt || "Calibrating.");
}

// ----------------------------------------------------------------------------- helper socket
function connectHelper(url: string) {
  helper = createHelperClient({
    url,
    onState: (s) => {
      const was = helperState;
      helperState = s;
      if (s === "open") {
        pipeline?.setHelperConnected(true);
        if (windowRect) sendHelper({ t: "chrome_rect", rect: windowRect });
        if (pipeline?.snapshot().paused) sendHelper({ t: "pause" });
      } else {
        pipeline?.setHelperConnected(false);
        if (was === "open") {
          helperHello = null;
          kritaConnected = false;
          if (target === "krita") {
            target = "canvas";
            forward(pipeline?.setTarget("canvas") ?? []);
            applyRects();
          }
          setStatus("Helper disconnected. Pen is up; drawing on the practice canvas.");
        }
      }
    },
    onMessage: (msg) => onHelperMessage(msg),
  });
}

function onHelperMessage(msg: HelperToWorker) {
  switch (msg.t) {
    case "hello":
      helperHello = msg;
      kritaConnected = msg.krita;
      kritaWindowRect = msg.krita_window_rect;
      if (!msg.accessibility || !msg.input_monitoring) {
        const which = !msg.accessibility ? "Accessibility" : "Input Monitoring";
        setStatus(`Helper needs ${which} permission for the terminal that launched it.`, "alert");
      }
      if (msg.krita) initKrita();
      applyRects();
      break;
    case "krita_window_rect":
      kritaWindowRect = msg.rect;
      applyRects();
      break;
    case "krita_state":
      if (msg.connected && !kritaConnected) initKrita();
      kritaConnected = msg.connected;
      break;
    case "hotkey": {
      const action = HOTKEY_TO_ACTION[msg.key];
      if (msg.key === "pen" || msg.key === "pause" || msg.key === "latch" || msg.key === "recenter") runAction(action);
      else if (msg.key === "ptt_down") runAction("ptt");
      break;
    }
    case "error":
      if (msg.code === "permission") {
        setStatus(
          `Helper needs ${msg.which === "input_monitoring" ? "Input Monitoring" : "Accessibility"} permission for the terminal that launched it.`,
          "alert",
        );
      }
      break;
    default:
      break;
  }
  post({ type: "helper", msg });
}

const STEADY_KEYS = ["f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10"];

function initKrita() {
  if (!helper) return;
  helper
    .request({ t: "krita", cmd: "session_init", keys: STEADY_KEYS }, 3000)
    .then((r) => {
      if (r.t === "krita_reply" && r.ok && (r as Record<string, unknown>).smoothing_changed) {
        setStatus("Steady smooths your strokes, so Krita's brush smoothing is now None.");
      }
    })
    .catch(() => undefined);
  helper
    .request({ t: "krita", cmd: "canvas_rect" }, 3000)
    .then((r) => {
      const rect = (r as Record<string, unknown>).rect as Rect | undefined;
      if (r.t === "krita_reply" && r.ok && rect) {
        kritaCanvasRect = rect;
        applyRects();
      }
    })
    .catch(() => undefined);
}

// ----------------------------------------------------------------------------- sources
async function startSource(kind: "camera" | "replay", replayUrl?: string) {
  try {
    if (kind === "replay") {
      source = new ReplaySource(replayUrl ?? "/replay/dev-circle.json");
      post({ type: "ready", delegate: "replay" });
      await source.start(onFrame);
    } else {
      const mod = await import("./MediaPipeSource");
      mediapipe = new mod.MediaPipeSource({
        onDelegate: (d) => post({ type: "ready", delegate: d }),
        onWarning: (text) => setStatus(text),
      });
      source = mediapipe;
      await mediapipe.start(onFrame);
      if (pendingReadable) {
        mediapipe.attach(pendingReadable);
        pendingReadable = null;
      }
    }
  } catch (err) {
    post({ type: "error", text: `Tracking could not start: ${String((err as Error)?.message ?? err)}` });
  }
}
let pendingReadable: ReadableStream<VideoFrame> | null = null;

// ----------------------------------------------------------------------------- messages
self.onmessage = (ev: MessageEvent<PageToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case "init": {
      settings = { ...DEFAULT_SETTINGS, ...m.settings };
      calibration = m.calibration;
      demo = m.demo;
      pipeline = createPipeline({
        settings,
        calibration,
        target,
        rects: rectsFor(target),
        helperConnected: false,
      });
      if (m.helperUrl) connectHelper(m.helperUrl);
      void startSource(m.source, m.replayUrl);
      break;
    }
    case "stream":
      if (mediapipe && source) mediapipe.attach(m.readable as ReadableStream<VideoFrame>);
      else pendingReadable = m.readable as ReadableStream<VideoFrame>;
      break;
    case "bitmap":
      if (mediapipe) mediapipe.pushBitmap(m.bitmap);
      else m.bitmap.close();
      break;
    case "settings":
      settings = { ...settings, ...m.settings, inputs: { ...settings.inputs, ...(m.settings.inputs ?? {}) } };
      pipeline?.setSettings(m.settings);
      break;
    case "window_rect": {
      const changed =
        !windowRect || windowRect.x !== m.rect.x || windowRect.y !== m.rect.y || windowRect.w !== m.rect.w || windowRect.h !== m.rect.h;
      windowRect = m.rect;
      if (changed) {
        applyRects();
        sendHelper({ t: "chrome_rect", rect: m.rect });
      }
      break;
    }
    case "canvas_rect":
      if (m.target === "canvas") practiceRect = m.rect;
      else kritaCanvasRect = m.rect;
      applyRects();
      break;
    case "set_target": {
      if (m.target === "krita" && !helperOpen()) {
        setStatus("Drawing in Krita needs the helper. Start it with npm run helper.");
        break;
      }
      if (m.target === target) break;
      const events = pipeline?.setTarget(m.target) ?? [];
      // Lift on the old target before switching.
      forward(events);
      target = m.target;
      applyRects();
      if (target === "krita" && !kritaCanvasRect) {
        setStatus("Drawing in Krita. Mark Krita's canvas corners on the Setup page so ink lands only on the canvas.");
      } else {
        setStatus(target === "krita" ? "Drawing in Krita. Pen is up." : "Drawing on the practice canvas. Pen is up.");
      }
      break;
    }
    case "action":
      if (m.action === "recalibrate" || m.action === "next_judge") {
        runAction(m.action);
        startCalibration(CALIBRATION_STEPS);
      } else if (WORKER_ACTIONS.has(m.action)) {
        runAction(m.action, m.variant, m.arg ?? null);
      }
      break;
    case "calibrate":
      runAction("recalibrate");
      startCalibration(m.steps);
      break;
    case "use_calibration":
      calibration = m.calibration;
      calibrator = null;
      pipeline?.setCalibration(m.calibration);
      setStatus("Using your last setup.");
      break;
    case "send": {
      const msg = { ...m.msg, id: m.msg.id ?? crypto.randomUUID() } as Outgoing & { id: string };
      if (!helper || !helperOpen()) {
        post({ type: "reply", id: msg.id, msg: { t: "timeout", id: msg.id } });
        break;
      }
      const t0 = now();
      helper
        .request(msg, 3000)
        .then((reply) => post({ type: "reply", id: msg.id, msg: reply }))
        .catch(() => post({ type: "reply", id: msg.id, msg: { t: "timeout", id: msg.id } }));
      lastSentAt = t0;
      const rec = { ...(msg as object), id: msg.id, at: t0 } as SentRecord;
      sentLog.push(rec);
      sentChannel?.postMessage(rec);
      break;
    }
    case "reset_metrics":
      frameStamps.length = 0;
      break;
    default:
      break;
  }
};

// keep `demo` and `calibratorSteps` referenced (diagnostics)
void demo;
void calibratorSteps;
export type { WorkerToHelper };
