/**
 * Worker-side WebSocket client for the Steady helper (implements `HelperClient` from protocol.ts).
 *
 * - Auto-reconnects with exponential backoff (250 ms → 5 s), forever, until close().
 * - `send()` adds a uuid `id` when missing; returns null (never throws) when not open.
 * - `request()` resolves with the reply echoing the id (pong / ack / krita_reply / error);
 *   rejects with HelperRequestError("timeout" | "closed") — a rejection, never a sync throw.
 * - RTT from ping → pong (pings sent via send() or request() both count).
 * - Keepalive: if nothing was sent for `keepaliveMs` (default PING_EVERY_MS = 100) while open,
 *   sends a `ping`, so the helper's 300 ms watchdog never fires while a stroke is held still.
 *   The Worker may send its own pings too; any send resets the keepalive timer.
 * - Every valid helper message (replies included) is passed to `onMessage`.
 *
 * Owned by agent C; imported by the tracking Worker (agent B).
 */
import {
  HELPER_URL,
  PING_EVERY_MS,
  parseHelperToWorker,
  type HelperClient,
  type HelperClientOptions,
  type HelperConnState,
  type HelperToWorker,
  type WorkerToHelper,
  type DistributiveOmit,
} from "./protocol";

export type OutgoingMsg = DistributiveOmit<WorkerToHelper, "id"> & { id?: string };

export interface HelperClientImplOptions extends Partial<HelperClientOptions> {
  onMessage?: (msg: HelperToWorker) => void;
  onState?: (state: HelperConnState) => void;
  /** Send `ping` when nothing was sent for this long while open. 0 disables. Default PING_EVERY_MS. */
  keepaliveMs?: number;
  /** Reconnect backoff: first delay, max delay (ms). Default 250 / 5000. */
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Default request() timeout. Default 3000 ms. */
  requestTimeoutMs?: number;
  /** Injected for tests. */
  setTimeoutImpl?: SetTimeoutFn;
  clearTimeoutImpl?: ClearTimeoutFn;
  uuid?: () => string;
}

export type TimerHandle = unknown;
export type SetTimeoutFn = (fn: () => void, ms: number) => TimerHandle;
export type ClearTimeoutFn = (h: TimerHandle) => void;

export class HelperRequestError extends Error {
  constructor(
    readonly reason: "timeout" | "closed",
    readonly id: string,
  ) {
    super(`helper request ${id} failed: ${reason}`);
    this.name = "HelperRequestError";
  }
}

const REPLY_TYPES = new Set(["pong", "ack", "krita_reply", "error"]);
const OPEN = 1;

function defaultUuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // RFC4122-ish fallback (only ids, not security)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function defaultNow(): number {
  const p = (globalThis as { performance?: Performance }).performance;
  return p && typeof p.now === "function" ? p.now() : Date.now();
}

interface Pending {
  resolve: (m: HelperToWorker) => void;
  reject: (e: Error) => void;
  timer: TimerHandle;
}

export class HelperSocketClient implements HelperClient {
  private ws: WebSocket | null = null;
  private st: HelperConnState = "closed";
  private closedByUser = false;
  private attempt = 0;
  private reconnectTimer: TimerHandle | null = null;
  private keepaliveTimer: TimerHandle | null = null;
  private pending = new Map<string, Pending>();
  private pingSentAt = new Map<string, number>();
  private lastRtt: number | null = null;
  private lastSendAt = -Infinity;

  private readonly url: string;
  private readonly onMessage: (msg: HelperToWorker) => void;
  private readonly onState: (s: HelperConnState) => void;
  private readonly WS: typeof WebSocket | undefined;
  private readonly now: () => number;
  private readonly keepaliveMs: number;
  private readonly backoffMinMs: number;
  private readonly backoffMaxMs: number;
  private readonly requestTimeoutMs: number;
  private readonly setT: SetTimeoutFn;
  private readonly clearT: ClearTimeoutFn;
  private readonly uuid: () => string;

  constructor(opts: HelperClientImplOptions = {}) {
    this.url = opts.url ?? HELPER_URL;
    this.onMessage = opts.onMessage ?? (() => {});
    this.onState = opts.onState ?? (() => {});
    this.WS = opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    this.now = opts.now ?? defaultNow;
    this.keepaliveMs = opts.keepaliveMs ?? PING_EVERY_MS;
    this.backoffMinMs = opts.backoffMinMs ?? 250;
    this.backoffMaxMs = opts.backoffMaxMs ?? 5000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 3000;
    // Wrapped so the globals are never called with this class as `this` (Illegal invocation).
    this.setT = opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = opts.clearTimeoutImpl ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.uuid = opts.uuid ?? defaultUuid;
    this.connect();
  }

