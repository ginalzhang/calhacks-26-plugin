/**
 * ColorCapSource (P3): tracks a bright fingertip / knuckle sticker instead of a hand skeleton.
 * Owned by G; B constructs and wires it in the Worker. The only tracking path for a hand in a
 * compression glove, a thumb spica or a splint (§11 P3, §13).
 *
 * Drop-in for MediaPipeSource: same constructor events, same frame inputs, same LandmarkSource API.
 *
 *   const cap = new ColorCapSource(
 *     { onDelegate: (d) => post({ type: "ready", delegate: d }), onWarning: (t) => setStatus(t) },
 *     { handedness: "Right", range: savedRange ?? undefined },   // optional
 *   );
 *   source = cap;
 *   await cap.start(onFrame);        // resolves immediately (no wasm); calls onDelegate("CPU")
 *   cap.attach(readable);            // ReadableStream<VideoFrame> from the page (MediaStreamTrackProcessor)
 *   cap.pushBitmap(bitmap);          // or: ImageBitmap fallback path (closed here)
 *   const pick = await cap.pickColourFromCentre();  // calibration: sticker in the middle → new range
 *   cap.setRange(r); cap.setHandedness("Left"); cap.stop();
 *
 * Each frame is drawn into a 160×120 OffscreenCanvas (the browser does the downscale), run through
 * the pure detector in colorCap.ts, and emitted as a LandmarkFrame in CAMERA px: one hand, all 21
 * landmarks at the blob centroid, score = confidence (≥ 0.75 solid, 0.6–0.75 faint, < 0.6 none),
 * handedness from settings, luma = mean luma. Every VideoFrame / ImageBitmap is closed.
 */
import {
  DEFAULT_COLORCAP_RANGE,
  GRID_HEIGHT,
  GRID_WIDTH,
  colorCapFrame,
  detectColorCap,
  pickColourFromCentre,
  type ColorCapOptions,
  type HsvRange,
  type PickColourResult,
  type RgbaImage,
} from "./colorCap";
import type { LandmarkFrame, LandmarkSource } from "./LandmarkSource";
import type { MediaPipeSourceEvents } from "./MediaPipeSource";

export type ColorCapSourceEvents = MediaPipeSourceEvents;

export interface ColorCapSourceOptions extends Omit<ColorCapOptions, "gridWidth"> {
  handedness?: "Left" | "Right";
}

export class ColorCapSource implements LandmarkSource {
  readonly kind = "colorcap" as const;
  private onFrame: ((f: LandmarkFrame) => void) | null = null;
  private range: HsvRange;
  private handedness: "Left" | "Right";
  private minArea?: number;
  private solidArea?: number;
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private stopped = false;
  private busy = false;
  private lastTs = -Infinity;
  private stamps: number[] = [];
  private cameraStamps: number[] = [];
  private pendingPicks: Array<(r: PickColourResult) => void> = [];
  private warnedCanvas = false;

  constructor(
    private readonly events: ColorCapSourceEvents = {},
    opts: ColorCapSourceOptions = {},
  ) {
    this.range = opts.range ?? DEFAULT_COLORCAP_RANGE;
    this.handedness = opts.handedness ?? "Right";
    this.minArea = opts.minArea;
    this.solidArea = opts.solidArea;
  }

  async start(onFrame: (frame: LandmarkFrame) => void): Promise<void> {
    this.onFrame = onFrame;
    this.stopped = false;
    if (typeof OffscreenCanvas === "undefined") {
      throw new Error("Sticker tracking needs OffscreenCanvas (use Chrome).");
    }
    this.canvas = new OffscreenCanvas(GRID_WIDTH, GRID_HEIGHT);
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!this.ctx) throw new Error("Sticker tracking could not create a canvas.");
    this.events.onDelegate?.("CPU");
  }

  setRange(range: HsvRange): void {
    this.range = range;
  }

  getRange(): HsvRange {
    return this.range;
  }

  setHandedness(h: "Left" | "Right"): void {
    this.handedness = h;
  }

  /**
   * Calibration helper: resolves with the HSV range of whatever is in the centre of the NEXT frame and,
   * when it is a bright colour (`ok`), starts tracking it. Show `result.message` in the status line.
   */
  pickColourFromCentre(): Promise<PickColourResult> {
    return new Promise((resolve) => this.pendingPicks.push(resolve));
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
    let t = performance.now();
    if (t <= this.lastTs) t = this.lastTs + 1;
    this.lastTs = t;
    return t;
  }

  private grab(src: VideoFrame | ImageBitmap): RgbaImage | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    try {
      ctx.drawImage(src as CanvasImageSource, 0, 0, GRID_WIDTH, GRID_HEIGHT);
      const id = ctx.getImageData(0, 0, GRID_WIDTH, GRID_HEIGHT);
      return { data: id.data, width: GRID_WIDTH, height: GRID_HEIGHT };
    } catch (err) {
      if (!this.warnedCanvas) {
        this.warnedCanvas = true;
        this.events.onWarning?.(`Sticker tracking could not read the camera (${String((err as Error)?.message ?? err)}).`);
      }
      return null;
    }
  }

  private process(src: VideoFrame | ImageBitmap, w: number, h: number) {
    const now = performance.now();
    this.cameraStamps.push(now);
    while (this.cameraStamps.length && this.cameraStamps[0] < now - 1000) this.cameraStamps.shift();
    if (this.busy || this.stopped || !this.onFrame) return;
    this.busy = true;
    try {
      const img = this.grab(src);
      if (!img) return;
      if (this.pendingPicks.length) {
        const pick = pickColourFromCentre(img);
        if (pick.ok) this.range = pick.range;
        const waiters = this.pendingPicks;
        this.pendingPicks = [];
        for (const resolve of waiters) resolve(pick);
      }
      const det = detectColorCap(img, { range: this.range, minArea: this.minArea, solidArea: this.solidArea });
      const t = this.nextTimestamp();
      this.stamps.push(t);
      while (this.stamps.length && this.stamps[0] < t - 1000) this.stamps.shift();
      const width = w || 640;
      const height = h || 480;
      this.onFrame(colorCapFrame(det, t, width, height, this.handedness, img.width, img.height));
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
    this.reader = null;
    const waiters = this.pendingPicks;
    this.pendingPicks = [];
    for (const resolve of waiters)
      resolve({ ok: false, range: this.range, hue: NaN, message: "Sticker tracking stopped" });
  }

  fps(): number {
    return this.stamps.length;
  }

  cameraFps(): number {
    return this.cameraStamps.length;
  }
}
