/**
 * Shared pipeline types and defaults.
 *
 * SHARED CONTRACT (lead). Pure: no DOM, no React. Imported by:
 *   A  src/pipeline/** (implements the math: oneEuro, activeBox, lazyBrush, dwell, mapping, strokeModes, pipeline)
 *   B  src/tracking/** Worker (drives the pipeline per frame), src/components/** (renders MirrorState)
 *   C  src/desktop/** (sends PenEvents to the helper)
 *   E  src/voice/** (reads MirrorState for Claude context)
 *   F  Playwright (reads window.__steady)
 *
 * Units: "camera px" = pixels of the 640×480 camera frame. "target units" = practice-canvas
 * CSS px when target = "canvas", Quartz screen points when target = "krita".
 * Timestamps are ms (monotonic, injected; never Date.now() inside src/pipeline).
 */
import type { HandObservation, LandmarkFrame } from "../tracking/LandmarkSource";
import type { HelperConnState, HelperToWorker, Rect, WorkerToHelper } from "../desktop/protocol";
import type { Phase } from "../actions";

export type { Rect } from "../desktop/protocol";

export interface Vec2 {
  x: number;
  y: number;
}
export interface TimedPoint extends Vec2 {
  t: number;
}

export const CAMERA_W = 640;
export const CAMERA_H = 480;

// ---------------------------------------------------------------------------
// Defaults (§2, §3). Tests assert against these exact numbers.
// ---------------------------------------------------------------------------

export const ONE_EURO_DEFAULTS = { minCutoff: 0.6, beta: 0.005, dCutoff: 1.0 } as const;
export const LAZY_RADIUS_DEFAULT = 12;
/** Steadiness 0..100 → (minCutoff Hz, lazyRadius target units), piecewise linear through these knots. */
export const STEADINESS_KNOTS: Array<[number, number, number]> = [
  [0, 1.2, 4],
  [50, 0.6, 12],
  [100, 0.3, 30],
];
export const STEADINESS_DEFAULT = 50;
export const WARMUP_FRAMES = 10;
export const GAIN_MIN = 2;
export const GAIN_MAX_SLIDER = 10;
export const GAIN_CAL_MAX = 4;
export const ACTIVE_BOX_PAD = 0.2;

export const SCORE_ACCEPT = 0.6; // < this counts as no detection
export const SCORE_TRACKING = 0.75; // ≥ this is "Tracking"
export const DETECTION_FPS_WEAK = 20;
export const LOST_AFTER_MS = 300;
export const FREEZE_MEDIAN_MS = 100;
export const HAND_LOCK_FRACTION = 0.25;

export const DWELL_DOWN_DEFAULT_MS = 800; // slider 500–1500
export const DWELL_UP_FACTOR = 1.5; // pen-up default = 1.5 × pen-down; slider 800–3000
export const DWELL_STILL_WINDOW_MS = 250;
export const DWELL_R_IN_MIN = 15;
export const REARM_AFTER_UP_MS = 600;
export const IGNORE_LIFT_AFTER_DOWN_MS = 80;
export const CLICK_SUPPRESS_MS = 500;
export const MENU_BAR_PT = 40;
export const STEADIER_STEP = 10; // voice steadier/looser
export const TILE_STEP = 5; // ± tiles
export const HATCH_LAG_DEFAULT_MS = 120; // slider 80–250

// ---------------------------------------------------------------------------
// Persisted state (localStorage, owned by B; shape fixed here)
// ---------------------------------------------------------------------------

export interface Calibration {
  /** RMS of One Euro output at rest, camera px. */
  restJitterRMS: number;
  /** RMS of the kinetic residual during the circle, camera px. */
  kineticJitterRMS: number;
  /** Active box in camera px (already padded 20 %). */
  box: Rect;
  /** Target width ÷ box width, clamped 2–4×. */
  gain: number;
  handedness: "Left" | "Right";
  /** Step 3 (P1) results: flip an axis that moved the wrong way. */
  flipX: boolean;
  flipY: boolean;
  /** clamp(round(8 × max(rest, kinetic)), 10, 90) */
  suggestedSteadiness: number;
  /** Hand bounding-box diagonal at calibration (camera px), the re-baseline reference. */
  handScale?: number;
  createdAt: number;
}

