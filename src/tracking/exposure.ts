/**
 * Exposure lock (P3, §1): after calibration, `applyConstraints({ advanced: [{ exposureMode: "manual" }] })`
 * so auto-exposure stops pumping brightness (and the hand / sticker detector's input) when the arm
 * moves through the frame. Owned by G; called by B on the MAIN thread with the camera's video track.
 *
 *   const msg = await lockExposure(stream.getVideoTracks()[0]);   // after calibration completes
 *   setStatus(msg);                                               // "Exposure locked" | "This camera can't lock exposure"
 *   await unlockExposure(track);                                  // on recalibrate / camera switch
 *
 * Both check `track.getCapabilities?.().exposureMode` first, never throw, and return a status string.
 */

export const EXPOSURE_LOCKED = "Exposure locked";
export const EXPOSURE_CANT_LOCK = "This camera can't lock exposure";
export const EXPOSURE_AUTO = "Exposure automatic";
export const EXPOSURE_CANT_UNLOCK = "This camera can't change exposure";

export type LockResult = typeof EXPOSURE_LOCKED | typeof EXPOSURE_CANT_LOCK;
export type UnlockResult = typeof EXPOSURE_AUTO | typeof EXPOSURE_CANT_UNLOCK;

/** The subset of MediaStreamTrack used here (so tests can pass a fake). */
export interface ExposureTrack {
  getCapabilities?: () => unknown;
  getSettings?: () => unknown;
  applyConstraints: (c: MediaTrackConstraints) => Promise<void>;
}

/** exposureMode values the camera reports (`[]` when unknown / unsupported). */
export function exposureModes(track: ExposureTrack | null | undefined): string[] {
  try {
    const caps = track?.getCapabilities?.() as { exposureMode?: unknown } | undefined;
    const modes = caps?.exposureMode;
    if (Array.isArray(modes)) return modes.filter((m): m is string => typeof m === "string");
    if (typeof modes === "string") return [modes];
  } catch {
    /* getCapabilities can throw on an ended track */
  }
  return [];
}

async function setMode(track: ExposureTrack, mode: "manual" | "continuous"): Promise<boolean> {
  try {
    // exposureMode is an Image Capture constraint, not in TS's DOM lib.
    await track.applyConstraints({ advanced: [{ exposureMode: mode } as MediaTrackConstraintSet] });
  } catch {
    return false;
  }
  // `advanced` sets are best-effort: a camera may resolve without applying. Trust getSettings when it answers.
  try {
    const s = track.getSettings?.() as { exposureMode?: unknown } | undefined;
    if (s && typeof s.exposureMode === "string" && s.exposureMode !== mode) return false;
  } catch {
    /* ignore */
  }
  return true;
}

export async function lockExposure(track: ExposureTrack | null | undefined): Promise<LockResult> {
  if (!track || !exposureModes(track).includes("manual")) return EXPOSURE_CANT_LOCK;
  return (await setMode(track, "manual")) ? EXPOSURE_LOCKED : EXPOSURE_CANT_LOCK;
}

export async function unlockExposure(track: ExposureTrack | null | undefined): Promise<UnlockResult> {
  if (!track || !exposureModes(track).includes("continuous")) return EXPOSURE_CANT_UNLOCK;
  return (await setMode(track, "continuous")) ? EXPOSURE_AUTO : EXPOSURE_CANT_UNLOCK;
}
