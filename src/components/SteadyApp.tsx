"use client";
/**
 * Steady's page (client only): pinned header + side-panel pages + practice canvas + pointer overlay.
 * Mirrors state from the tracking Worker; the page never opens a socket. Owned by B.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACTIONS, ACTIONS_BY_ID, COLOUR_HEX, DEFAULT_KEYS, type Action, type PageId } from "../actions";
import { HELPER_URL } from "../desktop/protocol";
import { CAMERA_W, MENU_BAR_PT, STORAGE_KEYS } from "../pipeline/types";
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
import { WORKER_EVENTS_CHANNEL, type WorkerEvent } from "../tracking/sentChannel";
import { buildLookups } from "../desktop/krita";
import { appMessageFor } from "../desktop/apps";
import { validateAlias } from "../pipeline/grammar";
import { mirrorCalibration } from "../pipeline/calibration";
import { handPresetSettings, isHandPreset } from "../pipeline/presets";
import {
  defaultProfileStore,
  parseProfiles,
  saveProfile as saveProfileIn,
  serializeProfiles,
  useProfile as profileFromStore,
  type ProfileStore,
} from "../pipeline/profiles";
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
  speakConfirmation,
  isAliasTaken,
  type ConfirmationKind,
} from "../voice";
import { ActionTile, tileAvailable } from "./ActionTile";
import { ConfirmDialog, type DialogSpec } from "./ConfirmDialog";
import {
  ColourPage,
  DemoPage,
  PaintPage,
  SetupPage,
  LayersPage,
  ModesPage,
  InputPage,
  KritaPage,
  type UiSettings,
  type NumberItem,
  SteadyPage,
  TimingPage,
  ViewPage,
  type DemoMetrics,
  type PageCtx,
} from "./Pages";
import {
  lastCalibration,
  loadCalibrations,
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
import { playEarcon } from "./earcons";
import { EXPOSURE_LOCKED, lockExposure, unlockExposure } from "../tracking/exposure";
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

type UiPage = PageId | "modes" | "input" | "krita";

/** Tabs, 4 per row. P4 added Modes / Input / Krita so every page still fits 320 × 900. */
const PAGES: Array<{ id: UiPage; label: string; demoOnly?: boolean }> = [
  { id: "steady", label: "Steady" },
  { id: "modes", label: "Modes" },
  { id: "setup", label: "Setup" },
  { id: "input", label: "Input" },
  { id: "timing", label: "Timing" },
  { id: "krita", label: "Krita" },
  { id: "paint", label: "Paint" },
  { id: "colour", label: "Colour" },
  { id: "view", label: "View" },
  { id: "layers", label: "Layers" },
  { id: "demo", label: "Demo", demoOnly: true },
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
  "smoothing_sketch",
  "smoothing_ink",
  "smoothing_shade",
  "dash",
  "repeat",
  "pan",
  "pick",
  "line",
  "pick_sticker_colour",
]);

const STEADIER_DEBOUNCE_MS = 1000;
const BREAK_EVERY_MS = 20 * 60 * 1000;

const TIPS_KEY = "steady.tipsShown.v1";
function tipShown(id: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(TIPS_KEY) ?? "[]") as string[]).includes(id);
  } catch {
    return false;
  }
}
function markTipShown(id: string) {
  try {
    const all = JSON.parse(localStorage.getItem(TIPS_KEY) ?? "[]") as string[];
    localStorage.setItem(TIPS_KEY, JSON.stringify([...all, id]));
  } catch {
    /* ignore */
  }
}

/**
 * The button under (x, y), or — with a hover tolerance (Hard to hold still: 40 px) — the nearest enabled
 * button whose rectangle is within `tolPx` of the point.
 */
function buttonNear(x: number, y: number, tolPx: number): HTMLButtonElement | null {
  const hit = document.elementFromPoint(x, y)?.closest("button") as HTMLButtonElement | null;
  if (hit || !tolPx) return hit;
  const scope: ParentNode = document.querySelector("[role=alertdialog], [role=dialog]") ?? document;
  let best: HTMLButtonElement | null = null;
  let bestD = Infinity;
  for (const b of Array.from(scope.querySelectorAll<HTMLButtonElement>("button:not([disabled])"))) {
    const r = b.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const dd = Math.hypot(dx, dy);
    if (dd <= tolPx && dd < bestD) {
      best = b;
      bestD = dd;
    }
  }
  return best;
}

