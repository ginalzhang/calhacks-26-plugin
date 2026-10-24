import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEYS } from "../pipeline/types";
import {
  CLAUDE_LOG_MAX,
  clearClaudeLog,
  logClaudeCall,
  markClaudeOutcome,
  markLastClaudeRejected,
  readClaudeLog,
  setClaudeLogStorage,
  summariseClaudeLog,
} from "./claudeLog";
import { FakeStorage } from "./testStorage";

let store: FakeStorage;
beforeEach(() => {
  store = new FakeStorage();
  setClaudeLogStorage(store);
});
afterEach(() => setClaudeLogStorage(null));

describe("Claude call log (localStorage)", () => {
  it("@P2a round-trips entries through Storage under STORAGE_KEYS.claudeLog", () => {
    const a = logClaudeCall({ summary: '"make it thinner" → smaller + airbrush', latencyMs: 640.4, outcome: "accepted", mock: false, t: 1 });
    logClaudeCall({ summary: '"blah" → timeout', latencyMs: 4000, outcome: "timeout", mock: false, t: 2 });
    const raw = store.getItem(STORAGE_KEYS.claudeLog);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed).toHaveLength(2);
    expect(readClaudeLog()).toEqual(parsed);
    expect(readClaudeLog()[0]).toMatchObject({ id: a.id, t: 1, latencyMs: 640, outcome: "accepted", mock: false });
  });

  it("@P2a summary counts calls, accepted, rejected, timeouts, invalid and mean latency", () => {
    logClaudeCall({ summary: "a", latencyMs: 600, outcome: "accepted", mock: false });
    logClaudeCall({ summary: "b", latencyMs: 2500, outcome: "timeout", mock: false });
    logClaudeCall({ summary: "c", latencyMs: 400, outcome: "invalid", mock: true });
    const p = logClaudeCall({ summary: "d", latencyMs: 500, outcome: "pending", mock: false });
    logClaudeCall({ summary: "e", latencyMs: 0, outcome: "offline", mock: false });
    expect(markClaudeOutcome(p.id, "rejected")).toBe(true);
    const s = summariseClaudeLog();
    expect(s).toMatchObject({ calls: 5, accepted: 1, rejected: 1, timeouts: 1, invalid: 1, errors: 1, mock: 1 });
    expect(s.meanLatencyMs).toBe(Math.round((600 + 2500 + 400 + 500) / 4));
  });

  it("@P2a markLastClaudeRejected flips the newest accepted entry (undo right after Claude)", () => {
    logClaudeCall({ summary: "a", latencyMs: 1, outcome: "accepted", mock: false });
    logClaudeCall({ summary: "b", latencyMs: 1, outcome: "timeout", mock: false });
    expect(markLastClaudeRejected()).toBe(true);
    expect(readClaudeLog().map((e) => e.outcome)).toEqual(["rejected", "timeout"]);
  });

  it("@P2a caps the log and survives corrupt storage", () => {
    for (let i = 0; i < CLAUDE_LOG_MAX + 5; i++) logClaudeCall({ summary: String(i), latencyMs: 1, outcome: "noop", mock: false });
    expect(readClaudeLog()).toHaveLength(CLAUDE_LOG_MAX);
    store.setItem(STORAGE_KEYS.claudeLog, "{not json");
    expect(readClaudeLog()).toEqual([]);
    clearClaudeLog();
    expect(store.getItem(STORAGE_KEYS.claudeLog)).toBeNull();
  });
});
