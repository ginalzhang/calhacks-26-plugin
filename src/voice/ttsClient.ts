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
 * Speaks only short confirmations (≤ 5 words plus heard text), never while the mic is open, never
 * on pen toggles (callers' job), and never in quiet mode or when the TTS setting is off.
 */
import { getCartesiaToken, type CartesiaToken } from "./tokenClient";

export const TTS_MODEL = "sonic-3.6";
export const TTS_RATE = 24000;
export const TTS_URL = "wss://api.cartesia.ai/tts/websocket";
const CARTESIA_VERSION = "2026-08-14";

export type TtsStatus = "ok" | "off" | "key_missing" | "voice_unavailable" | "error";

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

class TtsClient {
  private enabled = true;
  private quiet = false;
  private micOpen = false;
  private ws: WebSocket | null = null;
  private wsToken: string | null = null;
  private ctx: AudioContext | null = null;
  private playHead = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private contextId: string | null = null;
  private statusListener: ((s: TtsStatus, detail?: string) => void) | null = null;
  status: TtsStatus = "ok";

  onStatus(fn: ((s: TtsStatus, detail?: string) => void) | null): void {
    this.statusListener = fn;
  }

  private setStatus(s: TtsStatus, detail?: string): void {
    if (s !== this.status) {
      this.status = s;
      this.statusListener?.(s, detail);
    }
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

  /** Stop current speech: cancel the server context and silence queued audio. */
  cancel(): void {
    if (this.contextId && this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ context_id: this.contextId, cancel: true }));
      } catch {
        /* ignore */
      }
    }
    this.contextId = null;
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

  async speak(text: string): Promise<boolean> {
    if (!this.enabled || this.quiet || this.micOpen || !text.trim()) return false;
    if (typeof window === "undefined" || typeof WebSocket === "undefined") return false;
    let token: CartesiaToken;
    try {
      token = await getCartesiaToken();
    } catch (e) {
      this.setStatus("error", (e as Error)?.message);
      return false;
    }
    const v = selectVoiceId(token);
    if (!v.id) {
      this.setStatus(v.status);
      return false;
    }
    if (this.micOpen || this.quiet || !this.enabled) return false;
    this.cancel();
    const ws = await this.socket(token.token).catch(() => null);
    if (!ws) {
      this.setStatus("error", "TTS connection failed");
      return false;
    }
    this.setStatus("ok");
    const id = `steady-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.contextId = id;
    ws.send(JSON.stringify(buildTtsRequest(text, v.id, id)));
    return true;
  }

  private socket(token: string): Promise<WebSocket> {
    if (this.ws && this.wsToken === token && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    const url = `${TTS_URL}?cartesia_version=${CARTESIA_VERSION}&access_token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
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
    let m: { type?: string; context_id?: string; data?: string; message?: string; error?: string };
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (m.context_id !== this.contextId) return; // cancelled or stale
    if (m.type === "chunk" && typeof m.data === "string") this.play(b64ToInt16(m.data));
    else if (m.type === "error") this.setStatus("error", m.message ?? m.error);
  }

  private play(pcm: Int16Array): void {
    if (this.micOpen || this.quiet || !this.enabled || pcm.length === 0) return;
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
}

/** Singleton: MicTile cancels it on mic open; B calls speak("Saved") etc. */
export const tts = new TtsClient();
export const cancelSpeech = (): void => tts.cancel();
