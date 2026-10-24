/**
 * Browser side of /api/cartesia-token. Caches the token; `needsRemint` is true after 45 min so the
 * STT/TTS clients re-mint and reconnect on the next push-to-talk release, never mid-utterance.
 */
export interface CartesiaToken {
  token: string;
  expiresAt: number;
  voiceId: string | null;
  mock: boolean;
  mintedAt: number;
}

export const REMINT_AFTER_MS = 45 * 60 * 1000;

let current: CartesiaToken | null = null;
let inflight: Promise<CartesiaToken> | null = null;

export function needsRemint(t: CartesiaToken | null, now = Date.now()): boolean {
  return !t || now - t.mintedAt >= REMINT_AFTER_MS || now >= t.expiresAt - 60_000;
}

export function cachedToken(): CartesiaToken | null {
  return current;
}

export async function getCartesiaToken(opts: { force?: boolean; fetchImpl?: typeof fetch } = {}): Promise<CartesiaToken> {
  if (!opts.force && current && !needsRemint(current)) return current;
  if (inflight) return inflight;
  const f = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  inflight = (async () => {
    try {
      const res = await f("/api/cartesia-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error(`token ${res.status}`);
      const b = (await res.json()) as { token: string; expiresAt: number; voiceId: string | null; mock?: boolean };
      current = { token: b.token, expiresAt: b.expiresAt, voiceId: b.voiceId ?? null, mock: b.mock === true, mintedAt: Date.now() };
      return current;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Tests only. */
export function _resetToken(): void {
  current = null;
  inflight = null;
}
