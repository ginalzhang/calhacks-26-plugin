/**
 * Cartesia Sonic TTS (§8; P2b). Manual WebSocket (same reasoning as STT: no SDK in the browser):
 *   wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14&access_token=<token>
 * Request: { model_id: "sonic-3.6", transcript, voice: { mode: "id", id }, language: "en",
 *            output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 },
 *            context_id, max_buffer_delay_ms: 300 }
 * Cancel:  { context_id, cancel: true } (sent on push-to-talk start / mic open).
 *
 * Voice id: the token route returns CARTESIA_VOICE_ID if set, else the first English voice from
 * the voice list; if neither, TTS is disabled with status "voice unavailable".
 * Speaks only what can't be seen at a glance (speakConfirmation: "Saved", "New layer",
 * "Didn't catch that; I heard …"), ≤ 5 words plus the heard text, never while the mic is open,
 * never on pen toggles (there is no confirmation kind for them), never in quiet mode or when the
 * TTS setting is off.
 */
import { getCartesiaToken, type CartesiaToken } from "./tokenClient";

export const TTS_MODEL = "sonic-3.6";
export const TTS_RATE = 24000;
export const TTS_URL = "wss://api.cartesia.ai/tts/websocket";
const CARTESIA_VERSION = "2026-08-14";

export type TtsStatus = "ok" | "off" | "key_missing" | "voice_unavailable" | "error";

export const TTS_STATUS_TEXT: Record<TtsStatus, string> = {
  ok: "",
  off: "Spoken replies are off.",
  key_missing: "Spoken replies need a Cartesia key (key missing).",
  voice_unavailable: "Spoken replies: voice unavailable.",
  error: "Spoken replies stopped working.",
};

// ---------------------------------------------------------------------------
// Confirmations (pure)
// ---------------------------------------------------------------------------

export type ConfirmationKind =
  | "saved"
  | "new_layer"
  | "didnt_catch"
  | "needs_plugin"
  | "skin_saved"
  | "brush_named"
  | "word_taken";

/** Fixed part of each confirmation: ≤ 5 words. The heard text (if any) is appended. */
export const CONFIRMATIONS: Record<ConfirmationKind, { text: string; withHeard: boolean }> = {
  saved: { text: "Saved", withHeard: false },
  new_layer: { text: "New layer", withHeard: false },
  didnt_catch: { text: "Didn't catch that; I heard", withHeard: true },
  needs_plugin: { text: "That needs the Krita plugin", withHeard: false },
  skin_saved: { text: "Skin colour saved", withHeard: false },
  brush_named: { text: "Brush named", withHeard: true },
  word_taken: { text: "That word is taken", withHeard: false },
};

/** Heard text is capped so a long misrecognition doesn't become a speech. */
export const HEARD_MAX_WORDS = 12;

export function confirmationText(kind: ConfirmationKind, heard?: string): string | null {
  const c = CONFIRMATIONS[kind];
  if (!c) return null;
  if (!c.withHeard) return c.text;
  const h = (heard ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, HEARD_MAX_WORDS).join(" ");
  if (!h) return kind === "didnt_catch" ? "Didn't catch that" : null;
  return `${c.text} ${h}`;
}

/** Voice id selection: env/route-provided id wins; null → TTS disabled ("voice unavailable"). */
export function selectVoiceId(token: Pick<CartesiaToken, "voiceId" | "mock"> | null): { id: string | null; status: TtsStatus } {
  if (!token || token.mock) return { id: null, status: "key_missing" };
  if (!token.voiceId) return { id: null, status: "voice_unavailable" };
  return { id: token.voiceId, status: "ok" };
}

/** Build the generation request (exported for tests). */
export function buildTtsRequest(text: string, voiceId: string, contextId: string) {
  return {
    model_id: TTS_MODEL,
    transcript: text,
    voice: { mode: "id", id: voiceId },
    language: "en",
    output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: TTS_RATE },
    context_id: contextId,
    max_buffer_delay_ms: 300,
  };
}

function b64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface TtsSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}

export interface TtsPlayer {
  play(pcm: Int16Array): void;
  stop(): void;
}

export interface TtsDeps {
  getToken: () => Promise<CartesiaToken>;
  socket: (url: string) => TtsSocket;
  player: () => TtsPlayer;
  newContextId: () => string;
}

const OPEN = 1;