function loadAliases(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.aliases) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}
function saveAliases(a: Record<string, string>) {
  try {
    localStorage.setItem(STORAGE_KEYS.aliases, JSON.stringify(a));
  } catch {
    /* ignore */
  }
}


interface Params {
  demo: boolean;
  source: "camera" | "replay";
  replay: string | null;
  helperUrl: string | null;
  /** ?target=krita forces the Krita target as soon as a helper is connected (P1 tests with the fake helper). */
  target: "canvas" | "krita";
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
    target: q.get("target") === "krita" ? "krita" : "canvas",
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
  const [settings, setSettings] = useState<UiSettings>(() => loadSettings() as UiSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const bridgeRef = useRef<WorkerBridge | null>(null);
  const mirrorRef = useRef<MirrorState | null>(null);
  const frameRef = useRef<PipelineOutput | null>(null);
  const [mirror, setMirror] = useState<MirrorState | null>(null);
  const [page, setPage] = useState<UiPage>(params.demo ? "demo" : "steady");
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
  const [metrics, setMetrics] = useState<DemoMetrics>({
    commandsTried: 0,
    commandsOk: 0,
    claude: { calls: 0, accepted: 0, timeouts: 0 },
  });
  const metricsBase = useRef(0); // claude log length at the last Next judge

  const canvasRef = useRef<PracticeCanvasHandle | null>(null);
  const pageRef = useRef<HTMLElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const feedStopRef = useRef<(() => void) | null>(null);
  const lastSteadierRef = useRef(-Infinity);
  const lastActionsRef = useRef<string[]>([]);
  const kritaCtxRef = useRef<{
    tool: string | null;
    preset: string | null;
    size: number | null;
    opacity: number | null;
    color: string | null;
  }>({
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

  /** TTS (E): only what can't be seen; never on pen toggles; tts itself is silent while the mic is open or in quiet mode. */
  const speak = useCallback((kind: ConfirmationKind, heard?: string) => {
    if (settingsRef.current.quiet || !settingsRef.current.tts) return;
    void speakConfirmation(kind, heard).catch(() => undefined);
  }, []);

  // Break nudge (P2b): every 20 min of session, deferred until the pen is up; off by default in Demo mode.
  const sessionStartRef = useRef(Date.now());
  const nextNudgeAtRef = useRef(Date.now() + BREAK_EVERY_MS);
  const [nudge, setNudge] = useState<string | null>(null);
  const nudgeRef = useRef<string | null>(null);
  nudgeRef.current = nudge;
  const hideNudge = useCallback((snooze: boolean) => {
    setNudge(null);
    nudgeRef.current = null;
    nextNudgeAtRef.current = Date.now() + BREAK_EVERY_MS;
    if (snooze) setStatus("Break reminder: later.");
  }, []);
  const aliasesRef = useRef<Record<string, string>>({});
  const trackSource = settings.trackingSource ?? "hand";
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [exposureLocked, setExposureLocked] = useState(false);
  const exposureLockedRef = useRef(false);
  /** Exposure lock (P3) on the ORIGINAL camera track (the Worker gets a clone). */
  const setExposureLock = useCallback(async (on: boolean) => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) {
      if (on) setStatus("Exposure lock needs a camera.");
      return;
    }
    if (on) {
      const r = await lockExposure(track);
      exposureLockedRef.current = r === EXPOSURE_LOCKED;
      setExposureLocked(exposureLockedRef.current);
      setStatus(r);
    } else {
      exposureLockedRef.current = false;
      setExposureLocked(false);
      setStatus(await unlockExposure(track));
    }
  }, []);
  const lastLocalSteadyRef = useRef(0);
  const lastLocalLatchRef = useRef(0);
  const [profileStore, setProfileStore] = useState<ProfileStore>(defaultProfileStore);
  const profileStoreRef = useRef(profileStore);
  const [numbers, setNumbers] = useState<NumberItem[] | null>(null);
  const numbersRef = useRef<NumberItem[] | null>(null);

  // ---------------------------------------------------------------------------- settings
  const update = useCallback((patch: Partial<UiSettings>) => {
    const next = { ...settingsRef.current, ...patch };
    if ("steadiness" in patch) lastLocalSteadyRef.current = performance.now();
    if ("latch" in patch) lastLocalLatchRef.current = performance.now();
    settingsRef.current = next;
    setSettings(next);
    saveSettings(next);
    // Extra keys (dwellRadius, lockLandmark, headMode, …) ride along; the pipeline reads what it knows.
    bridgeRef.current?.post({ type: "settings", settings: patch as Partial<SteadySettings> });
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
      const app = settingsRef.current.appProfile ?? "krita";
      const built = appMessageFor(a, app, {
        arg,
        pluginConnected: !!mirrorRef.current?.kritaConnected,
        lookups: lookupsRef.current,
        skinHex: loadSkin(),
      });
      if ("error" in built) {
        say(
          built.error === "needs_plugin"
            ? app === "photoshop"
              ? `Photoshop: no shortcut for ${a.label}.`
              : "That needs the Krita plugin."
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
        say(
          r.error === "plugin_down"
            ? "That needs the Krita plugin."
            : r.error === "krita_not_running"
              ? "Krita is not running."
              : `Krita: ${r.error ?? "failed"}`,
        );
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
            speak("skin_saved");
          }
        }
        if (a.id.startsWith("colour_")) kritaCtxRef.current.color = COLOUR_HEX[a.id.slice(7)] ?? null;
        if (["brush", "pencil", "ink", "airbrush", "eraser"].includes(a.id)) kritaCtxRef.current.tool = a.id;
        if (a.id === "size" && arg != null) kritaCtxRef.current.size = arg;
        if (a.id === "opacity" && arg != null) kritaCtxRef.current.opacity = arg;
        if (a.id !== "undo" && a.id !== "redo") setLastUndo(a.label);
        // Spoken only for what can't be seen at a glance (§8).
        if (a.id === "save") speak("saved");
        if (a.id === "new_layer") speak("new_layer");
        if (a.id === "save") say("Saved.");
      }
    },
    [say, speak],
  );

