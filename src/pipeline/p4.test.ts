import { describe, expect, it } from "vitest";
import { keyterms, parseCommand } from "./grammar";
import { modeState } from "./pipeline";
import { Driver, TEST_CAL } from "./pipelineDriver";
import {
  BROW_HOLD_MS,
  EyebrowLift,
  eyebrowLift,
  HARD_TO_HOLD_STILL_TIP,
  handPresetSettings,
  headModeConfig,
  NOSE_TIP,
} from "./presets";
import {
  defaultProfileStore,
  findProfile,
  parseProfiles,
  saveProfile,
  serializeProfiles,
  SHAKY_DAY,
  STEADY_DAY,
  useProfile,
} from "./profiles";
import { handScale, rebaselineScale, rescaleBox, REBASELINE_MS } from "./rebaseline";
import { frame } from "./testSignals";
import { DEFAULT_SETTINGS, type ParseOptions } from "./types";
import type { HandObservation } from "../tracking/LandmarkSource";

const V: ParseOptions = { mode: "voice", phase: "P4" };
const T: ParseOptions = { mode: "typed", phase: "P4" };
const C = { x: 500, y: 400 };

describe("P4 grammar", () => {
  it("@P4 'click five' / 'click 12' → click_number with the number", () => {
    expect(parseCommand("click five", V)).toEqual({ kind: "match", commands: [{ action: "click_number", arg: 5 }], fuzzy: false });
    expect(parseCommand("click 12", T)).toMatchObject({ commands: [{ action: "click_number", arg: 12 }] });
    expect(parseCommand("click twenty three", V)).toMatchObject({ commands: [{ action: "click_number", arg: 23 }] });
    expect(parseCommand("show numbers", V)).toMatchObject({ commands: [{ action: "show_numbers" }] });
  });

  it("@P4 profile names may be several words (the rest of the utterance)", () => {
    expect(parseCommand("use profile shaky day", V)).toEqual({
      kind: "match",
      commands: [{ action: "use_profile", variant: "shaky day" }],
      fuzzy: false,
    });
    expect(parseCommand("Save profile, morning light!", V)).toMatchObject({ commands: [{ action: "save_profile", variant: "morning light" }] });
    expect(parseCommand("profile steady day", T)).toMatchObject({ commands: [{ action: "use_profile", variant: "steady day" }] });
    expect(parseCommand("use profile", V)).toMatchObject({ commands: [{ action: "use_profile", arg: null }] });
    // "save profile" beats "save" (longest first).
    expect(parseCommand("save profile x", V)).toMatchObject({ commands: [{ action: "save_profile" }] });
  });

  it("@P4 app profile variants by voice and typed", () => {
    expect(parseCommand("photoshop mode", V)).toMatchObject({ commands: [{ action: "app_profile", variant: "photoshop" }] });
    expect(parseCommand("krita mode", V)).toMatchObject({ commands: [{ action: "app_profile", variant: "krita" }] });
    expect(parseCommand("app photoshop", T)).toMatchObject({ commands: [{ action: "app_profile", variant: "photoshop" }] });
    expect(parseCommand("app krita", T)).toMatchObject({ commands: [{ action: "app_profile", variant: "krita" }] });
  });

  it("@P4 presets, head mode and eyebrow lift phrases; excluded before P4", () => {
    expect(parseCommand("hard to hold still", V)).toMatchObject({ commands: [{ action: "preset_hard_still" }] });
    expect(parseCommand("sore joints", V)).toMatchObject({ commands: [{ action: "preset_sore_joints" }] });
    expect(parseCommand("head mode", V)).toMatchObject({ commands: [{ action: "head_mode" }] });
    expect(parseCommand("click five", { mode: "voice", phase: "P3" }).kind).toBe("nomatch");
  });

  it("@P4 keyterms still ≤ 100 entries and ≤ 1200 characters with the P4 rows", () => {
    const k = keyterms("P4");
    expect(k.length).toBeLessThanOrEqual(100);
    expect(k.join("").length).toBeLessThanOrEqual(1200);
    expect(k).toContain("click");
    expect(k).toContain("use profile");
  });
});