export interface SteadySettings {
  steadiness: number; // 0..100
  /** null = use calibration gain. Slider 2–10. */
  gainOverride: number | null;
  landmark: number; // default 5
  dwellDownMs: number;
  dwellUpMs: number;
  dwellClickEnabled: boolean;
  latch: boolean;
  mirrorCamera: boolean;
  rotateCamera: boolean;
  cameraDeviceId: string | null;
  simulateTremor: boolean;
  hatchLagMs: number;
  /** P4 hand presets: floor for the dwell radius r_in (target units). */
  dwellRadius?: number | null;
  /** P4: tiles count as hovered within this many px of their edge. */
  tileHoverPx?: number | null;
  /** Landmark the hand lock follows (wrist 0; nose 1 in Head mode). */
  lockLandmark?: number;
  /** P4 Head mode (nose tip, FaceLandmarker). */
  headMode?: boolean;
  /** P4 eyebrow raise lifts the pen (never lowers). */
  eyebrowLift?: boolean;
  /** P4 target app for krita-scoped actions. */
  appProfile?: "krita" | "photoshop";
  /** Landmark source: MediaPipe hand, or the P3 colour-cap sticker. */
  trackingSource: "hand" | "colorcap";
  /** Saved sticker HSV range (ColorCapSource), or null for the default neon green. */
  stickerRange: { hMin: number; hMax: number; sMin: number; vMin: number; sMax?: number; vMax?: number } | null;
  /** Dash mode pause that ends a mark (slider 100–600). */
  dashPauseMs: number;
  micSilenceMs: number; // 1000–8000, default 2000
  micCapMs: number; // 15000–60000, default 15000
  quiet: boolean;
  tts: boolean;
  /** P3 opt-in: when Cartesia is unavailable, use Chrome's Web Speech API (sends audio to Google). Off by default so §0 rule 9 stays true. */
  webSpeechFallback: boolean;
  earcons: boolean;
  /** Input methods switch off independently (§0 rule 4). */
  inputs: { camera: boolean; voice: boolean; dwell: boolean; keys: boolean };
  /** Remapped keys: key → action id. Defaults from actions.ts DEFAULT_KEYS. */
  keymap: Record<string, string>;
}

export const DEFAULT_SETTINGS: SteadySettings = {
  steadiness: STEADINESS_DEFAULT,
  gainOverride: null,
  landmark: 5,
  dwellDownMs: DWELL_DOWN_DEFAULT_MS,
  dwellUpMs: DWELL_DOWN_DEFAULT_MS * DWELL_UP_FACTOR,
  dwellClickEnabled: true,
  latch: false,
  mirrorCamera: false,
  rotateCamera: false,
  cameraDeviceId: null,
  simulateTremor: false,
  hatchLagMs: HATCH_LAG_DEFAULT_MS,
  dashPauseMs: 200,
  trackingSource: "hand",
  stickerRange: null,
  micSilenceMs: 2000,
  micCapMs: 15000,
  quiet: false,
  tts: true,
  webSpeechFallback: false,
  earcons: true,
  inputs: { camera: true, voice: true, dwell: true, keys: true },
  keymap: {},
};

export const STORAGE_KEYS = {
  settings: "steady.settings.v1",
  calibration: "steady.calibration.v1", // Record<"Left"|"Right", Calibration>
  lastCamera: "steady.camera.v1",
  claudeLog: "steady.claudeLog.v1",
  skin: "steady.skin.v1",
  aliases: "steady.aliases.v1",
  profiles: "steady.profiles.v1",
} as const;

// ---------------------------------------------------------------------------
// Pipeline runtime
// ---------------------------------------------------------------------------

