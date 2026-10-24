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
import { ACTIONS_BY_ID, DEFAULT_KEYS, HOTKEY_TO_ACTION } from "../actions";
import { createCalibrator, type StepCalibrator } from "../pipeline/calibration";
import { createPipeline, modeState, panState, setCalibrating } from "../pipeline/pipeline";
import { kritaMessageFor } from "../desktop/krita";
import { EyebrowLift, handModeConfig, headModeConfig } from "../pipeline/presets";
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
import { kritaConnectMessages } from "../desktop/krita";
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
import type { ColorCapSource } from "./ColorCapSource";

type CameraSource = MediaPipeSource | ColorCapSource;
import { SENT_CHANNEL, WORKER_EVENTS_CHANNEL, type SentRecord, type WorkerEvent } from "./sentChannel";

declare const self: DedicatedWorkerGlobalScope;

const now = () => performance.now();
/** Calibration steps 1–2 (P0) and 3 (P1, auto-flips a wrong axis). */
const CALIBRATION_STEPS: Array<1 | 2 | 3> = [1, 2, 3];
const post = (msg: WorkerToPage, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

// ----------------------------------------------------------------------------- state
let settings: SteadySettings = { ...DEFAULT_SETTINGS };
let calibration: Calibration | null = null;
let pipeline: Pipeline | null = null;
let calibrator: StepCalibrator | null = null;
let calibratorSteps: Array<1 | 2 | 3> = [];
let source: LandmarkSource | null = null;
/** Camera-fed source (HandLandmarker or the colour-cap sticker tracker); replay has none. */
let mediapipe: CameraSource | null = null;
let cameraKind: "hand" | "colorcap" = "hand";
let sourceKind: "camera" | "replay" = "camera";
let helper: HelperClient | null = null;
let helperState: HelperConnState = "closed";
let helperHello: Extract<HelperToWorker, { t: "hello" }> | null = null;
let kritaConnected = false;
let kritaWindowRect: Rect | null = null;
let kritaCanvasRect: Rect | null = null;
let target: Target = "canvas";
/** Requested Krita target before the helper connected (?target=krita): applied on open. */
let pendingTarget: Target | null = null;
let demo = false;
let status: string | null = null;
let windowRect: Rect | null = null; // the page viewport in screen points
let windowZoom = 1; // page zoom: CSS px × windowZoom = screen points (R9)
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
/** Worker → page events WorkerToPage has no message for (the picked sticker range, to persist in settings). */
const workerEvents = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(WORKER_EVENTS_CHANNEL) : null;

// ----------------------------------------------------------------------------- helpers
function setStatus(text: string, level: "status" | "alert" = "status") {
  status = text;
  post({ type: "status", text, level });
}

/** Page viewport in CSS px (canvas-target units). windowRect is in screen points: divide by the page zoom. */
function viewportRect(): Rect {
  return { x: 0, y: 0, w: (windowRect?.w ?? 1280) / windowZoom, h: (windowRect?.h ?? 800) / windowZoom };
}

function rectsFor(t: Target): PipelineRects {
  if (t === "canvas") {
    const vp = viewportRect();
    return { canvas: practiceRect, chrome: vp, krita: null, screen: vp };
  }
  const scr = helperHello ? { x: 0, y: 0, w: helperHello.screen.w, h: helperHello.screen.h } : null;
  // R8: dwell-clicks only inside the usable area (no menu bar, no Dock).
  return { canvas: kritaCanvasRect, chrome: windowRect, krita: kritaWindowRect, screen: scr, usable: helperHello?.visible_frame ?? null };
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

/** R9: page CSS px → screen points (× page zoom). */
function viewportToScreen(x: number, y: number): { x: number; y: number } {
  return { x: (windowRect?.x ?? 0) + x * windowZoom, y: (windowRect?.y ?? 0) + y * windowZoom };
}

/** R8: a click is never sent outside the usable screen area (visible frame) or into the menu bar. */
function clickAllowed(x: number, y: number): boolean {
  const usable = helperHello?.visible_frame ?? null;
  if (usable) return inside(usable, x, y);
  return y >= 40;
}

/** Lift the Worker's pen without the 80 ms user-lift guard (refused down, helper release). */
function forceLift(): boolean {
  if (!pipeline || pipeline.snapshot().pen !== "DRAWING") return false;
  // "ptt" lifts immediately for any reason that isn't the user's own dwell/key/voice.
  const events = pipeline.action("ptt", Math.max(now(), last?.t ?? 0));
  forwardRaw(events);
  post({ type: "frame", out: { ...(last ?? emptyOutput()), events, pen: pipeline.snapshot().pen } });
  return true;
}

function inside(r: Rect | null, x: number, y: number) {
  return !!r && x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
}

/** Forward pipeline pen events: to the helper for the Krita target; the page draws the practice canvas itself. */
function forward(events: PenEvent[]) {
  afterPipelineCall();
  forwardRaw(events);
}

function forwardRaw(events: PenEvent[]) {
  if (target !== "krita" || !helperOpen()) return;
  // Pan (P3): this batch's down/up use the MIDDLE button (filter bypassed in the pipeline).
  const pan = pipeline ? panState(pipeline).batchIsPan : false;
  for (const e of events) {
    if (e.type === "move") sendHelper({ t: "move", x: Math.round(e.x * 10) / 10, y: Math.round(e.y * 10) / 10 });
    else if (e.type === "down") {
      // R4: the helper presses where the pointer is; put it exactly at the event first.
      sendHelper({ t: "move", x: Math.round(e.x * 10) / 10, y: Math.round(e.y * 10) / 10 });
      sendHelper(pan ? { t: "middle_down" } : { t: "down" });
    }
    else if (e.type === "up") sendHelper(pan ? { t: "middle_up" } : { t: "up", reason: e.reason });
    else if (e.type === "click" && clickAllowed(e.x, e.y))
      sendHelper({ t: "click", x: Math.round(e.x), y: Math.round(e.y), reactivate_krita: inside(windowRect, e.x, e.y) });
  }
}

/** Pick (P3): one batch carries the sampling click; then return to the brush. */
function afterPipelineCall() {
  if (!pipeline) return;
  const ms = modeState(pipeline);
  if (!ms?.batchPickSampled) return;
  setStatus("Colour picked. Back to the brush.");
  if (target === "krita" && helperOpen()) {
    const built = kritaMessageFor(ACTIONS_BY_ID.brush, { pluginConnected: kritaConnected, lookups: {} });
    if ("msg" in built) sendHelper(built.msg as Outgoing);
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

const RELEASE_TEXT: Record<string, string> = {
  watchdog: "the helper lost contact for 300 ms",
  pause: "paused",
  hotkey: "pen key",
  ptt: "push-to-talk",
  exception: "helper error",
  other: "helper",
};

/** Persistent alert (not overwritten by routine status; the page keeps alerts until cleared). */
let lastRefused = "";
function refusedAlert(text: string) {
  if (text === lastRefused) return;
  lastRefused = text;
  setStatus(text, "alert");
}
function clearAlert() {
  lastRefused = "";
  post({ type: "status", text: "", level: "alert" });
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
    if (hand && hand.score >= 0.6) calibrator.recordHand(hand.landmarks, frame.width, frame.height);
    if (calibrator.step && calibrator.step !== lastCalibStep) {
      lastCalibStep = calibrator.step;
      setStatus(`Step ${calibrator.step} of ${calibratorSteps.length}: ${calibrator.prompt}`);
    }
    const res = calibrator.result();
    if (res) {
      calibrator = null;
      if (pipeline) setCalibrating(pipeline, false);
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
    else if (lastTracking === "Lost" && out.tracking !== "Lost" && everTracked) {
      if (!lastRefused) clearAlert();
      setStatus("Tracking back. Pen is up.");
    }
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
    if (clickAllowed(s.x, s.y)) sendHelper({ t: "click", x: Math.round(s.x), y: Math.round(s.y) });
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
    calibrating:
      calibrator && calibrator.step ? { step: calibrator.step, progress: lastCalibProgress, prompt: calibrator.prompt } : null,
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
let lastCalibStep: number | null = null;

setInterval(() => {
  post({ type: "state", state: mirror() });
  sendRing();
}, 33);

/** P3 ring overlay in the helper (≤ 30 Hz, only on change); hidden while paused or on the practice target. */
let lastRing = "";
function sendRing() {
  if (!helperOpen() || !pipeline) return;
  const snap = pipeline.snapshot();
  const o = last;
  let state: "hover" | "drawing" | "outside" | "lost" | "hidden";
  if (snap.paused || target !== "krita" || !o?.pointer) state = "hidden";
  else if (o.tracking === "Lost") state = "lost";
  else if (snap.pen === "DRAWING") state = "drawing";
  else if (o.dwell.gated || o.dwell.kind === "click") state = "outside";
  else state = "hover";
  const x = Math.round(o?.pointer?.x ?? 0);
  const y = Math.round(o?.pointer?.y ?? 0);
  const progress = Math.round((o?.dwell.progress ?? 0) * 50) / 50;
  const key = state === "hidden" ? "hidden" : `${state}|${progress}|${x}|${y}`;
  if (key === lastRing) return;
  lastRing = key;
  sendHelper({ t: "ring", state, progress, x, y });
}

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
      if (lastRefused.startsWith("Helper is paused")) clearAlert();
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
  // R3: pen-down from any source is refused while calibrating; a pen that is down is lifted.
  if (pipeline) setCalibrating(pipeline, true);
  calibrator = createCalibrator({ steps: allowed, targetWidth: targetRect.w, prior: calibration, now: Date.now() });
  lastCalibProgress = 0;
  lastCalibStep = null;
  setStatus(calibrator.prompt || "Calibrating.");
}

function switchTarget(next: Target) {
  if (next === target) return;
  // Lift on the old target before switching.
  forward(pipeline?.setTarget(next) ?? []);
  target = next;
  applyRects();
  if (target === "krita" && !kritaCanvasRect) {
    setStatus("Drawing in Krita. Mark Krita's canvas corners on the Setup page so ink lands only on the canvas.");
  } else {
    setStatus(target === "krita" ? "Drawing in Krita. Pen is up." : "Drawing on the practice canvas. Pen is up.");
  }
}

const ACTION_TO_HOTKEY: Record<string, string> = {
  pen_toggle: "pen",
  pause: "pause",
  mic: "ptt_down",
  undo: "undo",
  redo: "redo",
  recenter: "recenter",
  other_hand: "other_hand",
  latch: "latch",
};

/** §4 remapped keys → the helper (the single key source while connected). */
function sendKeymap() {
  const merged: Record<string, string> = { ...DEFAULT_KEYS, ...settings.keymap };
  const map: Record<string, string> = {};
  for (const [key, action] of Object.entries(merged)) {
    const hk = ACTION_TO_HOTKEY[action];
    if (hk) map[key.toLowerCase()] = hk;
  }
  sendHelper({ t: "keymap", map } as Outgoing);
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
        sendKeymap();
        if (pipeline?.snapshot().paused) sendHelper({ t: "pause" });
        if (pendingTarget) {
          const want = pendingTarget;
          pendingTarget = null;
          switchTarget(want);
        }
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
    case "hello": {
      helperHello = msg;
      kritaConnected = msg.krita;
      kritaWindowRect = msg.krita_window_rect;
      if (!msg.accessibility || !msg.input_monitoring) {
        const which = !msg.accessibility ? "Accessibility" : "Input Monitoring";
        refusedAlert(`Krita isn't receiving the pen: grant ${which} to the terminal that runs the helper.`);
      } else if (lastRefused) clearAlert();
      // R6: the helper's pause flag survives reconnects; make it match the Worker's.
      const workerPaused = pipeline?.snapshot().paused ?? false;
      if (msg.paused !== workerPaused) sendHelper(workerPaused ? { t: "pause" } : { t: "resume" });
      if (msg.krita) initKrita();
      applyRects();
      break;
    }
    case "released": {
      // R7: the helper let go on its own (watchdog, socket, exception…): lift our pen to match.
      const wasDrawing = forceLift();
      if (wasDrawing) setStatus(`Pen released: ${RELEASE_TEXT[msg.reason] ?? msg.reason}.`, "alert");
      break;
    }
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
    case "warning":
      setStatus(msg.message ?? msg.code);
      break;
    case "error":
      // R6/H5: a refused down must not leave the Worker showing a pen that isn't down.
      if (msg.code === "paused" || msg.code === "permission") {
        forceLift();
        refusedAlert(
          msg.code === "paused"
            ? "Helper is paused: press Resume (F9) to draw in Krita."
            : `Krita isn't receiving the pen: grant ${msg.which === "input_monitoring" ? "Input Monitoring" : "Accessibility"} to the terminal that runs the helper.`,
        );
      }
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

let smoothingNoticeShown = false;
/** Any krita_reply may carry smoothing_changed: true (docs/PROTOCOL.md): show the notice once. */
function noteKritaReply(r: HelperToWorker) {
  if (r.t !== "krita_reply") return;
  if (!smoothingNoticeShown && (r as Record<string, unknown>).smoothing_changed === true) {
    smoothingNoticeShown = true;
    setStatus("Krita's brush smoothing set to None — Steady does the smoothing");
  }
}

function initKrita() {
  if (!helper) return;
  for (const msg of kritaConnectMessages()) {
    const m = msg as Outgoing;
    helper
      .request(m, 3000)
      .then((r) => {
        noteKritaReply(r);
        if (r.t !== "krita_reply") return;
        if (m.t === "krita" && m.cmd === "canvas_rect") {
          const rect = (r as Record<string, unknown>).rect as Rect | undefined;
          if (r.ok && rect) {
            kritaCanvasRect = rect;
            applyRects();
          } else if (!kritaCanvasRect) {
            setStatus("Krita's canvas was not found: use Mark corners on the Setup page.");
          }
        }
        // Forward every connect reply so the page can build its lookup maps.
        post({ type: "helper", msg: r });
      })
      .catch(() => undefined);
  }
}

// ----------------------------------------------------------------------------- sources
async function startSource(kind: "camera" | "replay", replayUrl?: string) {
  sourceKind = kind;
  try {
    if (kind === "replay") {
      source = new ReplaySource(replayUrl ?? "/replay/dev-circle.json");
      post({ type: "ready", delegate: "replay" });
      await source.start(onFrame);
    } else {
      await startCameraSource(cameraKind);
    }
  } catch (err) {
    post({ type: "error", text: `Tracking could not start: ${String((err as Error)?.message ?? err)}` });
  }
}

/** Hand (MediaPipe) or Colour cap (sticker, P3). The page sends a fresh camera stream after a switch. */
async function startCameraSource(kind: "hand" | "colorcap") {
  mediapipe?.stop();
  mediapipe = null;
  source = null;
  const events = {
    onDelegate: (d: "GPU" | "CPU") => post({ type: "ready", delegate: d }),
    onWarning: (text: string) => setStatus(text),
    onBrow: (v: number, t: number) => {
      // Eyebrow lift (P4): only ever lifts the pen (pen-state law).
      if (ui().eyebrowLift && eyebrow.update(v, t)) runAction("eyebrow_raise");
    },
  };
  let src: CameraSource;
  if (kind === "colorcap") {
    const { ColorCapSource } = await import("./ColorCapSource");
    src = new ColorCapSource(events, {
      handedness: calibration?.handedness ?? "Right",
      range: settings.stickerRange ?? undefined,
    });
  } else {
    const mod = await import("./MediaPipeSource");
    src = new mod.MediaPipeSource(events);
  }
  mediapipe = src;
  source = src;
  if (src.kind === "mediapipe") {
    src.setHeadMode(!!ui().headMode);
    src.setEyebrow(!!ui().eyebrowLift);
  }
  await src.start(onFrame);
  if (pendingReadable && mediapipe === src) {
    src.attach(pendingReadable);
    pendingReadable = null;
  }
}

type UiExtras = { headMode?: boolean; eyebrowLift?: boolean };
const ui = () => settings as typeof settings & UiExtras;
const eyebrow = new EyebrowLift();

/** Head mode / eyebrow toggles from the page's settings (extra keys beyond SteadySettings). */
function applyFaceSettings(prev: UiExtras) {
  const cur = ui();
  if (!!cur.headMode !== !!prev.headMode) {
    pipeline?.setSettings((cur.headMode ? headModeConfig() : handModeConfig(settings.landmark)) as Partial<typeof settings>);
    if (cur.headMode && cameraKind === "colorcap") switchCameraKind("hand", false);
    else if (!cur.headMode && settings.trackingSource === "colorcap") switchCameraKind("colorcap", false);
    if (mediapipe?.kind === "mediapipe") mediapipe.setHeadMode(!!cur.headMode);
  }
  if (!!cur.eyebrowLift !== !!prev.eyebrowLift) {
    eyebrow.reset();
    if (mediapipe?.kind === "mediapipe") mediapipe.setEyebrow(!!cur.eyebrowLift);
    if (cur.eyebrowLift && sourceKind === "replay") setStatus("Eyebrow lift needs the camera.");
  }
}

function switchCameraKind(want: "hand" | "colorcap", announce = true) {
  cameraKind = want;
  if (sourceKind === "camera") void startCameraSource(want).catch((err) => post({ type: "error", text: String(err) }));
  if (announce) setStatus(want === "colorcap" ? "Tracking a coloured sticker." : "Tracking your hand.");
}

async function pickStickerColour() {
  if (cameraKind !== "colorcap" || !mediapipe || mediapipe.kind !== "colorcap") {
    setStatus("Pick sticker colour works with the Colour cap source (Setup page).");
    return;
  }
  setStatus("Hold the sticker in the middle of the camera view.");
  const r = await mediapipe.pickColourFromCentre();
  setStatus(r.message);
  if (r.ok) {
    settings = { ...settings, stickerRange: r.range };
    workerEvents?.postMessage({ kind: "sticker_range", range: r.range } satisfies WorkerEvent);
  }
}

let pendingReadable: ReadableStream<VideoFrame> | null = null;

// ----------------------------------------------------------------------------- messages
self.onmessage = (ev: MessageEvent<PageToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case "init": {
      settings = { ...DEFAULT_SETTINGS, ...m.settings };
      cameraKind = settings.trackingSource ?? "hand";
      calibration = m.calibration;
      demo = m.demo;
      pipeline = createPipeline({
        settings,
        calibration,
        target,
        rects: rectsFor(target),
        helperConnected: false,
      });
      if (ui().headMode) {
        cameraKind = "hand";
        pipeline.setSettings(headModeConfig() as Partial<typeof settings>);
      }
      if (m.helperUrl) connectHelper(m.helperUrl);
      void startSource(m.source, m.replayUrl);
      break;
    }
    case "stream":
      if (mediapipe && source === mediapipe) mediapipe.attach(m.readable as ReadableStream<VideoFrame>);
      else pendingReadable = m.readable as ReadableStream<VideoFrame>;
      break;
    case "bitmap":
      if (mediapipe) mediapipe.pushBitmap(m.bitmap);
      else m.bitmap.close();
      break;
    case "settings":
      const prevUi: UiExtras = { headMode: ui().headMode, eyebrowLift: ui().eyebrowLift };
      settings = { ...settings, ...m.settings, inputs: { ...settings.inputs, ...(m.settings.inputs ?? {}) } };
      applyFaceSettings(prevUi);
      if (m.settings.keymap) sendKeymap();
      if (m.settings.trackingSource && m.settings.trackingSource !== cameraKind && !ui().headMode)
        switchCameraKind(m.settings.trackingSource);
      if (m.settings.stickerRange && mediapipe?.kind === "colorcap") mediapipe.setRange(m.settings.stickerRange);
      pipeline?.setSettings(
        m.settings,
      );
      break;
    case "window_rect": {
      const changed =
        !windowRect ||
        windowRect.x !== m.rect.x ||
        windowRect.y !== m.rect.y ||
        windowRect.w !== m.rect.w ||
        windowRect.h !== m.rect.h;
      windowRect = m.rect;
      const z = m.zoom && Number.isFinite(m.zoom) && m.zoom > 0 ? m.zoom : 1;
      if (z !== windowZoom) {
        windowZoom = z;
        applyRects();
      }
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
    case "set_target":
      if (m.target === "krita" && !helperOpen()) {
        pendingTarget = "krita";
        setStatus("Drawing in Krita needs the helper. Start it with npm run helper.");
        break;
      }
      pendingTarget = null;
      switchTarget(m.target);
      break;
    case "action":
      if (m.action === "connect_helper") {
        // R1: the page sends this only after the first-run privacy screen was acknowledged.
        if (!helper && m.variant) connectHelper(m.variant);
      } else if (m.action === "pick_sticker_colour") {
        void pickStickerColour();
      } else if (m.action === "recalibrate" || m.action === "next_judge") {
        runAction(m.action);
        startCalibration(CALIBRATION_STEPS);
      } else {
        // The page only posts pipeline actions; the pipeline ignores ids it does not know.
        runAction(m.action, m.variant, m.arg ?? null);
      }
      break;
    case "calibrate":
      runAction("recalibrate");
      startCalibration(m.steps);
      break;
    case "use_calibration":
      calibration = m.calibration;
      if (calibrator && pipeline) setCalibrating(pipeline, false);
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
        .then((reply) => {
          noteKritaReply(reply);
          post({ type: "reply", id: msg.id, msg: reply });
        })
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
