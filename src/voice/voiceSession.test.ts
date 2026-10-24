import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../pipeline/grammar", () => ({ parseCommand: vi.fn(), closestActions: vi.fn(() => []), keyterms: vi.fn(() => ["bigger"]) }));
import { VoiceSession, type VoiceDeps } from "./voiceSession";
import { REMINT_AFTER_MS, needsRemint, type CartesiaToken } from "./tokenClient";
import type { SttConnection, SttHandlers } from "./sttClient";
import { FakeRecognition } from "./fakeRecognition";
import { WEB_SPEECH_NOTICE, type RecognitionCtor } from "./webSpeech";

const noop = () => {};
const handlers = { onDelta: noop, onLevel: noop, onEnded: noop, onError: noop };
const tok = (o: Partial<CartesiaToken> = {}): CartesiaToken => ({ token: "t1", expiresAt: Date.now() + 3600_000, voiceId: "v", mock: false, mintedAt: Date.now(), ...o });

function fakeConn() {
  return {
    closed: false,
    opened: true,
    begun: 0,
    audio: 0,
    h: null as SttHandlers | null,
    begin() { this.begun++; },
    sendAudio() { this.audio++; },
    finish: async () => "blue",
    close() { this.closed = true; },
    setHandlers() {},
  };
}

function baseDeps(over: Partial<VoiceDeps> = {}): VoiceDeps {
  return {
    getToken: async () => tok(),
    keyterms: () => [],
    connect: (() => fakeConn()) as never,
    startCapture: async () => ({ stop: noop, sampleRate: 48000 }),
    now: () => Date.now(),
    webSpeech: () => null,
    online: () => true,
    ...over,
  };
}

beforeEach(() => {
  FakeRecognition.instances = [];
});

