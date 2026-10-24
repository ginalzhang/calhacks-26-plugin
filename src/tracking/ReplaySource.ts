/**
 * ReplaySource: plays recorded or synthesised landmark JSON (public/replay/<name>.json) in real time.
 * Needs no camera and no permission. Owned by B.
 *
 * Compact files give one tracked point per frame (camera px); they are expanded into 21 landmarks
 * with a fixed resting-hand layout so wrist / knuckle / tip all move together (the hand lock reads
 * the wrist). Frame timestamps are re-based onto the Worker's monotonic clock (performance.now()).
 */
import type { HandObservation, LandmarkFrame, LandmarkSource, NormalizedLandmark, ReplayFile } from "./LandmarkSource";

/** Right hand, palm down, seen from above; camera px offsets from the wrist (landmark 0). */
const RIGHT_HAND_OFFSETS: Array<[number, number]> = [
  [0, 0],
  [-25, -15],
  [-45, -35],
  [-58, -55],
  [-68, -70],
  [-20, -70],
  [-22, -95],
  [-23, -112],
  [-24, -126],
  [0, -74],
  [0, -102],
  [0, -120],
  [0, -135],
  [18, -68],
  [20, -94],
  [21, -110],
  [22, -123],
  [34, -58],
  [38, -78],
  [40, -92],
  [42, -104],
];

export function expandCompactPoint(
  x: number,
  y: number,
  landmark: number,
  handedness: "Left" | "Right",
  width: number,
  height: number,
): NormalizedLandmark[] {
  const sx = handedness === "Left" ? -1 : 1;
  const off = RIGHT_HAND_OFFSETS[landmark] ?? [0, 0];
  const wx = x - sx * off[0];
  const wy = y - off[1];
  return RIGHT_HAND_OFFSETS.map(([ox, oy]) => ({ x: (wx + sx * ox) / width, y: (wy + oy) / height, z: 0 }));
}

interface TimedEntry {
  dt: number; // ms from file start
  hands: HandObservation[];
}

function toEntries(file: ReplayFile): { entries: TimedEntry[]; width: number; height: number; loop: boolean; frameMs: number } {
  const frameMs = 1000 / (file.fps || 30);
  if (file.format === "full") {
    const first = file.frames[0]?.t ?? 0;
    return {
      entries: file.frames.map((f) => ({ dt: f.t - first, hands: f.hands })),
      width: file.width,
      height: file.height,
      loop: false,
      frameMs,
    };
  }
  const lm = file.landmark ?? 5;
  const hand = file.handedness ?? "Right";
  const entries: TimedEntry[] = file.points.map((p, i) => {
    if (!p) return { dt: i * frameMs, hands: [] };
    const [t, x, y, score] = p;
    return {
      dt: t,
      hands: [{ landmarks: expandCompactPoint(x, y, lm, hand, file.width, file.height), score, handedness: hand }],
    };
  });
  // null entries carry no timestamp: fill them from neighbours so time stays monotonic.
  for (let i = 1; i < entries.length; i++) {
    if (file.points[i] === null) entries[i].dt = entries[i - 1].dt + frameMs;
    if (entries[i].dt <= entries[i - 1].dt) entries[i].dt = entries[i - 1].dt + 1;
  }
  return { entries, width: file.width, height: file.height, loop: !!file.loop, frameMs };
}

export class ReplaySource implements LandmarkSource {
  readonly kind = "replay" as const;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private stamps: number[] = [];
  private lastT = -Infinity;

  constructor(
    private readonly url: string,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async start(onFrame: (frame: LandmarkFrame) => void): Promise<void> {
    const res = await fetch(this.url);
    if (!res.ok) throw new Error(`Replay file not found: ${this.url} (${res.status})`);
    const file = (await res.json()) as ReplayFile;
    const { entries, width, height, loop, frameMs } = toEntries(file);
    if (entries.length === 0) return;
    const duration = entries[entries.length - 1].dt + frameMs;
    let base = this.now() + 50;
    let i = 0;
    const next = () => {
      if (this.stopped) return;
      if (i >= entries.length) {
        if (!loop) return;
        i = 0;
        base += duration;
      }
      const e = entries[i];
      let t = base + e.dt;
      if (t <= this.lastT) t = this.lastT + 1;
      this.lastT = t;
      const frame: LandmarkFrame = { t, width, height, hands: e.hands };
      this.stamps.push(t);
      while (this.stamps.length && this.stamps[0] < t - 1000) this.stamps.shift();
      onFrame(frame);
      i++;
      if (i < entries.length || loop) {
        const nextEntry = entries[i] ?? entries[0];
        const nextT = i < entries.length ? base + nextEntry.dt : base + duration + entries[0].dt;
        this.timer = setTimeout(next, Math.max(0, nextT - this.now()));
      }
    };
    this.timer = setTimeout(next, Math.max(0, base - this.now()));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  fps(): number {
    return this.stamps.length;
  }
}