export type PenState = "HOVER" | "DRAWING";
export type TrackingWord = "Tracking" | "Weak" | "Lost";
export type LostReason = "no_hand" | "too_dark" | "low_fps" | "outside_area" | null;
export type StrokeMode = "normal" | "dots" | "hatch" | "hatch_alternate" | "dash";
/** Where the pointer goes: Steady's own practice canvas, or the system pointer over Krita. */
export type Target = "canvas" | "krita";

export type LiftReason =
  | "dwell"
  | "pen_key"
  | "voice"
  | "pause"
  | "tracking_lost"
  | "left_canvas"
  | "ptt"
  | "hatch_pass"
  | "dash"
  | "mode_change"
  | "socket"
  | "eyebrow";

/** What the pipeline wants done this frame. The Worker forwards these to the helper (target krita) or the practice canvas. */
export type PenEvent =
  | { type: "move"; x: number; y: number }
  | { type: "down"; x: number; y: number }
  | { type: "up"; x: number; y: number; reason: LiftReason }
  | { type: "click"; x: number; y: number };

export type DwellKind = "pen_down" | "pen_up" | "click" | null;

export interface DwellView {
  kind: DwellKind;
  /** 0..1 */
  progress: number;
  x: number;
  y: number;
  /** Grey ring: dwell would do nothing here (outside canvas & not a clickable window). */
  gated: boolean;
}

/** Rects known to the pipeline (all in target units / screen points). */
export interface PipelineRects {
  /** Ink is allowed only inside this rect (practice canvas, or Krita's canvas rect). */
  canvas: Rect | null;
  /** Chrome's own window rect (screen points): dwell-click allowed; Pause clamps the pointer here. */
  chrome: Rect | null;
  /** Krita main window rect (screen points): dwell-click allowed from P2a. */
  krita: Rect | null;
  /** Screen bounds (screen points) for clamping. */
  screen: Rect | null;
}

/** One frame's output, posted from the Worker to the page as `frame`. */
export interface PipelineOutput {
  t: number;
  /** Raw tracked landmark in camera px (after mirror/rotate), or null. */
  raw: Vec2 | null;
  /** One Euro output, camera px. */
  filtered: Vec2 | null;
  /** Pre-lazy-brush point in target units (dwell reads here). */
  pre: Vec2 | null;
  /** Final pointer in target units (after lazy brush), or null during warm-up/loss. */
  pointer: Vec2 | null;
  pen: PenState;
  events: PenEvent[];
  dwell: DwellView;
  tracking: TrackingWord;
  reason: LostReason;
  score: number;
  warmingUp: boolean;
}

/** 30 Hz state mirror, Worker → page. Also exposed to Playwright as window.__steady.state(). */
export interface MirrorState {
  t: number;
  target: Target;
  pen: PenState;
  tracking: TrackingWord;
  reason: LostReason;
  score: number;
  pointer: Vec2 | null;
  dwell: DwellView;
  paused: boolean;
  latch: boolean;
  mode: StrokeMode;
  steadiness: number;
  gain: number;
  calibrated: boolean;
  calibrating: null | { step: 1 | 2 | 3; progress: number; prompt: string };
  cameraFps: number;
  detectionFps: number;
  helper: HelperConnState;
  helperRttMs: number | null;
  helperHello: Extract<HelperToWorker, { t: "hello" }> | null;
  kritaConnected: boolean;
  kritaWindowRect: Rect | null;
  /** RMS distance of the drawn (post-lazy-brush) path from its own ±100 ms moving average over the last 3 s, target units: the shake that SURVIVES smoothing, so it drops as Steadiness rises. */
  deviationPx: number | null;
  lastStrokeMs: number | null;
  simulateTremor: boolean;
  /** Raw path (last 3 s, target units) for the Demo live trace. */
  rawTrail: Vec2[];
  status: string | null;
}

// ---------------------------------------------------------------------------
// Page ↔ Worker messages (B implements both ends; C's helperClient lives in the Worker)
// ---------------------------------------------------------------------------

