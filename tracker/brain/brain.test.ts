/**
 * Steady brain (agent B) — @PLUGIN tests. The core is driven as a function (createBrain) with
 * synthetic landmark frames; one test spawns the built bundle.
 */
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import { TEST_CAL } from "../../src/pipeline/pipelineDriver";
import { frame, hand } from "../../src/pipeline/testSignals";
import { DEFAULT_SETTINGS, type Calibration, type SteadySettings, type Vec2 } from "../../src/pipeline/types";
import { createBrain } from "./core";
import type { FromBrain, PanelState } from "./protocol";

const CANVAS = { x: 100, y: 100, w: 1000, h: 800 }; // centre (600, 500)
const KRITA = { x: 0, y: 30, w: 1440, h: 860 };
const SCREEN = { x: 0, y: 0, w: 1440, h: 900 };
const USABLE = { x: 0, y: 25, w: 1440, h: 800 };
const PANEL = { x: 1150, y: 100, w: 280, h: 700 };
const C = { x: 600, y: 500 };

type Wire = Extract<FromBrain, { t: "pen" }>["events"][number];

class Rig {
  sent: FromBrain[] = [];
  brain = createBrain((m) => this.sent.push(m));
  t = 1000;
  private lastTick = 1000;

  constructor(o: { settings?: Partial<SteadySettings> & Record<string, unknown>; calibration?: Calibration | null } = {}) {
    this.brain.handle({ t: "rects", rects: { canvas: CANVAS, krita: KRITA, screen: SCREEN, usable: USABLE, panel: PANEL } });
    this.brain.handle({
      t: "init",
      settings: { ...DEFAULT_SETTINGS, ...o.settings },
      calibration: o.calibration === undefined ? TEST_CAL : o.calibration,
      now: this.t,
    });
  }

  /** Target point (screen points) → camera px through TEST_CAL (gain 4, box centre 320,240 ↔ canvas centre). */
  cam(p: Vec2): Vec2 {
    return { x: 320 + (p.x - C.x) / TEST_CAL.gain, y: 240 + (p.y - C.y) / TEST_CAL.gain };
  }

  private advance() {
    this.t += 1000 / 30;
    while (this.t - this.lastTick >= 50) {
      this.lastTick += 50;
      this.brain.handle({ t: "tick", now: this.lastTick });
    }
  }

  frameAt(p: Vec2, score = 0.9) {
    this.brain.handle({ t: "frame", frame: frame(this.t, [hand(this.cam(p), { score })]) });
    this.advance();
  }

  hold(p: Vec2, ms: number) {
    const t0 = this.t;
    while (this.t - t0 < ms) this.frameAt(p);
  }

  path(ms: number, f: (e: number) => Vec2) {
    const t0 = this.t;
    while (this.t - t0 < ms) this.frameAt(f(this.t - t0));
  }

  empty(ms: number) {
    const t0 = this.t;
    while (this.t - t0 < ms) {
      this.brain.handle({ t: "frame", frame: frame(this.t, []) });
      this.advance();
    }
  }

  /** Ticks only (frames stopped entirely). */
  ticks(ms: number) {
    const end = this.t + ms;
    while (this.t < end) {
      this.t += 50;
      this.lastTick = this.t;
      this.brain.handle({ t: "tick", now: this.t });
    }
  }

  action(action: string, o: { variant?: string; arg?: number | null; source?: "tile" | "voice" | "typed" } = {}) {
    this.brain.handle({ t: "action", action, variant: o.variant, arg: o.arg ?? null, source: o.source ?? "tile", now: this.t });
  }

  helper(event: "released" | "refused_down" | "krita_state" | "krita_reply", data: Record<string, unknown> = {}) {
    this.brain.handle({ t: "helper_event", event, data, now: this.t });
  }

  of<T extends FromBrain["t"]>(t: T): Array<Extract<FromBrain, { t: T }>> {
    return this.sent.filter((m) => m.t === t) as Array<Extract<FromBrain, { t: T }>>;
  }

