/**
 * Tracker ↔ brain (stdin/stdout JSON lines) and the PanelState the tracker forwards to the Krita panel.
 * SHARED CONTRACT (lead). Prose: tracker/PROTOCOL.md.
 */
import type {
  Calibration,
  LandmarkFrame,
  MirrorState,
  ParseOptions,
  ParseResult,
  PenEvent,
  PipelineRects,
  SteadySettings,
} from "../../src/pipeline/types";
import type { KritaCommand } from "../../src/desktop/protocol";

/** What the Krita panel renders. A subset of MirrorState plus panel-specific fields. */
export interface PanelState {
  pen: MirrorState["pen"];
  tracking: MirrorState["tracking"];
  reason: MirrorState["reason"];
  paused: boolean;
  latch: boolean;
  mode: MirrorState["mode"];
  steadiness: number;
  gain: number;
  calibrated: boolean;
  calibrating: MirrorState["calibrating"];
  cameraFps: number;
  detectionFps: number;
  kritaConnected: boolean;
  micOpen: boolean;
  quiet: boolean;
  deviationPx: number | null;
  /** Last ≤ 3 s of raw (faded) and drawn points, screen points relative to the canvas rect, for the panel's live trace. ≤ 90 points each. */
  rawTrail: Array<{ x: number; y: number }>;
  undoLabel: string | null;
  /** Always-listening stream open (added by the tracker from the voice module; not the brain's micOpen). */
  listening?: boolean;
  /** Names of saved profiles (incl. "Steady day", "Shaky day") for profile tiles. */
  profiles?: string[];
  settings: SteadySettings;
}

// ---------------------------------------------------------------- tracker → brain
export type ToBrain =
  /** settings may carry brain-owned keys `aliases`, `profiles`, `skinHex` (round-tripped via settings_changed). calibrations = per-hand store (Other hand). */
  | { t: "init"; settings: SteadySettings; calibration: Calibration | null; calibrations?: { Left?: Calibration; Right?: Calibration }; now: number }
  | { t: "frame"; frame: LandmarkFrame; cameraFps?: number }
  | { t: "tick"; now: number }
  | { t: "action"; action: string; variant?: string; arg?: number | null; source: "tile" | "typed" | "voice" | "hotkey" | "claude" | "dwell" | "system"; now: number }
  | { t: "settings"; settings: Partial<SteadySettings> }
  | { t: "rects"; rects: Partial<PipelineRects> & { panel?: PipelineRects["chrome"] } }
  | { t: "calibrate"; steps: Array<1 | 2 | 3>; now: number }
  | { t: "parse"; id: string; text: string; opts: ParseOptions }
  | { t: "hotkey"; key: "pen" | "pause" | "ptt_down" | "ptt_up" | "undo" | "redo" | "recenter" | "other_hand" | "latch"; now: number }
  /**
   * Events from the pointer/bridge side. data shapes: released {reason}; refused_down {code:"paused"|"permission", which?, message?};
   * krita_state {connected, window_rect?}; krita_reply {id, ok, error?, ...reply fields} (id = the brain's `b<n>` request id).
   */
  | { t: "helper_event"; event: "released" | "refused_down" | "krita_state" | "krita_reply"; data?: Record<string, unknown>; now: number }
  | { t: "dialog_answer"; dialog_id: string; answer: string; now: number }
  | { t: "shutdown" };

// ---------------------------------------------------------------- brain → tracker
export type FromBrain =
  | { t: "ready"; version: string }
  /** Forward to the pointer in order. down/middle_down are preceded by a move to the same point. */
  | { t: "pen"; events: Array<PenEvent | { type: "middle_down" | "middle_up"; x: number; y: number }> }
  /** Relay to the Krita bridge; if the bridge is down use fallback_keys (keystrokes) or report "needs the Krita plugin". */
  | { t: "krita"; id: string; cmd: KritaCommand; fallback_keys?: string }
  | { t: "keys"; id: string; combo: string }
  | { t: "state"; state: PanelState }
  /** status {text:"", level:"alert"} clears the persistent alert. */
  | { t: "status"; text: string; level: "status" | "alert" }
  | { t: "calibration"; calibration: Calibration }
  | { t: "parsed"; id: string; result: ParseResult }
  | { t: "dialog"; dialog_id: string; kind: "confirm" | "clarify"; text: string; options: Array<{ id: string; label: string }> }
  | { t: "dialog_close"; dialog_id: string }
  | { t: "speak"; text: string }
  | { t: "mic"; open: boolean; reason: "ptt" | "tile" | "quiet" | "dialog" }
  | { t: "settings_changed"; settings: Partial<SteadySettings> }
  | { t: "error"; text: string };