export type PageToWorker =
  | {
      type: "init";
      settings: SteadySettings;
      calibration: Calibration | null;
      helperUrl: string | null; // null = do not connect (pure P0 / tests without helper)
      source: "camera" | "replay";
      replayUrl?: string;
      demo: boolean;
    }
  /** Camera frames (transferred ReadableStream<VideoFrame> from MediaStreamTrackProcessor). */
  | { type: "stream"; readable: ReadableStream }
  /** Fallback path when MediaStreamTrackProcessor is missing: page posts ImageBitmaps. */
  | { type: "bitmap"; bitmap: ImageBitmap; t: number }
  | { type: "settings"; settings: Partial<SteadySettings> }
  | { type: "window_rect"; rect: Rect }
  | { type: "canvas_rect"; target: Target; rect: Rect }
  | { type: "set_target"; target: Target }
  /** Run a Steady-internal action (pen_toggle, pen_down, pen_up, pause, latch, recenter, steadier, looser, hatch, …). */
  | { type: "action"; action: string; variant?: string; arg?: number | null; source: InputSource }
  | { type: "calibrate"; steps: Array<1 | 2 | 3> }
  | { type: "use_calibration"; calibration: Calibration }
  /** Forward to the helper; the Worker replies {type:"reply", id, msg}. */
  | { type: "send"; msg: DistributiveOmitId<WorkerToHelper> & { id?: string } }
  | { type: "reset_metrics" };

export type InputSource = "tile" | "dwell" | "voice" | "typed" | "key" | "pedal" | "hotkey" | "claude" | "system";

export type WorkerToPage =
  | { type: "ready"; delegate: "GPU" | "CPU" | "replay" }
  | { type: "frame"; out: PipelineOutput }
  | { type: "state"; state: MirrorState }
  /** Every helper message is forwarded (hello, hotkey, krita_state, krita_window_rect, error). */
  | { type: "helper"; msg: HelperToWorker }
  | { type: "reply"; id: string; msg: HelperToWorker | { t: "timeout"; id: string } }
  | { type: "calibration"; calibration: Calibration }
  | { type: "status"; text: string; level: "status" | "alert" }
  | { type: "error"; text: string };

type DistributiveOmitId<T> = T extends unknown ? Omit<T, "id"> : never;

/** Playwright / debugging hooks. B installs these on window.__steady in every build. */
export interface SteadyTestHooks {
  state(): MirrorState | null;
  /** Force the pointer target (tests: Krita target against the fake helper). Also settable with ?target=krita. */
  setTarget(target: Target): void;
  /** Last window rect the page reported to the Worker (screen points), or null. */
  windowRect(): Rect | null;
  /** Number of committed strokes on the practice canvas. */
  strokeCount(): number;
  /** Run an action exactly as a tile press would. */
  dispatch(actionId: string, opts?: { variant?: string; arg?: number; source?: InputSource }): void;
  /** Submit text to the typed-command box path. */
  typed(text: string): Promise<void>;
  /** Last messages sent to the helper (ring buffer, newest last). */
  sentToHelper(): unknown[];
}

export type { HandObservation, LandmarkFrame };

// ---------------------------------------------------------------------------
// Pipeline API (A implements in src/pipeline/pipeline.ts; B's Worker drives it)
// ---------------------------------------------------------------------------

export interface PipelineConfig {
  settings: SteadySettings;
  calibration: Calibration | null;
  target: Target;
  rects: PipelineRects;
  /** When the helper is connected, tiles are activated only by the helper's real click (§3). */
  helperConnected: boolean;
  /** Seed for Simulate tremor (deterministic tests). */
  seed?: number;
}

/** createPipeline(config: PipelineConfig, opts?: { phase?: Phase }) — phase gates e.g. Krita-window dwell-click (P2a); default BUILD_PHASE. */
export interface Pipeline {
  /** Process one landmark frame (t = frame.t). */
  step(frame: LandmarkFrame): PipelineOutput;
  /** Advance time with no frame (drives the 300 ms loss timer). */
  tick(t: number): PipelineOutput;
  /** Steady-internal actions: pen_toggle, pen_down, pen_up, pause, latch, recenter, steadier, looser, hatch*, dots, ptt (lift). Returns pen events to forward. */
  action(id: string, t: number, opts?: { variant?: string; arg?: number | null }): PenEvent[];
  setSettings(s: Partial<SteadySettings>): void;
  setCalibration(c: Calibration | null): void;
  setRects(r: Partial<PipelineRects>): void;
  setTarget(target: Target): PenEvent[];
  setHelperConnected(connected: boolean): void;
  /** Read-only view for the mirror. */
  snapshot(): {
    pen: PenState;
    paused: boolean;
    latch: boolean;
    mode: StrokeMode;
    steadiness: number;
    gain: number;
    deviationPx: number | null;
    rawTrail: Vec2[];
    lastStrokeMs: number | null;
  };
}

