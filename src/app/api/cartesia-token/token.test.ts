import { describe, expect, it } from "vitest";
import { CARTESIA_VERSION, handleToken } from "./handler";

describe("POST /api/cartesia-token handler", () => {
  it("@P2a returns a mock token with mock:true and reason key_missing when CARTESIA_API_KEY is missing", async () => {
    const r = await handleToken({ apiKey: undefined, voiceIdEnv: undefined, now: () => 1000 });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ token: "mock", expiresAt: 1000 + 3600_000, voiceId: null, mock: true, reason: "key_missing" });
  });

  it("@P2a mints upstream with the documented headers and body", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ token: "tok123" }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await handleToken({ apiKey: "sk", voiceIdEnv: "voice-env", fetchImpl, now: () => 0 });
    expect(r.json).toEqual({ token: "tok123", expiresAt: 3600_000, voiceId: "voice-env", mock: false });
    expect(seen[0].url).toBe("https://api.cartesia.ai/access-token");
    const h = seen[0].init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer sk");
    expect(h["Cartesia-Version"]).toBe(CARTESIA_VERSION);
    expect(CARTESIA_VERSION).toBe("2026-08-14");
    expect(JSON.parse(seen[0].init.body as string)).toEqual({ grants: { stt: true, tts: true }, expires_in: 3600 });
  });

  it("@P2a falls back to the voice lookup, and to null when it fails", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ token: "t" }), { status: 200 })) as unknown as typeof fetch;
    const a = await handleToken({ apiKey: "sk", voiceIdEnv: undefined, fetchImpl, lookupVoice: async () => "v1" });
    expect(a.json).toMatchObject({ voiceId: "v1" });
    const b = await handleToken({ apiKey: "sk", voiceIdEnv: undefined, fetchImpl, lookupVoice: async () => null });
    expect(b.json).toMatchObject({ voiceId: null, mock: false });
  });

  it("@P2a upstream error → 502 {error:'upstream', status}", async () => {
    const fetchImpl = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    const r = await handleToken({ apiKey: "bad", voiceIdEnv: undefined, fetchImpl });
    expect(r).toEqual({ status: 502, json: { error: "upstream", status: 401 } });
  });
});
