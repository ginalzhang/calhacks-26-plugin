/**
 * Page side of the tracking Worker (§1). Owned by B.
 * The page never opens a socket: it posts {type:"send"} and gets {type:"reply"} back by id.
 */
import type { HelperToWorker } from "../desktop/protocol";
import type { MirrorState, PageToWorker, PipelineOutput, WorkerToPage } from "../pipeline/types";
import { SENT_CHANNEL, type SentRecord } from "./sentChannel";

type Listener<T> = (v: T) => void;

export type SendMsg = Extract<PageToWorker, { type: "send" }>["msg"];
export type ReplyMsg = HelperToWorker | { t: "timeout"; id: string };

export class WorkerBridge {
  readonly worker: Worker;
  private frameL = new Set<Listener<PipelineOutput>>();
  private msgL = new Set<Listener<WorkerToPage>>();
  private pending = new Map<string, Listener<ReplyMsg>>();
  private sentCh: BroadcastChannel | null = null;
  readonly sent: SentRecord[] = [];
  latest: MirrorState | null = null;

  constructor() {
    this.worker = new Worker(new URL("./steady.worker.ts", import.meta.url), { type: "module", name: "steady-tracking" });
    this.worker.onmessage = (ev: MessageEvent<WorkerToPage>) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => {
      for (const l of this.msgL) l({ type: "error", text: `Tracking worker error: ${ev.message}` });
    };
    if (typeof BroadcastChannel !== "undefined") {
      this.sentCh = new BroadcastChannel(SENT_CHANNEL);
      this.sentCh.onmessage = (ev: MessageEvent<SentRecord>) => {
        this.sent.push(ev.data);
        if (this.sent.length > 500) this.sent.shift();
      };
    }
  }

  private onMessage(m: WorkerToPage) {
    if (m.type === "frame") {
      for (const l of this.frameL) l(m.out);
      return;
    }
    if (m.type === "state") this.latest = m.state;
    if (m.type === "reply") {
      const cb = this.pending.get(m.id);
      if (cb) {
        this.pending.delete(m.id);
        cb(m.msg);
      }
    }
    for (const l of this.msgL) l(m);
  }

  post(msg: PageToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(msg, transfer);
  }

  /** Send a message to the helper through the Worker; resolves with the reply (or {t:"timeout"}). */
  request(msg: SendMsg): Promise<ReplyMsg> {
    const id = msg.id ?? crypto.randomUUID();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.post({ type: "send", msg: { ...msg, id } as SendMsg });
    });
  }

  onFrame(l: Listener<PipelineOutput>) {
    this.frameL.add(l);
    return () => void this.frameL.delete(l);
  }

  onMessage$(l: Listener<WorkerToPage>) {
    this.msgL.add(l);
    return () => void this.msgL.delete(l);
  }

  terminate() {
    this.worker.terminate();
    this.sentCh?.close();
    this.frameL.clear();
    this.msgL.clear();
  }
}
