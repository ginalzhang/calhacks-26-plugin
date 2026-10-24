/**
 * Krita dispatch (§6): action table row → the message the Worker sends to the helper.
 *
 * - Plugin connected → `krita {cmd, ...}` (with `fallback_keys` when the row has keys, so the
 *   helper can still post keystrokes if the plugin drops between our check and its relay).
 * - Plugin down → `krita {cmd, ..., fallback_keys}` when a keystroke fallback exists (the helper
 *   posts the keys, reply `via:"keys"`), a bare `keys {combo}` for key-only rows, else
 *   `{error: "needs_plugin"}` ("That needs the Krita plugin").
 * - Lookup rows (merge down, delete/clear layer) use the id found by `buildLookups()` from the
 *   plugin's `list_actions` reply; never a guessed id.
 * - `skin` needs a saved swatch: `{error: "no_skin"}` until one exists.
 *
 * Owned by agent C. Pure; no DOM.
 */
import { ACTIONS, DEFAULT_KEYS, type Action } from "../actions";
import type { DistributiveOmit, KritaCommand, WorkerToHelper } from "./protocol";

type KritaWire = Extract<WorkerToHelper, { t: "krita" }>;
type KeysWire = Extract<WorkerToHelper, { t: "keys" }>;
/** A `krita` or `keys` message without its id (helperClient adds it). */
export type KritaOutMsg = DistributiveOmit<KritaWire, "id"> | Omit<KeysWire, "id">;
export type KritaDispatchError = "needs_plugin" | "no_skin" | "unknown";
export type KritaMessageResult = { msg: KritaOutMsg } | { error: KritaDispatchError };

export interface KritaMessageOpts {
  /** Numeric argument for `size` / `opacity` ("size 20"). */
  arg?: number | null;
  /** Plugin socket connected (from hello.krita / krita_state). */
  pluginConnected: boolean;
  /** actionId → Krita action id, from buildLookups(list_actions reply). */
  lookups: Record<string, string>;
  /** The user's saved skin swatch "#rrggbb", or null. */
  skinHex?: string | null;
}

/** Steady's global keys (§4), lowercase, f3..f10: sent in `session_init` / `clear_shortcuts`. */
export const KRITA_STEADY_KEYS: string[] = Object.keys(DEFAULT_KEYS)
  .map((k) => k.toLowerCase())
  .sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")));

export const SIZE_MIN = 1;
export const SIZE_MAX = 1000;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function withArg(cmd: KritaCommand, action: Action, arg: number | null | undefined): KritaCommand | null {
  if (action.arg !== "number") return cmd;
  if (typeof arg !== "number" || !Number.isFinite(arg)) return null;
  if (cmd.cmd === "size") return { cmd: "size", value: clamp(Math.round(arg), SIZE_MIN, SIZE_MAX) };
  if (cmd.cmd === "opacity") return { cmd: "opacity", value: clamp(Math.round(arg), 0, 100) };
  return cmd;
}

function kritaMsg(cmd: KritaCommand, fallbackKeys?: string): KritaOutMsg {
  const m = { t: "krita" as const, ...cmd } as KritaOutMsg & { fallback_keys?: string };
  if (fallbackKeys) m.fallback_keys = fallbackKeys;
  return m;
}

export function kritaMessageFor(action: Action, opts: KritaMessageOpts): KritaMessageResult {
  const d = action.krita;
  if (!d || action.scope === "canvas") return { error: "unknown" };
  const plugin = opts.pluginConnected;

  if (action.id === "skin") {
    if (!plugin) return { error: "needs_plugin" };
    if (!opts.skinHex) return { error: "no_skin" };
    return { msg: kritaMsg({ cmd: "color", hex: opts.skinHex }) };
  }

  if (d.lookupText) {
    const kid = opts.lookups[action.id];
    if (plugin && kid) return { msg: kritaMsg({ cmd: "action", action: kid }, d.keys) };
    if (d.keys) return { msg: { t: "keys", combo: d.keys } };
    return { error: "needs_plugin" };
  }

  if (d.plugin) {
    const cmd = withArg(d.plugin, action, opts.arg);
    if (!cmd) return { error: "unknown" };
    if (plugin) return { msg: kritaMsg(cmd, d.pluginOnly ? undefined : d.keys) };
    if (d.keys && !d.pluginOnly) return { msg: kritaMsg(cmd, d.keys) };
    return { error: "needs_plugin" };
  }

  if (d.keys) return { msg: { t: "keys", combo: d.keys } };
  return { error: d.pluginOnly ? "needs_plugin" : "unknown" };
}

/** The `krita` messages the Worker sends each time krita_state becomes connected (docs/PROTOCOL.md). */
export function kritaConnectMessages(): KritaOutMsg[] {
  return [
    kritaMsg({ cmd: "session_init", keys: KRITA_STEADY_KEYS }),
    kritaMsg({ cmd: "list_actions" }),
    kritaMsg({ cmd: "list_presets" }),
    kritaMsg({ cmd: "canvas_rect" }),
  ];
}

// ---------------------------------------------------------------------------
// Runtime action-id lookup (list_actions → {actionId: kritaActionId})
// ---------------------------------------------------------------------------

/**
 * Alternative wordings Krita uses for the same menu item (matched against the runtime text,
 * never used as ids). Krita 5's layer delete is labelled "Remove Layer".
 */
const LOOKUP_SYNONYMS: Record<string, string[]> = {
  "delete layer": ["remove layer"],
  "merge with layer below": ["merge down"],
  clear: ["clear layer"],
};

export function normalizeActionText(text: string): string {
  return text
    .replace(/&(?!&)/g, "") // Qt mnemonics
    .replace(/(\.\.\.|…)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Match every action-table row that has `krita.lookupText` against the plugin's
 * `list_actions` reply. Tiers: exact text, exact id, synonym text, text starts with, text
 * contains (the last two never for destructive rows); within a tier the shortest text wins;
 * a tie is no match.
 */
export function buildLookups(
  actions: { id: string; text: string }[],
  table: Action[] = ACTIONS,
): Record<string, string> {
  const norm = actions
    .filter((a) => a && typeof a.id === "string" && typeof a.text === "string")
    .map((a) => ({ id: a.id, text: normalizeActionText(a.text) }))
    .filter((a) => a.text.length > 0);
  const out: Record<string, string> = {};
  for (const row of table) {
    const lt = row.krita?.lookupText;
    if (!lt) continue;
    const want = normalizeActionText(lt);
    const syn = (LOOKUP_SYNONYMS[want] ?? []).map(normalizeActionText);
    const tiers: Array<(a: { id: string; text: string }) => boolean> = [
      (a) => a.text === want,
      (a) => a.id.toLowerCase() === want.replace(/ /g, "_"),
      (a) => syn.includes(a.text),
      (a) => a.text.startsWith(want + " "),
      (a) => a.text.includes(want),
    ];
    // Destructive rows (delete/clear layer) accept only exact, id or synonym matches.
    for (const tier of row.destructive ? tiers.slice(0, 3) : tiers) {
      const hits = norm.filter(tier);
      if (hits.length === 0) continue;
      const minLen = Math.min(...hits.map((h) => h.text.length));
      const best = hits.filter((h) => h.text.length === minLen);
      const ids = new Set(best.map((b) => b.id));
      if (ids.size === 1) out[row.id] = best[0].id;
      break; // a tie in the best tier is no match (never guess)
    }
  }
  return out;
}