describe("hand presets (§2)", () => {
  it("@P4 exact values for the four presets", () => {
    expect(handPresetSettings("preset_sore_joints")).toMatchObject({ steadiness: 25, gainOverride: 3, latch: false });
    expect(handPresetSettings("preset_shakes_reaching")).toMatchObject({ steadiness: 70, gainOverride: null, latch: false });
    expect(handPresetSettings("preset_slow_rest")).toMatchObject({ steadiness: 45, gainOverride: 4, dwellDownMs: 1200, latch: true });
    expect(handPresetSettings("preset_hard_still")).toMatchObject({
      steadiness: 60,
      latch: true,
      dwellRadius: 60,
      tileHoverPx: 40,
      tip: HARD_TO_HOLD_STILL_TIP,
    });
    expect(HARD_TO_HOLD_STILL_TIP).toBe("Fastest way to lift the pen: a pedal, the pen key, or say *up*");
    expect(() => handPresetSettings("nope")).toThrow();
  });

  it("@P4 the pipeline applies a preset action; 'Hard to hold still' widens the dwell radius to 60", () => {
    // ±30 units of wobble: outside the default r_in (15) but inside 60.
    const wobble = (d: Driver) => d.path(4000, (e) => ({ x: C.x + 30 * Math.sin((2 * Math.PI * e) / 900), y: C.y }));
    const control = new Driver({ phase: "P4" });
    wobble(control);
    expect(control.count("down")).toBe(0);
    const d = new Driver({ phase: "P4" });
    d.action("preset_hard_still");
    expect(d.pl.snapshot()).toMatchObject({ steadiness: 60, latch: true });
    wobble(d);
    expect(d.count("down")).toBe(1);
    d.action("preset_sore_joints");
    expect(d.pl.snapshot().gain).toBe(3);
    expect(d.pl.snapshot().latch).toBe(false);
  });
});

describe("profiles", () => {
  it("@P4 'Steady day' (defaults) and 'Shaky day' (70, Latch on) exist from the start", () => {
    const s = defaultProfileStore();
    expect(s.profiles.map((p) => p.name)).toEqual([STEADY_DAY, SHAKY_DAY]);
    expect(s.active).toBe(STEADY_DAY);
    expect(s.profiles[0].settings.steadiness).toBe(DEFAULT_SETTINGS.steadiness);
    expect(s.profiles[0].settings.latch).toBe(false);
    expect(s.profiles[1].settings).toMatchObject({ steadiness: 70, latch: true });
    expect("cameraDeviceId" in s.profiles[0].settings).toBe(false);
  });

  it("@P4 save stores the user's own values; use finds by name or unique prefix", () => {
    let s = defaultProfileStore();
    s = saveProfile(s, "morning light", { ...DEFAULT_SETTINGS, steadiness: 35, gainOverride: 3.5, simulateTremor: true });
    expect(s.active).toBe("Morning light");
    expect(findProfile(s, "Morning Light")!.settings).toMatchObject({ steadiness: 35, gainOverride: 3.5 });
    expect("simulateTremor" in findProfile(s, "morning light")!.settings).toBe(false);
    expect(findProfile(s, "shaky")!.name).toBe(SHAKY_DAY);
    expect(findProfile(s, "day")).toBeNull(); // ambiguous
    expect(findProfile(s, "evening")).toBeNull();
    const u = useProfile(s, "shaky")!;
    expect(u.store.active).toBe(SHAKY_DAY);
    // Overwrite keeps one entry.
    s = saveProfile(s, "MORNING LIGHT", { steadiness: 40 });
    expect(s.profiles.filter((p) => p.name.toLowerCase() === "morning light")).toHaveLength(1);
    expect(findProfile(s, "morning light")!.settings.steadiness).toBe(40);
  });

  it("@P4 serialise/parse round-trips and validates", () => {
    const s = saveProfile(defaultProfileStore(), "flare", { steadiness: 80, latch: true, dwellRadius: 60 });
    expect(parseProfiles(serializeProfiles(s))).toEqual(s);
    expect(parseProfiles("not json")).toEqual(defaultProfileStore());
    expect(parseProfiles(null)).toEqual(defaultProfileStore());
    const bad = parseProfiles(
      JSON.stringify({
        active: "ghost",
        profiles: [{ name: "x", settings: { steadiness: 400, latch: "yes", dwellDownMs: 900 } }, { settings: {} }, 5],
      }),
    );
    expect(bad.active).toBe(STEADY_DAY);
    expect(bad.profiles.map((p) => p.name)).toEqual([STEADY_DAY, SHAKY_DAY, "x"]);
    expect(bad.profiles[2].settings).toEqual({ dwellDownMs: 900 });
  });
});

