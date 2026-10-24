/**
 * /api/command logic, separated from route.ts so it is unit-testable with an injected client.
 * Server-only: imports @anthropic-ai/sdk. Never import this from client code.
 *
 * §8: client.messages.parse with the cached SYSTEM_BLOCK, thinking disabled, effort low,
 * zodOutputFormat(ActionsSchema), max_tokens 512, {timeout: 2500, maxRetries: 0}; never a forced
 * tool_choice. parsed_output === null (or a zod/JSON failure inside the SDK) → reason "invalid";
 * timeout → reason "timeout". Prewarm uses the same SYSTEM_BLOCK and a 30 s timeout.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { mockInterpret } from "./mock";
import {
  ActionsSchema,
  CommandRequestSchema,
  normaliseOutput,
  type ActionsOutput,
  type CommandResponse,
  type ErrorReason,
} from "./schema";
import { SYSTEM_BLOCK } from "./systemBlock";

export const MODEL = "claude-haiku-5-5";
export const TIMEOUT_MS = 2500;
export const PREWARM_TIMEOUT_MS = 30000;

/** One format object per process: the JSON schema it carries is byte-identical on every call. */
const OUTPUT_FORMAT = zodOutputFormat(ActionsSchema);

/** Fixed prewarm payload (a filler word): exercises grammar compilation and the cache write. */
const PREWARM_PAYLOAD = JSON.stringify({
  text: "um",
  context: { tool: null, preset: null, size: null, opacity: null, color: null, steadiness: 50, lastActions: [] },
});

/** Minimal surface of the SDK we use (lets tests inject a fake). */
export interface ParseClient {
  messages: {
    parse: (params: any, options?: { timeout?: number; maxRetries?: number }) => PromiseLike<{ parsed_output: unknown }>;
  };
}

export function buildParams(userContent: string) {
  return {
    model: MODEL,
    max_tokens: 512,
    system: [{ type: "text" as const, text: SYSTEM_BLOCK, cache_control: { type: "ephemeral" as const } }],
    messages: [{ role: "user" as const, content: userContent }],
    thinking: { type: "disabled" as const },
    output_config: { effort: "low" as const, format: OUTPUT_FORMAT },
  };
}

function classifyError(err: unknown): ErrorReason {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (err instanceof Anthropic.AuthenticationError) return "key_missing";
  // Structured-output parse failures (bad JSON / zod rejection) surface as a plain AnthropicError.
  if (err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError)) return "invalid";
  return "upstream";
}

function toResponse(out: ActionsOutput | null, latencyMs: number, mock: boolean): CommandResponse {
  if (!out) return { kind: "error", reason: "invalid", latencyMs, mock };
  if (out.kind === "actions") return { kind: "actions", first: out.first, second: out.second, arg: out.arg, latencyMs, mock };
  if (out.kind === "clarify") return { kind: "clarify", options: out.options, latencyMs, mock };
  return { kind: "noop", latencyMs, mock };
}

export interface HandlerDeps {
  apiKey: string | undefined;
  /** Injected for tests; default constructs the real SDK client. */
  makeClient?: (apiKey: string) => ParseClient;
  now?: () => number;
}

let cachedClient: { key: string; client: ParseClient } | null = null;
function defaultClient(apiKey: string): ParseClient {
  if (!cachedClient || cachedClient.key !== apiKey) {
    cachedClient = { key: apiKey, client: new Anthropic({ apiKey }) as unknown as ParseClient };
  }
  return cachedClient.client;
}

export async function handleCommand(body: unknown, deps: HandlerDeps): Promise<{ status: number; json: CommandResponse | { error: string } }> {
  const now = deps.now ?? (() => Date.now());
  const req = CommandRequestSchema.safeParse(body);
  if (!req.success) return { status: 400, json: { error: "bad_request" } };
  const t0 = now();
  const prewarm = "prewarm" in req.data;

  if (!deps.apiKey) {
    if (prewarm) return { status: 200, json: { kind: "noop", prewarm: true, latencyMs: 0, mock: true } };
    const text = (req.data as { text: string }).text;
    const out = mockInterpret(text);
    const latencyMs = Math.round(now() - t0);
    if (!out) return { status: 200, json: { kind: "error", reason: "key_missing", latencyMs, mock: true } };
    // The mock goes through the same validation as Claude's output.
    return { status: 200, json: toResponse(normaliseOutput(out), latencyMs, true) };
  }

  const client = (deps.makeClient ?? defaultClient)(deps.apiKey);
  // Privacy (§0 rule 9): forward only the validated fields, rebuilt explicitly.
  const content = prewarm
    ? PREWARM_PAYLOAD
    : (() => {
        const d = req.data as { text: string; context: Record<string, unknown> };
        const c = d.context;
        return JSON.stringify({
          text: d.text,
          context: {
            tool: c.tool, preset: c.preset, size: c.size, opacity: c.opacity,
            color: c.color, steadiness: c.steadiness, lastActions: c.lastActions,
          },
        });
      })();

  try {
    const msg = await client.messages.parse(buildParams(content), {
      timeout: prewarm ? PREWARM_TIMEOUT_MS : TIMEOUT_MS,
      maxRetries: 0,
    });
    const latencyMs = Math.round(now() - t0);
    if (prewarm) return { status: 200, json: { kind: "noop", prewarm: true, latencyMs, mock: false } };
    if (msg.parsed_output === null || msg.parsed_output === undefined) {
      return { status: 200, json: { kind: "error", reason: "invalid", latencyMs, mock: false } };
    }
    return { status: 200, json: toResponse(normaliseOutput(msg.parsed_output), latencyMs, false) };
  } catch (err) {
    const latencyMs = Math.round(now() - t0);
    const reason = classifyError(err);
    if (reason === "upstream" || reason === "key_missing") console.error("[api/command]", reason, err);
    return {
      status: 200,
      json: { kind: "error", reason, latencyMs, mock: false, ...(prewarm ? { prewarm: true as const } : {}) },
    };
  }
}