  pen(): Wire[] {
    return this.of("pen").flatMap((m) => m.events);
  }

  lastState(): PanelState {
    const s = this.of("state");
    return s[s.length - 1].state;
  }

  mark(): number {
    return this.sent.length;
  }

  since(i: number): FromBrain[] {
    return this.sent.slice(i);
  }

  /** Lower the pen by dwell at C. */
  penDown() {
    this.hold(C, 2000);
    expect(this.lastState().pen).toBe("DRAWING");
  }

  connectKrita(actions: Array<{ id: string; text: string }> = []) {
    this.helper("krita_state", { connected: true });
    const connect = this.of("krita").slice(-4);
    for (const k of connect) {
      if (k.cmd.cmd === "list_actions") this.helper("krita_reply", { id: k.id, ok: true, actions });
      else if (k.cmd.cmd === "canvas_rect") this.helper("krita_reply", { id: k.id, ok: true, rect: CANVAS });
      else this.helper("krita_reply", { id: k.id, ok: true });
    }
    return connect;
  }
}

function expectMoveBeforeEveryDown(events: Wire[]) {
  events.forEach((e, i) => {
    if (e.type === "down" || e.type === "middle_down") {
      const prev = events[i - 1];
      expect(prev?.type).toBe("move");
      expect(prev && "x" in prev && prev.x).toBe(e.x);
      expect(prev && "y" in prev && prev.y).toBe(e.y);
    }
  });
}

