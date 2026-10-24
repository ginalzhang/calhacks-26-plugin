import { describe, expect, it, vi } from "vitest";
import { ACTIONS, EXTRA_KEYTERMS } from "../actions";

// Until/unless A's grammar is importable here, keyterms() is stubbed with the §6 definition:
// every voice phrase in the action table plus EXTRA_KEYTERMS (aliases are never included).
vi.mock("../pipeline/grammar", () => ({
  parseCommand: vi.fn(),
  closestActions: vi.fn(() => []),
  keyterms: vi.fn(() => [...ACTIONS.flatMap((a) => a.voicePhrases), ...EXTRA_KEYTERMS]),
}));

import { KEYTERM_MAX_CHARS, KEYTERM_MAX_COUNT, limitKeyterms, sttKeyterms } from "./keyterms";

const total = (t: string[]) => t.reduce((s, k) => s + k.length, 0);

describe("STT keyterms", () => {
  it("@P2a the generated list is ≤ 100 entries and ≤ 1200 characters", () => {
    const k = sttKeyterms();
    expect(k.length).toBeGreaterThan(0);
    expect(k.length).toBeLessThanOrEqual(100);
    expect(total(k)).toBeLessThanOrEqual(1200);
    expect(k).toContain("undo that");
    expect(k).toContain("layer");
    expect(k).toContain("later");
  });

  it("@P2a limits are enforced on an oversized list (count and characters), deduped, exact casing", () => {
    const many = Array.from({ length: 150 }, (_, i) => `term${i}`);
    const a = limitKeyterms(many);
    expect(a).toHaveLength(KEYTERM_MAX_COUNT);
    const long = Array.from({ length: 60 }, (_, i) => `${"x".repeat(28)}${String(i).padStart(2, "0")}`);
    const b = limitKeyterms(long);
    expect(total(b)).toBeLessThanOrEqual(KEYTERM_MAX_CHARS);
    expect(b).toHaveLength(40);
    expect(limitKeyterms(["Undo that", "Undo that", " ", "bigger"])).toEqual(["Undo that", "bigger"]);
  });

  it("@P2a aliases are excluded (only what the grammar's keyterms() returns is used)", () => {
    expect(sttKeyterms(() => ["bigger"])).toEqual(["bigger"]);
  });
});
