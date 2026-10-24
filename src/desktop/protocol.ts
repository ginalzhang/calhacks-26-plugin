/**
 * Steady wire protocol: browser Worker ↔ Python helper ↔ Krita plugin.
 *
 * SHARED CONTRACT (created by the lead). Human-readable spec: docs/PROTOCOL.md.
 * One example per message lives in docs/protocol-examples.json and is loaded by
 * Vitest (this file's schemas) and pytest (helper + plugin), so the three
 * processes cannot drift. Change all three together or not at all.
 *
 * Transport:
 *   Worker ↔ helper : WebSocket ws://127.0.0.1:8765, one JSON object per frame.
 *                     The helper rejects any Origin other than http://localhost:3000.
 *   helper ↔ plugin : TCP 127.0.0.1:8766, newline-delimited JSON. The PLUGIN is the
 *                     server; the helper is the client and retries every 2 s.
 *
 * Every message carries `t` (type) and `id` (uuid string). Replies echo the
 * request's `id`. Coordinates are Quartz global screen POINTS, top-left origin,
 * no Retina scaling.
 *
 * Messages marked † are defined now but unused before P3 (no handler needed).
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type Rect = z.infer<typeof RectSchema>;

const Id = z.string();

/** Key combos: lowercase, "+"-joined, modifiers first. e.g. "cmd+shift+z", "]", "shift+delete", "f5". */
export const KeyComboSchema = z.string();

export const HotkeyNameSchema = z.enum([
  "pen",
  "pause",
  "ptt_down",
  "ptt_up",
  "undo",
  "redo",
  "recenter",
  "other_hand",
  "latch",
]);
export type HotkeyName = z.infer<typeof HotkeyNameSchema>;

// ---------------------------------------------------------------------------
// Krita commands (Worker → helper inside a `krita` message; helper → plugin as
// a bare line `{id, cmd, ...}`).
// ---------------------------------------------------------------------------

export const KritaCommandSchema = z.discriminatedUnion("cmd", [
  /** Trigger a Krita action by id (verified ids only; see §7 / DECISIONS.md). */
  z.object({ cmd: z.literal("action"), action: z.string() }),
  /** Set foreground colour. hex = "#rrggbb". */
  z.object({ cmd: z.literal("color"), hex: z.string() }),
  /** Shift FG colour HSV value by dv (−1..1; lighter = +0.1, darker = −0.1). */
  z.object({ cmd: z.literal("color_adjust"), dv: z.number() }),
  /** Absolute size (px) or relative delta (px). Exactly one is set. */
  z.object({ cmd: z.literal("size"), value: z.number().optional(), delta: z.number().optional() }),
  /** Painting opacity 0..100 (percent). */
  z.object({ cmd: z.literal("opacity"), value: z.number() }),
  /** Choose a preset by family keyword: "basic" | "pencil" | "ink" | "airbrush" | "eraser" | a user alias's stored preset name. */
  z.object({ cmd: z.literal("preset"), name: z.string() }),
  z.object({ cmd: z.literal("new_layer"), name: z.string().optional() }),
  z.object({ cmd: z.literal("layer_nav"), dir: z.enum(["up", "down"]) }),
  z.object({ cmd: z.literal("layer_visible"), visible: z.boolean() }),
  /** Canvas widget rect in global screen points. Reply {rect} or ok:false error:"no_canvas_rect". */
  z.object({ cmd: z.literal("canvas_rect") }),
  /** Main window rect in global screen points. Reply {rect}. */
  z.object({ cmd: z.literal("window_rect") }),
  /** Reply {actions: [{id, text}]}. Used to look up ids such as merge down / delete layer by text. */
  z.object({ cmd: z.literal("list_actions") }),
  /** Reply {presets: string[]}. */
  z.object({ cmd: z.literal("list_presets") }),
  z.object({ cmd: z.literal("smoothing"), mode: z.enum(["none", "simple", "weighted", "stabilizer"]) }),
  /** Clear Krita shortcuts bound to these keys. Reply {cleared: [{key, action}]}. */
  z.object({ cmd: z.literal("clear_shortcuts"), keys: z.array(KeyComboSchema) }),
  /**
   * Sent once by the Worker each time krita_state becomes connected. The plugin, once per
   * Krita process: sets brush smoothing to None (never re-applied), clears shortcuts on `keys`.
   * Reply {smoothing_changed: boolean, cleared: [{key, action}], krita_version: string}.
   */
  z.object({ cmd: z.literal("session_init"), keys: z.array(KeyComboSchema) }),
  /** Reply {preset, size, opacity, color, eraser, layer}. Used for Claude context and "save skin". */
  z.object({ cmd: z.literal("get_state") }),
  z.object({ cmd: z.literal("ping") }),
]);
export type KritaCommand = z.infer<typeof KritaCommandSchema>;
export type KritaCmdName = KritaCommand["cmd"];

