/**
 * Cartesia Ink 2 streaming STT over the documented manual-finalize WebSocket (§8; decision in
 * DECISIONS.md › Agent E: manual socket, not the SDK, in the browser).
 *
 *   wss://api.cartesia.ai/stt/websocket?model=ink-2&encoding=pcm_s16le&sample_rate=16000
 *     &cartesia_version=2026-08-14&access_token=<token>&keyterm=<phrase>&keyterm=<phrase>…
 *
 * Audio: 100 ms binary pcm_s16le 16 kHz chunks. On mic close send the text "finalize"; transcript
 * messages carry `text` as a delta: concatenate the chunks with is_final:true, untrimmed, until
 * `flush_done`. No /stt/turns, no turn.* events. Keyterms are immutable per connection.
 * The socket stays open across utterances; it is only replaced (new token / keyterms) between
 * utterances, never mid-utterance.
 */

export const STT_BASE = "wss://api.cartesia.ai/stt/websocket";
export const CARTESIA_VERSION = "2026-08-14";
/** Give up waiting for flush_done after this long and use what we have. */
export const FLUSH_TIMEOUT_MS = 5000;

export function buildSttUrl(token: string, keyterms: string[], base = STT_BASE): string {
  const q: string[] = [
    "model=ink-2",
    "encoding=pcm_s16le",
    "sample_rate=16000",
    `cartesia_version=${CARTESIA_VERSION}`,
    `access_token=${encodeURIComponent(token)}`,
    ...keyterms.map((k) => `keyterm=${encodeURIComponent(k)}`), // spaces → %20
  ];
  return `${base}?${q.join("&")}`;
}

export interface SttHandlers {
  /** Any transcript message with text (interim or final). `full` = finals so far + current interim. */
  onDelta?: (full: string, isFinal: boolean) => void;
  onError?: (message: string) => void;
  onClose?: (code: number) => void;
}

type WsLike = Pick<WebSocket, "send" | "close" | "readyState"> & {
  binaryType: string;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
};

export type WsFactory = (url: string) => WsLike;

const OPEN = 1;

/**
 * One connection; many utterances: begin() → sendAudio()* → finish() (resolves with the transcript).
 */
export class SttConnection {
  private ws: WsLike;
  private queue: ArrayBuffer[] = [];
  private finalizeQueued = false;
  private finals = "";
  private interim = "";
  private pending: { resolve: (t: string) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  closed = false;
  readonly url: string;

  constructor(token: string, keyterms: string[], private handlers: SttHandlers = {}, factory?: WsFactory) {
    this.url = buildSttUrl(token, keyterms);
    const make: WsFactory = factory ?? ((u) => new WebSocket(u) as unknown as WsLike);
    this.ws = make(this.url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => {
      for (const b of this.queue) this.ws.send(b);
      this.queue = [];
      if (this.finalizeQueued) {
        this.finalizeQueued = false;
        this.ws.send("finalize");
      }
    };
    this.ws.onmessage = (ev) => this.onMessage(ev.data);
    this.ws.onerror = () => this.handlers.onError?.("Voice connection error");
    this.ws.onclose = (ev) => {
      this.closed = true;
      this.settle();
      this.handlers.onClose?.(ev.code);
    };
  }

  setHandlers(h: SttHandlers): void {
    this.handlers = h;
  }

  /** Start a new utterance (clears the transcript accumulator). */
  begin(): void {
    this.finals = "";
    this.interim = "";
  }

  sendAudio(chunk: ArrayBuffer): void {
    if (this.closed) return;
    if (this.ws.readyState === OPEN) this.ws.send(chunk);
    else this.queue.push(chunk); // speech often starts before the socket opens: never drop it
  }

  /** Mic closed: send "finalize" and resolve with the concatenated finals once flush_done arrives. */
  finish(): Promise<string> {
    return new Promise((resolve) => {
      if (this.closed) return resolve(this.text());
      const timer = setTimeout(() => this.settle(), FLUSH_TIMEOUT_MS);
      this.pending = { resolve, timer };
      if (this.ws.readyState === OPEN) this.ws.send("finalize");
      else this.finalizeQueued = true; // sent right after the queued audio on open
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close(1000, "done");
    } catch {
      /* ignore */
    }
    this.settle();
  }

  private text(): string {
    return this.finals + this.interim;
  }

  private settle(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const p = this.pending;
    this.pending = null;
    // On flush_done the finals are the transcript; on timeout/close fall back to finals + interim.
    p.resolve(this.text());
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let msg: { type?: string; text?: string; is_final?: boolean; message?: string; title?: string };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === "transcript") {
      const t = typeof msg.text === "string" ? msg.text : "";
      if (msg.is_final) {
        this.finals += t; // deltas: concatenate, never trim or add spaces
        this.interim = "";
      } else {
        this.interim = t;
      }
      if (t) this.handlers.onDelta?.(this.text(), !!msg.is_final);
    } else if (msg.type === "flush_done") {
      this.interim = "";
      this.settle();
    } else if (msg.type === "error") {
      this.handlers.onError?.(msg.message || msg.title || "Voice service error");
      this.settle();
    }
  }
}
