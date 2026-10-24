/** Fake webkitSpeechRecognition for tests (no browser in Vitest's node environment). */
import type { RecognitionLike, RecognitionResultEvent } from "./webSpeech";

export class FakeRecognition implements RecognitionLike {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 0;
  starts = 0;
  stops = 0;
  aborts = 0;
  running = false;
  onresult: ((ev: RecognitionResultEvent) => void) | null = null;
  onerror: ((ev: { error: string; message?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  private results: Array<{ isFinal: boolean; 0: { transcript: string } }> = [];
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    if (this.running) throw new Error("InvalidStateError");
    this.running = true;
    this.starts++;
    this.results = [];
  }
  stop() {
    this.stops++;
    this.running = false;
    queueMicrotask(() => this.onend?.());
  }
  abort() {
    this.aborts++;
    this.running = false;
  }
  /** Simulate Chrome: interim then final results for the current session. */
  say(text: string, isFinal: boolean) {
    const last = this.results[this.results.length - 1];
    if (last && !last.isFinal) this.results[this.results.length - 1] = { isFinal, 0: { transcript: text } };
    else this.results.push({ isFinal, 0: { transcript: text } });
    this.onresult?.({ resultIndex: 0, results: this.results });
  }
  /** Chrome ends recognition on its own (pause, no-speech). */
  endByItself() {
    this.running = false;
    this.onend?.();
  }
}
