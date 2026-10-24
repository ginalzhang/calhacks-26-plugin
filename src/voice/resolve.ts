/**
 * Command resolution (§8), the same path for a voice transcript and for the typed box:
 *   (1) the local grammar (A's parseCommand; it also coalesces "undo that undo that …" into one
 *       {action:"undo", arg:N}, which B's dispatcher runs N times 50 ms apart, and puts a word
 *       argument such as the alias in "call this brush fluffy" into `variant`);
 *   (2) only on no match, and never while a dialog/clarify prompt is open, POST /api/command with
 *       the text plus exactly the privacy-rule context fields; ids are compared case-insensitively;
 *   on timeout / invalid output / offline / key missing → kind "none" with the two closest grammar
 *   matches (closestActions) so the UI shows "Didn't catch that" with tiles; the transcript is never
 *   discarded silently.
 * Client-only module: never imports the Anthropic SDK.
 */
import { ACTIONS } from "../actions";
import { closestActions, parseCommand } from "../pipeline/grammar";
import type { CommandContext, ParseOptions, ParseResult, ParsedCommand, Resolution } from "../pipeline/types";
import { logClaudeCall, markClaudeOutcome, type ClaudeOutcome } from "./claudeLog";

/** Server times out at 2500 ms; allow for the round trip before the client gives up. */
export const CLIENT_TIMEOUT_MS = 4000;

export interface ResolveOptions {
  mode: "voice" | "typed";
  dialogOpen: boolean;
  context: CommandContext;
  aliases?: Record<string, string>;
  /** Optional status sink ("Claude key missing", "Asking Claude…"). */
  onStatus?: (text: string, level: "status" | "alert") => void;
}

export interface ResolveDeps {
  parse: (text: string, opts: ParseOptions) => ParseResult;
  closest: (text: string, n: number) => string[];
  fetchImpl: typeof fetch;
  now: () => number;
  online: () => boolean;
}

const defaultDeps = (): ResolveDeps => ({
  parse: parseCommand,
  closest: closestActions,
  fetchImpl: (...args) => fetch(...args),
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  online: () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
});

const LOWER_TO_ACTION = new Map(ACTIONS.map((a) => [a.id.toLowerCase(), a]));
function canonical(id: unknown) {
  return typeof id === "string" ? (LOWER_TO_ACTION.get(id.trim().toLowerCase()) ?? null) : null;
}

/** Exactly the §0 rule 9 list, rebuilt field by field (nothing else ever leaves the machine). */
export function pickContext(c: CommandContext): CommandContext {
  return {
    tool: c.tool ?? null,
    preset: c.preset ?? null,
    size: typeof c.size === "number" ? c.size : null,
    opacity: typeof c.opacity === "number" ? c.opacity : null,
    color: c.color ?? null,
    steadiness: c.steadiness,
    lastActions: (c.lastActions ?? []).slice(-3),
  };
}

let lastClarifyLogId: string | null = null;
/** B calls this when a Claude clarify prompt closes: a picked option = accepted, cancel = rejected. */
export function resolveClarify(accepted: boolean): void {
  if (lastClarifyLogId) markClaudeOutcome(lastClarifyLogId, accepted ? "accepted" : "rejected");
  lastClarifyLogId = null;
}

type ApiResponse =
  | { kind: "actions"; first: string; second: string | null; arg: number | null; latencyMs: number; mock: boolean }
  | { kind: "clarify"; options: string[]; latencyMs: number; mock: boolean }
  | { kind: "noop"; latencyMs: number; mock: boolean }
  | { kind: "error"; reason: "timeout" | "invalid" | "key_missing" | "upstream"; latencyMs: number; mock: boolean };

function shortQuote(text: string): string {
  return text.length > 60 ? `"${text.slice(0, 57)}…"` : `"${text}"`;
}

