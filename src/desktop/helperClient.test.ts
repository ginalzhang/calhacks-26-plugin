import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HelperRequestError, HelperSocketClient, createHelperClient, helperUrlFromSearch } from "./helperClient";
import type { HelperConnState, HelperToWorker } from "./protocol";

/** Minimal fake of the browser WebSocket used by HelperSocketClient. */
class FakeWS {
  static instances: FakeWS[] = [];
  static throwOnConstruct = false;
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    if (FakeWS.throwOnConstruct) throw new SyntaxError("bad url");
    FakeWS.instances.push(this);
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  // test controls
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverSend(msg: unknown) {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }
  serverClose() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  sentMsgs(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

const last = () => FakeWS.instances[FakeWS.instances.length - 1];

let clock = 0;
let seq = 0;
function make(extra: Record<string, unknown> = {}) {
  const states: HelperConnState[] = [];
  const msgs: HelperToWorker[] = [];
  const c = new HelperSocketClient({
    url: "ws://127.0.0.1:18765",
    onMessage: (m) => msgs.push(m),
    onState: (s) => states.push(s),
    WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    now: () => clock,
    uuid: () => `id-${++seq}`,
    keepaliveMs: 0,
    ...extra,
  });
  return { c, states, msgs };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWS.instances = [];
  FakeWS.throwOnConstruct = false;
  clock = 0;
  seq = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("helperClient", () => {
  it("@P1 connects, reports states and adds uuid ids", () => {
    const { c, states } = make();
    expect(states).toEqual(["connecting"]);
    expect(c.send({ t: "ping" })).toBeNull(); // not open yet: dropped, no throw
    last().open();
    expect(c.state()).toBe("open");
    const id = c.send({ t: "move", x: 1, y: 2 });
    expect(id).toBe("id-1");
    expect(last().sentMsgs()).toEqual([{ t: "move", x: 1, y: 2, id: "id-1" }]);
    expect(c.send({ t: "down", id: "mine" })).toBe("mine");
    c.close();
  });

  it("@P1 request resolves on the reply echoing the id (pong/ack/krita_reply/error)", async () => {
    const { c, msgs } = make();
    last().open();
    const p1 = c.request({ t: "keys", combo: "cmd+z" });
    const p2 = c.request({ t: "krita", cmd: "color", hex: "#000000" });
    const p3 = c.request({ t: "down" });
    const p4 = c.request({ t: "ping" });
    const [k, kr, d, pg] = last().sentMsgs().map((m) => m.id as string);
    // unrelated messages do not resolve anything
    last().serverSend({ t: "hotkey", id: "h1", key: "pen" });
    last().serverSend({ t: "krita_reply", id: kr, ok: true, via: "plugin" });
    last().serverSend({ t: "ack", id: k, ok: true });
    last().serverSend({ t: "error", id: d, code: "paused" });
    last().serverSend({ t: "pong", id: pg });
    await expect(p1).resolves.toEqual({ t: "ack", id: k, ok: true });
    await expect(p2).resolves.toMatchObject({ t: "krita_reply", ok: true });
    await expect(p3).resolves.toMatchObject({ t: "error", code: "paused" });
    await expect(p4).resolves.toEqual({ t: "pong", id: pg });
    // every valid message is also forwarded
    expect(msgs.map((m) => m.t)).toEqual(["hotkey", "krita_reply", "ack", "error", "pong"]);
    c.close();
  });

  it("@P1 request rejects on timeout and when closed (never throws synchronously)", async () => {
    const { c } = make();
    const closedP = c.request({ t: "ping" });
    await expect(closedP).rejects.toBeInstanceOf(HelperRequestError);
    await expect(closedP).rejects.toMatchObject({ reason: "closed" });
    last().open();
    const p = c.request({ t: "keys", combo: "x" }, 500);
    vi.advanceTimersByTime(501);
    await expect(p).rejects.toMatchObject({ reason: "timeout" });
    const q = c.request({ t: "keys", combo: "x" });
    last().serverClose();
    await expect(q).rejects.toMatchObject({ reason: "closed" });
    c.close();
  });

  it("@P1 measures RTT from ping/pong", () => {
    const { c } = make();
    last().open();
    expect(c.rttMs()).toBeNull();
    clock = 1000;
    const id = c.send({ t: "ping" })!;
    clock = 1012.5;
    last().serverSend({ t: "pong", id });
    expect(c.rttMs()).toBe(12.5);
    last().serverSend({ t: "pong", id: "unknown" });
    expect(c.rttMs()).toBe(12.5);
    c.close();
  });

  it("@P1 auto-reconnects with backoff and stops after close()", () => {
    const { c, states } = make({ backoffMinMs: 100, backoffMaxMs: 400 });
    last().serverClose(); // connect failed
    expect(c.state()).toBe("closed");
    expect(FakeWS.instances.length).toBe(1);
    vi.advanceTimersByTime(99);
    expect(FakeWS.instances.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeWS.instances.length).toBe(2); // after 100 ms
    last().serverClose();
    vi.advanceTimersByTime(199);
    expect(FakeWS.instances.length).toBe(2);
    vi.advanceTimersByTime(1);
    expect(FakeWS.instances.length).toBe(3); // after 200 ms
    last().serverClose();
    vi.advanceTimersByTime(400);
    expect(FakeWS.instances.length).toBe(4); // 400 ms
    last().serverClose();
    vi.advanceTimersByTime(400);
    expect(FakeWS.instances.length).toBe(5); // capped at 400 ms
    last().open(); // success resets backoff
    expect(c.state()).toBe("open");
    last().serverClose();
    vi.advanceTimersByTime(100);
    expect(FakeWS.instances.length).toBe(6);
    c.close();
    expect(c.state()).toBe("closed");
    vi.advanceTimersByTime(10_000);
    expect(FakeWS.instances.length).toBe(6);
    expect(states[0]).toBe("connecting");
    expect(states).toContain("open");
  });

  it("@P1 send() and close() never throw when closed or when the socket throws", () => {
    const { c } = make();
    expect(() => c.send({ t: "up" })).not.toThrow();
    last().open();
    last().readyState = 3; // socket died without an event yet
    expect(c.send({ t: "up" })).toBeNull();
    c.close();
    expect(() => c.close()).not.toThrow();
    expect(c.send({ t: "up" })).toBeNull();
  });

  it("@P1 survives a throwing constructor and a missing WebSocket", () => {
    FakeWS.throwOnConstruct = true;
    const { c } = make();
    expect(c.state()).toBe("closed");
    FakeWS.throwOnConstruct = false;
    vi.advanceTimersByTime(250);
    expect(FakeWS.instances.length).toBe(1);
    c.close();
    const g = globalThis as { WebSocket?: unknown };
    const saved = g.WebSocket;
    g.WebSocket = undefined;
    try {
      const c2 = createHelperClient({ url: "ws://x", onMessage: () => {}, onState: () => {} });
      expect(c2.state()).toBe("closed");
      expect(c2.send({ t: "ping" })).toBeNull();
      c2.close();
    } finally {
      g.WebSocket = saved;
    }
  });

  it("@P1 ignores invalid JSON and unknown messages", () => {
    const { c, msgs } = make();
    last().open();
    last().serverSend("not json");
    last().serverSend({ t: "bogus", id: "1" });
    last().serverSend({ t: "hotkey", id: "1", key: "pen" });
    expect(msgs).toEqual([{ t: "hotkey", id: "1", key: "pen" }]);
    c.close();
  });

  it("@P1 keepalive pings when idle so the 300 ms watchdog never fires on a still hand", () => {
    // fake timers also drive Date.now(), so the client's clock follows advanceTimersByTime
    const { c } = make({ keepaliveMs: 100, now: () => Date.now() });
    const kinds = () => last().sentMsgs().map((m) => m.t);
    last().open();
    vi.advanceTimersByTime(99);
    expect(kinds()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(kinds()).toEqual(["ping"]); // 100 ms idle
    vi.advanceTimersByTime(50);
    c.send({ t: "move", x: 1, y: 1 }); // a move resets the idle timer
    vi.advanceTimersByTime(99);
    expect(kinds()).toEqual(["ping", "move"]);
    vi.advanceTimersByTime(1);
    expect(kinds()).toEqual(["ping", "move", "ping"]);
    // never more than 100 ms without a message while open
    vi.advanceTimersByTime(1000);
    expect(kinds().length).toBe(13);
    last().serverClose();
    vi.advanceTimersByTime(1000);
    expect(FakeWS.instances[0].sent.length).toBe(13); // no pings into a closed socket
    c.close();
  });

  it("@P1 helperUrlFromSearch: default, override, off, and refuses non-local hosts", () => {
    expect(helperUrlFromSearch("")).toBe("ws://127.0.0.1:8765");
    expect(helperUrlFromSearch("?helper=ws://127.0.0.1:18765")).toBe("ws://127.0.0.1:18765");
    expect(helperUrlFromSearch("?helper=off")).toBeNull();
    expect(helperUrlFromSearch("?helper=ws://evil.example:1")).toBe("ws://127.0.0.1:8765");
  });
});
