/**
 * /api/cartesia-token logic (server-only; testable with injected fetch / voice lookup).
 * Mints a short-lived Cartesia access token (STT + TTS grants) per docs/API.md. The API key never
 * leaves the server. Also resolves the Sonic voice id: CARTESIA_VOICE_ID if set, else the first
 * English voice from voices.list(); null if that fails (the client then disables TTS with
 * "voice unavailable").
 */

export const CARTESIA_VERSION = "2026-08-14";
export const TOKEN_TTL_S = 3600;

export type TokenResponse =
  | { token: string; expiresAt: number; voiceId: string | null; mock: false }
  | { token: "mock"; expiresAt: number; voiceId: null; mock: true; reason: "key_missing" };

export interface TokenDeps {
  apiKey: string | undefined;
  voiceIdEnv: string | undefined;
  fetchImpl?: typeof fetch;
  lookupVoice?: (apiKey: string) => Promise<string | null>;
  now?: () => number;
}

let voiceCache: { key: string; id: string | null } | null = null;

/**
 * Same endpoint the SDK's client.voices.list() pages over (GET /voices → {data: Voice[]}), called
 * with fetch so the server bundle never pulls in the SDK's optional `ws` peer dependency.
 */
export async function firstEnglishVoice(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (voiceCache?.key === apiKey) return voiceCache.id;
  let id: string | null = null;
  try {
    const res = await fetchImpl("https://api.cartesia.ai/voices?limit=100", {
      headers: { Authorization: `Bearer ${apiKey}`, "Cartesia-Version": CARTESIA_VERSION },
    });
    if (!res.ok) throw new Error(`voices ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: unknown; language?: unknown }> } | Array<{ id?: unknown; language?: unknown }>;
    const list = Array.isArray(body) ? body : (body.data ?? []);
    const hit = list.find((v) => typeof v.id === "string" && String(v.language ?? "").toLowerCase().startsWith("en"));
    id = hit ? (hit.id as string) : null;
  } catch (err) {
    console.error("[api/cartesia-token] voices list failed; TTS will report 'voice unavailable'", err);
    id = null;
  }
  voiceCache = { key: apiKey, id };
  return id;
}

export async function handleToken(deps: TokenDeps): Promise<{ status: number; json: TokenResponse | { error: "upstream"; status: number } }> {
  const now = deps.now ?? (() => Date.now());
  if (!deps.apiKey) {
    return {
      status: 200,
      json: { token: "mock", expiresAt: now() + TOKEN_TTL_S * 1000, voiceId: null, mock: true, reason: "key_missing" },
    };
  }
  const f = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f("https://api.cartesia.ai/access-token", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        "Cartesia-Version": CARTESIA_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ grants: { stt: true, tts: true }, expires_in: TOKEN_TTL_S }),
    });
  } catch {
    return { status: 502, json: { error: "upstream", status: 0 } };
  }
  if (!res.ok) return { status: 502, json: { error: "upstream", status: res.status } };
  const data = (await res.json().catch(() => null)) as { token?: unknown } | null;
  if (!data || typeof data.token !== "string") return { status: 502, json: { error: "upstream", status: res.status } };
  const voiceId = deps.voiceIdEnv || (await (deps.lookupVoice ?? ((k: string) => firstEnglishVoice(k, f)))(deps.apiKey));
  return {
    status: 200,
    json: { token: data.token, expiresAt: now() + TOKEN_TTL_S * 1000, voiceId: voiceId || null, mock: false },
  };
}
