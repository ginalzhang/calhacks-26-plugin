/**
 * /api/command shared schema (server + tests; imports only zod and the action table, so it is
 * safe to unit-test without the SDK). §8: ActionsSchema is a discriminated union with no
 * min/max/length constraints (the SDK strips them from the JSON schema anyway).
 */
import * as z from "zod/v4";
import { ACTIONS, ACTIONS_BY_ID, BUILD_PHASE, PHASE_ORDER, phaseAtMost, type Phase } from "../../../actions";

/**
 * Claude never answers in dialog vocabulary (yes/no/cancel/one/two/three: dialogs are exact-match
 * only, §0 rule 6), and never opens the mic or toggles the pen (key/tile only, rule 4).
 * Rows up to max(BUILD_PHASE, P2b) are offered: the route lands in P2a and P2b rows are
 * near; B's dispatcher renders a not-yet-landed row as "not available yet" rather than failing.
 */
export const CLAUDE_PHASE: Phase =
  PHASE_ORDER.indexOf(BUILD_PHASE) > PHASE_ORDER.indexOf("P2b") ? BUILD_PHASE : "P2b";

/** Demo-panel controls and clearing the practice canvas are never Claude's call. */
const NEVER_CLAUDE = new Set(["simulate_tremor", "next_judge", "clear_practice"]);

export const CLAUDE_ACTION_IDS: string[] = ACTIONS.filter(
  (a) =>
    a.voicePhrases.length > 0 &&
    a.page !== "dialog" &&
    a.page !== "demo" &&
    !NEVER_CLAUDE.has(a.id) &&
    // Word arguments (alias names, e.g. name_brush) must come from the user verbatim, not Claude.
    a.arg !== "word" &&
    phaseAtMost(a.phase, CLAUDE_PHASE),
).map((a) => a.id);

export const Action = z.enum(CLAUDE_ACTION_IDS as [string, ...string[]]);

export const ActionsSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("actions"),
    first: Action,
    second: Action.nullable(),
    arg: z.number().nullable(),
  }),
  z.object({
    kind: z.literal("clarify"),
    options: z.array(Action),
  }),
  z.object({
    kind: z.literal("noop"),
  }),
]);
export type ActionsOutput = z.infer<typeof ActionsSchema>;

/** Request body: exactly the privacy-rule (§0 rule 9) list. Unknown keys are dropped. */
export const CommandContextSchema = z.object({
  tool: z.string().max(64).nullable(),
  preset: z.string().max(128).nullable(),
  size: z.number().nullable(),
  opacity: z.number().nullable(),
  color: z.string().max(32).nullable(),
  steadiness: z.number(),
  lastActions: z.array(z.string().max(64)).max(3),
});

export const CommandRequestSchema = z.union([
  z.object({ prewarm: z.literal(true) }),
  z.object({ text: z.string().min(1).max(500), context: CommandContextSchema }),
]);
export type CommandRequest = z.infer<typeof CommandRequestSchema>;

export type ErrorReason = "timeout" | "invalid" | "key_missing" | "upstream";

/** Route response (docs/API.md). */
export type CommandResponse =
  | { kind: "actions"; first: string; second: string | null; arg: number | null; latencyMs: number; mock: boolean }
  | { kind: "clarify"; options: string[]; latencyMs: number; mock: boolean }
  | { kind: "noop"; latencyMs: number; mock: boolean; prewarm?: true }
  | { kind: "error"; reason: ErrorReason; latencyMs: number; mock: boolean; prewarm?: true };

const LOWER_TO_ID: Record<string, string> = Object.fromEntries(ACTIONS.map((a) => [a.id.toLowerCase(), a.id]));

/** Case-insensitive action id → canonical id, or null if unknown. */
export function canonicalId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  return LOWER_TO_ID[id.trim().toLowerCase()] ?? null;
}

/**
 * Validate an already-parsed object (from parsed_output or the mock) and normalise ids.
 * Returns null for anything malformed: that is the "Didn't catch that" path.
 * Clarify with zero known options is invalid; more than 3 options are trimmed to 3 (tiles "one/two/three").
 */
export function normaliseOutput(raw: unknown): ActionsOutput | null {
  // Case-insensitive compare: lower-case ids before zod sees them.
  let candidate = raw;
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const fix = (v: unknown) => (typeof v === "string" ? (canonicalId(v) ?? v) : v);
    candidate = {
      ...r,
      ...(r.first !== undefined ? { first: fix(r.first) } : {}),
      ...(r.second !== undefined ? { second: fix(r.second) } : {}),
      ...(Array.isArray(r.options) ? { options: r.options.map(fix) } : {}),
    };
  }
  const parsed = ActionsSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const out = parsed.data;
  if (out.kind === "clarify") {
    const options = [...new Set(out.options)].slice(0, 3);
    if (options.length === 0) return null;
    return { kind: "clarify", options };
  }
  if (out.kind === "actions") {
    const second = out.second === out.first ? null : out.second;
    const arg = out.arg !== null && Number.isFinite(out.arg) ? out.arg : null;
    return { kind: "actions", first: out.first, second, arg };
  }
  return out;
}

/** Which of the returned actions takes the numeric argument (size/opacity), if any. */
export function argTarget(first: string, second: string | null): string | null {
  if (ACTIONS_BY_ID[first]?.arg === "number") return first;
  if (second && ACTIONS_BY_ID[second]?.arg === "number") return second;
  return null;
}
