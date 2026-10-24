"use client";
/**
 * Steady's page (client only): pinned header + side-panel pages + practice canvas + pointer overlay.
 * Mirrors state from the tracking Worker; the page never opens a socket. Owned by B.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACTIONS, ACTIONS_BY_ID, COLOUR_HEX, DEFAULT_KEYS, type Action, type PageId } from "../actions";
import { HELPER_URL } from "../desktop/protocol";
import type {
  Calibration,
  CommandContext,
  InputSource,
  MirrorState,
  PipelineOutput,
  Resolution,
  SteadySettings,
  SteadyTestHooks,
  Vec2,
} from "../pipeline/types";
import { feedWorker, defaultMirrorFor, listCameras, openCamera, pickDefaultCamera, type CameraInfo } from "../tracking/camera";
import { WorkerBridge, type SendMsg } from "../tracking/workerBridge";
import { buildLookups, kritaMessageFor } from "../desktop/krita";
import {
  MicTile,
  markLastClaudeRejected,
  onClaudeLogChange,
  prewarmClaude,
  readClaudeLog,
  resolveClarify,
  resolveText,
  summariseClaudeLog,
  tts,
} from "../voice";
import { ActionTile, tileAvailable } from "./ActionTile";
import { ConfirmDialog, type DialogSpec } from "./ConfirmDialog";
import { ColourPage, DemoPage, PaintPage, SetupPage, SimplePage, SteadyPage, TimingPage, type DemoMetrics, type PageCtx } from "./Pages";
import {
  lastCalibration,
  loadCameraPrefs,
  loadKritaCanvas,
  loadLastCamera,
  loadSettings,
  loadSkin,
  markPrivacySeen,
  privacySeen,
  saveCalibration,
  saveCameraPref,
  saveKritaCanvas,
  saveLastCamera,
  saveSettings,
} from "./persist";
import { PointerOverlay, screenToViewport } from "./PointerOverlay";
import { PracticeCanvas, type PracticeCanvasHandle } from "./PracticeCanvas";
import { StrokeStore } from "./strokes";
import { Tile } from "./Tile";

declare global {
  interface Window {
    __steady?: SteadyTestHooks;
  }
}

export const PRIVACY_TEXT =
  "Camera frames never leave this computer; the camera sees the desk, so papers on it are visible to the app, and processing is local only. Microphone audio goes to Cartesia only while the mic is open. When the local grammar can't match a command, its text (never audio) plus the current tool, preset, size, opacity, colour, Steadiness and your last three actions go to our server and on to Anthropic. The helper and the Krita plugin listen on 127.0.0.1 only and send nothing off the machine.";

export const COACHING_TEXT =
  "Let your fingers curl loosely. Move from the elbow and shoulder; let the forearm slide; keep the wrist straight.";

const PAGES: Array<{ id: PageId; label: string; demoOnly?: boolean }> = [
  { id: "steady", label: "Steady" },
  { id: "setup", label: "Setup" },
  { id: "timing", label: "Timing" },
  { id: "demo", label: "Demo", demoOnly: true },
  { id: "paint", label: "Paint" },
  { id: "colour", label: "Colour" },
  { id: "view", label: "View" },
  { id: "layers", label: "Layers" },
];

/** Actions the Worker's pipeline runs (pen state, pause, latch, recenter, stroke modes). */
const WORKER_ACTIONS = new Set([
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
  "other_hand",
]);

const STEADIER_DEBOUNCE_MS = 1000;

interface Params {
  demo: boolean;
  source: "camera" | "replay";
  replay: string | null;
  helperUrl: string | null;
}

function readParams(): Params {
  const q = new URLSearchParams(window.location.search);
  const helper = q.get("helper");
  const source = q.get("source") === "replay" ? "replay" : "camera";
  return {
    demo: q.get("demo") === "1",
    source,
    replay: source === "replay" ? (q.get("replay") ?? "dev-circle") : null,
    helperUrl: helper === "off" ? null : helper || HELPER_URL,
  };
}

function viewportScreenRect() {
  return {
    x: window.screenX,
    y: window.screenY + (window.outerHeight - window.innerHeight),
    w: window.innerWidth,
    h: window.innerHeight,
  };
}

function isFormTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return ["BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable;
}

