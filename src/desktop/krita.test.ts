import { describe, expect, it } from "vitest";
import { ACTIONS, ACTIONS_BY_ID, DEFAULT_KEYS, type Action } from "../actions";
import {
  KRITA_STEADY_KEYS,
  buildLookups,
  keymapMessage,
  kritaConnectMessages,
  kritaMessageFor,
  normalizeActionText,
} from "./krita";
import { WorkerToHelperSchema } from "./protocol";

const kritaScoped = ACTIONS.filter((a) => a.scope !== "canvas" && a.krita);
const A = (id: string): Action => {
  const a = ACTIONS_BY_ID[id];
  if (!a) throw new Error(`no action ${id}`);
  return a;
};
const LOOKUPS = buildLookups([
  { id: "merge_layer", text: "&Merge with Layer Below" },
  { id: "remove_layer", text: "&Remove Layer" },
  { id: "clear", text: "Clear" },
]);
const UP = { pluginConnected: true, lookups: LOOKUPS, skinHex: "#c68642", arg: 20 };
const DOWN = { pluginConnected: false, lookups: {}, skinHex: "#c68642", arg: 20 };

/** The message with an id added must validate against the wire schema. */
function validates(msg: unknown) {
  const r = WorkerToHelperSchema.safeParse({ ...(msg as object), id: "x" });
  if (!r.success) throw new Error(JSON.stringify(msg) + " " + r.error.message);
}

describe("krita.ts mapping", () => {
  it("@P1 KRITA_STEADY_KEYS is f3..f10", () => {
    expect(KRITA_STEADY_KEYS).toEqual(["f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10"]);
  });

  for (const a of kritaScoped) {
    it(`@P1 ${a.id}: valid message (plugin up) and correct plugin-down behaviour`, () => {
      const up = kritaMessageFor(a, UP);
      if ("error" in up) throw new Error(`${a.id} plugin up → ${up.error}`);
      validates(up.msg);
      const down = kritaMessageFor(a, DOWN);
      const d = a.krita!;
      if ("msg" in down) {
        validates(down.msg);
        // when the plugin is down, only keystrokes may run
        const m = down.msg as { t: string; fallback_keys?: string; combo?: string };
        expect(m.t === "keys" ? m.combo : m.fallback_keys).toBe(d.keys);
      } else {
        expect(down.error).toBe("needs_plugin");
        expect(d.pluginOnly || !d.keys).toBe(true);
      }
    });
  }

  it("@P1 plugin up: undo is an action with its keystroke fallback", () => {
    expect(kritaMessageFor(A("undo"), UP)).toEqual({
      msg: { t: "krita", cmd: "action", action: "edit_undo", fallback_keys: "cmd+z" },
    });
  });

  it("@P1 plugin down: undo still goes out as krita + fallback_keys (helper posts the keys)", () => {
    expect(kritaMessageFor(A("undo"), DOWN)).toEqual({
      msg: { t: "krita", cmd: "action", action: "edit_undo", fallback_keys: "cmd+z" },
    });
  });

  it("@P1 plugin-only rows answer needs_plugin when the plugin is down", () => {
    for (const id of ["colour_blue", "size", "opacity", "lighter", "fit", "new_layer", "pencil"]) {
      expect(kritaMessageFor(A(id), DOWN)).toEqual({ error: "needs_plugin" });
    }
  });

  it("@P1 colours carry their hex and no fallback keys", () => {
    expect(kritaMessageFor(A("colour_blue"), UP)).toEqual({ msg: { t: "krita", cmd: "color", hex: "#1d4ed8" } });
  });

  it("@P1 size / opacity use the spoken number, clamped", () => {
    expect(kritaMessageFor(A("size"), { ...UP, arg: 35 })).toEqual({ msg: { t: "krita", cmd: "size", value: 35 } });
    expect(kritaMessageFor(A("size"), { ...UP, arg: 0 })).toEqual({ msg: { t: "krita", cmd: "size", value: 1 } });
    expect(kritaMessageFor(A("size"), { ...UP, arg: 99999 })).toEqual({ msg: { t: "krita", cmd: "size", value: 1000 } });
    expect(kritaMessageFor(A("opacity"), { ...UP, arg: 50 })).toEqual({ msg: { t: "krita", cmd: "opacity", value: 50 } });
    expect(kritaMessageFor(A("opacity"), { ...UP, arg: 150 })).toEqual({ msg: { t: "krita", cmd: "opacity", value: 100 } });
    expect(kritaMessageFor(A("size"), { ...UP, arg: null })).toEqual({ error: "unknown" });
    expect(kritaMessageFor(A("opacity"), { ...UP, arg: Number.NaN })).toEqual({ error: "unknown" });
  });

  it("@P1 skin: no_skin until saved, needs_plugin when down", () => {
    expect(kritaMessageFor(A("skin"), { ...UP, skinHex: null })).toEqual({ error: "no_skin" });
    expect(kritaMessageFor(A("skin"), UP)).toEqual({ msg: { t: "krita", cmd: "color", hex: "#c68642" } });
    expect(kritaMessageFor(A("skin"), DOWN)).toEqual({ error: "needs_plugin" });
  });

  it("@P1 lookup rows use the runtime id, else their keystroke", () => {
    expect(kritaMessageFor(A("merge_down"), UP)).toEqual({
      msg: { t: "krita", cmd: "action", action: "merge_layer", fallback_keys: A("merge_down").krita!.keys },
    });
    expect(kritaMessageFor(A("merge_down"), { ...UP, lookups: {} })).toEqual({
      msg: { t: "keys", combo: A("merge_down").krita!.keys },
    });
    expect(kritaMessageFor(A("delete_layer"), UP)).toMatchObject({ msg: { cmd: "action", action: "remove_layer" } });
    expect(kritaMessageFor(A("clear_layer"), UP)).toMatchObject({ msg: { cmd: "action", action: "clear" } });
  });

  it("@P1 key-only rows become keys messages", () => {
    expect(kritaMessageFor(A("swap"), UP)).toEqual({ msg: { t: "keys", combo: "x" } });
    expect(kritaMessageFor(A("swap"), DOWN)).toEqual({ msg: { t: "keys", combo: "x" } });
  });

  it("@P1 canvas-scoped and pointer actions are unknown to Krita", () => {
    expect(kritaMessageFor(A("steadier"), UP)).toEqual({ error: "unknown" });
    expect(kritaMessageFor(A("pen_toggle"), UP)).toEqual({ error: "unknown" });
  });

  it("@P1 connect messages: session_init with Steady's keys, list_actions, list_presets, canvas_rect", () => {
    const msgs = kritaConnectMessages();
    msgs.forEach(validates);
    expect(msgs.map((m) => (m as { cmd: string }).cmd)).toEqual(["session_init", "list_actions", "list_presets", "canvas_rect"]);
    expect(msgs[0]).toEqual({ t: "krita", cmd: "session_init", keys: KRITA_STEADY_KEYS });
  });
});