class WebAudioPlayer implements TtsPlayer {
  private ctx: AudioContext | null = null;
  private playHead = 0;
  private sources = new Set<AudioBufferSourceNode>();
  play(pcm: Int16Array): void {
    if (pcm.length === 0) return;
    if (!this.ctx) this.ctx = new AudioContext({ sampleRate: TTS_RATE });
    const ctx = this.ctx;
    if (ctx.state === "suspended") void ctx.resume();
    const buf = ctx.createBuffer(1, pcm.length, TTS_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const start = Math.max(ctx.currentTime + 0.02, this.playHead);
    src.start(start);
    this.playHead = start + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }
  stop(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    this.sources.clear();
    this.playHead = 0;
  }
}

export const defaultTtsDeps = (): TtsDeps => ({
  getToken: () => getCartesiaToken(),
  socket: (url) => new WebSocket(url) as unknown as TtsSocket,
  player: () => new WebAudioPlayer(),
  newContextId: () => `steady-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
});

export class TtsClient {
  private enabled = true;
  private quiet = false;
  private micOpen = false;
  private ws: TtsSocket | null = null;
  private wsToken: string | null = null;
  private player: TtsPlayer | null = null;
  private contextId: string | null = null;
  private listeners = new Set<(s: TtsStatus, text: string) => void>();
  status: TtsStatus = "ok";

  constructor(private deps: TtsDeps = defaultTtsDeps()) {}

  /** Subscribe to status changes ("voice unavailable", "key missing"). Returns unsubscribe. */
  onStatus(fn: (s: TtsStatus, text: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setStatus(s: TtsStatus): void {
    if (s === this.status) return;
    this.status = s;
    for (const fn of this.listeners) fn(s, TTS_STATUS_TEXT[s]);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.cancel();
  }
  setQuiet(q: boolean): void {
    this.quiet = q;
    if (q) this.cancel();
  }
  /** The mic opened (push-to-talk start / Mic tile): stop speaking at once. */
  setMicOpen(open: boolean): void {
    this.micOpen = open;
    if (open) this.cancel();
  }

  private allowed(): boolean {
    return this.enabled && !this.quiet && !this.micOpen;
  }

  /** Stop current speech: cancel the server context and silence queued audio. */
  cancel(): void {
    if (this.contextId && this.ws?.readyState === OPEN) {
      try {
        this.ws.send(JSON.stringify({ context_id: this.contextId, cancel: true }));
      } catch {
        /* ignore */
      }
    }
    this.contextId = null;
    this.player?.stop();
  }

  /** Speak a §8 confirmation. Returns false when it was not spoken (off, quiet, mic open, unavailable). */
  speakConfirmation(kind: ConfirmationKind, heard?: string): Promise<boolean> {
    const text = confirmationText(kind, heard);
    return text ? this.speak(text) : Promise.resolve(false);
  }

  /** Low-level: prefer speakConfirmation. */
  async speak(text: string): Promise<boolean> {
    if (!this.allowed() || !text.trim()) return false;
    let token: CartesiaToken;
    try {
      token = await this.deps.getToken();
    } catch {
      this.setStatus("error");
      return false;
    }
    const v = selectVoiceId(token);
    if (!v.id) {
      this.setStatus(v.status);
      return false;
    }
    if (!this.allowed()) return false; // mic may have opened while minting
    this.cancel();
    const ws = await this.socket(token.token).catch(() => null);
    if (!ws) {
      this.setStatus("error");
      return false;
    }
    if (!this.allowed()) return false;
    this.setStatus("ok");
    const id = this.deps.newContextId();
    this.contextId = id;
    ws.send(JSON.stringify(buildTtsRequest(text, v.id, id)));
    return true;
  }

  private socket(token: string): Promise<TtsSocket> {
    if (this.ws && this.wsToken === token && this.ws.readyState === OPEN) return Promise.resolve(this.ws);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    const url = `${TTS_URL}?cartesia_version=${CARTESIA_VERSION}&access_token=${encodeURIComponent(token)}`;
    const ws = this.deps.socket(url);
    this.ws = ws;
    this.wsToken = token;
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
    };
    return new Promise((resolve, reject) => {
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("tts socket error"));
    });
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let m: { type?: string; context_id?: string; data?: string };
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (!m.context_id || m.context_id !== this.contextId) return; // cancelled or stale
    if (m.type === "chunk" && typeof m.data === "string") {
      if (!this.allowed()) return;
      (this.player ??= this.deps.player()).play(b64ToInt16(m.data));
    } else if (m.type === "error") {
      this.setStatus("error");
    }
  }
}

/** Singleton: MicTile cancels it on mic open; B calls speakConfirmation("saved") etc. */
export const tts = new TtsClient();
export const cancelSpeech = (): void => tts.cancel();
export const speakConfirmation = (kind: ConfirmationKind, heard?: string): Promise<boolean> =>
  tts.speakConfirmation(kind, heard);
