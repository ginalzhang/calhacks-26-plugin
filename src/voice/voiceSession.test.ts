import { describe, expect, it, vi } from "vitest";
vi.mock("../pipeline/grammar", () => ({ parseCommand: vi.fn(), closestActions: vi.fn(() => []), keyterms: vi.fn(() => ["bigger"]) }));
import { VoiceSession, type VoiceDeps } from "./voiceSession";
import { REMINT_AFTER_MS, needsRemint, type CartesiaToken } from "./tokenClient";
import { buildTtsRequest, selectVoiceId } from "./ttsClient";
import type { SttConnection } from "./sttClient";

const handlers = { onDelta: () => {}, onLevel: () => {}, onEnded: () => {}, onError: () => {} };
const tok = (o: Partial<CartesiaToken> = {}): CartesiaToken => ({ token: "t1", expiresAt: Date.now() + 3600_000, voiceId: "v", mock: false, mintedAt: Date.now(), ...o });

function fakeConn() {
  return {
    closed: false,
    begun: 0,
    audio: 0,
    begin() { this.begun++; },
    sendAudio() { this.audio++; },
    finish: async () => "blue",
    close() { this.closed = true; },
    setHandlers() {},
  };
}

describe("VoiceSession", () => {
  it("@P2a mock token (no Cartesia key) → key_missing, mic never captured", async () => {
    const startCapture = vi.fn();
    const s = new VoiceSession({
      getToken: async () => tok({ token: "mock", mock: true, voiceId: null }),
      keyterms: () => [],
      connect: vi.fn() as never,
      startCapture: startCapture as never,
      now: () => 0,
    });
    expect(await s.open(handlers)).toEqual({ ok: false, reason: "key_missing", message: "Voice needs a Cartesia key" });
    expect(startCapture).not.toHaveBeenCalled();
  });

  it("@P2a reuses the socket across utterances and drops it after 45 min, between utterances only", async () => {
    const conns: ReturnType<typeof fakeConn>[] = [];
    let now = Date.now();
    const t = tok({ mintedAt: now });
    const deps: VoiceDeps = {
      getToken: async () => t,
      keyterms: () => ["bigger"],
      connect: (() => {
        const c = fakeConn();
        conns.push(c);
        return c as unknown as SttConnection;
      }) as VoiceDeps["connect"],
      startCapture: async (h) => {
        h.onChunk(new ArrayBuffer(2));
        return { stop: () => {}, sampleRate: 48000 };
      },
      now: () => now,
    };
    const s = new VoiceSession(deps);
    expect(await s.open(handlers)).toEqual({ ok: true });
    expect(await s.close()).toBe("blue");
    expect(await s.open(handlers)).toEqual({ ok: true });
    expect(conns).toHaveLength(1);
    now += REMINT_AFTER_MS + 1; // token aged during the utterance: not dropped mid-utterance…
    expect(conns[0].closed).toBe(false);
    await s.close(); // …but dropped at release
    expect(conns[0].closed).toBe(true);
  });

  it("@P2a denied microphone surfaces as reason denied", async () => {
    const s = new VoiceSession({
      getToken: async () => tok(),
      keyterms: () => [],
      connect: (() => fakeConn()) as never,
      startCapture: async () => {
        throw Object.assign(new Error("Microphone permission denied"), { kind: "denied" });
      },
      now: () => 0,
    });
    expect(await s.open(handlers)).toMatchObject({ ok: false, reason: "denied" });
  });

  it("@P2a token re-mint rule: 45 minutes", () => {
    const now = 1_000_000_000;
    expect(needsRemint(null, now)).toBe(true);
    expect(needsRemint(tok({ mintedAt: now - REMINT_AFTER_MS + 1, expiresAt: now + 3600_000 }), now)).toBe(false);
    expect(needsRemint(tok({ mintedAt: now - REMINT_AFTER_MS, expiresAt: now + 3600_000 }), now)).toBe(true);
    expect(REMINT_AFTER_MS).toBe(45 * 60 * 1000);
  });
});

describe("Sonic TTS (P2b stub)", () => {
  it("@P2b voice id selection: route/env id, else voice unavailable, mock → key missing", () => {
    expect(selectVoiceId({ voiceId: "abc", mock: false })).toEqual({ id: "abc", status: "ok" });
    expect(selectVoiceId({ voiceId: null, mock: false })).toEqual({ id: null, status: "voice_unavailable" });
    expect(selectVoiceId({ voiceId: null, mock: true })).toEqual({ id: null, status: "key_missing" });
  });
  it("@P2b request shape per §8", () => {
    expect(buildTtsRequest("Saved", "v1", "c1")).toEqual({
      model_id: "sonic-3.6",
      transcript: "Saved",
      voice: { mode: "id", id: "v1" },
      language: "en",
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 },
      context_id: "c1",
      max_buffer_delay_ms: 300,
    });
  });
});