export async function resolveText(text: string, opts: ResolveOptions, depsIn?: Partial<ResolveDeps>): Promise<Resolution> {
  const deps: ResolveDeps = { ...defaultDeps(), ...depsIn };
  const heard = text.trim();
  if (!heard) return { kind: "noop", heard };

  // (1) grammar
  const parsed = deps.parse(heard, { mode: opts.mode, dialogOpen: opts.dialogOpen, aliases: opts.aliases });
  if (parsed.kind === "match") return { kind: "commands", commands: parsed.commands, heard, via: "grammar" };

  // Dialogs and clarify prompts: exact grammar only, never Claude, no suggestion tiles.
  if (opts.dialogOpen) return { kind: "none", heard, closest: [], reason: "nomatch" };

  const closest = () => {
    const fromGrammar = parsed.closest?.length ? parsed.closest : deps.closest(heard, 2);
    return fromGrammar.slice(0, 2);
  };
  const none = (reason: "timeout" | "invalid" | "offline" | "key_missing"): Resolution => ({
    kind: "none",
    heard,
    closest: closest(),
    reason,
  });
  const log = (outcome: ClaudeOutcome, latencyMs: number, mock: boolean, what: string) =>
    logClaudeCall({ summary: `${shortQuote(heard)} → ${what}`, latencyMs, outcome, mock });

  // (2) Claude fallback
  if (!deps.online()) {
    log("offline", 0, false, "offline");
    opts.onStatus?.("Offline: only exact commands work. Tiles, keys and the typed box still work.", "status");
    return none("offline");
  }

  const t0 = deps.now();
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), CLIENT_TIMEOUT_MS);
  let body: ApiResponse;
  try {
    const res = await deps.fetchImpl("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: heard.slice(0, 500), context: pickContext(opts.context) }),
      signal: ctl?.signal,
    });
    if (!res.ok) {
      log(res.status >= 500 ? "upstream" : "invalid", deps.now() - t0, false, `HTTP ${res.status}`);
      return none(res.status >= 500 ? "offline" : "invalid");
    }
    body = (await res.json()) as ApiResponse;
  } catch (err) {
    const latency = deps.now() - t0;
    const aborted = (err as { name?: string })?.name === "AbortError";
    log(aborted ? "timeout" : "offline", latency, false, aborted ? "timeout" : "network error");
    return none(aborted ? "timeout" : "offline");
  } finally {
    clearTimeout(timer);
  }
  const latency = deps.now() - t0;
  const mock = body?.mock === true;
  if (mock) opts.onStatus?.("Claude key missing: using the offline keyword matcher.", "status");

  switch (body?.kind) {
    case "actions": {
      const first = canonical(body.first);
      const second = body.second == null ? null : canonical(body.second);
      if (!first || (body.second != null && !second)) {
        log("invalid", latency, mock, `unknown id ${String(body.first)}`);
        return none("invalid");
      }
      const arg = typeof body.arg === "number" && Number.isFinite(body.arg) ? body.arg : null;
      const argOwner = first.arg === "number" ? first : second?.arg === "number" ? second : null;
      const commands: ParsedCommand[] = [];
      for (const a of [first, second]) {
        if (!a) continue;
        // Word arguments (alias names) must come from the user verbatim, never from Claude.
        if (a.arg === "word") continue;
        if (a.arg === "number") {
          if (a !== argOwner || arg === null) continue; // a size/opacity with no number is meaningless
          commands.push({ action: a.id, arg });
        } else {
          commands.push({ action: a.id });
        }
      }
      if (commands.length === 0) {
        log("invalid", latency, mock, "no usable action");
        return none("invalid");
      }
      log("accepted", latency, mock, commands.map((c) => (c.arg != null ? `${c.action} ${c.arg}` : c.action)).join(" + "));
      return { kind: "commands", commands, heard, via: "claude" };
    }
    case "clarify": {
      const options = [...new Set((body.options ?? []).map((o) => canonical(o)?.id).filter((x): x is string => !!x))].slice(0, 3);
      if (options.length === 0) {
        log("invalid", latency, mock, "empty clarify");
        return none("invalid");
      }
      lastClarifyLogId = log("pending", latency, mock, `clarify ${options.join(" / ")}`).id;
      return { kind: "clarify", options, heard };
    }
    case "noop":
      log("noop", latency, mock, "noop");
      return { kind: "noop", heard };
    case "error": {
      const reason = body.reason === "upstream" ? "offline" : body.reason;
      log(body.reason, latency, mock, body.reason);
      if (reason === "key_missing") opts.onStatus?.("Claude key missing: only exact commands work.", "status");
      return none(reason === "timeout" || reason === "invalid" || reason === "key_missing" ? reason : "offline");
    }
    default:
      log("invalid", latency, mock, "malformed response");
      return none("invalid");
  }
}