/** A hand whose landmarks span `spread` camera px around centre c (camera px). */
function scaledHand(c: { x: number; y: number }, spread: number, extraLandmarks?: (i: number) => { x: number; y: number }): HandObservation {
  const lms = Array.from({ length: 21 }, (_, i) => {
    if (extraLandmarks) {
      const p = extraLandmarks(i);
      return { x: p.x / 640, y: p.y / 480, z: 0 };
    }
    const a = (i / 21) * 2 * Math.PI;
    const p = i === 5 ? c : i === 0 ? { x: c.x, y: c.y + spread / 2 } : { x: c.x + (spread / 2) * Math.cos(a), y: c.y + (spread / 2) * Math.sin(a) };
    return { x: p.x / 640, y: p.y / 480, z: 0 };
  });
  return { landmarks: lms, score: 0.9, handedness: "Right" };
}

describe("re-baseline", () => {
  it("@P4 hand scale = landmark bounding-box diagonal; rescale about the centre; dead band and clamp", () => {
    const h = scaledHand({ x: 320, y: 240 }, 100);
    expect(handScale(h.landmarks, 640, 480)).toBeGreaterThan(130);
    expect(rescaleBox({ x: 100, y: 100, w: 200, h: 100 }, 1.5)).toEqual({ x: 50, y: 75, w: 300, h: 150 });
    expect(rebaselineScale(100, 103)).toBe(1); // within 5 %
    expect(rebaselineScale(100, 150)).toBeCloseTo(1.5);
    expect(rebaselineScale(100, 400)).toBe(2);
  });

  it("@P4 every 10 min the box is rescaled from the hand scale, never during a stroke", () => {
    const d = new Driver({ phase: "P4", fps: 5 });
    const step = (spread: number) => {
      const out = d.pl.step(frame(d.t, [scaledHand(d.cam(C), spread)]));
      d.outs.push(out);
      for (const e of out.events) d.events.push({ ...e, t: out.t });
      d.t += 200;
      return out;
    };
    for (let i = 0; i < 20; i++) step(80); // reference
    expect(modeState(d.pl)!.boxScale).toBe(1);
    // Hand looks 1.5× bigger for 9 minutes: not yet.
    while (d.t < 9 * 60 * 1000) step(120);
    expect(modeState(d.pl)!.boxScale).toBe(1);
    // Pen down just before the 10-minute mark: deferred.
    d.pl.setSettings({ dwellDownMs: 500 });
    d.action("pen_toggle");
    expect(d.pl.snapshot().pen).toBe("DRAWING");
    while (d.t < REBASELINE_MS + 20000) step(120);
    expect(modeState(d.pl)!.boxScale).toBe(1);
    d.action("pen_toggle");
    step(120);
    expect(modeState(d.pl)!.boxScale).toBeCloseTo(1.5, 1);
    expect(d.pl.snapshot().gain).toBeCloseTo(TEST_CAL.gain / modeState(d.pl)!.boxScale, 6);
  });

  it("@P4 'rebaseline' action makes it due at once (still not mid-stroke)", () => {
    // Dwell off: a still hand would otherwise lower the pen, which (correctly) defers re-baseline.
    const d = new Driver({ phase: "P4", settings: { inputs: { camera: true, voice: true, dwell: false, keys: true } } });
    const step = (spread: number) => {
      d.pl.step(frame(d.t, [scaledHand(d.cam(C), spread)]));
      d.t += 1000 / 30;
    };
    for (let i = 0; i < 90; i++) step(100);
    d.action("rebaseline");
    for (let i = 0; i < 90; i++) step(70);
    expect(modeState(d.pl)!.boxScale).toBeCloseTo(0.7, 1);
  });
});

