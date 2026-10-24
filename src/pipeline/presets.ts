/**
 * P4: hand presets (§2, exact names and values), Head mode config and the eyebrow pen-up
 * detector. Pure.
 *
 * SteadySettings keys used here:
 *   dwellRadius   r_in floor for dwell (target units)          — Hard to hold still: 60
 *   tileHoverPx   tiles count as hovered within this many px  — page-side (B); pipeline ignores
 *   lockLandmark  landmark index used by the hand lock (0 = wrist; Head mode: 1 = nose tip)
 *   dashPauseMs   Dash pause (P3)
 */
import { DEFAULT_SETTINGS, DWELL_DOWN_DEFAULT_MS, DWELL_UP_FACTOR, type SteadySettings } from "./types";

/** P4 keys (now part of SteadySettings). */
export type ExtraSettings = Pick<SteadySettings, "dwellRadius" | "tileHoverPx" | "lockLandmark"> & { dashPauseMs?: number };

export type PresetSettings = Partial<SteadySettings> & ExtraSettings & { tip?: string };

export type HandPresetId = "preset_sore_joints" | "preset_shakes_reaching" | "preset_slow_rest" | "preset_hard_still";

export const HARD_TO_HOLD_STILL_TIP = "Fastest way to lift the pen: a pedal, the pen key, or say *up*";

/**
 * Every preset sets the full hand-related set (Steadiness, gain, dwell times, Latch, dwell
 * radius, tile hover), so switching presets is deterministic; unspecified values return to
 * the defaults (gain null = calibrated gain).
 */
const BASE: PresetSettings = {
  gainOverride: null,
  dwellDownMs: DWELL_DOWN_DEFAULT_MS,
  dwellUpMs: DWELL_DOWN_DEFAULT_MS * DWELL_UP_FACTOR,
  latch: false,
  dwellRadius: null,
  tileHoverPx: null,
};

export const HAND_PRESETS: Record<HandPresetId, PresetSettings> = {
  // "Sore joints, steady hand"
  preset_sore_joints: { ...BASE, steadiness: 25, gainOverride: 3 },
  // "Shakes when holding still or reaching"
  preset_shakes_reaching: { ...BASE, steadiness: 70 },
  // "Slow movements, shakes at rest"
  preset_slow_rest: { ...BASE, steadiness: 45, gainOverride: 4, dwellDownMs: 1200, dwellUpMs: 1200 * DWELL_UP_FACTOR, latch: true },
  // "Hard to hold still" (shows the tip once)
  preset_hard_still: { ...BASE, steadiness: 60, latch: true, dwellRadius: 60, tileHoverPx: 40, tip: HARD_TO_HOLD_STILL_TIP },
};

export function isHandPreset(id: string): id is HandPresetId {
  return id in HAND_PRESETS;
}

/** Settings for a hand preset (copy). `tip` is shown once by the page (B). */
export function handPresetSettings(id: HandPresetId | string): PresetSettings {
  const p = (HAND_PRESETS as Record<string, PresetSettings>)[id];
  if (!p) throw new Error(`unknown hand preset ${id}`);
  return { ...p };
}

// ---------------------------------------------------------------------------
// Head mode (P4)
// ---------------------------------------------------------------------------

/** FaceLandmarker nose-tip landmark index. */
export const NOSE_TIP = 1;
export const HEAD_GAIN = 6;

/**
 * Head mode: the pointer follows the nose tip (gain 6×) through the same pipeline.
 * B's face source emits LandmarkFrames whose `hands[0].landmarks` are the face landmarks
 * (score = face presence/confidence, or 1 when the model reports none; handedness "Right"),
 * then calls `pipeline.setSettings(headModeConfig())`; the hand lock then follows the nose
 * (`lockLandmark: 1`) instead of the wrist. Leaving Head mode: `setSettings(handModeConfig())`.
 */
export function headModeConfig(): PresetSettings {
  return { landmark: NOSE_TIP, lockLandmark: NOSE_TIP, gainOverride: HEAD_GAIN };
}

export function handModeConfig(landmark = DEFAULT_SETTINGS.landmark): PresetSettings {
  return { landmark, lockLandmark: 0, gainOverride: null };
}

// ---------------------------------------------------------------------------
// Eyebrow pen-up (P4)
// ---------------------------------------------------------------------------

export const BROW_ON = 0.5;
export const BROW_OFF = 0.3;
export const BROW_HOLD_MS = 150;

/**
 * Eyebrow raise → pen-up, from FaceLandmarker's `browInnerUp` blendshape (0..1). Hysteresis:
 * a raise counts once `browInnerUp > 0.5` has held for 150 ms; it re-arms only after the value
 * drops below 0.3. `update()` returns true exactly once per raise; the caller then runs the
 * pipeline action "eyebrow_raise", which can only LIFT (reason "eyebrow") (never lowers: pen-state law).
 */
export class EyebrowLift {
  private aboveSince: number | null = null;
  private fired = false;

  constructor(
    private on = BROW_ON,
    private off = BROW_OFF,
    private holdMs = BROW_HOLD_MS,
  ) {}

  reset(): void {
    this.aboveSince = null;
    this.fired = false;
  }

  update(browInnerUp: number, t: number): boolean {
    if (!Number.isFinite(browInnerUp)) return false;
    if (browInnerUp < this.off) {
      this.aboveSince = null;
      this.fired = false;
      return false;
    }
    if (browInnerUp > this.on) {
      if (this.aboveSince === null) this.aboveSince = t;
      if (!this.fired && t - this.aboveSince >= this.holdMs) {
        this.fired = true;
        return true;
      }
      return false;
    }
    // Between off and on: keep the state (hysteresis), but a raise in progress must be continuous.
    if (!this.fired) this.aboveSince = null;
    return false;
  }
}

/** Functional form: `const lift = eyebrowLift(); lift(v, t) → true once per raise`. */
export function eyebrowLift(opts: { on?: number; off?: number; holdMs?: number } = {}): (browInnerUp: number, t: number) => boolean {
  const d = new EyebrowLift(opts.on, opts.off, opts.holdMs);
  return (v, t) => d.update(v, t);
}
