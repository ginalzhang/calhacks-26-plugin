/**
 * Web Speech API fallback (§8 P3): used by the Mic tile only when Cartesia is unavailable (no key,
 * token error, socket failure) and the browser has `webkitSpeechRecognition`.
 * Same open/close semantics as the Cartesia path: recognition runs only while the mic is open
 * (tap or push-to-talk), never always-on. If Chrome ends recognition on its own while the mic is
 * still open (it does after a pause), it is restarted so there is still no time limit the user
 * can hit; transcripts accumulate across restarts.
 *
 * PRIVACY: Chrome's Web Speech implementation sends the audio to Google's servers. The Mic tile
 * says so in the status the first time it is used in a session (DECISIONS.md › Agent E).
 */

/** Minimal typing of the (untyped in lib.dom) webkitSpeechRecognition surface we use. */
export interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: RecognitionResultEvent) => void) | null;
  onerror: ((ev: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
}
export interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
export type RecognitionCtor = new () => RecognitionLike;

export function webSpeechCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { webkitSpeechRecognition?: RecognitionCtor; SpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const WEB_SPEECH_NOTICE =
  "Using the browser's speech recognition. Chrome sends this audio to Google while the mic is open.";
export const WEB_SPEECH_STATUS = "Using the browser's speech recognition.";

export interface WebSpeechHandlers {
  onDelta: (full: string) => void;
  onActivity: () => void;
  onEnded: (reason: "revoked" | "ended") => void;
  onError: (message: string) => void;
}

/** Restart at most this many times in a row without any result (guards an error loop). */
const MAX_IDLE_RESTARTS = 20;

export class WebSpeechSession {
  private rec: RecognitionLike;
  private finals = "";
  private interim = "";
  private open = false;
  private idleRestarts = 0;
  private closing: ((t: string) => void) | null = null;
  private fatal = false;

  constructor(Ctor: RecognitionCtor, private h: WebSpeechHandlers) {
    this.rec = new Ctor();
    this.rec.continuous = true;
    this.rec.interimResults = true;
    this.rec.lang = "en-US";
    this.rec.maxAlternatives = 1;
    this.rec.onspeechstart = () => this.h.onActivity();
    this.rec.onresult = (ev) => {
      this.idleRestarts = 0;
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const t = r[0]?.transcript ?? "";
        if (r.isFinal) this.finals += (this.finals && !this.finals.endsWith(" ") && !t.startsWith(" ") ? " " : "") + t;
        else interim += t;
      }
      this.interim = interim;
      this.h.onActivity();
      this.h.onDelta(this.text());
    };
    this.rec.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        this.fatal = true;
        this.open = false;
        this.h.onEnded("revoked");
      } else if (ev.error === "network") {
        this.fatal = true;
        this.h.onError("The browser's speech recognition needs a network connection");
      } else if (ev.error === "audio-capture") {
        this.fatal = true;
        this.open = false;
        this.h.onEnded("ended");
      }
      // "no-speech" / "aborted": onend follows; restart while open.
    };
    this.rec.onend = () => {
      if (this.closing) {
        const done = this.closing;
        this.closing = null;
        done(this.text());
        return;
      }
      if (this.open && !this.fatal && this.idleRestarts++ < MAX_IDLE_RESTARTS) {
        // Chrome stopped by itself while the user still has the mic open: keep listening.
        this.finals = this.text();
        this.interim = "";
        try {
          this.rec.start();
        } catch {
          /* already started */
        }
      }
    };
  }

  private text(): string {
    return (this.finals + (this.interim ? (this.finals ? " " : "") + this.interim : "")).trim();
  }

  start(): void {
    this.open = true;
    this.finals = "";
    this.interim = "";
    this.rec.start();
  }

  /** Mic closed: stop and resolve with the transcript once Chrome delivers the last result. */
  close(): Promise<string> {
    if (!this.open) return Promise.resolve(this.text());
    this.open = false;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.closing) {
          this.closing = null;
          resolve(this.text());
        }
      }, 3000);
      this.closing = (t) => {
        clearTimeout(timer);
        resolve(t);
      };
      try {
        this.rec.stop();
      } catch {
        this.closing = null;
        clearTimeout(timer);
        resolve(this.text());
      }
    });
  }

  cancel(): void {
    this.open = false;
    this.closing = null;
    try {
      this.rec.abort();
    } catch {
      /* ignore */
    }
  }
}
