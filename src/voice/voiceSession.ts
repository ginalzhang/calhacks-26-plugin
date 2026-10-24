/**
 * Voice session orchestration (browser): token → STT connection (reused across utterances) →
 * capture → finalize. Framework-free so MicTile stays thin. Dependencies are injectable.
 *
 * Engines: Cartesia Ink 2 (primary). If Cartesia is unavailable (no key → mock token, token
 * error, or a socket that never opened) and the browser has webkitSpeechRecognition, the Web
 * Speech fallback (P3) is used with the same open/close semantics. Offline → no voice at all.
 *
 * Token lifecycle (§8): the connection is (re)built only when the mic opens and the previous one is
 * gone; after each utterance, if the token is ≥ 45 min old, the connection is closed so the next
 * open re-mints. Never reconnects mid-utterance.
 */
import { startCapture as realStartCapture, type Capture, type CaptureHandlers } from "./capture";
import { sttKeyterms } from "./keyterms";
import { SttConnection, type SttHandlers } from "./sttClient";
import { getCartesiaToken, needsRemint, type CartesiaToken } from "./tokenClient";
import { WebSpeechSession, webSpeechCtor, type RecognitionCtor } from "./webSpeech";

export interface VoiceDeps {
  getToken: () => Promise<CartesiaToken>;
  keyterms: () => string[];
  connect: (token: string, keyterms: string[], h: SttHandlers) => SttConnection;
  startCapture: (h: CaptureHandlers) => Promise<Capture>;
  now: () => number;
  /** Web Speech constructor, or null when the browser has none. */
  webSpeech: () => RecognitionCtor | null;
  online: () => boolean;
}

export const defaultVoiceDeps = (): VoiceDeps => ({
  getToken: () => getCartesiaToken(),
  keyterms: () => sttKeyterms(),
  connect: (token, keyterms, h) => new SttConnection(token, keyterms, h),
  startCapture: realStartCapture,
  now: () => Date.now(),
  webSpeech: webSpeechCtor,
  online: () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
});

export interface SessionHandlers {
  onDelta: (full: string) => void;
  onLevel: (level: number, meter: number) => void;
  /** Speech activity without a level (Web Speech has no audio access). */
  onActivity?: () => void;
  onEnded: (reason: "revoked" | "ended") => void;
  onError: (message: string) => void;
}

export type Engine = "cartesia" | "webspeech";
export type FailReason = "offline" | "key_missing" | "token_failed" | "denied" | "no_device" | "unsupported" | "failed";
export type OpenResult =
  | { ok: true; engine: Engine; /** Why Cartesia was skipped, when engine is webspeech. */ fallbackFrom?: FailReason | "socket_failed" }
  | { ok: false; reason: FailReason; message: string };

export class VoiceSession {
  private conn: SttConnection | null = null;
  private connToken: CartesiaToken | null = null;
  private capture: Capture | null = null;
  private web: WebSpeechSession | null = null;
  private handlers: SessionHandlers | null = null;
  private gen = 0;
  /** Set when a Cartesia socket closed before ever opening: later opens go to Web Speech. */
  private cartesiaBroken = false;
  engine: Engine | null = null;
  active = false;

  constructor(private deps: VoiceDeps = defaultVoiceDeps()) {}

  /** opts.allowWebSpeech: settings.webSpeechFallback (opt-in, default off: Chrome sends the audio to Google). */
  async open(h: SessionHandlers, opts: { allowWebSpeech?: boolean } = {}): Promise<OpenResult> {
    this.allowWeb = opts.allowWebSpeech === true;
    const gen = ++this.gen;
    this.handlers = h;
    this.active = true;
    this.engine = null;
    if (!this.deps.online()) {
      this.active = false;
      return { ok: false, reason: "offline", message: "Voice needs a network connection" };
    }
    if (this.cartesiaBroken && this.allowWeb) return this.openWeb("failed", "socket_failed", "Voice connection failed");
    let token: CartesiaToken;
    try {
      token = await this.deps.getToken();
    } catch (e) {
      if (gen !== this.gen) return { ok: false, reason: "failed", message: "cancelled" };
      return this.openWeb("token_failed", "token_failed", (e as Error)?.message ?? "token failed");
    }
    if (gen !== this.gen) return { ok: false, reason: "failed", message: "cancelled" };
    if (token.mock) return this.openWeb("key_missing", "key_missing", "Voice needs a Cartesia key");

    const sttHandlers: SttHandlers = {
      onDelta: (full) => this.handlers?.onDelta(full),
      onError: (m) => this.handlers?.onError(m),
      onClose: () => {
        if (conn && !conn.opened) this.cartesiaBroken = true; // refused / unreachable
      },
    };
    let conn: SttConnection | null = null;
    if (!this.conn || this.conn.closed || this.connToken?.token !== token.token) {
      this.conn?.close();
      this.conn = this.deps.connect(token.token, this.deps.keyterms(), sttHandlers);
      this.connToken = token;
    } else {
      this.conn.setHandlers(sttHandlers);
    }
    conn = this.conn;
    conn.begin();
    try {
      this.capture = await this.deps.startCapture({
        onChunk: (pcm) => conn!.sendAudio(pcm),
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
    this.engine = "cartesia";
    return { ok: true, engine: "cartesia" };
  }

  private allowWeb = false;

  private openWeb(reason: FailReason, from: FailReason | "socket_failed", message: string): OpenResult {
    const Ctor = this.allowWeb ? this.deps.webSpeech() : null;
    if (!Ctor) {
      this.active = false;
      return { ok: false, reason, message };
    }
    const h = this.handlers;
    this.web = new WebSpeechSession(Ctor, {
      onDelta: (t) => h?.onDelta(t),
      onActivity: () => h?.onActivity?.(),
      onEnded: (r) => h?.onEnded(r),
      onError: (m) => h?.onError(m),
    });
    try {
      this.web.start();
    } catch (e) {
      this.web = null;
      this.active = false;
      return { ok: false, reason: "failed", message: (e as Error)?.message ?? "speech recognition failed" };
    }
    this.engine = "webspeech";
    return { ok: true, engine: "webspeech", fallbackFrom: from };
  }

  /** Close the mic and return the transcript. */
  async close(): Promise<string> {
    this.gen++;
    this.active = false;
    if (this.web) {
      const web = this.web;
      this.web = null;
      return web.close();
    }
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
    this.web?.cancel();
    this.web = null;
    this.capture?.stop();
    this.capture = null;
    this.handlers = null;
    if (wasActive && this.engine !== "webspeech") {
      // Audio already sent for this utterance must never leak into the next one: drop the socket.
      this.conn?.close();
      this.conn = null;
      this.connToken = null;
    }
  }

  get cartesiaFailed(): boolean {
    return this.cartesiaBroken;
  }

  /** Let Cartesia be tried again (e.g. after keys are added and the page is still open). */
  resetCartesia(): void {
    this.cartesiaBroken = false;
  }

  dispose(): void {
    this.cancel();
    this.conn?.close();
    this.conn = null;
  }
}
