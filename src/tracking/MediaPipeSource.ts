/**
 * MediaPipeSource: HandLandmarker on camera frames, inside the tracking Worker. Owned by B.
 *
 * - Frames arrive as a transferred ReadableStream<VideoFrame> (MediaStreamTrackProcessor on the page),
 *   or, on the fallback path, as ImageBitmaps posted by the page's requestVideoFrameCallback loop.
 * - GPU delegate first (with `canvas: new OffscreenCanvas(1, 1)`, retried without it), CPU fallback when
 *   creation throws, when detectForVideo throws, or when it returns no result object for 2 s.
 * - Timestamps passed to detectForVideo are strictly increasing on the Worker's monotonic clock.
 * - Every VideoFrame is closed, whatever happens.
 */
import type { HandObservation, LandmarkFrame, LandmarkSource } from "./LandmarkSource";

export const TASKS_VISION_VERSION = "1.1.1";
export const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
export const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

type Delegate = "GPU" | "CPU";
// Loaded lazily so ReplaySource never pulls in MediaPipe.
type Vision = typeof import("@mediapipe/tasks-vision");
type Landmarker = import("@mediapipe/tasks-vision").HandLandmarker;
type Result = import("@mediapipe/tasks-vision").HandLandmarkerResult;

export interface MediaPipeSourceEvents {
  onDelegate?: (d: Delegate) => void;
  onWarning?: (text: string) => void;
}

export class MediaPipeSource implements LandmarkSource {
  readonly kind = "mediapipe" as const;
  private vision: Vision | null = null;
  private fileset: Awaited<ReturnType<Vision["FilesetResolver"]["forVisionTasks"]>> | null = null;
  private landmarker: Landmarker | null = null;
  private delegate: Delegate = "GPU";
  private onFrame: ((f: LandmarkFrame) => void) | null = null;
  private lastTs = -Infinity;
  private stamps: number[] = [];
  private cameraStamps: number[] = [];
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private stopped = false;
  private busy = false;
  private lastResultAt = 0;
  private switching = false;
  private lumaCanvas: OffscreenCanvas | null = null;
  private lumaCtx: OffscreenCanvasRenderingContext2D | null = null;
  private frameCount = 0;
  private luma: number | undefined;

  constructor(private readonly events: MediaPipeSourceEvents = {}) {}

  async start(onFrame: (frame: LandmarkFrame) => void): Promise<void> {
    this.onFrame = onFrame;
    this.vision = await import("@mediapipe/tasks-vision");
    // useModule=true: in a module Worker the classic loader cannot be importScripts()ed.
    this.fileset = await this.vision.FilesetResolver.forVisionTasks(WASM_BASE, true);
    await this.create("GPU");
  }

  private async create(delegate: Delegate): Promise<void> {
    if (!this.vision || !this.fileset) return;
    const { HandLandmarker } = this.vision;
    const base = {
      baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
      runningMode: "VIDEO" as const,
      numHands: 1,
      minHandDetectionConfidence: 0.4,
    };
    try {
      this.landmarker?.close();
    } catch {
      /* ignore */
    }
    this.landmarker = null;
    try {
      try {
        this.landmarker = await HandLandmarker.createFromOptions(this.fileset, {
          ...base,
          canvas: typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : undefined,
        });
      } catch {
        // tasks-vision creates its own OffscreenCanvas inside a Worker.
        this.landmarker = await HandLandmarker.createFromOptions(this.fileset, base);
      }
      this.delegate = delegate;
      this.lastResultAt = performance.now();
      this.events.onDelegate?.(delegate);
    } catch (err) {
      if (delegate === "GPU") {
        this.events.onWarning?.("GPU tracking unavailable; using CPU.");
        await this.create("CPU");
      } else {
        throw err;
      }
    }
  }

  private async fallbackToCpu(reason: string) {
    if (this.delegate === "CPU" || this.switching) return;
    this.switching = true;
    this.events.onWarning?.(`GPU tracking failed (${reason}); using CPU.`);
    try {
      await this.create("CPU");
    } finally {
      this.switching = false;
    }
  }

