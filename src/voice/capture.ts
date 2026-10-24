/**
 * Microphone capture (browser only): getUserMedia → AudioContext → AudioWorklet
 * (/steady-capture-worklet.js) → 100 ms pcm_s16le 16 kHz chunks + levels.
 * The mic is acquired only while it is open (privacy rule 9) and fully released on stop().
 * On a device change (e.g. a Bluetooth headset connects) the graph is rebuilt and
 * AudioContext.sampleRate is re-read. If the track ends on its own (permission revoked, device
 * unplugged with no fallback), onEnded("revoked"|"ended") fires so the UI can show a banner.
 */
export const WORKLET_URL = "/steady-capture-worklet.js";

export interface CaptureHandlers {
  onChunk: (pcm: ArrayBuffer) => void;
  /** level = pre-gain RMS (voice activity); meter = post-gain RMS 0..1 (level meter). */
  onLevel: (level: number, meter: number) => void;
  onEnded: (reason: "revoked" | "ended") => void;
}

export type CaptureErrorKind = "denied" | "no_device" | "unsupported" | "failed";

export class CaptureError extends Error {
  constructor(public kind: CaptureErrorKind, message: string) {
    super(message);
  }
}

export interface Capture {
  stop(): void;
  readonly sampleRate: number;
}

function classify(err: unknown): CaptureError {
  const name = (err as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return new CaptureError("denied", "Microphone permission denied");
  if (name === "NotFoundError" || name === "OverconstrainedError") return new CaptureError("no_device", "No microphone found");
  return new CaptureError("failed", (err as Error)?.message ?? "Microphone failed");
}

export async function startCapture(h: CaptureHandlers): Promise<Capture> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") {
    throw new CaptureError("unsupported", "This browser cannot capture audio for voice commands");
  }
  let stopped = false;
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  let src: MediaStreamAudioSourceNode | null = null;
  let rate = 0;

  const teardownGraph = () => {
    try {
      node?.port.close();
      node?.disconnect();
      src?.disconnect();
    } catch {
      /* ignore */
    }
    stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    void ctx?.close().catch(() => undefined);
    node = null;
    src = null;
    stream = null;
    ctx = null;
  };

  const build = async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      throw classify(err);
    }
    if (stopped) {
      teardownGraph();
      return;
    }
    ctx = new AudioContext();
    rate = ctx.sampleRate; // re-read every build (device changes change it)
    await ctx.audioWorklet.addModule(WORKLET_URL);
    if (stopped) {
      teardownGraph();
      return;
    }
    src = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, "steady-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { inputRate: rate },
    });
    node.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { type: string; pcm: ArrayBuffer; level: number; meter: number };
      if (d?.type !== "chunk" || stopped) return;
      h.onLevel(d.level, d.meter);
      h.onChunk(d.pcm);
    };
    src.connect(node);
    if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
    const track = stream.getAudioTracks()[0];
    if (track) {
      track.onended = () => {
        if (stopped) return;
        // A track that ends without stop() means the device vanished or permission was revoked.
        void (async () => {
          let reason: "revoked" | "ended" = "ended";
          try {
            const p = await navigator.permissions?.query({ name: "microphone" as PermissionName });
            if (p?.state === "denied") reason = "revoked";
          } catch {
            /* permissions API not available */
          }
          stopAll();
          h.onEnded(reason);
        })();
      };
    }
  };

  const onDeviceChange = () => {
    if (stopped) return;
    teardownGraph();
    build().catch(() => {
      if (!stopped) {
        stopAll();
        h.onEnded("ended");
      }
    });
  };

  const stopAll = () => {
    stopped = true;
    navigator.mediaDevices.removeEventListener?.("devicechange", onDeviceChange);
    teardownGraph();
  };

  try {
    await build();
  } catch (err) {
    stopAll();
    throw err instanceof CaptureError ? err : classify(err);
  }
  navigator.mediaDevices.addEventListener?.("devicechange", onDeviceChange);
  return {
    stop: stopAll,
    get sampleRate() {
      return rate;
    },
  };
}