describe("VoiceSession (Cartesia)", () => {
  it("@P2a mock token (no Cartesia key) and no Web Speech → key_missing, mic never captured", async () => {
    const startCapture = vi.fn();
    const s = new VoiceSession(baseDeps({ getToken: async () => tok({ token: "mock", mock: true, voiceId: null }), startCapture: startCapture as never }));
    expect(await s.open(handlers)).toEqual({ ok: false, reason: "key_missing", message: "Voice needs a Cartesia key" });
    expect(startCapture).not.toHaveBeenCalled();
  });

  it("@P2a reuses the socket across utterances and drops it after 45 min, between utterances only", async () => {
    const conns: ReturnType<typeof fakeConn>[] = [];
    let now = Date.now();
    const t = tok({ mintedAt: now });
    const s = new VoiceSession(
      baseDeps({
        getToken: async () => t,
        connect: (() => {
          const c = fakeConn();
          conns.push(c);
          return c as unknown as SttConnection;
        }) as VoiceDeps["connect"],
        startCapture: async (h) => {
          h.onChunk(new ArrayBuffer(2));
          return { stop: noop, sampleRate: 48000 };
        },
        now: () => now,
      }),
    );
    expect(await s.open(handlers)).toEqual({ ok: true, engine: "cartesia" });
    expect(await s.close()).toBe("blue");
    expect(await s.open(handlers)).toEqual({ ok: true, engine: "cartesia" });
    expect(conns).toHaveLength(1);
    now += REMINT_AFTER_MS + 1; // token aged during the utterance: not dropped mid-utterance…
    expect(conns[0].closed).toBe(false);
    await s.close(); // …but dropped at release
    expect(conns[0].closed).toBe(true);
  });

  it("@P2a denied microphone surfaces as reason denied", async () => {
    const s = new VoiceSession(
      baseDeps({
        startCapture: async () => {
          throw Object.assign(new Error("Microphone permission denied"), { kind: "denied" });
        },
      }),
    );
    expect(await s.open(handlers)).toMatchObject({ ok: false, reason: "denied" });
  });

  it("@P2a offline (§13): no voice at all, clear reason, no token request", async () => {
    const getToken = vi.fn(async () => tok());
    const s = new VoiceSession(baseDeps({ online: () => false, getToken, webSpeech: () => FakeRecognition as unknown as RecognitionCtor }));
    expect(await s.open(handlers)).toMatchObject({ ok: false, reason: "offline" });
    expect(getToken).not.toHaveBeenCalled();
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it("@P2a token re-mint rule: 45 minutes", () => {
    const now = 1_000_000_000;
    expect(needsRemint(null, now)).toBe(true);
    expect(needsRemint(tok({ mintedAt: now - REMINT_AFTER_MS + 1, expiresAt: now + 3600_000 }), now)).toBe(false);
    expect(needsRemint(tok({ mintedAt: now - REMINT_AFTER_MS, expiresAt: now + 3600_000 }), now)).toBe(true);
    expect(REMINT_AFTER_MS).toBe(45 * 60 * 1000);
  });
});

describe("Web Speech fallback", () => {
  const web = () => FakeRecognition as unknown as RecognitionCtor;
  const allow = { allowWebSpeech: true };

  it("@P3 opt-in: without allowWebSpeech, no key keeps the key_missing behaviour and never starts recognition", async () => {
    const s = new VoiceSession(baseDeps({ getToken: async () => tok({ token: "mock", mock: true }), webSpeech: web }));
    expect(await s.open(handlers)).toEqual({ ok: false, reason: "key_missing", message: "Voice needs a Cartesia key" });
    expect(await s.open(handlers, { allowWebSpeech: false })).toMatchObject({ ok: false, reason: "key_missing" });
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it("@P3 opt-in: with allowWebSpeech, no key falls back to the browser's recognition", async () => {
    const s = new VoiceSession(baseDeps({ getToken: async () => tok({ token: "mock", mock: true }), webSpeech: web }));
    expect(await s.open(handlers, allow)).toEqual({ ok: true, engine: "webspeech", fallbackFrom: "key_missing" });
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it("@P3 no Cartesia key + webkitSpeechRecognition → browser recognition, only while the mic is open", async () => {
    const startCapture = vi.fn();
    const deltas: string[] = [];
    const s = new VoiceSession(baseDeps({ getToken: async () => tok({ token: "mock", mock: true }), webSpeech: web, startCapture: startCapture as never }));
    const r = await s.open({ ...handlers, onDelta: (t) => deltas.push(t) }, allow);
    expect(r).toEqual({ ok: true, engine: "webspeech", fallbackFrom: "key_missing" });
    expect(startCapture).not.toHaveBeenCalled(); // Cartesia capture never runs
    const rec = FakeRecognition.instances[0];
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);
    expect(rec.running).toBe(true);
    rec.say("make it", false);
    rec.say("make it thinner", true);
    expect(deltas.at(-1)).toBe("make it thinner");
    expect(await s.close()).toBe("make it thinner");
    expect(rec.running).toBe(false); // no always-on mic
    expect(rec.stops).toBe(1);
  });

  it("@P3 token error also falls back; Chrome ending by itself mid-hold is restarted (no time limit)", async () => {
    const s = new VoiceSession(baseDeps({ getToken: async () => Promise.reject(new Error("token 502")), webSpeech: web }));
    expect(await s.open(handlers, allow)).toMatchObject({ ok: true, engine: "webspeech", fallbackFrom: "token_failed" });
    const rec = FakeRecognition.instances[0];
    rec.say("blue", true);
    rec.endByItself();
    expect(rec.running).toBe(true);
    expect(rec.starts).toBe(2);
    rec.say("bigger", true);
    expect(await s.close()).toBe("blue bigger");
  });

  it("@P3 a Cartesia socket that never opened sends later utterances to Web Speech", async () => {
    let made: { h: SttHandlers; c: ReturnType<typeof fakeConn> } | null = null;
    const s = new VoiceSession(
      baseDeps({
        webSpeech: web,
        connect: ((_t: string, _k: string[], h: SttHandlers) => {
          const c = fakeConn();
          c.opened = false;
          made = { h, c };
          return c as unknown as SttConnection;
        }) as VoiceDeps["connect"],
      }),
    );
    expect(await s.open(handlers, allow)).toMatchObject({ engine: "cartesia" });
    made!.c.closed = true;
    made!.h.onClose?.(1006);
    await s.close();
    expect(s.cartesiaFailed).toBe(true);
    expect(await s.open(handlers, allow)).toMatchObject({ ok: true, engine: "webspeech", fallbackFrom: "socket_failed" });
    expect(await (async () => { await s.close(); return s.open(handlers); })()).toMatchObject({ engine: "cartesia" }); // not opted in → Cartesia retried
  });

  it("@P3 cancel (quiet mode) aborts recognition; permission denied → revoked", async () => {
    const ended: string[] = [];
    const s = new VoiceSession(baseDeps({ getToken: async () => tok({ mock: true }), webSpeech: web }));
    await s.open({ ...handlers, onEnded: (r) => ended.push(r) }, allow);
    const rec = FakeRecognition.instances[0];
    rec.onerror?.({ error: "not-allowed" });
    expect(ended).toEqual(["revoked"]);
    s.cancel();
    expect(rec.aborts).toBe(1);
  });

  it("@P3 the privacy notice names Google", () => {
    expect(WEB_SPEECH_NOTICE).toMatch(/browser's speech recognition/);
    expect(WEB_SPEECH_NOTICE).toMatch(/Google/);
  });
});