  /** Store the current Krita preset under `word` (aliases, P2b). */
  const nameBrush = useCallback(
    async (wordIn: string) => {
      const word = wordIn.trim().toLowerCase();
      if (!word || /\s/.test(word)) {
        say("Use one word for the brush name.");
        return;
      }
      if (validateAlias(word) === "taken") {
        say("That word is taken.");
        speak("word_taken");
        return;
      }
      const bridge = bridgeRef.current;
      if (!bridge || mirrorRef.current?.helper !== "open" || !mirrorRef.current?.kritaConnected) {
        say("Naming a brush needs the Krita plugin.");
        return;
      }
      const r = await bridge.request({ t: "krita", cmd: "get_state" } as SendMsg);
      const preset = r.t === "krita_reply" && r.ok ? (r as Record<string, unknown>).preset : null;
      if (typeof preset !== "string" || !preset) {
        say("Krita did not say which brush is active.");
        return;
      }
      const all = { ...loadAliases(), [word]: preset };
      saveAliases(all);
      aliasesRef.current = all;
      setAliases(all);
      say(`Say ${word} to pick ${preset}.`);
      speak("brush_named");
    },
    [say, speak],
  );

  // ---------------------------------------------------------------------------- profiles (P4)
  const persistProfiles = useCallback((st: ProfileStore) => {
    profileStoreRef.current = st;
    setProfileStore(st);
    try {
      localStorage.setItem(STORAGE_KEYS.profiles, serializeProfiles(st));
    } catch {
      /* ignore */
    }
  }, []);
  const applyProfile = useCallback(
    (name: string) => {
      const r = profileFromStore(profileStoreRef.current, name);
      if (!r) {
        say(`No profile called ${name}.`);
        return;
      }
      persistProfiles(r.store);
      update(r.profile.settings as Partial<UiSettings>);
      const cal = r.profile.calibration;
      const c = cal ? (cal.Right ?? cal.Left) : null;
      if (c) bridgeRef.current?.post({ type: "use_calibration", calibration: c });
      say(`Profile: ${r.profile.name}.`);
    },
    [persistProfiles, say, update],
  );
  const saveProfileNamed = useCallback(
    (name: string) => {
      const st = saveProfileIn(profileStoreRef.current, name, settingsRef.current as unknown as Record<string, unknown>);
      persistProfiles(st);
      say(`Saved profile ${st.active}.`);
    },
    [persistProfiles, say],
  );
  const applyProfileRef = useRef(applyProfile);
  applyProfileRef.current = applyProfile;
  const saveProfileNamedRef = useRef(saveProfileNamed);
  saveProfileNamedRef.current = saveProfileNamed;

