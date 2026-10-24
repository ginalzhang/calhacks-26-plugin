import { describe, expect, it, vi } from "vitest";
import { buildSttUrl, FLUSH_TIMEOUT_MS, SttConnection, type WsFactory } from "./sttClient";
import { autoCloseReason, newMicTiming, noteActivity } from "./micPolicy";

class FakeWs {
  readyState = 0;
  binaryType = "blob";
  sent: Array<string | ArrayBuffer> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  constructor(public url: string) {}
  send(d: string | ArrayBuffer) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  msg(o: unknown) {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
}

function make() {
  let ws!: FakeWs;
  const factory: WsFactory = (u) => (ws = new FakeWs(u)) as never;
  const deltas: string[] = [];
  const conn = new SttConnection("tok en", ["undo that", "new layer"], { onDelta: (f) => deltas.push(f) }, factory);
  return { conn, ws: () => ws, deltas };
}

describe("Cartesia STT manual socket", () => {
  it("@P2a builds the documented manual-finalize URL with access_token and repeated keyterm params", () => {
    const u = buildSttUrl("abc", ["undo that", "bigger"]);
    expect(u).toBe(
      "wss://api.cartesia.ai/stt/websocket?model=ink-2&encoding=pcm_s16le&sample_rate=16000&cartesia_version=2026-08-14&access_token=abc&keyterm=undo%20that&keyterm=bigger",
    );
    expect(u).not.toContain("turns");
  });

  it("@P2a queues audio sent before open, sends finalize on close, concatenates is_final deltas untrimmed until flush_done", async () => {
    const { conn, ws, deltas } = make();
    expect(ws().binaryType).toBe("arraybuffer");
    conn.begin();
    const a = new ArrayBuffer(3200);
    const b = new ArrayBuffer(3200);
    conn.sendAudio(a);
    ws().open();
    conn.sendAudio(b);
    expect(ws().sent).toEqual([a, b]);
    const p = conn.finish();
    expect(ws().sent.at(-1)).toBe("finalize");
    ws().msg({ type: "transcript", text: " make it", is_final: false, request_id: "r" });
    ws().msg({ type: "transcript", text: " make it thinner", is_final: true, request_id: "r" });
    ws().msg({ type: "transcript", text: " and softer ", is_final: true, request_id: "r" });
    ws().msg({ type: "flush_done", request_id: "r" });
    expect(await p).toBe(" make it thinner and softer ");
    expect(deltas.at(-1)).toBe(" make it thinner and softer ");
  });

  it("@P2a finalize issued before the socket opens is sent right after the queued audio", async () => {
    const { conn, ws } = make();
    conn.begin();
    const a = new ArrayBuffer(10);
    conn.sendAudio(a);
    const p = conn.finish();
    ws().open();
    expect(ws().sent).toEqual([a, "finalize"]);
    ws().msg({ type: "transcript", text: "blue", is_final: true });
    ws().msg({ type: "flush_done" });
    expect(await p).toBe("blue");
  });

  it("@P2a resolves with what it has if flush_done never comes", async () => {
    vi.useFakeTimers();
    const { conn, ws } = make();
    ws().open();
    conn.begin();
    const p = conn.finish();
    ws().msg({ type: "transcript", text: "bigger", is_final: true });
    vi.advanceTimersByTime(FLUSH_TIMEOUT_MS + 1);
    expect(await p).toBe("bigger");
    vi.useRealTimers();
  });

  it("@P2a begin() starts a fresh transcript for the next utterance on the same socket", async () => {
    const { conn, ws } = make();
    ws().open();
    conn.begin();
    let p = conn.finish();
    ws().msg({ type: "transcript", text: "red", is_final: true });
    ws().msg({ type: "flush_done" });
    expect(await p).toBe("red");
    conn.begin();
    p = conn.finish();
    ws().msg({ type: "transcript", text: "save", is_final: true });
    ws().msg({ type: "flush_done" });
    expect(await p).toBe("save");
  });
});

describe("mic auto-close policy", () => {
  it("@P2a nothing closes before speech starts (no onset timeout)", () => {
    const m = newMicTiming("tap");
    expect(autoCloseReason(m, 60_000, 2000, 15000)).toBeNull();
  });
  it("@P2a tap: closes on silence after speech, and at the cap counted from speech onset", () => {
    let m = noteActivity(newMicTiming("tap"), 10_000);
    expect(autoCloseReason(m, 11_000, 2000, 15000)).toBeNull();
    expect(autoCloseReason(m, 12_000, 2000, 15000)).toBe("silence");
    for (let t = 10_000; t <= 25_000; t += 500) m = noteActivity(m, t);
    expect(autoCloseReason(m, 24_999, 2000, 15000)).toBeNull();
    expect(autoCloseReason(m, 25_000, 2000, 15000)).toBe("cap");
  });
  it("@P2a push-to-talk never auto-closes while held", () => {
    const m = noteActivity(newMicTiming("ptt"), 0);
    expect(autoCloseReason(m, 120_000, 1000, 15000)).toBeNull();
  });
});