describe("buildLookups", () => {
  it("@P1 matches the protocol example and strips mnemonics", () => {
    expect(buildLookups([{ id: "merge_layer", text: "Merge with Layer Below" }])).toEqual({ merge_down: "merge_layer" });
    expect(normalizeActionText("&Merge with Layer Below...")).toBe("merge with layer below");
  });

  it("@P1 exact beats contains; a tie is no match; destructive rows never match loosely", () => {
    const l = buildLookups([
      { id: "clear_all", text: "Clear All Guides" },
      { id: "clear", text: "Clear" },
      { id: "a", text: "Delete Layer Group" },
    ]);
    expect(l.clear_layer).toBe("clear");
    expect(l.delete_layer).toBeUndefined(); // "Delete Layer Group" must not be guessed
    const tie = buildLookups([
      { id: "m1", text: "Merge with Layer Below" },
      { id: "m2", text: "Merge with layer below" },
    ]);
    expect(tie.merge_down).toBeUndefined();
    expect(buildLookups([])).toEqual({});
  });
});

describe("P2b/P3 rows and keymap", () => {
  it("@P3 pick → keys p and line → keys v (with or without the plugin)", () => {
    for (const opts of [UP, DOWN]) {
      expect(kritaMessageFor(A("pick"), opts)).toEqual({ msg: { t: "keys", combo: "p" } });
      expect(kritaMessageFor(A("line"), opts)).toEqual({ msg: { t: "keys", combo: "v" } });
    }
  });

  it("@P2b name_brush reads the current preset via get_state; needs the plugin", () => {
    expect(kritaMessageFor(A("name_brush"), { ...UP, arg: null })).toEqual({ msg: { t: "krita", cmd: "get_state" } });
    expect(kritaMessageFor(A("name_brush"), DOWN)).toEqual({ error: "needs_plugin" });
  });

  it("@P2b keymapMessage from DEFAULT_KEYS equals the protocol example map", () => {
    const msg = keymapMessage(DEFAULT_KEYS);
    validates(msg);
    expect(msg).toEqual({
      t: "keymap",
      map: { f3: "latch", f4: "other_hand", f5: "recenter", f6: "redo", f7: "undo", f8: "pen", f9: "pause", f10: "ptt_down" },
    });
  });

  it("@P2b keymapMessage accepts hotkey names, lowercases combos, drops junk and ptt_up", () => {
    const msg = keymapMessage({ " PageUp ": "pen", "Shift+F8": "undo", f10: "ptt_down", x: "explode", y: "ptt_up", "": "pen" });
    validates(msg);
    expect(msg.map).toEqual({ pageup: "pen", "shift+f8": "undo", f10: "ptt_down" });
  });
});