  // ---------------------------------------------------------------------------- numbered overlay (P4)
  const hideNumbers = useCallback(
    (why: string | null) => {
      const had = numbersRef.current !== null;
      numbersRef.current = null;
      setNumbers(null);
      if (mirrorRef.current?.helper === "open") void bridgeRef.current?.request({ t: "numbers", items: null } as SendMsg);
      if (why && had) say(why);
    },
    [say],
  );
  const showNumbers = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge || mirrorRef.current?.helper !== "open") {
      say("Show numbers needs the helper. Start it with npm run helper.");
      return;
    }
    const r = await bridge.request({ t: "krita", cmd: "list_widgets" } as SendMsg);
    const widgets = r.t === "krita_reply" && r.ok ? ((r as Record<string, unknown>).widgets as NumberItem[] | undefined) : undefined;
    if (!widgets || !widgets.length) {
      say(r.t === "krita_reply" && r.error === "plugin_down" ? "Show numbers needs the Krita plugin." : "Krita listed no buttons to number.");
      return;
    }
    numbersRef.current = widgets;
    setNumbers(widgets);
    const ack = await bridge.request({ t: "numbers", items: widgets } as SendMsg);
    const ok = ack.t === "ack" && ack.ok;
    say(ok ? `${widgets.length} numbers shown. Say click and a number.` : `${widgets.length} numbers listed on the View page. Say click and a number.`);
  }, [say]);
  const clickNumber = useCallback(
    (n: number) => {
      const item = numbersRef.current?.find((i) => i.n === n);
      if (!item) {
        say(numbersRef.current ? `No number ${n}.` : "Show numbers first.");
        return;
      }
      const x = Math.round(item.rect.x + item.rect.w / 2);
      const y = Math.round(item.rect.y + item.rect.h / 2);
      const m = mirrorRef.current;
      const kw = m?.kritaWindowRect;
      const top = 0;
      // Dwell-click rules: only inside Krita's window, never the menu bar.
      if (y < top + MENU_BAR_PT || (kw && !(x >= kw.x && y >= kw.y && x <= kw.x + kw.w && y <= kw.y + kw.h))) {
        say(`Number ${n} is outside Krita's window.`);
        return;
      }
      void bridgeRef.current?.request({ t: "click", x, y } as SendMsg);
      setLastUndo(item.label);
      say(`Clicked ${n}: ${item.label}.`);
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
      const bridge = bridgeRef.current;
      // The user's next action dismisses the break nudge and still executes (rule 5).
      if (nudgeRef.current && id !== "later") hideNudge(false);
      if (id === "alias") {
        // Grammar-only id: a user alias → choose the stored preset by name.
        if (opts.variant && bridge) {
          void bridge.request({ t: "krita", cmd: "preset", name: opts.variant } as SendMsg).then((r) => {
            if (r.t === "krita_reply" && !r.ok) say(r.error === "plugin_down" ? "That needs the Krita plugin." : `Krita: ${r.error}`);
            else if (r.t === "timeout") say("Krita did not answer.");
            else setLastUndo(opts.variant ?? null);
          });
        }
        return;
      }
      const a = ACTIONS_BY_ID[id];
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
        if (id.startsWith("choice_") && dlg.kind === "choose")
          dlg.options?.[["choice_one", "choice_two", "choice_three"].indexOf(id)]?.run();
        return;
      }

      const viaClaude = source === "claude";
      if (id === "undo" && lastViaClaudeRef.current && !viaClaude) markLastClaudeRejected();
      lastViaClaudeRef.current = viaClaude;

      if ((id === "undo" || id === "redo") && opts.arg != null && opts.arg > 1) {
        // Coalesced "undo that undo that": run serially 50 ms apart.
        const n = Math.min(20, Math.round(opts.arg));
        for (let i = 0; i < n; i++) setTimeout(() => dispatchRef.current(id, { source }), i * 50);
        return;
      }

      if (isHandPreset(id)) {
        const { tip, ...preset } = handPresetSettings(id);
        update(preset as Partial<UiSettings>);
        bridge.post({ type: "action", action: id, source });
        say(`${a.label}: Steadiness ${preset.steadiness}.`);
        if (tip && !tipShown(id)) {
          markTipShown(id);
          setTimeout(() => say(tip.replace(/\*/g, "")), 50);
        }
        return;
      }

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
          if ((source === "voice" || source === "claude") && t - lastSteadierRef.current < STEADIER_DEBOUNCE_MS) return;
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
          if (exposureLockedRef.current) void setExposureLock(false);
          startCalibration();
          return;
        case "lock_exposure":
          void setExposureLock(!exposureLockedRef.current);
          return;
        case "clear_practice": {
          const run = () => {
            strokes.clear();
            setLastUndo(null);
            say("Practice canvas cleared.");
          };
          setDialog({
            kind: "confirm",
            title: "Clear the practice canvas?",
            body: "This removes every practice stroke.",
            onConfirm: run,
            returnFocus: opts.el ?? null,
          });
          return;
        }
        case "quiet": {
          const on = !settingsRef.current.quiet;
          update({ quiet: on });
          say(on ? "Quiet mode on: mic, spoken replies and click sounds off." : "Quiet mode off.");
          return;
        }
        case "mic":
          say("Use the Mic tile, or hold F10.");
          return;
        case "later":
          hideNudge(true);
          return;
        case "other_hand": {
          bridge.post({ type: "action", action: "other_hand", source });
          const stored = loadCalibrations();
          const current = lastCalibration();
          const cur = current?.handedness ?? "Right";
          const other = cur === "Right" ? "Left" : "Right";
          const mine = stored[other];
          if (mine) {
            bridge.post({ type: "use_calibration", calibration: mine });
            say(`Using your ${other.toLowerCase()} hand setup.`);
          } else {
            if (current) bridge.post({ type: "use_calibration", calibration: mirrorCalibration(current, CAMERA_W) });
            bridge.post({ type: "calibrate", steps: [1, 2] });
            say(`${other} hand: rest it and hold still.`);
          }
          return;
        }
        case "use_profile":
        case "save_profile": {
          const name = opts.variant?.trim();
          if (name) {
            if (id === "use_profile") applyProfileRef.current(name);
            else saveProfileNamedRef.current(name);
          } else
            setDialog({
              kind: "name",
              title: a.label,
              body: id === "use_profile" ? "Type the profile's name, e.g. Shaky day." : "Name these settings, e.g. Evening.",
              inputLabel: "Profile name",
              onName: (w) => (id === "use_profile" ? applyProfileRef.current(w) : saveProfileNamedRef.current(w)),
              returnFocus: opts.el ?? null,
            });
          return;
        }
        case "show_numbers":
          void showNumbers();
          return;
        case "hide_numbers":
          hideNumbers("Numbers hidden.");
          return;
        case "click_number": {
          const n = opts.arg ?? (opts.variant ? Number(opts.variant) : NaN);
          if (Number.isFinite(n)) clickNumber(Number(n));
          else
            setDialog({
              kind: "name",
              title: "Click number",
              body: numbersRef.current ? "Which number?" : "Show numbers first.",
              inputLabel: "Number",
              onName: (w) => clickNumber(Number(w)),
              returnFocus: opts.el ?? null,
            });
          return;
        }
        case "head_mode": {
          const on = !settingsRef.current.headMode;
          update({ headMode: on });
          say(on ? "Head mode: the pointer follows your nose tip." : "Head mode off: tracking your hand.");
          return;
        }
        case "eyebrow_lift": {
          const on = !settingsRef.current.eyebrowLift;
          update({ eyebrowLift: on });
          say(on ? "Eyebrow lift on: raise your eyebrows to lift the pen." : "Eyebrow lift off.");
          return;
        }
        case "app_profile": {
          const cur = settingsRef.current.appProfile ?? "krita";
          const next = opts.variant === "krita" || opts.variant === "photoshop" ? opts.variant : cur === "krita" ? "photoshop" : "krita";
          update({ appProfile: next });
          say(
            next === "photoshop"
              ? "Photoshop: shortcuts only. Restart the helper with: npm run helper -- --app photoshop"
              : "Krita: plugin and shortcuts.",
          );
          return;
        }
        case "name_brush":
          if (opts.variant) void nameBrush(opts.variant);
          else
            setDialog({
              kind: "name",
              title: "Name this brush",
              body: "One word. Say or type it later to pick this brush.",
              onName: (w) => void nameBrush(w),
              returnFocus: opts.el ?? null,
            });
          return;
        default:
          break;
      }
      if (WORKER_ACTIONS.has(id))
        bridge.post({ type: "action", action: id, variant: opts.variant, arg: opts.arg ?? null, source });
      if (a.destructive && a.krita) {
        setDialog({
          kind: "confirm",
          title: `${a.label}?`,
          body: "Krita's Undo can bring it back.",
          onConfirm: () => void kritaDispatch(a, opts.arg),
          returnFocus: opts.el ?? null,
        });
        return;
      }
      if (a.krita && (a.scope === "krita" || target === "krita")) void kritaDispatch(a, opts.arg);
    },
    [kritaDispatch, say, startCalibration, strokes, update, nameBrush, hideNudge, showNumbers, hideNumbers, clickNumber],
  );
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const run = useCallback((id: string, el: HTMLElement | null) => dispatchRef.current(id, { source: "tile", el }), []);

  // ---------------------------------------------------------------------------- voice / typed
  const getContext = useCallback(
    (): CommandContext => ({
      ...kritaCtxRef.current,
      steadiness: settingsRef.current.steadiness,
      lastActions: lastActionsRef.current.slice(-3),
    }),
    [],
  );

  const onResolution = useCallback(
    (r: Resolution, source: InputSource = "voice") => {
      setMetrics((mm) => ({
        ...mm,
        commandsTried: mm.commandsTried + 1,
        commandsOk: mm.commandsOk + (r.kind === "commands" ? 1 : 0),
      }));
      if (r.kind === "commands") {
        say(`Heard: ${r.heard}`);
        const src: InputSource = r.via === "claude" ? "claude" : source;
        r.commands.forEach((c, i) =>
          setTimeout(() => dispatchRef.current(c.action, { variant: c.variant, arg: c.arg, source: src }), i * 50),
        );
      } else if (r.kind === "noop") {
        say(`Heard: ${r.heard}`);
      } else {
        // Voice fallbacks the MicTile cannot know about (MicTileProps has no aliases): user aliases and
        // "call this brush <word>".
        const heard = r.heard.trim().toLowerCase();
        if (isAliasTaken(r)) {
          say("That word is taken.");
          speak("word_taken");
          return;
        }
        const naming = /^call this brush\s+(\S+)$/.exec(heard);
        if (r.kind === "none" && naming && !dialogRef.current) {
          dispatchRef.current("name_brush", { variant: naming[1], source });
          return;
        }
        if (r.kind === "none" && aliasesRef.current[heard] && !dialogRef.current) {
          say(`Heard: ${r.heard}`);
          dispatchRef.current("alias", { variant: aliasesRef.current[heard], source });
          return;
        }
        if (r.kind === "none") speak("didnt_catch", r.heard);
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
    [say, speak],
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
      const prof = /^(save profile|use profile|profile)\s+(.+)$/i.exec(text.trim());
      if (prof && !dlg) {
        dispatchRef.current(/^save/i.test(prof[1]) ? "save_profile" : "use_profile", { variant: prof[2], source: "typed" });
        return;
      }
      const alias = /^(?:alias|call this brush)\s+(\S+)$/i.exec(text.trim());
      if (alias && !dlg) {
        dispatchRef.current("name_brush", { variant: alias[1], source: "typed" });
        return;
      }
      const r = await resolveText(text, {
        aliases: aliasesRef.current,
        mode: "typed",
        dialogOpen: !!dlg,
        context: getContext(),
        onStatus: (t, l) => say(t, l),
      });
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
          // §2/P3: lock exposure on the original camera track once calibrated.
          if (params.source === "camera") void setExposureLock(true);
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
            else if (msg.key === "other_hand" && tileAvailable("other_hand"))
              dispatchRef.current("other_hand", { source: "hotkey" });
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
      if (settingsRef.current.earcons && !settingsRef.current.quiet) {
        for (const e of out.events) if (e.type === "down" || e.type === "up") playEarcon(e.type);
      }
      const m = mirrorRef.current;
      const target = m?.target ?? "canvas";
      if (target === "canvas" && strokes.feed(out)) setLastUndo("Stroke");
      else if (target === "krita" && out.pointer) strokes.trail.push({ ...out.pointer, t: out.t });
      // Page hover-dwell (§3): with no helper, the page activates the tile under the dwell itself.
      const d = out.dwell;
      if (d.kind === "click" && d.progress >= 1 && lastClick < 1 && !d.gated && target === "canvas" && m?.helper !== "open") {
        const el = buttonNear(d.x, d.y, settingsRef.current.tileHoverPx ?? 0);
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
    if (params.target === "krita") bridge.post({ type: "set_target", target: "krita" });
    // The picked sticker range comes back from the Worker; persist it with the settings.
    const evCh = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(WORKER_EVENTS_CHANNEL) : null;
    if (evCh)
      evCh.onmessage = (ev: MessageEvent<WorkerEvent>) => {
        if (ev.data?.kind === "sticker_range") {
          const next = { ...settingsRef.current, stickerRange: ev.data.range };
          settingsRef.current = next;
          setSettings(next);
          saveSettings(next);
        }
      };
    const kc = loadKritaCanvas();
    if (kc) bridge.post({ type: "canvas_rect", target: "krita", rect: kc });

    // Window rect on load, resize and every 1 s; practice canvas rect alongside.
    let lastWindowRect: ReturnType<typeof viewportScreenRect> | null = null;
    const report = () => {
      lastWindowRect = viewportScreenRect();
      bridge.post({ type: "window_rect", rect: lastWindowRect });
      const r = canvasRef.current?.el?.getBoundingClientRect();
      if (r && r.width > 0)
        bridge.post({ type: "canvas_rect", target: "canvas", rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
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
      setTarget: (t) => bridge.post({ type: "set_target", target: t }),
      windowRect: () => lastWindowRect,
    };

    return () => {
      offMsg();
      offFrame();
      clearInterval(iv);
      window.removeEventListener("resize", report);
      bridge.terminate();
      evCh?.close();
      bridgeRef.current = null;
      feedStopRef.current?.();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      delete window.__steady;
    };
  }, [params, strokes, update, say]);

  // Profiles from storage ("Steady day" / "Shaky day" always exist).
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEYS.profiles);
    } catch {
      /* ignore */
    }
    const st = parseProfiles(raw);
    profileStoreRef.current = st;
    setProfileStore(st);
  }, []);

  // Numbers hide on Pause and when Krita's window moves (the badges would point at the wrong place).
  const kwKey = mirror?.kritaWindowRect ? JSON.stringify(mirror.kritaWindowRect) : "";
  const pausedNow = !!mirror?.paused;
  const kwKeyRef = useRef(kwKey);
  useEffect(() => {
    if (pausedNow && numbersRef.current) hideNumbers("Numbers hidden while paused.");
    if (kwKey !== kwKeyRef.current) {
      if (numbersRef.current && kwKeyRef.current) hideNumbers("Krita moved: say show numbers again.");
      kwKeyRef.current = kwKey;
    }
  }, [pausedNow, kwKey, hideNumbers]);

  // Aliases from storage.
  useEffect(() => {
    aliasesRef.current = loadAliases();
    setAliases(aliasesRef.current);
  }, []);

  // Break nudge timer (P2b; not in Demo mode). Shown only while the pen is up.
  useEffect(() => {
    if (params.demo || !tileAvailable("later")) return;
    const iv = setInterval(() => {
      if (nudgeRef.current || Date.now() < nextNudgeAtRef.current) return;
      if (mirrorRef.current?.pen === "DRAWING") return; // deferred until the pen is up
      const mins = Math.round((Date.now() - sessionStartRef.current) / 60000);
      const text = `You've been drawing for ${mins} minutes. Time for a short break?`;
      setNudge(text);
      setStatus(text);
    }, 5000);
    return () => clearInterval(iv);
  }, [params.demo]);

  // Stroke-mode status (Hatch shows its look-ahead lag while on).
  const modeNow = mirror?.mode ?? "normal";
  useEffect(() => {
    if (modeNow === "hatch" || modeNow === "hatch_alternate")
      setStatus(`Hatch: forward passes only (lag ${settingsRef.current.hatchLagMs} ms).`);
    else if (modeNow === "dots") setStatus("Dots: each hold stamps one dot.");
    else if (modeNow === "dash") setStatus("Dash: ink only while moving.");
  }, [modeNow]);

  // The pipeline may change Steadiness itself (smoothing presets): adopt it unless the user just moved it.
  useEffect(() => {
    if (!mirror) return;
    if (performance.now() - lastLocalSteadyRef.current < 1500) return;
    if (mirror.steadiness !== settingsRef.current.steadiness) {
      const next = { ...settingsRef.current, steadiness: mirror.steadiness };
      settingsRef.current = next;
      setSettings(next);
      saveSettings(next);
    }
  }, [mirror]);

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
    if (mirror && mirror.latch !== settingsRef.current.latch && performance.now() - lastLocalLatchRef.current > 1500) {
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
      if (exposureLockedRef.current) void setExposureLock(false);
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

  const setTrackSource = useCallback(
    (k: "hand" | "colorcap") => {
      update({ trackingSource: k });
      // The new source needs a fresh camera stream.
      if (params.source === "camera") void startCamera(settingsRef.current.cameraDeviceId);
    },
    [params.source, startCamera, update],
  );

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

  // A page that scrolls (200 % zoom) must be keyboard-scrollable: focusable only while it overflows.
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const check = () => {
      if (el.scrollHeight > el.clientHeight + 1) el.setAttribute("tabindex", "0");
      else el.removeAttribute("tabindex");
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => ro.disconnect();
  }, [page]);

  // ---------------------------------------------------------------------------- keys (§4)
  useEffect(() => {
    const keymap = () => ({ ...DEFAULT_KEYS, ...settingsRef.current.keymap });
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (dialogRef.current || e.defaultPrevented) return; // the dialog handles Esc itself
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
  const helperText = !params.helperUrl
    ? "Helper off"
    : mirror?.helper === "open"
      ? mirror.kritaConnected
        ? "Helper + Krita"
        : "Helper on"
      : mirror?.helper === "connecting"
        ? "Helper…"
        : "No helper";
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
    profiles: profileStore.profiles.map((p) => p.name),
    activeProfile: profileStore.active,
    applyProfile,
    numbers,
    trackSource,
    setTrackSource,
    exposureLocked,
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
          <div className="pinned">
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
                    allowWebSpeech={settings.webSpeechFallback}
                    aliases={aliases}
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
        <section ref={pageRef} className="page" aria-label={`${pageLabel} page`} data-page={page} data-testid="page">
          {page === "steady" && <SteadyPage ctx={ctx} />}
          {page === "setup" && <SetupPage ctx={ctx} />}
          {page === "timing" && <TimingPage ctx={ctx} />}
          {page === "demo" && params.demo && <DemoPage ctx={ctx} />}
          {page === "paint" && <PaintPage ctx={ctx} />}
          {page === "colour" && <ColourPage ctx={ctx} />}
          {page === "view" && <ViewPage ctx={ctx} />}
          {page === "layers" && <LayersPage ctx={ctx} />}
          {page === "modes" && <ModesPage ctx={ctx} />}
          {page === "input" && <InputPage ctx={ctx} />}
          {page === "krita" && <KritaPage ctx={ctx} />}
        </section>
        {nudge && (
          <div className="nudge" role="status">
            <p>{nudge}</p>
            <ActionTile id="later" run={run} />
          </div>
        )}
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
                style={{
                  transform:
                    `${settings.rotateCamera ? "rotate(180deg) " : ""}${settings.mirrorCamera ? "scaleX(-1)" : ""}` || undefined,
                }}
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
                {mirror?.calibrated
                  ? "Hold still on the canvas to lower the pen; hold still again to lift it. "
                  : "Calibrate on the Setup page (15 s), or just rest your hand and start. "}
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