  // ------------------------------------------------------------------ public API
  state(): HelperConnState {
    return this.st;
  }

  rttMs(): number | null {
    return this.lastRtt;
  }

  send(msg: OutgoingMsg): string | null {
    const ws = this.ws;
    if (this.st !== "open" || !ws || ws.readyState !== OPEN) return null;
    const id = msg.id ?? this.uuid();
    const full = { ...msg, id };
    try {
      ws.send(JSON.stringify(full));
    } catch {
      return null;
    }
    this.lastSendAt = this.now();
    if (full.t === "ping") {
      this.pingSentAt.set(id, this.lastSendAt);
      if (this.pingSentAt.size > 64) {
        const oldest = this.pingSentAt.keys().next().value;
        if (oldest !== undefined) this.pingSentAt.delete(oldest);
      }
    }
    return id;
  }

  request(msg: OutgoingMsg, timeoutMs?: number): Promise<HelperToWorker> {
    const id = msg.id ?? this.uuid();
    return new Promise<HelperToWorker>((resolve, reject) => {
      const sent = this.send({ ...msg, id } as OutgoingMsg);
      if (sent === null) {
        reject(new HelperRequestError("closed", id));
        return;
      }
      const timer = this.setT(() => {
        this.pending.delete(id);
        reject(new HelperRequestError("timeout", id));
      }, timeoutMs ?? this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) this.clearT(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopKeepalive();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      this.detach(ws);
      try {
        ws.close(1000, "client closed");
      } catch {
        /* ignore */
      }
    }
    this.failPending();
    this.setState("closed");
  }

  // ------------------------------------------------------------------ internals
  private setState(s: HelperConnState): void {
    if (s === this.st) return;
    this.st = s;
    try {
      this.onState(s);
    } catch {
      /* a UI bug must not break the socket */
    }
  }

  private connect(): void {
    if (this.closedByUser) return;
    if (!this.WS) {
      this.setState("closed");
      return; // no WebSocket in this environment: stay closed, never throw
    }
    this.setState("connecting");
    let ws: WebSocket;
    try {
      ws = new this.WS(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.lastSendAt = this.now();
      this.setState("open");
      this.startKeepalive();
    };
    ws.onmessage = (ev: MessageEvent) => this.handleData(ev.data);
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopKeepalive();
      this.failPending();
      this.setState("closed");
      this.scheduleReconnect();
    };
  }

  private detach(ws: WebSocket): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== null) return;
    const delay = Math.min(this.backoffMaxMs, this.backoffMinMs * 2 ** this.attempt);
    this.attempt += 1;
    if (this.st !== "closed") this.setState("closed");
    this.reconnectTimer = this.setT(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleData(data: unknown): void {
    if (typeof data !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const msg = parseHelperToWorker(raw);
    if (!msg) return;
    if (msg.t === "pong") {
      const sentAt = this.pingSentAt.get(msg.id);
      if (sentAt !== undefined) {
        this.pingSentAt.delete(msg.id);
        this.lastRtt = Math.max(0, this.now() - sentAt);
      }
    }
    if (REPLY_TYPES.has(msg.t)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        this.clearT(p.timer);
        p.resolve(msg);
      }
    }
    try {
      this.onMessage(msg);
    } catch {
      /* consumer bug must not break the socket */
    }
  }

  private failPending(): void {
    const all = [...this.pending.entries()];
    this.pending.clear();
    for (const [id, p] of all) {
      this.clearT(p.timer);
      p.reject(new HelperRequestError("closed", id));
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    if (this.keepaliveMs <= 0) return;
    const tick = () => {
      this.keepaliveTimer = null;
      if (this.st !== "open") return;
      const idle = this.now() - this.lastSendAt;
      if (idle >= this.keepaliveMs) {
        this.send({ t: "ping" });
        this.keepaliveTimer = this.setT(tick, this.keepaliveMs);
      } else {
        this.keepaliveTimer = this.setT(tick, Math.max(1, this.keepaliveMs - idle));
      }
    };
    this.keepaliveTimer = this.setT(tick, this.keepaliveMs);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) this.clearT(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }
}

/** Factory matching the HelperClient contract. */
export function createHelperClient(opts: HelperClientOptions | HelperClientImplOptions): HelperClient {
  return new HelperSocketClient(opts);
}

/** `?helper=ws://127.0.0.1:18765` override (Playwright); `?helper=off` → null (do not connect). */
export function helperUrlFromSearch(search: string): string | null {
  const v = new URLSearchParams(search).get("helper");
  if (v === null || v === "") return HELPER_URL;
  if (v === "off" || v === "none" || v === "0") return null;
  return /^wss?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/.*)?$/.test(v) ? v : HELPER_URL;
}
