import { describe, expect, it } from "vitest";
import { ACTIONS, DEFAULT_KEYS, PHASE_ORDER } from "../actions";

/** §4 core actions and their default keys. */
const CORE_KEYS: Record<string, string> = {
  pen_toggle: "F8",
  pause: "F9",
  mic: "F10",
  undo: "F7",
  redo: "F6",
  recenter: "F5",
  other_hand: "F4",
  latch: "F3",
};

describe("action table (src/actions.ts)", () => {
  it("@P0 every action has a label, a scope and a phase; ids are unique", () => {
    const ids = new Set<string>();
    for (const a of ACTIONS) {
      expect(a.label.trim().length, a.id).toBeGreaterThan(0);
      expect(["canvas", "krita", "both"], a.id).toContain(a.scope);
      expect(PHASE_ORDER, a.id).toContain(a.phase);
      expect(ids.has(a.id), a.id).toBe(false);
      ids.add(a.id);
    }
  });

  it("@P0 every action has a typed form and ≥ 1 voice phrase, except mic and pen_toggle ([])", () => {
    for (const a of ACTIONS) {
      if (a.id === "mic" || a.id === "pen_toggle") {
        expect(a.voicePhrases, a.id).toEqual([]);
        expect(a.typed, a.id).toBeNull();
        continue;
      }
      expect(a.voicePhrases.length, a.id).toBeGreaterThanOrEqual(1);
      expect(typeof a.typed === "string" && a.typed.length > 0, a.id).toBe(true);
    }
    const empty = ACTIONS.filter((a) => a.voicePhrases.length === 0).map((a) => a.id).sort();
    expect(empty).toEqual(["mic", "pen_toggle"]);
  });

  it("@P0 key is non-null iff the action is a §4 core action, with the default key", () => {
    for (const a of ACTIONS) {
      if (a.id in CORE_KEYS) expect(a.key, a.id).toBe(CORE_KEYS[a.id]);
      else expect(a.key, a.id).toBeNull();
    }
    expect(DEFAULT_KEYS).toEqual(Object.fromEntries(Object.entries(CORE_KEYS).map(([id, k]) => [k, id])));
  });

  it("@P0 no bare 'pen' or bare 'undo' voice phrase; mode-changing actions are never fuzzy", () => {
    const phrases = ACTIONS.flatMap((a) => a.voicePhrases);
    expect(phrases).not.toContain("pen");
    expect(phrases).not.toContain("undo");
    for (const a of ACTIONS) if (a.modeChanging) expect(a.fuzzyAllowed, a.id).toBe(false);
  });
});
