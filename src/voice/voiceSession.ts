/**
 * Voice session orchestration (browser): token → STT connection (reused across utterances) →
 * capture → finalize. Framework-free so MicTile stays thin. Dependencies are injectable.
 *
 * Token lifecycle (§8): the connection is (re)built only when the mic opens and the previous one is
 * gone; after each utterance, if the token is ≥ 45 min old, the connection is closed so the next
 * open re-mints. Never reconnects mid-utterance.
 */
import { startCapture as realStartCapture, type Capture, type CaptureHandlers } from "./capture";
import { sttKeyterms } from "./keyterms";
import { SttConnection, type SttHandlers } from "./sttClient";
import { getCartesiaToken, needsRemint, type CartesiaToken } from "./tokenClient";

export interface VoiceDeps {
  getToken: () => Promise<CartesiaToken>;
  keyterms: () => string[];
  connect: (token: string, keyterms: string[], h: SttHandlers) => SttConnection;
  startCapture: (h: CaptureHandlers) => Promise<Capture>;
  now: () => number;
}

export const defaultVoiceDeps = (): VoiceDeps => ({
  getToken: () => getCartesiaToken(),
  keyterms: () => sttKeyterms(),
  connect: (token, keyterms, h) => new SttConnection(token, keyterms, h),
  startCapture: realStartCapture,
  now: () => Date.now(),
});

export interface SessionHandlers {
  onDelta: (full: string) => void;
  onLevel: (level: number, meter: number) => void;
  onEnded: (reason: "revoked" | "ended") => void;
  onError: (message: string) => void;
}

export type OpenResult = { ok: true } | { ok: false; reason: "key_missing" | "token_failed" | "denied" | "no_device" | "unsupported" | "failed"; message: string };

export class VoiceSession {
  private conn: SttConnection | null = null;
  private connToken: CartesiaToken | null = null;
  private capture: Capture | null = null;
  private handlers: SessionHandlers | null = null;
  private gen = 0;
  active = false;

  constructor(private deps: VoiceDeps = defaultVoiceDeps()) {}

  async open(h: SessionHandlers): Promise<OpenResult> {
    const gen = ++this.gen;
    this.handlers = h;
    this.active = true;
    let token: CartesiaToken;
    try {
      token = await this.deps.getToken();
    } catch (e) {
      this.active = false;
      return { ok: false, reason: "token_failed", message: (e as Error)?.message ?? "token failed" };
    }
    if (gen !== this.gen) return { ok: false, reason: "failed", message: "cancelled" };
    if (token.mock) {
      this.active = false;
      return { ok: false, reason: "key_missing", message: "Voice needs a Cartesia key" };
    }
    const sttHandlers: SttHandlers = {
      onDelta: (full) => this.handlers?.onDelta(full),
      onError: (m) => this.handlers?.onError(m),
      onClose: () => {
        /* reconnect lazily on the next open */
      },
    };
    if (!this.conn || this.conn.closed || this.connToken?.token !== token.token) {
      this.conn?.close();
      this.conn = this.deps.connect(token.token, this.deps.keyterms(), sttHandlers);
      this.connToken = token;
    } else {
      this.conn.setHandlers(sttHandlers);
    }
    this.conn.begin();
    const conn = this.conn;
    try {
      this.capture = await this.deps.startCapture({
        onChunk: (pcm) => conn.sendAudio(pcm),
        onLevel: (l, m) => this.handlers?.onLevel(l, m),
        onEnded: (r) => {
          this.capture = null;
          this.handlers?.onEnded(r);
        },
      });
    } catch (e) {
      this.active = false;
      const kind = (e as { kind?: string })?.kind;
      const reason = kind === "denied" || kind === "no_device" || kind === "unsupported" ? kind : "failed";
      return { ok: false, reason, message: (e as Error)?.message ?? "microphone failed" };
    }
    if (gen !== this.gen) {
      this.capture?.stop();
      this.capture = null;
      return { ok: false, reason: "failed", message: "cancelled" };
    }
    return { ok: true };
  }

  /** Close the mic and return the transcript (concatenated finals until flush_done). */
  async close(): Promise<string> {
    this.gen++;
    this.active = false;
    this.capture?.stop();
    this.capture = null;
    const conn = this.conn;
    if (!conn) return "";
    const text = await conn.finish();
    // Between utterances: drop a connection whose token is due for re-minting.
    if (needsRemint(this.connToken, this.deps.now())) {
      conn.close();
      if (this.conn === conn) {
        this.conn = null;
        this.connToken = null;
      }
    }
    return text;
  }

  /** Stop without a transcript (quiet mode switched on, unmount). */
  cancel(): void {
    const wasActive = this.active || this.capture !== null;
    this.gen++;
    this.active = false;
    this.capture?.stop();
    this.capture = null;
    this.handlers = null;
    if (wasActive) {
      // Audio already sent for this utterance must never leak into the next one: drop the socket.
      this.conn?.close();
      this.conn = null;
      this.connToken = null;
    }
  }

  dispose(): void {
    this.cancel();
    this.conn?.close();
    this.conn = null;
  }
}
