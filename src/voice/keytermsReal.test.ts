import { describe, expect, it } from "vitest";
import { keyterms } from "../pipeline/grammar";
import { sttKeyterms } from "./keyterms";

describe("STT keyterms from A's real grammar", () => {
  it("@P2a keyterms() feeds the socket unchanged and within ≤ 100 / ≤ 1200", () => {
    const raw = keyterms();
    const k = sttKeyterms();
    expect(k.length).toBeLessThanOrEqual(100);
    expect(k.reduce((s, t) => s + t.length, 0)).toBeLessThanOrEqual(1200);
    expect(k).toEqual([...new Set(raw.map((t) => t.trim()).filter(Boolean))]);
    expect(k).toContain("undo that");
  });
});

import { resolveText } from "./resolve";
import { setClaudeLogStorage } from "./claudeLog";
import { FakeStorage } from "./testStorage";

describe("resolveText with A's real grammar", () => {
  it("@P2a the demo paraphrase misses the grammar and reaches /api/command", async () => {
    setClaudeLogStorage(new FakeStorage());
    let called = 0;
    const fetchImpl = (async () => {
      called++;
      return new Response(JSON.stringify({ kind: "actions", first: "smaller", second: "airbrush", arg: null, latencyMs: 1, mock: true }));
    }) as unknown as typeof fetch;
    const r = await resolveText(
      "make it thinner and a bit softer",
      { mode: "voice", dialogOpen: false, context: { tool: null, preset: null, size: null, opacity: null, color: null, steadiness: 50, lastActions: [] } },
      { fetchImpl, online: () => true },
    );
    expect(called).toBe(1);
    expect(r).toMatchObject({ kind: "commands", via: "claude", commands: [{ action: "smaller" }, { action: "airbrush" }] });
    setClaudeLogStorage(null);
  });
});