export default function SteadyApp() {
  const params = useMemo(readParams, []);
  const [settings, setSettings] = useState<SteadySettings>(loadSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const bridgeRef = useRef<WorkerBridge | null>(null);
  const mirrorRef = useRef<MirrorState | null>(null);
  const frameRef = useRef<PipelineOutput | null>(null);
  const [mirror, setMirror] = useState<MirrorState | null>(null);
  const [page, setPage] = useState<PageId>(params.demo ? "demo" : "steady");
  const [status, setStatus] = useState<string>("Starting…");
  const [alert, setAlert] = useState<string>("");
  const [lastUndo, setLastUndo] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const dialogRef = useRef<DialogSpec | null>(null);
  dialogRef.current = dialog;
  const [pttHeld, setPttHeld] = useState(false);
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [cameraId, setCameraId] = useState<string | null>(null);
  const [hasLastSetup, setHasLastSetup] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [marking, setMarking] = useState<string | null>(null);
  const [skinHex, setSkinHex] = useState<string | null>(null);
  const [lowLight, setLowLight] = useState(false);
  const [fallbackWarning, setFallbackWarning] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<DemoMetrics>({ commandsTried: 0, commandsOk: 0, claude: { calls: 0, accepted: 0, timeouts: 0 } });
  const metricsBase = useRef(0); // claude log length at the last Next judge

  const canvasRef = useRef<PracticeCanvasHandle | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const feedStopRef = useRef<(() => void) | null>(null);
  const lastSteadierRef = useRef(0);
  const lastActionsRef = useRef<string[]>([]);
  const kritaCtxRef = useRef<{ tool: string | null; preset: string | null; size: number | null; opacity: number | null; color: string | null }>({
    tool: null,
    preset: null,
    size: null,
    opacity: null,
    color: null,
  });
  const lookupsRef = useRef<Record<string, string>>({});
  const [eraserOn, setEraserOn] = useState(false);
  /** True while the most recent dispatched action came from a Claude resolution (undo right after = rejected). */
  const lastViaClaudeRef = useRef(false);
  const cornerRef = useRef<{ pts: Vec2[]; hist: Array<Vec2 & { t: number }> } | null>(null);

  const strokes = useMemo(
    () =>
      new StrokeStore(() => {
        const r = canvasRef.current?.el?.getBoundingClientRect();
        return { x: r?.left ?? 0, y: r?.top ?? 0 };
      }),
    [],
  );

  const getMirror = useCallback(() => mirrorRef.current, []);
  const getFrame = useCallback(() => frameRef.current, []);
  const helperOpen = mirror?.helper === "open";

  const say = useCallback((text: string, level: "status" | "alert" = "status") => {
    if (level === "alert") setAlert(text);
    else setStatus(text);
  }, []);

  // ---------------------------------------------------------------------------- settings
  const update = useCallback((patch: Partial<SteadySettings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    saveSettings(next);
    bridgeRef.current?.post({ type: "settings", settings: patch });
    if (next.cameraDeviceId && ("mirrorCamera" in patch || "rotateCamera" in patch)) {
      saveCameraPref(next.cameraDeviceId, { mirror: next.mirrorCamera, rotate: next.rotateCamera });
    }
  }, []);

  // ---------------------------------------------------------------------------- Krita dispatch
  const kritaDispatch = useCallback(
    async (a: Action, arg?: number | null) => {
      const bridge = bridgeRef.current;
      if (!bridge || mirrorRef.current?.helper !== "open") {
        say(`${a.label} needs the helper. Start it with npm run helper.`);
        return;
      }
      const built = kritaMessageFor(a, {
        arg,
        pluginConnected: !!mirrorRef.current?.kritaConnected,
        lookups: lookupsRef.current,
        skinHex: loadSkin(),
      });
      if ("error" in built) {
        say(
          built.error === "needs_plugin"
            ? "That needs the Krita plugin."
            : built.error === "no_skin"
              ? "Pick a colour, then say save skin."
              : `${a.label} is not available in Krita.`,
        );
        return;
      }
      const msg = built.msg as SendMsg;
      const r = await bridge.request(msg);
      if (r.t === "timeout") say("Krita did not answer.");
      else if ((r.t === "krita_reply" || r.t === "ack") && !r.ok) {
        say(r.error === "plugin_down" ? "That needs the Krita plugin." : r.error === "krita_not_running" ? "Krita is not running." : `Krita: ${r.error ?? "failed"}`);
      } else if (r.t === "error") {
        say(`Krita: ${r.code}`);
      } else {
        const extra = r as Record<string, unknown>;
        if (a.id === "eraser" && typeof extra.checked === "boolean") setEraserOn(extra.checked);
        if (a.krita?.clearsEraser) setEraserOn(false);
        if (a.id === "save_skin") {
          const color = (r as Record<string, unknown>).color;
          if (typeof color === "string") {
            localStorage.setItem("steady.skin.v1", JSON.stringify(color));
            setSkinHex(color);
            say("Skin colour saved.");
          }
        }
        if (a.id.startsWith("colour_")) kritaCtxRef.current.color = COLOUR_HEX[a.id.slice(7)] ?? null;
        if (["brush", "pencil", "ink", "airbrush", "eraser"].includes(a.id)) kritaCtxRef.current.tool = a.id;
        if (a.id === "size" && arg != null) kritaCtxRef.current.size = arg;
        if (a.id === "opacity" && arg != null) kritaCtxRef.current.opacity = arg;
        if (a.id !== "undo" && a.id !== "redo") setLastUndo(a.label);
      }
    },
    [say],
  );

  // ---------------------------------------------------------------------------- dispatcher
  const startCalibration = useCallback(() => {
    bridgeRef.current?.post({ type: "calibrate", steps: [1, 2, 3] });
    say("Calibrating. Rest your hand and hold still.");
  }, [say]);

  const dispatch = useCallback(
    (id: string, opts: { variant?: string; arg?: number | null; source?: InputSource; el?: HTMLElement | null } = {}) => {
      const a = ACTIONS_BY_ID[id];
      const bridge = bridgeRef.current;
      if (!a || !bridge) return;
      const source = opts.source ?? "tile";
      const m = mirrorRef.current;
      const target = m?.target ?? "canvas";
      lastActionsRef.current = [...lastActionsRef.current, id].slice(-3);

      // Dialog answers.
      const dlg = dialogRef.current;
      if (["yes", "no", "cancel", "choice_one", "choice_two", "choice_three"].includes(id)) {
        if (!dlg) return;
        setDialog(null);
        if (id === "no" || id === "cancel") dlg.onCancel?.();
        if (id === "yes" && dlg.kind === "confirm") dlg.onConfirm?.();
        if (id.startsWith("choice_") && dlg.kind === "choose") dlg.options?.[["choice_one", "choice_two", "choice_three"].indexOf(id)]?.run();
        return;
      }

      const viaClaude = source === "claude";
      if (id === "undo" && lastViaClaudeRef.current && !viaClaude) markLastClaudeRejected();
      lastViaClaudeRef.current = viaClaude;

      switch (id) {
        case "undo":
          if (target === "krita") void kritaDispatch(a);
          else if (strokes.undo()) {
            setLastUndo(strokes.count() ? "Stroke" : null);
            say("Undid the last stroke.");
          } else say("Nothing to undo.");
          return;
        case "redo":
          if (target === "krita") void kritaDispatch(a);
          else if (strokes.redo()) {
            setLastUndo("Stroke");
            say("Redid the stroke.");
          } else say("Nothing to redo.");
          return;
        case "steadier":
        case "looser": {
          const t = performance.now();
          if (source !== "tile" && t - lastSteadierRef.current < STEADIER_DEBOUNCE_MS) return;
          lastSteadierRef.current = t;
          const v = Math.max(0, Math.min(100, settingsRef.current.steadiness + (id === "steadier" ? 10 : -10)));
          update({ steadiness: v });
          say(`Steadiness ${v}.`);
          return;
        }
        case "simulate_tremor": {
          const on = !settingsRef.current.simulateTremor;
          update({ simulateTremor: on });
          say(on ? "Simulated tremor on." : "Simulated tremor off.");
          return;
        }
        case "next_judge":
          strokes.clear();
          setLastUndo(null);
          metricsBase.current = readClaudeLog().length;
          setMetrics({ commandsTried: 0, commandsOk: 0, claude: { calls: 0, accepted: 0, timeouts: 0 } });
          if (settingsRef.current.simulateTremor) update({ simulateTremor: false });
          bridge.post({ type: "reset_metrics" });
          bridge.post({ type: "action", action: "next_judge", source });
          say("Ready for the next judge. Rest your hand and hold still.");
          return;
        case "recalibrate":
          startCalibration();
          return;
        case "clear_practice": {
          const run = () => {
            strokes.clear();
            setLastUndo(null);
            say("Practice canvas cleared.");
          };
          setDialog({ kind: "confirm", title: "Clear the practice canvas?", body: "This removes every practice stroke.", onConfirm: run, returnFocus: opts.el ?? null });
          return;
        }
        case "quiet":
          update({ quiet: !settingsRef.current.quiet });
          return;
        case "mic":
          say("Use the Mic tile, or hold F10.");
          return;
        case "later":
          return;
        default:
          break;
      }
      if (WORKER_ACTIONS.has(id)) bridge.post({ type: "action", action: id, variant: opts.variant, arg: opts.arg ?? null, source });
      if (a.destructive && a.krita) {
        setDialog({ kind: "confirm", title: `${a.label}?`, body: "Krita's Undo can bring it back.", onConfirm: () => void kritaDispatch(a, opts.arg), returnFocus: opts.el ?? null });
        return;
      }
      if (a.krita && (a.scope === "krita" || target === "krita")) void kritaDispatch(a, opts.arg);
    },
    [kritaDispatch, say, startCalibration, strokes, update],
  );
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const run = useCallback((id: string, el: HTMLElement | null) => dispatchRef.current(id, { source: "tile", el }), []);

  // ---------------------------------------------------------------------------- voice / typed
  const getContext = useCallback(
    (): CommandContext => ({ ...kritaCtxRef.current, steadiness: settingsRef.current.steadiness, lastActions: lastActionsRef.current.slice(-3) }),
    [],
  );

  const onResolution = useCallback(
    (r: Resolution, source: InputSource = "voice") => {
      setMetrics((mm) => ({ ...mm, commandsTried: mm.commandsTried + 1, commandsOk: mm.commandsOk + (r.kind === "commands" ? 1 : 0) }));
      if (r.kind === "commands") {
        say(`Heard: ${r.heard}`);
        const src: InputSource = r.via === "claude" ? "claude" : source;
        r.commands.forEach((c, i) => setTimeout(() => dispatchRef.current(c.action, { variant: c.variant, arg: c.arg, source: src }), i * 50));
      } else if (r.kind === "noop") {
        say(`Heard: ${r.heard}`);
      } else {
        const ids = r.kind === "clarify" ? r.options : r.closest;
        const opts = ids
          .map((id) => ACTIONS_BY_ID[id])
          .filter(Boolean)
          .slice(0, 3)
          .map((a) => ({
            label: a.label,
            run: () => {
              if (r.kind === "clarify") resolveClarify(true);
              dispatchRef.current(a.id, { source: r.kind === "clarify" ? "claude" : source });
            },
          }));
        say(r.kind === "clarify" ? `Heard: ${r.heard}. Which one?` : `Didn't catch that; I heard ${r.heard}`);
        if (opts.length)
          setDialog({
            kind: "choose",
            title: r.kind === "clarify" ? "Which one?" : "Did you mean",
            body: `Heard: ${r.heard}`,
            options: opts,
            onCancel: r.kind === "clarify" ? () => resolveClarify(false) : undefined,
          });
        else if (r.kind === "clarify") resolveClarify(false);
      }
    },
    [say],
  );

  const submitTyped = useCallback(
    async (text: string) => {
      const dlg = dialogRef.current;
      const lower = text.trim().toLowerCase();
      if (dlg && (lower === "yes" || lower === "no" || lower === "cancel")) {
        dispatchRef.current(lower, { source: "typed" });
        return;
      }
      say(`Heard: ${text}`);
      const r = await resolveText(text, { mode: "typed", dialogOpen: !!dlg, context: getContext(), onStatus: (t, l) => say(t, l) });
      onResolution(r, "typed");
    },
    [getContext, onResolution, say],
  );
  const typedRef = useRef(submitTyped);
  typedRef.current = submitTyped;

  // ---------------------------------------------------------------------------- worker
  useEffect(() => {
    const bridge = new WorkerBridge();
    bridgeRef.current = bridge;
    const calib = null as Calibration | null;
    setHasLastSetup(!!lastCalibration());
    setShowPrivacy(!privacySeen());
    setSkinHex(loadSkin());
    let lastPush = 0;
    let lastClick = 0;

    const offMsg = bridge.onMessage$((m) => {
      switch (m.type) {
        case "state": {
          mirrorRef.current = m.state;
          const t = performance.now();
          if (t - lastPush > 100) {
            lastPush = t;
            setMirror(m.state);
          }
          break;
        }
        case "status":
          if (m.level === "alert") setAlert(m.text);
          else {
            setStatus(m.text);
            setAlert("");
          }
          break;
        case "error":
          setAlert(m.text);
          break;
        case "calibration":
          saveCalibration(m.calibration);
          setHasLastSetup(true);
          update({ steadiness: m.calibration.suggestedSteadiness, gainOverride: null });
          break;
        case "ready":
          setStatus(m.delegate === "replay" ? `Replay: ${params.replay}.` : `Tracking ready (${m.delegate}).`);
          break;
        case "helper": {
          const msg = m.msg;
          if (msg.t === "krita_reply") {
            const acts = (msg as Record<string, unknown>).actions;
            if (Array.isArray(acts)) lookupsRef.current = buildLookups(acts as Array<{ id: string; text: string }>);
          }
          if (msg.t === "hotkey") {
            // The Worker handled pen / pause / latch / recenter / ptt_down itself.
            if (msg.key === "undo") dispatchRef.current("undo", { source: "hotkey" });
            else if (msg.key === "redo") dispatchRef.current("redo", { source: "hotkey" });
            else if (msg.key === "other_hand" && tileAvailable("other_hand")) dispatchRef.current("other_hand", { source: "hotkey" });
            else if (msg.key === "ptt_down") setPttHeld(true);
            else if (msg.key === "ptt_up") setPttHeld(false);
          }
          break;
        }
        default:
          break;
      }
    });

    const offFrame = bridge.onFrame((out) => {
      frameRef.current = out;
      const m = mirrorRef.current;
      const target = m?.target ?? "canvas";
      if (target === "canvas" && strokes.feed(out)) setLastUndo("Stroke");
      else if (target === "krita" && out.pointer) strokes.trail.push({ ...out.pointer, t: out.t });
      // Page hover-dwell (§3): with no helper, the page activates the tile under the dwell itself.
      const d = out.dwell;
      if (d.kind === "click" && d.progress >= 1 && lastClick < 1 && !d.gated && target === "canvas" && m?.helper !== "open") {
        const el = document.elementFromPoint(d.x, d.y)?.closest("button") as HTMLButtonElement | null;
        if (el && !el.disabled) el.click();
      }
      lastClick = d.kind === "click" ? d.progress : 0;
      // Corner marking for Krita's canvas rect (P1).
      const cm = cornerRef.current;
      if (cm && out.pre && target === "krita") {
        cm.hist.push({ ...out.pre, t: out.t });
        while (cm.hist.length && cm.hist[0].t < out.t - 1000) cm.hist.shift();
        const span = cm.hist.length ? out.t - cm.hist[0].t : 0;
        const c = cm.hist.reduce((s, p) => ({ x: s.x + p.x / cm.hist.length, y: s.y + p.y / cm.hist.length }), { x: 0, y: 0 });
        if (span > 900 && cm.hist.every((p) => Math.hypot(p.x - c.x, p.y - c.y) < 15)) {
          cm.pts.push(c);
          cm.hist = [];
          if (cm.pts.length === 1) setMarking("Top-left marked. Now hold still on the bottom-right corner of Krita's canvas.");
          else {
            const [a, b] = cm.pts;
            const rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
            cornerRef.current = null;
            saveKritaCanvas(rect);
            bridge.post({ type: "canvas_rect", target: "krita", rect });
            setMarking(null);
            say("Krita canvas marked. Hold still on it to start drawing.");
          }
        }
      }
    });

    const s = settingsRef.current;
    bridge.post({
      type: "init",
      settings: s,
      calibration: calib,
      helperUrl: params.helperUrl,
      source: params.source,
      replayUrl: params.replay ? `/replay/${params.replay}.json` : undefined,
      demo: params.demo,
    });
    const kc = loadKritaCanvas();
    if (kc) bridge.post({ type: "canvas_rect", target: "krita", rect: kc });

    // Window rect on load, resize and every 1 s; practice canvas rect alongside.
    const report = () => {
      bridge.post({ type: "window_rect", rect: viewportScreenRect() });
      const r = canvasRef.current?.el?.getBoundingClientRect();
      if (r && r.width > 0) bridge.post({ type: "canvas_rect", target: "canvas", rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
    };
    report();
    window.addEventListener("resize", report);
    const iv = setInterval(report, 1000);

    window.__steady = {
      state: () => bridge.latest,
      strokeCount: () => strokes.count(),
      dispatch: (actionId, o) => dispatchRef.current(actionId, { variant: o?.variant, arg: o?.arg, source: o?.source ?? "tile" }),
      typed: (text) => typedRef.current(text),
      sentToHelper: () => bridge.sent.slice(),
    };

    return () => {
      offMsg();
      offFrame();
      clearInterval(iv);
      window.removeEventListener("resize", report);
      bridge.terminate();
      bridgeRef.current = null;
      feedStopRef.current?.();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      delete window.__steady;
    };
  }, [params, strokes, update, say]);

  // Claude pre-warm once at app start (E).
  useEffect(() => {
    void prewarmClaude().catch(() => undefined);
  }, []);

  // Spoken replies follow the settings (quiet mode turns TTS off).
  useEffect(() => {
    tts.setEnabled(settings.tts && settings.inputs.voice);
    tts.setQuiet(settings.quiet);
  }, [settings.tts, settings.quiet, settings.inputs.voice]);

  // Latch can be flipped by the helper's F3 in the Worker: persist what the Worker reports.
  useEffect(() => {
    if (mirror && mirror.latch !== settingsRef.current.latch) {
      const next = { ...settingsRef.current, latch: mirror.latch };
      settingsRef.current = next;
      setSettings(next);
      saveSettings(next);
    }
  }, [mirror]);

  // Claude metrics from E's log.
  useEffect(() => {
    const read = () => {
      const entries = readClaudeLog().slice(metricsBase.current);
      const s = summariseClaudeLog(entries);
      setMetrics((mm) => ({ ...mm, claude: { calls: s.calls, accepted: s.accepted, timeouts: s.timeouts } }));
    };
    read();
    return onClaudeLogChange(read);
  }, []);

  // ---------------------------------------------------------------------------- camera
  const startCamera = useCallback(
    async (deviceId: string | null) => {
      const bridge = bridgeRef.current;
      if (!bridge) return;
      feedStopRef.current?.();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      try {
        const stream = await openCamera(deviceId);
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        const actualId = track?.getSettings().deviceId ?? deviceId;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => undefined);
        }
        const fed = feedWorker(stream, bridge, videoRef.current);
        feedStopRef.current = fed.stop;
        setFallbackWarning(fed.workerPath ? null : "This Chrome can't track in the background: keep this window visible.");
        const cams = await listCameras();
        setCameras(cams);
        if (actualId) {
          setCameraId(actualId);
          saveLastCamera(actualId);
          const label = cams.find((c) => c.deviceId === actualId)?.label ?? track?.label ?? "";
          const pref = loadCameraPrefs()[actualId] ?? { mirror: defaultMirrorFor(label), rotate: false };
          update({ cameraDeviceId: actualId, mirrorCamera: pref.mirror, rotateCamera: pref.rotate });
        }
        return cams;
      } catch (err) {
        const name = (err as DOMException)?.name;
        setAlert(
          name === "NotAllowedError"
            ? "Chrome is blocking the camera. Allow the camera for this site, then reload."
            : "No camera found. Connect a camera (an iPhone over USB works), then reload.",
        );
        return [];
      }
    },
    [update],
  );

  useEffect(() => {
    if (params.source !== "camera") return;
    let cancelled = false;
    (async () => {
      const remembered = loadLastCamera();
      const cams = await startCamera(remembered);
      if (cancelled || !cams) return;
      // First run: prefer Desk View if Chrome lists it.
      if (!remembered) {
        const pick = pickDefaultCamera(cams);
        const current = streamRef.current?.getVideoTracks()[0]?.getSettings().deviceId;
        if (pick && pick.deviceId !== current) await startCamera(pick.deviceId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.source, startCamera]);

  // Lighting warning from the preview (main thread, once a second).
  useEffect(() => {
    if (params.source !== "camera") return;
    const c = document.createElement("canvas");
    c.width = 32;
    c.height = 24;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const iv = setInterval(() => {
      const v = videoRef.current;
      if (!ctx || !v || v.readyState < 2) return;
      ctx.drawImage(v, 0, 0, 32, 24);
      const d = ctx.getImageData(0, 0, 32, 24).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      setLowLight(sum / (d.length / 4) < 50);
    }, 1000);
    return () => clearInterval(iv);
  }, [params.source]);

  const chooseCamera = useCallback((id: string) => void startCamera(id), [startCamera]);
  const nextCamera = useCallback(() => {
    if (cameras.length < 2) return;
    const i = cameras.findIndex((c) => c.deviceId === cameraId);
    void startCamera(cameras[(i + 1) % cameras.length].deviceId);
  }, [cameras, cameraId, startCamera]);

  const useLastSetup = useCallback(() => {
    const c = lastCalibration();
    if (!c) return;
    bridgeRef.current?.post({ type: "use_calibration", calibration: c });
    update({ steadiness: settingsRef.current.steadiness });
  }, [update]);

  const setTarget = useCallback((t: "canvas" | "krita") => bridgeRef.current?.post({ type: "set_target", target: t }), []);
  const markCorners = useCallback(() => {
    cornerRef.current = { pts: [], hist: [] };
    setMarking("Hold still on the top-left corner of Krita's canvas.");
  }, []);

  // ---------------------------------------------------------------------------- keys (§4)
  useEffect(() => {
    const keymap = () => ({ ...DEFAULT_KEYS, ...settingsRef.current.keymap });
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (dialogRef.current) return; // the dialog handles Esc itself
        canvasRef.current?.focus();
        return;
      }
      const id = keymap()[e.key];
      if (!id) return;
      e.preventDefault(); // F5 must never reload the page
      if (mirrorRef.current?.helper === "open") return; // the helper is the single key source
      if (!settingsRef.current.inputs.keys) return;
      if (isFormTarget(e.target)) return;
      if (e.repeat) return;
      if (id === "mic") {
        setPttHeld(true);
        return;
      }
      if (!tileAvailable(id)) return;
      dispatchRef.current(id, { source: "key" });
    };
    const onUp = (e: KeyboardEvent) => {
      const id = keymap()[e.key];
      if (id === "mic") setPttHeld(false);
    };
    document.addEventListener("keydown", onDown);
    document.addEventListener("keyup", onUp);
    return () => {
      document.removeEventListener("keydown", onDown);
      document.removeEventListener("keyup", onUp);
    };
  }, []);

  // ---------------------------------------------------------------------------- render
  const word = mirror?.tracking ?? "Lost";
  const paused = !!mirror?.paused;
  const target = mirror?.target ?? "canvas";
  const helperText = !params.helperUrl ? "Helper off" : mirror?.helper === "open" ? (mirror.kritaConnected ? "Helper + Krita" : "Helper on") : mirror?.helper === "connecting" ? "Helper…" : "No helper";
  const calibrating = mirror?.calibrating ?? null;

  const ctx: PageCtx = {
    settings,
    mirror,
    run,
    update,
    source: params.source,
    replayName: params.replay,
    cameras,
    cameraId,
    chooseCamera,
    nextCamera,
    hasLastSetup,
    useLastSetup,
    helperOpen,
    setTarget,
    markCorners,
    marking,
    submitTyped,
    skinHex,
    eraserOn,
    metrics,
    strokes,
    getMirror,
  };

  const pages = PAGES.filter((p) => !p.demoOnly || params.demo);
  const header = ACTIONS.filter((a) => a.page === "header");
  const pageLabel = PAGES.find((p) => p.id === page)?.label ?? "";

  return (
    <div className="app" data-target={target}>
      <aside className="panel" aria-label="Steady side panel">
        <header className="panel-header">
          <h1 className="sr-only">Steady</h1>
          <div className="statusline">
            <span className={`dot dot-${word.toLowerCase()}`} aria-hidden="true" />
            <span className="tracking-word" data-testid="tracking-word">
              {word}
            </span>
            <span className="fps" aria-live="off" data-testid="fps">
              {mirror ? `${mirror.detectionFps} fps` : "– fps"}
            </span>
            <span className="helper-state" data-testid="helper-state">
              {helperText}
            </span>
          </div>
          <div className="undo-line" data-testid="undo-line">
            Undo: {lastUndo ?? "nothing yet"}
          </div>
          <div className={`status-box${alert ? " has-alert" : ""}`}>
            <div role="alert" className="alert-text" data-testid="alert">
              {alert}
            </div>
            <div role="status" className="status-text" data-testid="status">
              {status}
            </div>
          </div>
          <nav aria-label="Pages" className="tile-grid cols-4 tabs">
            {pages.map((p) => (
              <Tile key={p.id} label={p.label} current={page === p.id} onPress={() => setPage(p.id)} />
            ))}
          </nav>
          <div role="group" aria-label="Core actions" className="tile-grid cols-4">
            {header.map((a) =>
              a.id === "mic" ? (
                <div key="mic" className="mic-cell">
                  <MicTile
                    onResolution={(r) => onResolution(r, "voice")}
                    getContext={getContext}
                    quiet={settings.quiet}
                    disabled={!tileAvailable("mic") || !settings.inputs.voice}
                    pttHeld={pttHeld}
                    onMicOpen={() => bridgeRef.current?.post({ type: "action", action: "ptt", source: "voice" })}
                    onStatus={(t, l) => say(t, l)}
                    dialogOpen={!!dialog}
                    micSilenceMs={settings.micSilenceMs}
                    micCapMs={settings.micCapMs}
                  />
                </div>
              ) : (
                <ActionTile
                  key={a.id}
                  id={a.id}
                  run={run}
                  label={a.id === "pause" && paused ? "Resume" : undefined}
                  pressed={a.id === "pen_toggle" ? mirror?.pen === "DRAWING" : a.id === "latch" ? !!mirror?.latch : undefined}
                />
              ),
            )}
          </div>
        </header>
        <section className="page" aria-label={`${pageLabel} page`} data-page={page} data-testid="page">
          {page === "steady" && <SteadyPage ctx={ctx} />}
          {page === "setup" && <SetupPage ctx={ctx} />}
          {page === "timing" && <TimingPage ctx={ctx} />}
          {page === "demo" && params.demo && <DemoPage ctx={ctx} />}
          {page === "paint" && <PaintPage ctx={ctx} />}
          {page === "colour" && <ColourPage ctx={ctx} />}
          {(page === "view" || page === "layers") && <SimplePage page={page} ctx={ctx} />}
        </section>
        {dialog && (
          <ConfirmDialog
            spec={dialog}
            onClose={(how) => {
              setDialog(null);
              if (how === "cancel") dialog.onCancel?.();
            }}
          />
        )}
      </aside>

      <main className="main">
        <div className="main-top">
          <div className={`camera-box${mirror?.calibrated && !calibrating ? " small" : ""}`}>
            {params.source === "camera" ? (
              <video
                ref={videoRef}
                className="preview"
                muted
                playsInline
                aria-label="Camera preview"
                style={{ transform: `${settings.rotateCamera ? "rotate(180deg) " : ""}${settings.mirrorCamera ? "scaleX(-1)" : ""}` || undefined }}
              />
            ) : (
              <div className="preview replay-box">Replay: {params.replay}</div>
            )}
            <div className="camera-badge">
              <span className={`dot dot-${word.toLowerCase()}`} aria-hidden="true" /> {word}
            </div>
          </div>
          <div className="guide">
            {calibrating ? (
              <div className="calib">
                <p className="calib-step">Step {calibrating.step} of 3</p>
                <p className="calib-prompt">{calibrating.prompt}</p>
                <div className="progress" aria-hidden="true">
                  <div style={{ width: `${Math.round(calibrating.progress * 100)}%` }} />
                </div>
              </div>
            ) : (
              <p className="coach">
                {mirror?.calibrated ? "Hold still on the canvas to lower the pen; hold still again to lift it. " : "Calibrate on the Setup page (15 s), or just rest your hand and start. "}
                {COACHING_TEXT}
              </p>
            )}
            {lowLight && <p className="warn">The desk looks dark. Add light so tracking stays steady.</p>}
            {fallbackWarning && <p className="warn">{fallbackWarning}</p>}
            {showPrivacy && (
              <div className="privacy">
                <h2>Privacy</h2>
                <p>{PRIVACY_TEXT}</p>
                <button
                  type="button"
                  className="tile tile-default"
                  onClick={() => {
                    markPrivacySeen();
                    setShowPrivacy(false);
                  }}
                >
                  <span className="tile-label">Got it</span>
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="canvas-wrap">
          <PracticeCanvas ref={canvasRef} store={strokes} demo={params.demo} getMirror={getMirror} />
        </div>
      </main>
      <PointerOverlay getFrame={getFrame} getMirror={getMirror} />
    </div>
  );
}

export { screenToViewport };