describe("brain: pen from frames", () => {
  it("@PLUGIN dwell → down preceded by a move to the same point → stroke moves → dwell up", () => {
    const r = new Rig();
    r.hold(C, 2000);
    let ev = r.pen();
    const downs = ev.filter((e) => e.type === "down");
    expect(downs).toHaveLength(1);
    expectMoveBeforeEveryDown(ev);
    const d = downs[0];
    expect(d.x).toBeGreaterThanOrEqual(CANVAS.x);
    expect(d.x).toBeLessThanOrEqual(CANVAS.x + CANVAS.w);
    const iDown = ev.indexOf(d);

    r.path(1000, (e) => ({ x: C.x + e * 0.15, y: C.y }));
    ev = r.pen();
    const strokeMoves = ev.slice(iDown + 1).filter((e) => e.type === "move");
    expect(strokeMoves.length).toBeGreaterThan(10);
    expect(Math.max(...strokeMoves.map((m) => m.x))).toBeGreaterThan(d.x + 80);

    r.hold({ x: C.x + 150, y: C.y }, 2500);
    const ups = r.pen().filter((e) => e.type === "up");
    expect(ups).toHaveLength(1);
    expect(ups[0].type === "up" && ups[0].reason).toBe("dwell");
    expect(r.lastState().pen).toBe("HOVER");
  });

  it("@PLUGIN pan → middle_down (after a move to the same point) … middle_up", () => {
    const r = new Rig();
    r.hold(C, 300);
    r.action("pan");
    r.hold(C, 2000);
    r.path(1000, (e) => ({ x: C.x + e * 0.15, y: C.y }));
    r.hold({ x: C.x + 150, y: C.y }, 2500);
    const ev = r.pen();
    expect(ev.filter((e) => e.type === "middle_down")).toHaveLength(1);
    expect(ev.filter((e) => e.type === "middle_up")).toHaveLength(1);
    expect(ev.some((e) => e.type === "down" || e.type === "up")).toBe(false);
    expectMoveBeforeEveryDown(ev);
  });

  it("@PLUGIN tracking loss (no hand) → up within 300 ms", () => {
    const r = new Rig();
    r.penDown();
    const lastGood = r.t - 1000 / 30;
    const i = r.mark();
    let upAt: number | null = null;
    while (r.t - lastGood < 600 && upAt === null) {
      r.empty(1000 / 30);
      const up = r.since(i).find((m) => m.t === "pen" && m.events.some((e) => e.type === "up"));
      if (up) upAt = r.t - 1000 / 30;
    }
    expect(upAt).not.toBeNull();
    expect(upAt! - lastGood).toBeLessThanOrEqual(300 + 1000 / 30);
    const up = r.pen().find((e) => e.type === "up");
    expect(up?.type === "up" && up.reason).toBe("tracking_lost");
    expect(r.of("status").some((s) => s.level === "alert" && /tracking lost/i.test(s.text))).toBe(true);
  });

  it("@PLUGIN frames stop entirely → the 50 ms tick releases within 300 ms", () => {
    const r = new Rig();
    r.penDown();
    const lastGood = r.t - 1000 / 30;
    const i = r.mark();
    let upAt: number | null = null;
    for (let k = 0; k < 20 && upAt === null; k++) {
      r.ticks(50);
      if (r.since(i).some((m) => m.t === "pen" && m.events.some((e) => e.type === "up"))) upAt = r.t;
    }
    expect(upAt).not.toBeNull();
    expect(upAt! - lastGood).toBeLessThanOrEqual(300 + 50);
    expect(r.lastState().pen).toBe("HOVER");
  });

  it("@PLUGIN pause → up, no down while paused, pointer clamped to the panel", () => {
    const r = new Rig();
    r.penDown();
    const i = r.mark();
    r.action("pause");
    const after = r.since(i);
    const ups = after.flatMap((m) => (m.t === "pen" ? m.events : [])).filter((e) => e.type === "up");
    expect(ups).toHaveLength(1);
    expect(r.lastState().paused).toBe(true);
    const j = r.mark();
    r.hold(C, 3000);
    r.path(1000, (e) => ({ x: C.x - e * 0.1, y: C.y }));
    r.hold({ x: C.x - 100, y: C.y }, 3000);
    const ev = r.since(j).flatMap((m) => (m.t === "pen" ? m.events : []));
    expect(ev.some((e) => e.type === "down" || e.type === "middle_down")).toBe(false);
    for (const e of ev.filter((x) => x.type === "move")) {
      expect(e.x).toBeGreaterThanOrEqual(PANEL.x);
      expect(e.x).toBeLessThanOrEqual(PANEL.x + PANEL.w);
    }
    r.action("pause");
    expect(r.lastState().paused).toBe(false);
  });

  it("@PLUGIN panel hidden (rects.panel = null) → Pause clamps the pointer to Krita's main window", () => {
    const r = new Rig();
    r.brain.handle({ t: "rects", rects: { panel: null } });
    r.penDown();
    r.action("pause");
    const j = r.mark();
    // Far outside Krita's window on the left/top: clamped to KRITA, not to the old panel.
    r.path(1500, (e) => ({ x: C.x - e * 1.2, y: C.y - e * 0.6 }));
    const moves = r.since(j).flatMap((m) => (m.t === "pen" ? m.events : [])).filter((e) => e.type === "move");
    expect(moves.length).toBeGreaterThan(10);
    for (const e of moves) {
      expect(e.x).toBeGreaterThanOrEqual(KRITA.x);
      expect(e.y).toBeGreaterThanOrEqual(KRITA.y);
      expect(e.x).toBeLessThanOrEqual(KRITA.x + KRITA.w);
    }
    expect(moves.some((e) => e.x < PANEL.x)).toBe(true); // not the panel any more
  });

  it("@PLUGIN state is ≤ 15 Hz, only on change, rawTrail ≤ 90 points relative to the canvas", () => {
    const r = new Rig();
    const i = r.mark();
    r.path(3000, (e) => ({ x: C.x + 100 * Math.sin(e / 300), y: C.y + 50 * Math.cos(e / 400) }));
    const states = r.since(i).filter((m) => m.t === "state") as Array<Extract<FromBrain, { t: "state" }>>;
    // 3 s at ≤ 15 Hz plus a few immediate safety-state changes (pen / tracking).
    expect(states.length).toBeLessThanOrEqual(3 * 15 + 6);
    expect(states.length).toBeGreaterThan(10);
    for (const s of states) expect(s.state.rawTrail.length).toBeLessThanOrEqual(90);
    const tr = states[states.length - 1].state.rawTrail;
    expect(tr.length).toBeGreaterThan(10);
    for (const p of tr) {
      expect(p.x).toBeLessThan(CANVAS.w + 50);
      expect(p.y).toBeLessThan(CANVAS.h + 50);
    }
    const keys = states.map((s) => JSON.stringify(s.state));
    for (let k = 1; k < keys.length; k++) expect(keys[k]).not.toBe(keys[k - 1]);
  });
});