/** Calibration steps 1–3 (A implements src/pipeline/calibration.ts; B drives it from the Worker). */
export interface Calibrator {
  /** Feed one frame's raw (camera px, post mirror/rotate) and One Euro output; returns progress 0..1 of the current step. */
  feed(t: number, raw: Vec2 | null, filtered: Vec2 | null, handedness: "Left" | "Right" | null): number;
  readonly step: 1 | 2 | 3 | null;
  readonly prompt: string;
  /** Non-null once all requested steps finished. */
  result(): Calibration | null;
}

// ---------------------------------------------------------------------------
// Grammar API (A implements src/pipeline/grammar.ts from actions.ts; E and B consume)
// ---------------------------------------------------------------------------

export interface ParsedCommand {
  /** Action id. Grammar-only id "alias" (P2b): variant = the stored preset name for a user alias. */
  action: string;
  variant?: string;
  /** Numeric argument (size/opacity), or the repeat count for coalesced undo/redo ("undo that undo that" → arg 2). */
  arg?: number | null;
}

export type ParseResult =
  | { kind: "match"; commands: ParsedCommand[]; fuzzy: boolean }
  | { kind: "nomatch"; closest: string[] /* up to 2 action ids */; refused?: { reason: "alias_taken"; word: string } };

export interface ParseOptions {
  mode: "voice" | "typed";
  /** While a dialog or clarify prompt is open: exact match only. */
  dialogOpen?: boolean;
  /** User aliases: word → preset name (P2b). */
  aliases?: Record<string, string>;
  /** Rows whose phase is later than this are excluded. Default BUILD_PHASE. */
  phase?: Phase;
}

// ---------------------------------------------------------------------------
// Voice / command resolution API (E implements in src/voice/**; B renders and calls)
// ---------------------------------------------------------------------------

/** Exactly the privacy-rule (§0 rule 9) context list. */
export interface CommandContext {
  tool: string | null;
  preset: string | null;
  size: number | null;
  opacity: number | null;
  color: string | null;
  steadiness: number;
  lastActions: string[]; // last 3 action ids
}

export type Resolution =
  | { kind: "commands"; commands: ParsedCommand[]; heard: string; via: "grammar" | "claude" }
  | { kind: "clarify"; options: string[]; heard: string }
  | { kind: "noop"; heard: string }
  | { kind: "none"; heard: string; closest: string[]; reason: "nomatch" | "timeout" | "invalid" | "offline" | "key_missing" };

/** Props of E's <MicTile> (src/voice/MicTile.tsx), rendered by B in the pinned header. */
export interface MicTileProps {
  /** Execute resolved commands (B's dispatcher). */
  onResolution: (r: Resolution) => void;
  getContext: () => CommandContext;
  quiet: boolean;
  disabled: boolean;
  /** Push-to-talk held (F10 down from helper hotkey or page key). */
  pttHeld: boolean;
  /** Called when the mic opens (B lifts the pen: "push-to-talk start lifts the pen"). */
  onMicOpen: () => void;
  onStatus: (text: string, level: "status" | "alert") => void;
  dialogOpen: boolean;
  micSilenceMs: number;
  micCapMs: number;
  /** Settings.webSpeechFallback: only then may the Mic tile fall back to Chrome's Web Speech API. */
  allowWebSpeech?: boolean;
  /** User aliases (word → preset name) so the grammar matches them before Claude. */
  aliases?: Record<string, string>;
}
