import { describe, expect, it } from "vitest";
import { ACTIONS, ACTIONS_BY_ID, type Action } from "../actions";
import { APP_IDS, APP_PROFILES, appMessageFor, isAppId } from "./apps";
import { kritaMessageFor } from "./krita";
import { WorkerToHelperSchema } from "./protocol";

const A = (id: string): Action => {
  const a = ACTIONS_BY_ID[id];
  if (!a) throw new Error(`no action ${id}`);
  return a;
};
const OPTS = { pluginConnected: true, lookups: { merge_down: "merge_layer" }, skinHex: "#c68642", arg: 20 };
const MAC_COMBO = /^((cmd|ctrl|alt|shift)\+)*([a-z0-9]|f\d{1,2}|[[\]=\-+]|delete|backspace)$/;

describe("app profiles", () => {
  it("@P4 two profiles with bundle ids matching the helper's --app choices", () => {
    expect(APP_IDS.sort()).toEqual(["krita", "photoshop"]);
    expect(APP_PROFILES.krita.bundleId).toBe("org.krita");
    expect(APP_PROFILES.photoshop.bundleId).toBe("com.adobe.Photoshop");
    expect(APP_PROFILES.photoshop.helperArg).toBe("photoshop");
    expect(APP_PROFILES.krita.plugin).toBe(true);
    expect(APP_PROFILES.photoshop.plugin).toBe(false);
    expect(isAppId("photoshop")).toBe(true);
    expect(isAppId("gimp")).toBe(false);
  });

  it("@P4 every profile key names a krita-scoped action and is a well-formed combo", () => {
    for (const p of Object.values(APP_PROFILES)) {
      for (const [id, k] of Object.entries(p.keys)) {
        const a = ACTIONS_BY_ID[id];
        expect(a, `${p.id}.${id}`).toBeDefined();
        expect(a.scope).not.toBe("canvas");
        expect(k.combo).toMatch(MAC_COMBO);
      }
    }
  });

  it("@P4 Photoshop shortcuts for the core actions", () => {
    const k = (id: string) => APP_PROFILES.photoshop.keys[id]?.combo;
    expect([k("undo"), k("redo"), k("brush"), k("eraser"), k("bigger"), k("smaller")]).toEqual([
      "cmd+z",
      "cmd+shift+z",
      "b",
      "e",
      "]",
      "[",
    ]);
    expect([k("zoom_in"), k("zoom_out"), k("fit"), k("actual"), k("swap"), k("save")]).toEqual([
      "cmd+=",
      "cmd+-",
      "cmd+0",
      "cmd+1",
      "x",
      "cmd+s",
    ]);
    expect([k("merge_down"), k("pick")]).toEqual(["cmd+e", "i"]);
    expect(APP_PROFILES.photoshop.keys.line.unverified).toBe(true);
    expect(APP_PROFILES.photoshop.keys.new_layer.unverified).toBe(true);
  });

  it("@P4 Krita profile is exactly the action table's keystroke fallbacks", () => {
    expect(APP_PROFILES.krita.keys.undo.combo).toBe("cmd+z");
    expect(APP_PROFILES.krita.keys.swap.combo).toBe("x");
  });
});

describe("appMessageFor", () => {
  it("@P4 Krita delegates to kritaMessageFor (plugin path)", () => {
    for (const a of ACTIONS) expect(appMessageFor(a, "krita", OPTS)).toEqual(kritaMessageFor(a, OPTS));
  });

  it("@P4 Photoshop always sends keys, never a krita message, even with the plugin 'connected'", () => {
    for (const a of ACTIONS) {
      const r = appMessageFor(a, "photoshop", OPTS);
      if ("msg" in r) {
        expect(r.msg.t).toBe("keys");
        expect(WorkerToHelperSchema.safeParse({ ...r.msg, id: "x" }).success).toBe(true);
      }
    }
    expect(appMessageFor(A("undo"), "photoshop", OPTS)).toEqual({ msg: { t: "keys", combo: "cmd+z" } });
    expect(appMessageFor(A("zoom_in"), "photoshop", OPTS)).toEqual({ msg: { t: "keys", combo: "cmd+=" } });
    expect(appMessageFor(A("merge_down"), "photoshop", OPTS)).toEqual({ msg: { t: "keys", combo: "cmd+e" } });
  });

  it("@P4 Krita-only actions answer needs_plugin in Photoshop; Steady-internal ones are unknown", () => {
    for (const id of ["colour_blue", "size", "opacity", "lighter", "pencil", "turn_left", "mirror", "show_numbers", "skin"]) {
      expect(appMessageFor(A(id), "photoshop", OPTS), id).toEqual({ error: "needs_plugin" });
    }
    expect(appMessageFor(A("steadier"), "photoshop", OPTS)).toEqual({ error: "unknown" });
    expect(appMessageFor(A("pen_toggle"), "photoshop", OPTS)).toEqual({ error: "unknown" });
  });
});