// ---------------------------------------------------------------------------
// Worker → helper
// ---------------------------------------------------------------------------

export const MoveMsg = z.object({ t: z.literal("move"), id: Id, x: z.number(), y: z.number() });
export const DownMsg = z.object({ t: z.literal("down"), id: Id });
export const UpMsg = z.object({ t: z.literal("up"), id: Id, reason: z.string().optional() });
/** One left click at (x,y). `reactivate_krita`: after clicking a Chrome tile, bring Krita front again. */
export const ClickMsg = z.object({
  t: z.literal("click"),
  id: Id,
  x: z.number(),
  y: z.number(),
  reactivate_krita: z.boolean().optional(),
});
export const MiddleDownMsg = z.object({ t: z.literal("middle_down"), id: Id }); // †
export const MiddleUpMsg = z.object({ t: z.literal("middle_up"), id: Id }); // †
/** Post a key combo to Krita (activating Krita first). */
export const KeysMsg = z.object({ t: z.literal("keys"), id: Id, combo: KeyComboSchema });
/**
 * Relay a command to the Krita plugin. `fallback_keys`: if the plugin socket is down,
 * the helper posts these keys instead (reply ok:true, via:"keys"); if absent, reply
 * ok:false error:"plugin_down".
 */
export const KritaMsg = z
  .object({ t: z.literal("krita"), id: Id, fallback_keys: KeyComboSchema.optional() })
  .and(KritaCommandSchema);
export const RingMsg = z.object({
  t: z.literal("ring"),
  id: Id,
  state: z.enum(["hover", "drawing", "outside", "lost", "hidden"]),
  progress: z.number(),
  x: z.number(),
  y: z.number(),
}); // †
export const PingMsg = z.object({ t: z.literal("ping"), id: Id });
/** Pause: release the button; refuse `down`; honour `click` only inside chrome_rect. */
export const PauseMsg = z.object({ t: z.literal("pause"), id: Id });
export const ResumeMsg = z.object({ t: z.literal("resume"), id: Id });
/** Chrome's own window rect (screen points), sent on connect, on change and before pause. */
export const ChromeRectMsg = z.object({ t: z.literal("chrome_rect"), id: Id, rect: RectSchema });

export const WorkerToHelperSchema = z.union([
  MoveMsg,
  DownMsg,
  UpMsg,
  ClickMsg,
  MiddleDownMsg,
  MiddleUpMsg,
  KeysMsg,
  KritaMsg,
  RingMsg,
  PingMsg,
  PauseMsg,
  ResumeMsg,
  ChromeRectMsg,
]);
export type WorkerToHelper = z.infer<typeof WorkerToHelperSchema>;

// ---------------------------------------------------------------------------
// helper → Worker
// ---------------------------------------------------------------------------

export const HelloMsg = z.object({
  t: z.literal("hello"),
  id: Id,
  version: z.string(),
  screen: z.object({ w: z.number(), h: z.number(), scale: z.number() }),
  accessibility: z.boolean(),
  input_monitoring: z.boolean(),
  /** Plugin socket connected. */
  krita: z.boolean(),
  /** Krita running (from NSRunningApplication). */
  krita_running: z.boolean(),
  krita_window_rect: RectSchema.nullable(),
  paused: z.boolean(),
});
export const KritaWindowRectMsg = z.object({
  t: z.literal("krita_window_rect"),
  id: Id,
  rect: RectSchema.nullable(),
  frontmost: z.boolean(),
});
export const HotkeyMsg = z.object({ t: z.literal("hotkey"), id: Id, key: HotkeyNameSchema });
export const KritaReplyMsg = z
  .object({
    t: z.literal("krita_reply"),
    id: Id,
    ok: z.boolean(),
    error: z.string().optional(),
    /** "plugin" or "keys" (keystroke fallback). */
    via: z.enum(["plugin", "keys"]).optional(),
  })
  .passthrough();