  /** Attach the camera stream (MediaStreamTrackProcessor.readable transferred from the page). */
  attach(readable: ReadableStream<VideoFrame>): void {
    try {
      this.reader?.cancel().catch(() => undefined);
    } catch {
      /* ignore */
    }
    const reader = readable.getReader();
    this.reader = reader;
    const pump = async () => {
      while (!this.stopped && this.reader === reader) {
        let r: ReadableStreamReadResult<VideoFrame>;
        try {
          r = await reader.read();
        } catch {
          return;
        }
        if (r.done) return;
        const frame = r.value;
        try {
          this.process(frame, frame.displayWidth, frame.displayHeight);
        } finally {
          frame.close();
        }
      }
    };
    void pump();
  }

  /** Fallback path: an ImageBitmap from the page's requestVideoFrameCallback loop. */
  pushBitmap(bitmap: ImageBitmap): void {
    try {
      this.process(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  }

  private nextTimestamp(): number {
    // Monotonic: performance.now(), forced strictly increasing (camera switches reset frame.timestamp).
    let t = performance.now();
    if (t <= this.lastTs) t = this.lastTs + 1;
    this.lastTs = t;
    return t;
  }

  private measureLuma(src: VideoFrame | ImageBitmap) {
    if (this.frameCount++ % 30 !== 0) return;
    try {
      if (!this.lumaCanvas) {
        this.lumaCanvas = new OffscreenCanvas(32, 24);
        this.lumaCtx = this.lumaCanvas.getContext("2d", { willReadFrequently: true });
      }
      const ctx = this.lumaCtx;
      if (!ctx) return;
      ctx.drawImage(src as CanvasImageSource, 0, 0, 32, 24);
      const d = ctx.getImageData(0, 0, 32, 24).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      this.luma = sum / (d.length / 4);
    } catch {
      /* luma is best-effort */
    }
  }

  private process(src: VideoFrame | ImageBitmap, w: number, h: number) {
    const now = performance.now();
    this.cameraStamps.push(now);
    while (this.cameraStamps.length && this.cameraStamps[0] < now - 1000) this.cameraStamps.shift();
    const lm = this.landmarker;
    if (!lm || this.busy || this.switching || this.stopped) return;
    this.busy = true;
    try {
      this.measureLuma(src);
      const t = this.nextTimestamp();
      let result: Result | undefined;
      try {
        result = lm.detectForVideo(src as unknown as ImageBitmap, t);
      } catch (err) {
        void this.fallbackToCpu(String((err as Error)?.message ?? err));
        return;
      }
      if (!result || !Array.isArray(result.landmarks)) {
        if (performance.now() - this.lastResultAt > 2000) void this.fallbackToCpu("no result for 2 s");
        return;
      }
      this.lastResultAt = performance.now();
      this.stamps.push(t);
      while (this.stamps.length && this.stamps[0] < t - 1000) this.stamps.shift();
      const hands: HandObservation[] = result.landmarks.map((landmarks, i) => {
        const cat = result!.handedness?.[i]?.[0];
        return {
          landmarks: landmarks.map((p) => ({ x: p.x, y: p.y, z: p.z })),
          score: cat?.score ?? 0,
          handedness: (cat?.categoryName === "Left" ? "Left" : "Right") as "Left" | "Right",
        };
      });
      this.onFrame?.({ t, width: w || 640, height: h || 480, hands, luma: this.luma });
    } finally {
      this.busy = false;
    }
  }

  stop(): void {
    this.stopped = true;
    try {
      this.reader?.cancel().catch(() => undefined);
    } catch {
      /* ignore */
    }
    try {
      this.landmarker?.close();
    } catch {
      /* ignore */
    }
    this.landmarker = null;
  }

  fps(): number {
    return this.stamps.length;
  }

  cameraFps(): number {
    return this.cameraStamps.length;
  }

  currentDelegate(): Delegate {
    return this.delegate;
  }
}
