/**
 * Pre-warm /api/command once per page load (§8): one real request with the same SYSTEM_BLOCK and a
 * 30 s server timeout, so the first real command doesn't pay for grammar compilation or the cache
 * write. Fire-and-forget; never throws. Not logged as a Claude call (it is not a user command).
 */
export interface PrewarmResult {
  ok: boolean;
  mock: boolean;
  latencyMs: number | null;
}

let started: Promise<PrewarmResult> | null = null;

export function prewarmClaude(fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<PrewarmResult> {
  if (started) return started;
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  started = (async () => {
    try {
      const res = await fetchImpl("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prewarm: true }),
      });
      const body = (await res.json().catch(() => null)) as { kind?: string; mock?: boolean } | null;
      const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
      return { ok: res.ok && body?.kind === "noop", mock: body?.mock === true, latencyMs: Math.round(t1 - t0) };
    } catch {
      return { ok: false, mock: false, latencyMs: null };
    }
  })();
  return started;
}

/** Tests only. */
export function _resetPrewarm(): void {
  started = null;
}
