import { describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ActionsSchema, CLAUDE_ACTION_IDS, canonicalId, normaliseOutput } from "./schema";
import { SYSTEM_BLOCK, estimateTokens } from "./systemBlock";
import { buildParams, handleCommand, MODEL, PREWARM_TIMEOUT_MS, TIMEOUT_MS, type ParseClient } from "./handler";
import { mockInterpret } from "./mock";

const ctx = {
  tool: "brush",
  preset: "b) Basic-5 Size",
  size: 40,
  opacity: 100,
  color: "#1d4ed8",
  steadiness: 50,
  lastActions: ["colour_blue", "bigger", "new_layer"],
};

function fakeClient(impl: (params: any, opts: any) => Promise<{ parsed_output: unknown }>) {
  const calls: Array<{ params: any; opts: any }> = [];
  const client: ParseClient = {
    messages: {
      parse: (params, opts) => {
        calls.push({ params, opts });
        return impl(params, opts);
      },
    },
  };
  return { client, calls };
}

describe("ActionsSchema (zod)", () => {
  it("@P2a accepts the three valid shapes", () => {
    expect(ActionsSchema.safeParse({ kind: "actions", first: "smaller", second: "airbrush", arg: null }).success).toBe(true);
    expect(ActionsSchema.safeParse({ kind: "clarify", options: ["lighter", "fade"] }).success).toBe(true);
    expect(ActionsSchema.safeParse({ kind: "noop" }).success).toBe(true);
  });

  it("@P2a zod rejects malformed Claude output", () => {
    const bad: unknown[] = [
      { kind: "actions", first: "make_it_pretty", second: null, arg: null }, // unknown id
      { kind: "actions", first: "smaller", arg: null }, // second missing
      { kind: "actions", first: "smaller", second: null, arg: "big" }, // arg not a number
      { kind: "clarify", options: "fade" }, // not an array
      { kind: "launch_rockets" }, // unknown kind
      { first: "smaller" }, // no discriminator
      null,
      "smaller",
      { kind: "actions", first: "mic", second: null, arg: null }, // mic is key/tile only
      { kind: "actions", first: "yes", second: null, arg: null }, // dialog vocabulary is exact-match only
    ];
    for (const b of bad) expect(ActionsSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
    for (const b of bad) expect(normaliseOutput(b), JSON.stringify(b)).toBeNull();
  });

  it("@P2a the SDK output format rejects malformed JSON and schema violations", () => {
    const fmt = zodOutputFormat(ActionsSchema);
    expect(fmt.type).toBe("json_schema");
    expect(() => fmt.parse("not json")).toThrow(Anthropic.AnthropicError);
    expect(() => fmt.parse('{"kind":"actions","first":"nope","second":null,"arg":null}')).toThrow(Anthropic.AnthropicError);
    expect(fmt.parse('{"kind":"noop"}')).toEqual({ kind: "noop" });
  });

  it("@P2a has no min/max/length constraints in the JSON schema", () => {
    const s = JSON.stringify(zodOutputFormat(ActionsSchema).schema);
    expect(s).not.toMatch(/minItems|maxItems|minLength|maxLength|"minimum"|"maximum"/);
  });

  it("@P2a compares ids case-insensitively", () => {
    expect(canonicalId("SMALLER")).toBe("smaller");
    expect(canonicalId(" Colour_Blue ")).toBe("colour_blue");
    expect(normaliseOutput({ kind: "actions", first: "Smaller", second: "AIRBRUSH", arg: null })).toEqual({
      kind: "actions",
      first: "smaller",
      second: "airbrush",
      arg: null,
    });
    expect(normaliseOutput({ kind: "clarify", options: ["FADE", "fade", "Lighter", "bigger", "smaller"] })).toEqual({
      kind: "clarify",
      options: ["fade", "lighter", "bigger"],
    });
    expect(normaliseOutput({ kind: "clarify", options: [] })).toBeNull();
  });

  it("@P2a the Claude action set excludes dialog words and key/tile-only actions", () => {
    for (const id of ["mic", "pen_toggle", "yes", "no", "cancel", "choice_one"]) expect(CLAUDE_ACTION_IDS).not.toContain(id);
    for (const id of ["smaller", "airbrush", "undo", "colour_blue", "new_layer", "size"]) expect(CLAUDE_ACTION_IDS).toContain(id);
  });
});

describe("SYSTEM_BLOCK", () => {
  it("@P2a is byte-identical across module loads and calls", async () => {
    vi.resetModules();
    const again = await import("./systemBlock");
    expect(again.SYSTEM_BLOCK).toBe(SYSTEM_BLOCK);
    const a = buildParams("x").system[0];
    const b = buildParams("y").system[0];
    expect(a.text).toBe(b.text);
    expect(a.text).toBe(SYSTEM_BLOCK);
    expect(a.cache_control).toEqual({ type: "ephemeral" });
    expect(SYSTEM_BLOCK).not.toMatch(/\d{4}-\d{2}-\d{2}T|Date|timestamp/);
  });

  it("@P2a is ≥ 512 tokens (chars/4) so the prompt cache applies", () => {
    expect(estimateTokens(SYSTEM_BLOCK)).toBeGreaterThanOrEqual(512);
  });

  it("@P2a contains every Claude action id, its phrases and the preset family list", () => {
    for (const id of CLAUDE_ACTION_IDS) expect(SYSTEM_BLOCK).toContain(`- ${id} (`);
    for (const f of ["basic", "pencil", "ink", "airbrush", "eraser"]) expect(SYSTEM_BLOCK).toContain(`"${f}"`);
    expect(SYSTEM_BLOCK).toContain('"undo that"');
  });
});

describe("POST /api/command handler", () => {
  it("@P2a returns the mock with mock:true when ANTHROPIC_API_KEY is missing", async () => {
    const r = await handleCommand({ text: "make it thinner and a bit softer", context: ctx }, { apiKey: undefined });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ kind: "actions", first: "smaller", second: "airbrush", arg: null, mock: true });
  });

  it("@P2a mock: noop for fillers, clarify for ambiguity, key_missing when nothing matches", async () => {
    const noop = await handleCommand({ text: "um uh", context: ctx }, { apiKey: undefined });
    expect(noop.json).toMatchObject({ kind: "noop", mock: true });
    const clar = await handleCommand({ text: "make it lighter", context: ctx }, { apiKey: undefined });
    expect(clar.json).toMatchObject({ kind: "clarify", options: ["lighter", "fade"], mock: true });
    const miss = await handleCommand({ text: "paint the room", context: ctx }, { apiKey: undefined });
    expect(miss.json).toMatchObject({ kind: "error", reason: "key_missing", mock: true });
    const pre = await handleCommand({ prewarm: true }, { apiKey: undefined });
    expect(pre.json).toMatchObject({ kind: "noop", prewarm: true, mock: true });
  });

  it("@P2a mock matcher covers the demo paraphrases", () => {
    expect(mockInterpret("set the brush to 40")).toEqual({ kind: "actions", first: "size", second: null, arg: 40 });
    expect(mockInterpret("oops go back")).toMatchObject({ first: "undo" });
    expect(mockInterpret("navy and fatter")).toMatchObject({ first: "colour_blue", second: "bigger" });
    expect(mockInterpret("*cough*")).toEqual({ kind: "noop" });
  });

  it("@P2a rejects a malformed request body with 400", async () => {
    expect((await handleCommand({ text: "" }, { apiKey: undefined })).status).toBe(400);
    expect((await handleCommand(null, { apiKey: undefined })).status).toBe(400);
    expect((await handleCommand({ text: "x", context: { ...ctx, steadiness: "high" } }, { apiKey: undefined })).status).toBe(400);
  });

  it("@P2a calls messages.parse exactly per §8 and forwards only the privacy-rule fields", async () => {
    const { client, calls } = fakeClient(async () => ({ parsed_output: { kind: "actions", first: "smaller", second: "airbrush", arg: null } }));
    const r = await handleCommand(
      { text: "make it thinner and a bit softer", context: { ...ctx, secret: "nope" } },
      { apiKey: "k", makeClient: () => client },
    );
    expect(r.json).toMatchObject({ kind: "actions", first: "smaller", second: "airbrush", mock: false });
    expect(calls).toHaveLength(1);
    const { params, opts } = calls[0];
    expect(params.model).toBe(MODEL);
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params.max_tokens).toBe(512);
    expect(params.thinking).toEqual({ type: "disabled" });
    expect(params.output_config.effort).toBe("low");
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.tool_choice).toBeUndefined();
    expect(params.tools).toBeUndefined();
    expect(params.system).toEqual([{ type: "text", text: SYSTEM_BLOCK, cache_control: { type: "ephemeral" } }]);
    expect(opts).toEqual({ timeout: TIMEOUT_MS, maxRetries: 0 });
    expect(TIMEOUT_MS).toBe(2500);
    const sent = JSON.parse(params.messages[0].content);
    expect(Object.keys(sent)).toEqual(["text", "context"]);
    expect(Object.keys(sent.context).sort()).toEqual(["color", "lastActions", "opacity", "preset", "size", "steadiness", "tool"]);
  });

  it("@P2a parsed_output === null → error invalid", async () => {
    const { client } = fakeClient(async () => ({ parsed_output: null }));
    const r = await handleCommand({ text: "blah", context: ctx }, { apiKey: "k", makeClient: () => client });
    expect(r.json).toMatchObject({ kind: "error", reason: "invalid", mock: false });
  });

  it("@P2a SDK structured-output parse failure → error invalid", async () => {
    const { client } = fakeClient(async () => {
      throw new Anthropic.AnthropicError("Failed to parse structured output: bad");
    });
    const r = await handleCommand({ text: "blah", context: ctx }, { apiKey: "k", makeClient: () => client });
    expect(r.json).toMatchObject({ kind: "error", reason: "invalid" });
  });

  it("@P2a timeout → error timeout", async () => {
    const { client } = fakeClient(async () => {
      throw new Anthropic.APIConnectionTimeoutError();
    });
    const r = await handleCommand({ text: "blah", context: ctx }, { apiKey: "k", makeClient: () => client });
    expect(r.json).toMatchObject({ kind: "error", reason: "timeout" });
  });

  it("@P2a prewarm uses the same SYSTEM_BLOCK with a 30 s timeout", async () => {
    const { client, calls } = fakeClient(async () => ({ parsed_output: { kind: "noop" } }));
    const r = await handleCommand({ prewarm: true }, { apiKey: "k", makeClient: () => client });
    expect(r.json).toMatchObject({ kind: "noop", prewarm: true, mock: false });
    expect(calls[0].opts).toEqual({ timeout: PREWARM_TIMEOUT_MS, maxRetries: 0 });
    expect(PREWARM_TIMEOUT_MS).toBe(30000);
    expect(calls[0].params.system[0].text).toBe(SYSTEM_BLOCK);
    expect(calls[0].params.max_tokens).toBeGreaterThan(0);
  });
});
