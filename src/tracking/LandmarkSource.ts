/**
 * LandmarkSource: anything that produces hand landmark frames.
 *
 * SHARED CONTRACT (lead). Implementations (owned by B):
 *   - MediaPipeSource.ts  (Worker; HandLandmarker on VideoFrames)
 *   - ReplaySource.ts     (recorded/synthesised landmark JSON; no camera; used by Vitest-free
 *                          Playwright runs via ?source=replay&replay=<name>)
 *   - ColorCapSource.ts   (P3; HSV blob of a bright fingertip sticker)
 *
 * Downstream code is landmark-agnostic: the pipeline picks one landmark index
 * (default 5 = index knuckle) from `hands[0].landmarks`.
 */

/** MediaPipe normalised landmark: x,y in 0..1 of the frame, z relative depth. */
export interface NormalizedLandmark {
  x: number;
  y: number;
  z: number;
}

export interface HandObservation {
  /** 21 landmarks, MediaPipe order (0 = wrist, 5 = index MCP, 8 = index tip, 9 = middle MCP). */
  landmarks: NormalizedLandmark[];
  /** handedness[0][0].score — tasks-vision has no per-landmark confidence. */
  score: number;
  handedness: "Left" | "Right";
}

export interface LandmarkFrame {
  /** Strictly increasing monotonic ms (never resets; sources fix up camera-switch resets). */
  t: number;
  /** Frame size in camera pixels (default 640×480). */
  width: number;
  height: number;
  /** Zero or one hand (numHands: 1); may contain more for hand-lock tests. */
  hands: HandObservation[];
  /** Mean luma 0..255 when known (lighting warning). */
  luma?: number;
}

export type LandmarkSourceKind = "mediapipe" | "replay" | "colorcap";

export interface LandmarkSource {
  readonly kind: LandmarkSourceKind;
  /** Start producing frames. Resolves once the first frame can be expected. */
  start(onFrame: (frame: LandmarkFrame) => void): Promise<void>;
  stop(): void;
  /** Detection fps over the last second, if known. */
  fps?(): number;
}

/** Landmark indices offered on the Setup page (§0 rule 1). */
export const LANDMARK_CHOICES = {
  knuckle: 5, // default: index MCP, moves only with wrist/forearm
  precise: 8, // index fingertip
  middle_knuckle: 9, // loose fist / thumb brace
  wrist: 0, // splint
} as const;
export const DEFAULT_LANDMARK = 5;
export const WRIST = 0;

// ---------------------------------------------------------------------------
// Replay file format (tests/fixtures/replay/*.json, mirrored to public/replay/*.json)
// ---------------------------------------------------------------------------

/**
 * Full form: explicit frames. Compact form: one tracked point per frame; ReplaySource
 * expands it into 21 landmarks (all landmarks placed relative to the given point with a
 * fixed resting-hand offset, so wrist/knuckle/tip all move together).
 *
 * Coordinates in the compact form are CAMERA PIXELS (0..width, 0..height) for readability.
 * score < 0.6 frames model tracking loss; `null` entries model no detection at all.
 */
export interface ReplayFileFull {
  format: "full";
  name: string;
  fps: number;
  width: number;
  height: number;
  frames: LandmarkFrame[];
}

export interface ReplayFileCompact {
  format: "compact";
  name: string;
  fps: number;
  width: number;
  height: number;
  /** Which landmark the points describe (default 5). */
  landmark?: number;
  handedness?: "Left" | "Right";
  /** [t_ms, x_px, y_px, score] or null for "no hand". */
  points: Array<[number, number, number, number] | null>;
  /** Loop when finished (default false). */
  loop?: boolean;
}

export type ReplayFile = ReplayFileFull | ReplayFileCompact;