describe("brain: actions", () => {
  it("@PLUGIN destructive action waits for dialog confirm", () => {
    const r = new Rig();
    r.connectKrita([{ id: "remove_layer", text: "&Remove Layer" }]);
    const i = r.mark();
    r.action("delete_layer");
    let dialogs = r.since(i).filter((m) => m.t === "dialog") as Array<Extract<FromBrain, { t: "dialog" }>>;
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].kind).toBe("confirm");
    expect(dialogs[0].options.map((o) => o.id)).toEqual(["confirm", "cancel"]);
    expect(r.since(i).some((m) => m.t === "krita" || m.t === "keys")).toBe(false);

    r.brain.handle({ t: "dialog_answer", dialog_id: dialogs[0].dialog_id, answer: "cancel", now: r.t });
    expect(r.since(i).some((m) => m.t === "krita" || m.t === "keys")).toBe(false);

    const j = r.mark();
    r.action("delete_layer");
    dialogs = r.since(j).filter((m) => m.t === "dialog") as Array<Extract<FromBrain, { t: "dialog" }>>;
    r.brain.handle({ t: "dialog_answer", dialog_id: dialogs[0].dialog_id, answer: "confirm", now: r.t });
    const k = r.since(j).filter((m) => m.t === "krita") as Array<Extract<FromBrain, { t: "krita" }>>;
    expect(k).toHaveLength(1);
    expect(k[0].cmd).toEqual({ cmd: "action", action: "remove_layer" });
    expect(k[0].fallback_keys).toBe("shift+delete");
  });

  it("@PLUGIN voice yes confirms an open dialog and closes it on the panel", () => {
    const r = new Rig();
    r.action("clear_layer");
    const d = r.of("dialog")[0];
    const i = r.mark();
    r.action("yes", { source: "voice" });
    const after = r.since(i);
    expect(after).toContainEqual({ t: "dialog_close", dialog_id: d.dialog_id });
    expect(after.some((m) => m.t === "dialog")).toBe(false);
    // Plugin down: the lookup row falls back to its keystroke.
    expect(after.some((m) => m.t === "keys" && m.combo === "backspace")).toBe(true);
  });

  it("@PLUGIN krita action → krita message with fallback_keys; plugin-only without plugin → status", () => {
    const r = new Rig();
    r.action("undo");
    const k = r.of("krita");
    expect(k).toHaveLength(1);
    expect(k[0].cmd).toEqual({ cmd: "action", action: "edit_undo" });
    expect(k[0].fallback_keys).toBe("cmd+z");
    r.action("colour_red");
    expect(r.of("krita")).toHaveLength(1);
    expect(r.of("status").pop()?.text).toBe("That needs the Krita plugin.");
    r.connectKrita();
    r.action("colour_red");
    expect(r.of("krita").pop()?.cmd).toEqual({ cmd: "color", hex: "#d62828" });
    r.action("size", { arg: 20 });
    expect(r.of("krita").pop()?.cmd).toEqual({ cmd: "size", value: 20 });
  });

  it("@PLUGIN coalesced undo arg 3 → 3 commands 50 ms apart", () => {
    const r = new Rig();
    const i = r.mark();
    r.action("undo", { arg: 3 });
    expect(r.since(i).filter((m) => m.t === "krita")).toHaveLength(1);
    r.ticks(50);
    expect(r.since(i).filter((m) => m.t === "krita")).toHaveLength(2);
    r.ticks(50);
    expect(r.since(i).filter((m) => m.t === "krita")).toHaveLength(3);
    r.ticks(500);
    expect(r.since(i).filter((m) => m.t === "krita")).toHaveLength(3);
  });

  it("@PLUGIN krita_state connected → session_init, list_actions, list_presets, canvas_rect; the reply sets the canvas", () => {
    const r = new Rig();
    // No canvas rect yet: ink is impossible (dwell cannot lower the pen).
    r.brain.handle({ t: "rects", rects: { canvas: null } });
    r.hold(C, 2500);
    expect(r.pen().some((e) => e.type === "down")).toBe(false);
    const connect = r.connectKrita();
    expect(connect.map((k) => k.cmd.cmd)).toEqual(["session_init", "list_actions", "list_presets", "canvas_rect"]);
    r.ticks(100);
    expect(r.lastState().kritaConnected).toBe(true);
    // The canvas_rect reply (CANVAS) now allows ink.
    r.path(800, (e) => ({ x: C.x + e * 0.1, y: C.y }));
    r.hold({ x: C.x + 80, y: C.y }, 2500);
    expect(r.pen().filter((e) => e.type === "down")).toHaveLength(1);
    const k = r.mark();
    r.helper("krita_state", { connected: false });
    expect(r.lastState().kritaConnected).toBe(false);
    expect(r.since(k).some((m) => m.t === "status")).toBe(true);
  });

  it("@PLUGIN parse round-trip (grammar, aliases, dialog exact-match)", () => {
    const r = new Rig({ settings: { aliases: { fluffy: "Basic-5 Size" } } as never });
    r.brain.handle({ t: "parse", id: "p1", text: "undo that undo that", opts: { mode: "voice" } });
    r.brain.handle({ t: "parse", id: "p2", text: "paint the room purple elephants", opts: { mode: "voice" } });
    r.brain.handle({ t: "parse", id: "p3", text: "fluffy", opts: { mode: "voice" } });
    r.brain.handle({ t: "parse", id: "p4", text: "use profile shaky day", opts: { mode: "typed" } });
    const parsed = r.of("parsed");
    expect(parsed.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(parsed[0].result).toEqual({ kind: "match", commands: [{ action: "undo", arg: 2 }], fuzzy: false });
    expect(parsed[1].result.kind).toBe("nomatch");
    expect(parsed[2].result.kind === "match" && parsed[2].result.commands[0]).toMatchObject({ action: "alias", variant: "Basic-5 Size" });
    expect(parsed[3].result.kind === "match" && parsed[3].result.commands[0]).toMatchObject({ action: "use_profile", variant: "shaky day" });
  });

  it("@PLUGIN refused_down → up + persistent alert", () => {
    const r = new Rig();
    r.penDown();
    const i = r.mark();
    r.helper("refused_down", { code: "paused" });
    const ev = r.since(i).flatMap((m) => (m.t === "pen" ? m.events : []));
    expect(ev.filter((e) => e.type === "up")).toHaveLength(1);
    const al = r.since(i).filter((m) => m.t === "status" && m.level === "alert") as Array<Extract<FromBrain, { t: "status" }>>;
    expect(al.length).toBe(1);
    expect(al[0].text).toMatch(/paused/i);
    expect(r.lastState().pen).toBe("HOVER");
  });

  it("@PLUGIN released by the pointer → pen lifted + alert", () => {
    const r = new Rig();
    r.penDown();
    r.helper("released", { reason: "watchdog", button: "left" });
    expect(r.lastState().pen).toBe("HOVER");
    expect(r.of("status").some((s) => s.level === "alert" && /released/i.test(s.text))).toBe(true);
  });

  it("@PLUGIN ptt_down → up + mic open (ptt); ptt_up → mic close", () => {
    const r = new Rig();
    r.penDown();
    const i = r.mark();
    r.brain.handle({ t: "hotkey", key: "ptt_down", now: r.t });
    const after = r.since(i);
    const up = after.findIndex((m) => m.t === "pen" && m.events.some((e) => e.type === "up" && e.reason === "ptt"));
    const mic = after.findIndex((m) => m.t === "mic" && m.open && m.reason === "ptt");
    expect(up).toBeGreaterThanOrEqual(0);
    expect(mic).toBeGreaterThan(up);
    expect(r.lastState().micOpen).toBe(true);
    r.brain.handle({ t: "hotkey", key: "ptt_up", now: r.t });
    expect(r.of("mic").pop()).toEqual({ t: "mic", open: false, reason: "ptt" });
    // Quiet mode keeps the mic shut.
    r.action("quiet");
    const j = r.mark();
    r.brain.handle({ t: "hotkey", key: "ptt_down", now: r.t });
    expect(r.since(j).some((m) => m.t === "mic")).toBe(false);
  });

  it("@PLUGIN F-keys: pen toggles, pause, latch from hotkeys", () => {
    const r = new Rig();
    r.hold(C, 600); // tracking, not yet dwelled down
    r.brain.handle({ t: "hotkey", key: "pen", now: r.t });
    expect(r.lastState().pen).toBe("DRAWING");
    expectMoveBeforeEveryDown(r.pen());
    r.brain.handle({ t: "hotkey", key: "latch", now: r.t });
    expect(r.of("settings_changed").pop()?.settings).toEqual({ latch: true });
    r.brain.handle({ t: "hotkey", key: "pause", now: r.t });
    expect(r.lastState().pen).toBe("HOVER");
    expect(r.lastState().paused).toBe(true);
  });

  it("@PLUGIN steadier / looser / smoothing presets / hand presets → settings_changed", () => {
    const r = new Rig();
    r.action("steadier");
    expect(r.of("settings_changed").pop()?.settings).toEqual({ steadiness: 60 });
    r.action("looser"); // tiles are not debounced
    expect(r.of("settings_changed").pop()?.settings).toEqual({ steadiness: 50 });
    const n = r.of("settings_changed").length;
    r.action("looser", { source: "voice" }); // voice: once per second
    expect(r.of("settings_changed")).toHaveLength(n);
    r.ticks(1000);
    r.action("looser", { source: "voice" });
    expect(r.of("settings_changed").pop()?.settings).toEqual({ steadiness: 40 });
    r.action("smoothing_ink");
    expect(r.of("settings_changed").pop()?.settings).toEqual({ steadiness: 70 });
    r.action("preset_hard_still");
    const p = r.of("settings_changed").pop()?.settings as Record<string, unknown>;
    expect(p.steadiness).toBe(60);
    expect(p.latch).toBe(true);
    expect(p).not.toHaveProperty("tip");
    expect(r.of("status").some((s) => /Fastest way to lift the pen/.test(s.text))).toBe(true);
  });

  it("@PLUGIN profiles save/use persist through settings_changed.profiles", () => {
    const r = new Rig();
    r.action("steadier");
    r.action("save_profile", { variant: "evening" });
    const saved = r.of("settings_changed").pop()?.settings as { profiles?: { active: string; profiles: Array<{ name: string }> } };
    expect(saved.profiles?.active).toBe("Evening");
    r.action("use_profile", { variant: "shaky" });
    const used = r.of("settings_changed").pop()?.settings as Record<string, unknown> & { profiles: { active: string } };
    expect(used.steadiness).toBe(70);
    expect(used.latch).toBe(true);
    expect(used.profiles.active).toBe("Shaky day");
    r.action("use_profile", { variant: "nonexistent" });
    expect(r.of("status").pop()?.text).toBe("No profile called nonexistent.");
  });

  it("@PLUGIN use_last_setup → stored calibration for the current hand, or a status when none", () => {
    const none = new Rig({ calibration: null });
    none.action("use_last_setup");
    expect(none.of("status").pop()?.text).toBe("No saved setup yet: calibrate on the Setup page.");
    expect(none.lastState().calibrated).toBe(false);

    const r = new Rig({ calibration: null });
    r.brain.handle({
      t: "init",
      settings: DEFAULT_SETTINGS,
      calibration: null,
      calibrations: { Right: TEST_CAL },
      now: r.t,
    });
    r.brain.handle({ t: "calibrate", steps: [1, 2], now: r.t });
    r.action("use_last_setup");
    expect(r.of("status").pop()?.text).toBe("Using your last setup.");
    expect(r.lastState().calibrated).toBe(true);
    expect(r.lastState().calibrating).toBeNull();
    expect(r.lastState().gain).toBe(TEST_CAL.gain);
  });

  it("@PLUGIN PanelState.profiles lists the profile names", () => {
    const r = new Rig();
    expect(r.lastState().profiles).toEqual(["Steady day", "Shaky day"]);
    r.action("save_profile", { variant: "evening" });
    r.ticks(100);
    expect(r.lastState().profiles).toEqual(["Steady day", "Shaky day", "Evening"]);
  });

  it("@PLUGIN name_brush → get_state → alias stored in settings.aliases", () => {
    const r = new Rig();
    r.action("name_brush", { variant: "fluffy" });
    expect(r.of("status").pop()?.text).toMatch(/needs the Krita plugin/);
    r.connectKrita();
    r.action("name_brush", { variant: "fluffy" });
    const k = r.of("krita").pop()!;
    expect(k.cmd).toEqual({ cmd: "get_state" });
    r.helper("krita_reply", { id: k.id, ok: true, preset: "b) Basic-5 Size" });
    expect(r.of("settings_changed").pop()?.settings).toEqual({ aliases: { fluffy: "b) Basic-5 Size" } });
    r.action("alias", { variant: "b) Basic-5 Size" });
    expect(r.of("krita").pop()?.cmd).toEqual({ cmd: "preset", name: "b) Basic-5 Size" });
    r.action("name_brush", { variant: "blue" });
    expect(r.of("status").pop()?.text).toBe("That word is taken.");
  });

  it("@PLUGIN show numbers → status list; click number → pen click at the item centre", () => {
    const r = new Rig();
    r.connectKrita();
    r.action("show_numbers");
    const k = r.of("krita").pop()!;
    expect(k.cmd).toEqual({ cmd: "list_widgets" });
    r.helper("krita_reply", {
      id: k.id,
      ok: true,
      widgets: [
        { n: 1, label: "Brush", rect: { x: 10, y: 100, w: 30, h: 30 } },
        { n: 2, label: "Eraser", rect: { x: 50, y: 100, w: 30, h: 30 } },
      ],
    });
    expect(r.of("status").pop()?.text).toBe("Numbers: 1 Brush, 2 Eraser. Say click and a number.");
    const i = r.mark();
    r.action("click_number", { arg: 2 });
    const ev = r.since(i).flatMap((m) => (m.t === "pen" ? m.events : []));
    expect(ev).toContainEqual({ type: "click", x: 65, y: 115 });
    r.ticks(100);
    expect(r.lastState().undoLabel).toBe("Eraser");
    r.action("click_number", { arg: 9 });
    expect(r.of("status").pop()?.text).toBe("No number 9.");
  });

  it("@PLUGIN unsupported head mode → status, no crash", () => {
    const r = new Rig();
    r.action("head_mode");
    expect(r.of("status").pop()?.text).toMatch(/Head mode isn't in the Krita panel/);
    expect(r.of("error")).toHaveLength(0);
  });

  it("@PLUGIN calibrate → calibration + suggested Steadiness in status, Steadiness unchanged", () => {
    const r = new Rig({ calibration: null });
    r.hold(C, 500);
    r.brain.handle({ t: "calibrate", steps: [1, 2], now: r.t });
    expect(r.lastState().calibrating?.step).toBe(1);
    r.hold(C, 3500);
    r.path(5000, (e) => ({ x: C.x + 200 * Math.cos(e / 600), y: C.y + 200 * Math.sin(e / 600) }));
    const cal = r.of("calibration");
    expect(cal).toHaveLength(1);
    expect(cal[0].calibration.gain).toBeGreaterThanOrEqual(2);
    const done = r.of("status").find((s) => s.text.startsWith("Calibration done."));
    expect(done?.text).toMatch(/Suggested Steadiness: \d+ \(now 50\)/);
    expect(r.of("settings_changed").some((m) => "steadiness" in m.settings)).toBe(false);
    expect(r.lastState().calibrating).toBeNull();
    expect(r.lastState().calibrated).toBe(true);
  });

  it("@PLUGIN never throws: a bad message mid-stroke → force lift first, then error, and keeps running", () => {
    const r = new Rig();
    r.penDown();
    const i = r.mark();
    r.brain.handle({ t: "frame", frame: null });
    const after = r.since(i);
    const up = after.findIndex((m) => m.t === "pen" && m.events.some((e) => e.type === "up"));
    const err = after.findIndex((m) => m.t === "error");
    expect(up).toBeGreaterThanOrEqual(0);
    expect(err).toBeGreaterThan(up);
    r.brain.handle("garbage");
    r.brain.handle({ t: "nope" });
    expect(r.of("error").length).toBe(3);
    r.brain.handle({ t: "parse", id: "after", text: "undo", opts: { mode: "typed" } });
    expect(r.of("parsed").pop()?.id).toBe("after");
  });

  it("@PLUGIN shutdown → force lift and no further output", () => {
    const r = new Rig();
    r.penDown();
    const i = r.mark();
    r.brain.handle({ t: "shutdown" });
    expect(r.since(i).some((m) => m.t === "pen" && m.events.some((e) => e.type === "up"))).toBe(true);
    const j = r.mark();
    r.hold(C, 500);
    expect(r.since(j)).toHaveLength(0);
  });
});

