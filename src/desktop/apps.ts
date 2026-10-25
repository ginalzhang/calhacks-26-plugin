/**
 * App profiles (§11 P4, "any drawing app"): which keystrokes Steady sends to the drawing app.
 *
 * Krita uses the plugin (krita.ts) with its keystroke fallbacks. Every other app is
 * keystrokes only: `appMessageFor()` returns `keys` messages, and an action that Krita can do
 * but the app has no shortcut for answers `needs_plugin` ("That needs the Krita plugin").
 *
 * The helper must target the same app: run it with `npm run helper -- --app photoshop`
 * (or STEADY_APP=photoshop). The protocol has no per-message app field (see DECISIONS.md).
 *
 * Photoshop shortcuts are the macOS defaults from Adobe's keyboard-shortcut reference; entries
 * marked `unverified` are believed correct but were not checked in a running Photoshop.
 * Owned by agent C. Pure; no DOM.
 */
import { ACTIONS, type Action } from "../actions";
import { kritaMessageFor, type KritaMessageOpts, type KritaMessageResult } from "./krita";

export type AppId = "krita" | "photoshop";

export interface AppKey {
  combo: string;
  /** Not checked in the real app yet (logged in DECISIONS.md / NEEDS-HUMAN.md). */
  unverified?: boolean;
  note?: string;
}

export interface AppProfile {
  id: AppId;
  label: string;
  /** macOS bundle id; the helper's `--app` flag selects the same one. */
  bundleId: string;
  /** Helper CLI value for `--app`. */
  helperArg: string;
  /** True only for Krita: commands go through the Steady plugin. */
  plugin: boolean;
  /** actionId → keystroke. For Krita, derived from the action table's keystroke fallbacks. */
  keys: Record<string, AppKey>;
}

const kritaKeys: Record<string, AppKey> = Object.fromEntries(
  ACTIONS.filter((a) => a.scope !== "canvas" && a.krita?.keys).map((a) => [a.id, { combo: a.krita!.keys! }]),
);

/** Photoshop (macOS defaults). Only actions with a direct keystroke equivalent. */
const photoshopKeys: Record<string, AppKey> = {
  undo: { combo: "cmd+z" },
  redo: { combo: "cmd+shift+z" },
  brush: { combo: "b", note: "Brush tool (also returns from the Eraser tool)" },
  eraser: { combo: "e", note: "Eraser tool (a tool, not Krita's erase toggle); 'brush' returns" },
  bigger: { combo: "]" },
  smaller: { combo: "[" },
  zoom_in: { combo: "cmd+=" },
  zoom_out: { combo: "cmd+-" },
  fit: { combo: "cmd+0" },
  actual: { combo: "cmd+1" },
  swap: { combo: "x" },
  save: { combo: "cmd+s" },
  new_layer: {
    combo: "cmd+alt+shift+n",
    unverified: true,
    note: "New layer without the dialog (cmd+shift+n opens the New Layer dialog)",
  },
  merge_down: { combo: "cmd+e" },
  pick: { combo: "i", note: "Eyedropper tool" },
  line: { combo: "u", unverified: true, note: "U selects the last-used shape tool, which may not be the Line tool" },
  solid: { combo: "0", unverified: true, note: "With a painting tool active, 0 sets 100 % opacity" },
};

export const APP_PROFILES: Record<AppId, AppProfile> = {
  krita: { id: "krita", label: "Krita", bundleId: "org.krita", helperArg: "krita", plugin: true, keys: kritaKeys },
  photoshop: {
    id: "photoshop",
    label: "Photoshop",
    bundleId: "com.adobe.Photoshop",
    helperArg: "photoshop",
    plugin: false,
    keys: photoshopKeys,
  },
};

export const APP_IDS = Object.keys(APP_PROFILES) as AppId[];

export function isAppId(v: unknown): v is AppId {
  return typeof v === "string" && v in APP_PROFILES;
}

/**
 * The message for `action` in `app`. Krita → kritaMessageFor (plugin + fallbacks). Other apps →
 * always a `keys` message from the profile; a Krita-scoped action without a shortcut in that app
 * → `needs_plugin`; Steady-internal (canvas) actions → `unknown`.
 */
export function appMessageFor(action: Action, app: AppId, opts: KritaMessageOpts): KritaMessageResult {
  if (app === "krita") return kritaMessageFor(action, opts);
  if (action.scope === "canvas" || !action.krita) return { error: "unknown" };
  const key = APP_PROFILES[app].keys[action.id];
  if (!key) return { error: "needs_plugin" };
  return { msg: { t: "keys", combo: key.combo } };
}