describe("Head mode", () => {
  it("@P4 headModeConfig: nose tip landmark 1, gain 6×, lock on the nose", () => {
    expect(headModeConfig()).toEqual({ landmark: NOSE_TIP, lockLandmark: NOSE_TIP, gainOverride: 6 });
    expect(NOSE_TIP).toBe(1);
  });

  it("@P4 a face-landmark frame drives the pointer; the lock follows the nose, not landmark 0", () => {
    const d = new Driver({ phase: "P4" });
    d.action("head_mode");
    expect(modeState(d.pl)!.headMode).toBe(true);
    expect(d.pl.snapshot().gain).toBe(6);
    let k = 0;
    const face = (nose: { x: number; y: number }) =>
      scaledHand(nose, 0, (i) => (i === 1 ? nose : i === 0 ? { x: (k++ * 97) % 640, y: (k * 53) % 480 } : { x: nose.x + i, y: nose.y + 20 }));
    const outs = [];
    for (let i = 0; i < 60; i++) {
      const nose = { x: 320 + i * 0.5, y: 240 };
      outs.push(d.pl.step(frame(d.t, [face(nose)])));
      d.t += 1000 / 30;
    }
    expect(outs.every((o) => o.tracking !== "Lost")).toBe(true);
    const last = outs[outs.length - 1];
    expect(last.pointer).not.toBeNull();
    // Nose moved right of the box centre: the pointer is right of the canvas centre (gain 6).
    expect(last.pre!.x).toBeGreaterThan(C.x + 6 * 20);
    d.action("head_mode");
    expect(modeState(d.pl)!.headMode).toBe(false);
  });
});

describe("eyebrow pen-up", () => {
  it("@P4 fires once per raise after 150 ms above 0.5; re-arms below 0.3 (hysteresis)", () => {
    const e = new EyebrowLift();
    let fires = 0;
    let t = 0;
    const feed = (v: number, ms: number) => {
      for (const end = t + ms; t < end; t += 33) if (e.update(v, t)) fires++;
    };
    feed(0.1, 300);
    feed(0.7, 100); // too short
    feed(0.1, 100);
    expect(fires).toBe(0);
    feed(0.7, 1000); // one long raise
    expect(fires).toBe(1);
    feed(0.4, 300); // between thresholds: no re-arm
    feed(0.7, 500);
    expect(fires).toBe(1);
    feed(0.2, 100); // re-armed
    feed(0.8, BROW_HOLD_MS + 50);
    expect(fires).toBe(2);
    const f = eyebrowLift();
    expect([f(0.9, 0), f(0.9, 100), f(0.9, 160), f(0.9, 300)]).toEqual([false, false, true, false]);
  });

  it("@P4 the eyebrow action only lifts, never lowers", () => {
    const d = new Driver({ phase: "P4" });
    d.hold(C, 600);
    expect(d.action("eyebrow_raise")).toEqual([]);
    expect(d.pl.snapshot().pen).toBe("HOVER");
    d.action("pen_toggle");
    d.hold(C, 200);
    const ev = d.action("eyebrow_raise");
    expect(ev.map((x) => x.type)).toEqual(["up"]);
    expect(d.pl.snapshot().pen).toBe("HOVER");
  });
});
