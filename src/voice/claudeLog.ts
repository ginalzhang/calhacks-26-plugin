/**
 * localStorage log of every Claude (/api/command) call (§8): summary, latency, outcome.
 * Feeds the Demo metrics panel ("Claude calls/accepted/timeouts") and the README counts.
 * Storage is injectable so tests can use a fake; in the browser it defaults to window.localStorage.
 * The log stays on this computer.
 */
import { STORAGE_KEYS } from "../pipeline/types";

export type ClaudeOutcome =
  | "accepted" // actions executed, or a clarify option picked
  | "rejected" // clarify cancelled, or the user undid Claude's action right away
  | "pending" // clarify shown, no choice yet
  | "noop" // Claude decided there was nothing to do (cough, filler)
  | "timeout"
  | "invalid"
  | "offline"
  | "key_missing"
  | "upstream";

export interface ClaudeLogEntry {
  id: string;
  t: number; // Date.now()
  /** Short human summary: `"make it thinner…" → smaller + airbrush`. */
  summary: string;
  latencyMs: number;
  outcome: ClaudeOutcome;
  mock: boolean;
}

export interface ClaudeLogSummary {
  calls: number;
  accepted: number;
  rejected: number;
  timeouts: number;
  invalid: number;
  noop: number;
  errors: number; // offline + key_missing + upstream
  mock: number;
  meanLatencyMs: number | null;
}

export const CLAUDE_LOG_MAX = 200;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

let storageOverride: StorageLike | null = null;
/** Tests inject a fake Storage; pass null to restore the default. */
export function setClaudeLogStorage(s: StorageLike | null): void {
  storageOverride = s;
}

function storage(): StorageLike | null {
  if (storageOverride) return storageOverride;
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
/** Subscribe to log changes (metrics panel). Returns an unsubscribe function. */
export function onClaudeLogChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function readClaudeLog(): ClaudeLogEntry[] {
  const s = storage();
  if (!s) return [];
  try {
    const raw = s.getItem(STORAGE_KEYS.claudeLog);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? (v as ClaudeLogEntry[]) : [];
  } catch {
    return [];
  }
}

function write(entries: ClaudeLogEntry[]): void {
  const s = storage();
  if (s) {
    try {
      s.setItem(STORAGE_KEYS.claudeLog, JSON.stringify(entries.slice(-CLAUDE_LOG_MAX)));
    } catch {
      /* quota or privacy mode: the log is best-effort */
    }
  }
  for (const fn of listeners) fn();
}

let seq = 0;
export function logClaudeCall(e: Omit<ClaudeLogEntry, "id" | "t"> & { t?: number }): ClaudeLogEntry {
  const entry: ClaudeLogEntry = {
    id: `c${Date.now().toString(36)}${(seq++).toString(36)}`,
    t: e.t ?? Date.now(),
    summary: e.summary.slice(0, 160),
    latencyMs: Math.max(0, Math.round(e.latencyMs)),
    outcome: e.outcome,
    mock: e.mock,
  };
  write([...readClaudeLog(), entry]);
  return entry;
}

/** Change an entry's outcome (clarify picked/cancelled; Claude's action undone). Returns false if not found. */
export function markClaudeOutcome(id: string, outcome: ClaudeOutcome): boolean {
  const entries = readClaudeLog();
  const e = entries.find((x) => x.id === id);
  if (!e) return false;
  e.outcome = outcome;
  write(entries);
  return true;
}

/** Mark the newest accepted/pending entry rejected (e.g. "undo that" right after a Claude action). */
export function markLastClaudeRejected(): boolean {
  const entries = readClaudeLog();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].outcome === "accepted" || entries[i].outcome === "pending") {
      entries[i].outcome = "rejected";
      write(entries);
      return true;
    }
  }
  return false;
}

export function clearClaudeLog(): void {
  const s = storage();
  try {
    s?.removeItem(STORAGE_KEYS.claudeLog);
  } catch {
    /* ignore */
  }
  for (const fn of listeners) fn();
}

export function summariseClaudeLog(entries: ClaudeLogEntry[] = readClaudeLog()): ClaudeLogSummary {
  const count = (o: ClaudeOutcome) => entries.filter((e) => e.outcome === o).length;
  const timed = entries.filter((e) => e.outcome !== "offline" && e.outcome !== "key_missing");
  return {
    calls: entries.length,
    accepted: count("accepted"),
    rejected: count("rejected"),
    timeouts: count("timeout"),
    invalid: count("invalid"),
    noop: count("noop"),
    errors: count("offline") + count("key_missing") + count("upstream"),
    mock: entries.filter((e) => e.mock).length,
    meanLatencyMs: timed.length ? Math.round(timed.reduce((s, e) => s + e.latencyMs, 0) / timed.length) : null,
  };
}
