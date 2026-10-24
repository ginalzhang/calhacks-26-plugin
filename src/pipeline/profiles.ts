/**
 * Profiles (P4): user-named sets of the user's own values. "Steady day" (the defaults) and
 * "Shaky day" (Steadiness 70, Latch on) exist from the start. Pure; B persists the serialised
 * string in localStorage under PROFILES_STORAGE_KEY.
 *
 * Stored per profile: the tunable values below (not the camera device, mirror/rotate, which
 * belong to the camera, nor Simulate tremor, which is a demo control).
 */
import type { Calibration, SteadySettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import type { ExtraSettings } from "./presets";

export const PROFILES_STORAGE_KEY = "steady.profiles.v1";

export type ProfileSettings = Partial<
  Pick<
    SteadySettings,
    | "steadiness"
    | "gainOverride"
    | "landmark"
    | "dwellDownMs"
    | "dwellUpMs"
    | "dwellClickEnabled"
    | "latch"
    | "hatchLagMs"
    | "micSilenceMs"
    | "micCapMs"
    | "quiet"
    | "tts"
    | "earcons"
    | "inputs"
    | "keymap"
  >
> &
  ExtraSettings;

export interface Profile {
  name: string;
  settings: ProfileSettings;
  /** Per-hand calibration, if the user saved one with the profile. */
  calibration?: Partial<Record<"Left" | "Right", Calibration>> | null;
}

export interface ProfileStore {
  version: 1;
  active: string;
  profiles: Profile[];
}

type Check = (v: unknown) => boolean;
const num = (lo: number, hi: number): Check => (v) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const bool: Check = (v) => typeof v === "boolean";
const orNull = (c: Check): Check => (v) => v === null || c(v);

/** Field validators (slider ranges from the brief). Invalid fields are dropped, not the profile. */
export const PROFILE_FIELDS: Record<keyof ProfileSettings, Check> = {
  steadiness: num(0, 100),
  gainOverride: orNull(num(2, 10)),
  landmark: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 477,
  dwellDownMs: num(500, 1500),
  dwellUpMs: num(800, 3000),
  dwellClickEnabled: bool,
  latch: bool,
  hatchLagMs: num(80, 250),
  micSilenceMs: num(1000, 8000),
  micCapMs: num(15000, 60000),
  quiet: bool,
  tts: bool,
  earcons: bool,
  inputs: (v) =>
    !!v && typeof v === "object" && ["camera", "voice", "dwell", "keys"].every((k) => typeof (v as Record<string, unknown>)[k] === "boolean"),
  keymap: (v) => !!v && typeof v === "object" && Object.values(v as object).every((x) => typeof x === "string"),
  dwellRadius: orNull(num(0, 200)),
  tileHoverPx: orNull(num(0, 200)),
  lockLandmark: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 477,
  dashPauseMs: num(100, 600),
};

/** Keep only the profile fields of a settings object, validated. */
export function pickProfileSettings(s: Record<string, unknown>): ProfileSettings {
  const out: Record<string, unknown> = {};
  for (const [k, check] of Object.entries(PROFILE_FIELDS)) {
    if (k in s && check(s[k])) out[k] = structuredCloneSafe(s[k]);
  }
  return out as ProfileSettings;
}

function structuredCloneSafe<T>(v: T): T {
  return v && typeof v === "object" ? (JSON.parse(JSON.stringify(v)) as T) : v;
}

export const STEADY_DAY = "Steady day";
export const SHAKY_DAY = "Shaky day";

export function builtInProfiles(): Profile[] {
  const defaults = pickProfileSettings(DEFAULT_SETTINGS as unknown as Record<string, unknown>);
  return [
    { name: STEADY_DAY, settings: defaults },
    { name: SHAKY_DAY, settings: { ...defaults, steadiness: 70, latch: true } },
  ];
}

export function defaultProfileStore(): ProfileStore {
  return { version: 1, active: STEADY_DAY, profiles: builtInProfiles() };
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Find a profile by spoken/typed name: exact (case-insensitive), then a unique profile whose
 * name starts with the query ("shaky" → "Shaky day"), then a unique one containing it. Ambiguous
 * or unknown → null.
 */
export function findProfile(store: ProfileStore, query: string): Profile | null {
  const q = norm(query);
  if (!q) return null;
  const exact = store.profiles.find((p) => norm(p.name) === q);
  if (exact) return exact;
  const starts = store.profiles.filter((p) => norm(p.name).startsWith(q));
  if (starts.length === 1) return starts[0];
  const contains = store.profiles.filter((p) => norm(p.name).includes(q));
  return contains.length === 1 ? contains[0] : null;
}

/** Save (or overwrite, matching case-insensitively) a profile with the user's current values; makes it active. */
export function saveProfile(
  store: ProfileStore,
  name: string,
  settings: Record<string, unknown>,
  calibration?: Profile["calibration"],
): ProfileStore {
  const clean = name.trim().replace(/\s+/g, " ");
  if (!clean) return store;
  const display = clean.charAt(0).toUpperCase() + clean.slice(1);
  const entry: Profile = { name: display, settings: pickProfileSettings(settings), ...(calibration ? { calibration } : {}) };
  const i = store.profiles.findIndex((p) => norm(p.name) === norm(clean));
  const profiles = [...store.profiles];
  if (i >= 0) profiles[i] = { ...entry, name: store.profiles[i].name };
  else profiles.push(entry);
  return { ...store, profiles, active: i >= 0 ? store.profiles[i].name : display };
}

/** Switch to a profile by name; returns the new store and the settings to apply, or null if not found. */
export function useProfile(store: ProfileStore, query: string): { store: ProfileStore; profile: Profile } | null {
  const p = findProfile(store, query);
  if (!p) return null;
  return { store: { ...store, active: p.name }, profile: p };
}

export function serializeProfiles(store: ProfileStore): string {
  return JSON.stringify(store);
}

/**
 * Parse a stored string. Anything malformed falls back field by field: invalid settings fields
 * are dropped, nameless profiles are skipped, the built-ins are re-added if missing, and an
 * unknown `active` falls back to "Steady day". Never throws.
 */
export function parseProfiles(json: string | null | undefined): ProfileStore {
  let raw: unknown;
  try {
    raw = json ? JSON.parse(json) : null;
  } catch {
    raw = null;
  }
  const store = defaultProfileStore();
  if (!raw || typeof raw !== "object") return store;
  const r = raw as { active?: unknown; profiles?: unknown };
  const profiles: Profile[] = [];
  if (Array.isArray(r.profiles)) {
    for (const p of r.profiles) {
      if (!p || typeof p !== "object") continue;
      const name = (p as { name?: unknown }).name;
      if (typeof name !== "string" || !name.trim()) continue;
      if (profiles.some((q) => norm(q.name) === norm(name))) continue;
      const settings = (p as { settings?: unknown }).settings;
      const cal = (p as { calibration?: unknown }).calibration;
      profiles.push({
        name: name.trim(),
        settings: settings && typeof settings === "object" ? pickProfileSettings(settings as Record<string, unknown>) : {},
        ...(cal && typeof cal === "object" ? { calibration: cal as Profile["calibration"] } : {}),
      });
    }
  }
  const missing = builtInProfiles().filter((b) => !profiles.some((q) => norm(q.name) === norm(b.name)));
  profiles.unshift(...missing);
  const active = typeof r.active === "string" && profiles.some((p) => p.name === r.active) ? r.active : STEADY_DAY;
  return { version: 1, active, profiles };
}
