import { describe, expect, it } from "vitest";
import {
  CONFIRMATIONS,
  TtsClient,
  buildTtsRequest,
  confirmationText,
  selectVoiceId,
  type TtsDeps,
  type TtsSocket,
} from "./ttsClient";
import type { CartesiaToken } from "./tokenClient";

class FakeSocket implements TtsSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  get json() {
    return this.sent.map((s) => JSON.parse(s));
  }
}

const tok = (o: Partial<CartesiaToken> = {}): CartesiaToken => ({ token: "tk", expiresAt: Date.now() + 3600_000, voiceId: "voice-1", mock: false, mintedAt: Date.now(), ...o });

function client(token: CartesiaToken = tok()) {
  FakeSocket.all = [];
  const played: number[] = [];
  let stops = 0;
  let n = 0;
  const deps: TtsDeps = {
    getToken: async () => token,
    socket: (u) => new FakeSocket(u),
    player: () => ({ play: (p) => played.push(p.length), stop: () => void stops++ }),
    newContextId: () => `ctx${++n}`,
  };
  const c = new TtsClient(deps);
  const statuses: string[] = [];
  c.onStatus((s) => statuses.push(s));
  return { c, played, statuses, stops: () => stops, sock: () => FakeSocket.all[FakeSocket.all.length - 1] };
}

describe("Sonic TTS confirmations", () => {
  it("@P2b only non-visible confirmations, ≤ 5 words plus the heard text", () => {
    for (const [, c] of Object.entries(CONFIRMATIONS)) expect(c.text.split(" ").length).toBeLessThanOrEqual(5);
    expect(confirmationText("saved")).toBe("Saved");
    expect(confirmationText("new_layer")).toBe("New layer");
    expect(confirmationText("didnt_catch", "paint the room")).toBe("Didn't catch that; I heard paint the room");
    expect(confirmationText("didnt_catch", "")).toBe("Didn't catch that");
    const long = confirmationText("didnt_catch", Array.from({ length: 30 }, (_, i) => `w${i}`).join(" "))!;
    expect(long.split(" ").length).toBeLessThanOrEqual(5 + 12);
    expect(Object.keys(CONFIRMATIONS).some((k) => /pen/.test(k))).toBe(false); // never on pen toggles
  });

  it("@P2b speaks over the socket with the §8 request", async () => {
    const t = client();
    expect(await t.c.speakConfirmation("saved")).toBe(true);
    const s = t.sock();
    expect(s.url).toBe("wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14&access_token=tk");
    expect(s.json[0]).toEqual(buildTtsRequest("Saved", "voice-1", "ctx1"));
    expect(s.json[0]).toMatchObject({ model_id: "sonic-3.6", voice: { mode: "id", id: "voice-1" }, max_buffer_delay_ms: 300 });
    s.onmessage?.({ data: JSON.stringify({ type: "chunk", context_id: "ctx1", data: btoa("\u0000\u0001\u0002\u0003") }) });
    expect(t.played).toEqual([2]);
    s.onmessage?.({ data: JSON.stringify({ type: "chunk", context_id: "stale", data: btoa("\u0000\u0001") }) });
    expect(t.played).toEqual([2]);
  });

  it("@P2b never while the mic is open; opening the mic cancels speech in progress", async () => {
    const t = client();
    await t.c.speakConfirmation("new_layer");
    const s = t.sock();
    s.onmessage?.({ data: JSON.stringify({ type: "chunk", context_id: "ctx1", data: btoa("\u0000\u0001") }) });
    expect(t.played).toEqual([1]);
    t.c.setMicOpen(true);
    expect(s.json.at(-1)).toEqual({ context_id: "ctx1", cancel: true });
    expect(t.stops()).toBeGreaterThan(0);
    s.onmessage?.({ data: JSON.stringify({ type: "chunk", context_id: "ctx1", data: btoa("\u0000\u0001") }) });
    expect(t.played).toEqual([1]); // nothing more after the cancel
    expect(await t.c.speakConfirmation("saved")).toBe(false);
    t.c.setMicOpen(false);
    expect(await t.c.speakConfirmation("saved")).toBe(true);
  });

  it("@P2b off in quiet mode and when the setting is off", async () => {
    const t = client();
    t.c.setQuiet(true);
    expect(await t.c.speakConfirmation("saved")).toBe(false);
    t.c.setQuiet(false);
    t.c.setEnabled(false);
    expect(await t.c.speakConfirmation("saved")).toBe(false);
    expect(FakeSocket.all).toHaveLength(0);
  });

  it('@P2b voice id selection failure → status "voice_unavailable"; no key → "key_missing"', async () => {
    const a = client(tok({ voiceId: null }));
    expect(await a.c.speakConfirmation("saved")).toBe(false);
    expect(a.statuses).toEqual(["voice_unavailable"]);
    const b = client(tok({ mock: true, voiceId: null, token: "mock" }));
    expect(await b.c.speakConfirmation("saved")).toBe(false);
    expect(b.statuses).toEqual(["key_missing"]);
    expect(FakeSocket.all).toHaveLength(0);
    expect(selectVoiceId({ voiceId: "abc", mock: false })).toEqual({ id: "abc", status: "ok" });
  });
});
