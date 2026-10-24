import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A's grammar is exercised by A's own tests; here it is replaced by a spy so the order of
// resolution (grammar first, Claude only on no match, exact only in dialogs) is observable.
vi.mock("../pipeline/grammar", () => ({
  parseCommand: vi.fn(() => ({ kind: "nomatch", closest: [] })),
  closestActions: vi.fn(() => ["bigger", "smaller"]),
  keyterms: vi.fn(() => []),
}));

import type { CommandContext, ParseResult } from "../pipeline/types";
import { readClaudeLog, setClaudeLogStorage } from "./claudeLog";
import { pickContext, resolveClarify, resolveText, type ResolveDeps } from "./resolve";
import { FakeStorage } from "./testStorage";

const context: CommandContext = {
  tool: "brush",
  preset: "b) Basic-5 Size",
  size: 40,
  opacity: 100,
  color: "#1d4ed8",
  steadiness: 50,
  lastActions: ["a", "colour_blue", "bigger", "new_layer"],
};

function deps(over: Partial<ResolveDeps> & { api?: unknown; status?: number; throws?: unknown } = {}) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    if (over.throws) throw over.throws;
    return new Response(JSON.stringify(over.api ?? { kind: "noop", latencyMs: 1, mock: false }), { status: over.status ?? 200 });
  }) as unknown as typeof fetch;
  const parse = over.parse ?? vi.fn((): ParseResult => ({ kind: "nomatch", closest: [] }));
  const d: Partial<ResolveDeps> = {
    parse,
    closest: over.closest ?? (() => ["bigger", "smaller"]),
    fetchImpl,
    now: () => 0,
    online: over.online ?? (() => true),
  };
  return { d, calls, fetchImpl, parse };
}

beforeEach(() => setClaudeLogStorage(new FakeStorage()));
afterEach(() => setClaudeLogStorage(null));

