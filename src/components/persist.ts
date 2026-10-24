/**
 * localStorage persistence for settings, calibration (per hand) and per-camera toggles. Owned by B.
 * Keys come from STORAGE_KEYS; the few B-only keys are listed here and in DECISIONS.md.
 */
import { DEFAULT_SETTINGS, STORAGE_KEYS, type Calibration, type Rect, type SteadySettings } from "../pipeline/types";

export const B_KEYS = {
  cameraPrefs: "steady.cameraPrefs.v1", // Record<deviceId, {mirror, rotate}>
  kritaCanvas: "steady.kritaCanvas.v1", // Rect (corner marking)
  privacySeen: "steady.privacySeen.v1",
  skinHex: STORAGE_KEYS.skin,
} as const;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode */
  }
}

export function loadSettings(): SteadySettings {
  const s = read<Partial<SteadySettings>>(STORAGE_KEYS.settings) ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    inputs: { ...DEFAULT_SETTINGS.inputs, ...(s.inputs ?? {}) },
    keymap: { ...(s.keymap ?? {}) },
    // Session-only toggles never persist across launches.
    simulateTremor: false,
  };
}

export function saveSettings(s: SteadySettings) {
  write(STORAGE_KEYS.settings, { ...s, simulateTremor: false });
}

export type CalibrationStore = Partial<Record<"Left" | "Right", Calibration>>;

export function loadCalibrations(): CalibrationStore {
  return read<CalibrationStore>(STORAGE_KEYS.calibration) ?? {};
}

export function lastCalibration(): Calibration | null {
  const all = loadCalibrations();
  const list = Object.values(all).filter(Boolean) as Calibration[];
  list.sort((a, b) => b.createdAt - a.createdAt);
  return list[0] ?? null;
}

export function saveCalibration(c: Calibration) {
  const all = loadCalibrations();
  all[c.handedness] = c;
  write(STORAGE_KEYS.calibration, all);
}

export type CameraPrefs = Record<string, { mirror: boolean; rotate: boolean }>;

export function loadCameraPrefs(): CameraPrefs {
  return read<CameraPrefs>(B_KEYS.cameraPrefs) ?? {};
}

export function saveCameraPref(deviceId: string, pref: { mirror: boolean; rotate: boolean }) {
  const all = loadCameraPrefs();
  all[deviceId] = pref;
  write(B_KEYS.cameraPrefs, all);
}

export function loadLastCamera(): string | null {
  return read<string>(STORAGE_KEYS.lastCamera);
}

export function saveLastCamera(id: string) {
  write(STORAGE_KEYS.lastCamera, id);
}

export function loadKritaCanvas(): Rect | null {
  return read<Rect>(B_KEYS.kritaCanvas);
}

export function saveKritaCanvas(r: Rect) {
  write(B_KEYS.kritaCanvas, r);
}

export function privacySeen(): boolean {
  return read<boolean>(B_KEYS.privacySeen) === true;
}

export function markPrivacySeen() {
  write(B_KEYS.privacySeen, true);
}

export function loadSkin(): string | null {
  return read<string>(STORAGE_KEYS.skin);
}