export const ErrorCodeSchema = z.enum([
  "permission",
  "bad_message",
  "krita_not_running",
  "plugin_down",
  "paused",
  "outside_chrome",
  "internal",
]);
export const ErrorMsg = z
  .object({
    t: z.literal("error"),
    id: Id,
    code: ErrorCodeSchema,
    which: z.enum(["accessibility", "input_monitoring"]).optional(),
    message: z.string().optional(),
  })
  .passthrough();
export const KritaStateMsg = z.object({ t: z.literal("krita_state"), id: Id, connected: z.boolean() });
/** Reply to `ping` (echoes id) for the round-trip metric. */
export const PongMsg = z.object({ t: z.literal("pong"), id: Id });
/** Generic ack for keys/click/pause/resume (echoes id). */
export const AckMsg = z.object({ t: z.literal("ack"), id: Id, ok: z.boolean(), error: z.string().optional() });

export const HelperToWorkerSchema = z.union([
  HelloMsg,
  KritaWindowRectMsg,
  HotkeyMsg,
  KritaReplyMsg,
  ErrorMsg,
  KritaStateMsg,
  PongMsg,
  AckMsg,
]);
export type HelperToWorker = z.infer<typeof HelperToWorkerSchema>;

// ---------------------------------------------------------------------------
// helper ↔ plugin (TCP line JSON)
// ---------------------------------------------------------------------------

/** helper → plugin: the KritaCommand plus the id, no `t`. */
export const PluginRequestSchema = z.object({ id: Id }).and(KritaCommandSchema);
export type PluginRequest = z.infer<typeof PluginRequestSchema>;
/** plugin → helper: {id, ok, ...payload} or {id, ok:false, error}. */
export const PluginReplySchema = z
  .object({ id: Id, ok: z.boolean(), error: z.string().optional() })
  .passthrough();
export type PluginReply = z.infer<typeof PluginReplySchema>;

// ---------------------------------------------------------------------------
// Helper client interface (implemented by src/desktop/helperClient.ts, owned by C,
// imported by the tracking Worker, owned by B). Lives in the Worker.
// ---------------------------------------------------------------------------

export type HelperConnState = "connecting" | "open" | "closed";

export interface HelperClientOptions {
  /** Default "ws://127.0.0.1:8765"; Playwright overrides with ?helper=ws://127.0.0.1:18765 */
  url: string;
  onMessage: (msg: HelperToWorker) => void;
  onState: (state: HelperConnState) => void;
  /** Injected for tests. */
  WebSocketImpl?: typeof WebSocket;
  now?: () => number;
}

export interface HelperClient {
  /** Adds `id` if missing; returns the id. Drops silently (returns null) when not open. */
  send(msg: DistributiveOmit<WorkerToHelper, "id"> & { id?: string }): string | null;
  /** Sends and resolves with the reply that echoes the id (krita_reply / pong / ack / error), or rejects on timeout. */
  request(msg: DistributiveOmit<WorkerToHelper, "id"> & { id?: string }, timeoutMs?: number): Promise<HelperToWorker>;
  state(): HelperConnState;
  /** Last ping round-trip in ms, or null. */
  rttMs(): number | null;
  close(): void;
}

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export const HELPER_URL = "ws://127.0.0.1:8765";
export const HELPER_ORIGIN = "http://localhost:3000";
export const PLUGIN_PORT = 8766;
/** Helper releases the button when no message arrives for this long. */
export const WATCHDOG_MS = 300;
/** Worker sends `ping` when no `move` was sent in the last this-many ms. */
export const PING_EVERY_MS = 100;

export function parseHelperToWorker(raw: unknown): HelperToWorker | null {
  const r = HelperToWorkerSchema.safeParse(raw);
  return r.success ? r.data : null;
}
export function parseWorkerToHelper(raw: unknown): WorkerToHelper | null {
  const r = WorkerToHelperSchema.safeParse(raw);
  return r.success ? r.data : null;
}