describe("resolveText order", () => {
  it("@P2a grammar first: a match never calls Claude", async () => {
    const parse = vi.fn((): ParseResult => ({ kind: "match", commands: [{ action: "colour_blue" }, { action: "bigger" }], fuzzy: false }));
    const { d, fetchImpl } = deps({ parse });
    const r = await resolveText("blue bigger", { mode: "voice", dialogOpen: false, context }, d);
    expect(r).toEqual({ kind: "commands", commands: [{ action: "colour_blue" }, { action: "bigger" }], heard: "blue bigger", via: "grammar" });
    expect(parse).toHaveBeenCalledWith("blue bigger", expect.objectContaining({ mode: "voice", dialogOpen: false }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readClaudeLog()).toHaveLength(0);
  });

  it("@P2a Claude only on no match, with exactly the CommandContext fields", async () => {
    const { d, calls } = deps({ api: { kind: "actions", first: "Smaller", second: "AIRBRUSH", arg: null, latencyMs: 600, mock: false } });
    const r = await resolveText("make it thinner and a bit softer", { mode: "voice", dialogOpen: false, context: { ...context, extra: 1 } as CommandContext }, d);
    expect(r).toEqual({
      kind: "commands",
      commands: [{ action: "smaller" }, { action: "airbrush" }],
      heard: "make it thinner and a bit softer",
      via: "claude",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/command");
    expect(Object.keys(calls[0].body)).toEqual(["text", "context"]);
    expect(Object.keys(calls[0].body.context).sort()).toEqual(["color", "lastActions", "opacity", "preset", "size", "steadiness", "tool"]);
    expect(calls[0].body.context.lastActions).toEqual(["colour_blue", "bigger", "new_layer"]);
    const log = readClaudeLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ outcome: "accepted", mock: false });
    expect(log[0].summary).toContain("smaller + airbrush");
  });

  it("@P2a dialogs: exact grammar only, never Claude", async () => {
    const parse = vi.fn((): ParseResult => ({ kind: "nomatch", closest: ["yes"] }));
    const { d, fetchImpl } = deps({ parse });
    const r = await resolveText("yeah sure", { mode: "voice", dialogOpen: true, context }, d);
    expect(r).toEqual({ kind: "none", heard: "yeah sure", closest: [], reason: "nomatch" });
    expect(parse).toHaveBeenCalledWith("yeah sure", expect.objectContaining({ dialogOpen: true }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("@P2a Claude arg goes to size/opacity; a size with no number is dropped", async () => {
    const a = deps({ api: { kind: "actions", first: "size", second: null, arg: 40, latencyMs: 1, mock: false } });
    expect(await resolveText("brush to forty", { mode: "typed", dialogOpen: false, context }, a.d)).toMatchObject({
      kind: "commands",
      commands: [{ action: "size", arg: 40 }],
    });
    const b = deps({ api: { kind: "actions", first: "size", second: null, arg: null, latencyMs: 1, mock: false } });
    expect(await resolveText("brush thing", { mode: "typed", dialogOpen: false, context }, b.d)).toMatchObject({ kind: "none", reason: "invalid" });
  });

  it("@P2a clarify passes 2–3 known options and logs pending → accepted", async () => {
    const { d } = deps({ api: { kind: "clarify", options: ["LIGHTER", "fade", "bogus"], latencyMs: 1, mock: false } });
    const r = await resolveText("make it lighter", { mode: "voice", dialogOpen: false, context }, d);
    expect(r).toEqual({ kind: "clarify", options: ["lighter", "fade"], heard: "make it lighter" });
    expect(readClaudeLog()[0].outcome).toBe("pending");
    resolveClarify(true);
    expect(readClaudeLog()[0].outcome).toBe("accepted");
  });

  it("@P2a noop (cough) resolves to noop", async () => {
    const { d } = deps({ api: { kind: "noop", latencyMs: 1, mock: false } });
    expect(await resolveText("*cough*", { mode: "voice", dialogOpen: false, context }, d)).toEqual({ kind: "noop", heard: "*cough*" });
  });
});

describe("resolveText fallbacks: closest two grammar matches", () => {
  const cases: Array<[string, Parameters<typeof deps>[0], string]> = [
    ["timeout", { api: { kind: "error", reason: "timeout", latencyMs: 2500, mock: false } }, "timeout"],
    ["invalid", { api: { kind: "error", reason: "invalid", latencyMs: 300, mock: false } }, "invalid"],
    ["key_missing", { api: { kind: "error", reason: "key_missing", latencyMs: 1, mock: true } }, "key_missing"],
    ["unknown id", { api: { kind: "actions", first: "paint_room", second: null, arg: null, latencyMs: 1, mock: false } }, "invalid"],
    ["network error", { throws: new TypeError("Failed to fetch") }, "offline"],
    ["client abort", { throws: Object.assign(new Error("aborted"), { name: "AbortError" }) }, "timeout"],
    ["navigator offline", { online: () => false }, "offline"],
    ["HTTP 500", { status: 500 }, "offline"],
  ];
  for (const [name, over, reason] of cases) {
    it(`@P2a ${name} → none/${reason} with closest-two`, async () => {
      const { d } = deps(over);
      const r = await resolveText("paint the room", { mode: "voice", dialogOpen: false, context }, d);
      expect(r).toEqual({ kind: "none", heard: "paint the room", closest: ["bigger", "smaller"], reason });
      expect(readClaudeLog()).toHaveLength(1);
    });
  }

  it("@P2a uses the grammar's own closest list when it has one", async () => {
    const parse = vi.fn((): ParseResult => ({ kind: "nomatch", closest: ["new_layer", "save", "fit"] }));
    const { d } = deps({ parse, online: () => false });
    const r = await resolveText("new lair", { mode: "voice", dialogOpen: false, context }, d);
    expect(r).toMatchObject({ kind: "none", closest: ["new_layer", "save"] });
  });
});

describe("grammar-owned arguments pass through unchanged", () => {
  it('@P2a "undo that" ×N arrives as one {action:"undo", arg:N} from the grammar, never via Claude', async () => {
    const parse = vi.fn((): ParseResult => ({ kind: "match", commands: [{ action: "undo", arg: 5 }], fuzzy: false }));
    const { d, fetchImpl } = deps({ parse });
    const r = await resolveText("undo that undo that undo that undo that undo that", { mode: "voice", dialogOpen: false, context }, d);
    expect(r).toEqual({ kind: "commands", commands: [{ action: "undo", arg: 5 }], heard: "undo that undo that undo that undo that undo that", via: "grammar" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("@P2b word arguments (alias names) keep the grammar's variant", async () => {
    const parse = vi.fn((): ParseResult => ({ kind: "match", commands: [{ action: "name_brush", variant: "fluffy" }], fuzzy: false }));
    const { d } = deps({ parse });
    const r = await resolveText("call this brush fluffy", { mode: "voice", dialogOpen: false, context }, d);
    expect(r).toMatchObject({ kind: "commands", commands: [{ action: "name_brush", variant: "fluffy" }], via: "grammar" });
  });

  it("@P2b Claude never supplies a word argument: name_brush from Claude is dropped", async () => {
    const { d } = deps({ api: { kind: "actions", first: "name_brush", second: null, arg: null, latencyMs: 1, mock: false } });
    const r = await resolveText("name it fluffy please", { mode: "voice", dialogOpen: false, context }, d);
    expect(r).toMatchObject({ kind: "none", reason: "invalid" });
    const { d: d2 } = deps({ api: { kind: "actions", first: "name_brush", second: "bigger", arg: null, latencyMs: 1, mock: false } });
    expect(await resolveText("x", { mode: "voice", dialogOpen: false, context }, d2)).toMatchObject({ kind: "commands", commands: [{ action: "bigger" }] });
  });
});

describe("network down (§13)", () => {
  it("@P2a offline: grammar still resolves; Claude is skipped with a clear status", async () => {
    const statuses: string[] = [];
    const hit = deps({ online: () => false, parse: vi.fn((): ParseResult => ({ kind: "match", commands: [{ action: "colour_blue" }], fuzzy: false })) });
    expect(await resolveText("blue", { mode: "typed", dialogOpen: false, context, onStatus: (t) => statuses.push(t) }, hit.d)).toMatchObject({ kind: "commands", via: "grammar" });
    const miss = deps({ online: () => false });
    const r = await resolveText("make it thinner", { mode: "typed", dialogOpen: false, context, onStatus: (t) => statuses.push(t) }, miss.d);
    expect(r).toMatchObject({ kind: "none", reason: "offline" });
    expect(miss.fetchImpl).not.toHaveBeenCalled();
    expect(statuses.join(" ")).toMatch(/Offline: only exact commands work/);
  });
});

describe("pickContext", () => {
  it("@P2a keeps exactly the privacy-rule fields and the last three actions", () => {
    const c = pickContext({ ...context, secret: "x" } as CommandContext);
    expect(Object.keys(c).sort()).toEqual(["color", "lastActions", "opacity", "preset", "size", "steadiness", "tool"]);
    expect(c.lastActions).toEqual(["colour_blue", "bigger", "new_layer"]);
  });
});