describe("brain: built bundle", () => {
  const root = path.resolve(__dirname, "../..");
  const bundle = path.join(root, "tracker/brain/dist/brain.mjs");

  beforeAll(() => {
    execFileSync(process.execPath, [path.join(root, "tracker/brain/build.mjs")], { cwd: root, stdio: "pipe" });
  }, 60000);

  it("@PLUGIN node tracker/brain/dist/brain.mjs: init → ready + state, stdout is JSON lines only, exit 0", async () => {
    const child = spawn(process.execPath, [bundle], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (out += d));
    child.stderr.resume();
    const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
    child.stdin.write(`${JSON.stringify({ t: "init", settings: DEFAULT_SETTINGS, calibration: TEST_CAL, now: 0 })}\n`);
    child.stdin.write(`${JSON.stringify({ t: "parse", id: "q", text: "bigger", opts: { mode: "voice" } })}\n`);
    child.stdin.write("this is not json\n");
    await new Promise((res) => setTimeout(res, 300));
    child.stdin.write(`${JSON.stringify({ t: "shutdown" })}\n`);
    const code = await exited;
    expect(code).toBe(0);
    const lines = out.split("\n").filter(Boolean);
    const msgs = lines.map((l) => JSON.parse(l) as FromBrain); // throws if anything else hit stdout
    expect(msgs[0]).toEqual({ t: "ready", version: expect.any(String) });
    expect(msgs.some((m) => m.t === "state")).toBe(true);
    const parsed = msgs.find((m) => m.t === "parsed") as Extract<FromBrain, { t: "parsed" }>;
    expect(parsed.result).toEqual({ kind: "match", commands: [{ action: "bigger" }], fuzzy: false });
    expect(msgs.some((m) => m.t === "error")).toBe(true);
  }, 20000);
});

describe("refused pen-down feedback (real-Mac fix)", () => {
  it("@PLUGIN voice down with no hand in view explains why instead of doing nothing", () => {
    const out: any[] = [];
    const brain = createBrain((m: any) => out.push(m));
    brain.handle({ t: "init", settings: {} as any, calibration: null, now: 0 });
    brain.handle({ t: "action", action: "pen_down", source: "voice", now: 100 });
    const st = out.filter((m) => m.t === "status").map((m) => m.text).join(" | ");
    expect(st).toMatch(/can't see your hand/i);
    expect(out.some((m) => m.t === "pen" && m.events.some((e: any) => e.type === "down"))).toBe(false);
  });
});
