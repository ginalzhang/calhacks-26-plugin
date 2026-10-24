"use client";
/**
 * Side-panel pages (§0 rule 6). Each fits 320 × 900 at 100 % without scrolling; pages were added
 * rather than shrinking a tile or a gap. Since P4 the layout is explicit (PAGE_LAYOUT): the action
 * table's `page` field is the default, but tiles moved to Modes / Input / Krita where a page would
 * not fit (see DECISIONS.md › Agent B round 3). Every non-dialog action has exactly one tile.
 */
import { useEffect, useRef, useState } from "react";
import { ACTIONS, COLOUR_HEX } from "../actions";
import { LANDMARK_CHOICES } from "../tracking/LandmarkSource";
import type { MirrorState, SteadySettings, Vec2 } from "../pipeline/types";
import { GAIN_MAX_SLIDER, GAIN_MIN } from "../pipeline/types";
import type { ExtraSettings } from "../pipeline/presets";
import { ActionTile } from "./ActionTile";
import { SliderRow } from "./SliderRow";
import { Tile } from "./Tile";
import type { CameraInfo } from "../tracking/camera";
import type { StrokeStore } from "./strokes";

export type UiSettings = SteadySettings & ExtraSettings & { headMode?: boolean; eyebrowLift?: boolean; appProfile?: "krita" | "photoshop" };

export interface DemoMetrics {
  commandsTried: number;
  commandsOk: number;
  claude: { calls: number; accepted: number; timeouts: number };
}

export interface NumberItem {
  n: number;
  label: string;
  rect: { x: number; y: number; w: number; h: number };
}

export interface PageCtx {
  settings: UiSettings;
  mirror: MirrorState | null;
  run: (id: string, el: HTMLElement | null) => void;
  update: (patch: Partial<UiSettings>) => void;
  // setup
  source: "camera" | "replay";
  replayName: string | null;
  cameras: CameraInfo[];
  cameraId: string | null;
  chooseCamera: (id: string) => void;
  nextCamera: () => void;
  hasLastSetup: boolean;
  useLastSetup: () => void;
  helperOpen: boolean;
  setTarget: (t: "canvas" | "krita") => void;
  markCorners: () => void;
  marking: string | null;
  profiles: string[];
  activeProfile: string | null;
  applyProfile: (name: string) => void;
  // paint
  submitTyped: (text: string) => Promise<void>;
  skinHex: string | null;
  eraserOn: boolean;
  trackSource: "hand" | "colorcap";
  setTrackSource: (k: "hand" | "colorcap") => void;
  exposureLocked: boolean;
  numbers: NumberItem[] | null;
  // demo
  metrics: DemoMetrics;
  strokes: StrokeStore;
  getMirror: () => MirrorState | null;
}

/** B's page layout (tile ids per page, in order). */
export const PAGE_LAYOUT = {
  steady: ["steadier", "looser", "hatch", "dots", "quiet", "clear_practice"],
  presets: ["preset_sore_joints", "preset_shakes_reaching", "preset_slow_rest", "preset_hard_still"],
  modes: ["smoothing_sketch", "smoothing_ink", "smoothing_shade", "hatch_lr", "hatch_down", "hatch_alternate", "stop_hatching", "dash", "repeat"],
  paint: ["pen_down", "pen_up", "brush", "pencil", "ink", "airbrush", "eraser", "bigger", "smaller", "size", "fade", "solid", "opacity", "name_brush", "line"],
  view: ["zoom_in", "zoom_out", "fit", "actual", "turn_left", "turn_right", "straight", "mirror", "pan", "show_numbers", "hide_numbers", "click_number"],
  layers: ACTIONS.filter((a) => a.page === "layers").map((a) => a.id),
  colour: ACTIONS.filter((a) => a.page === "colour").map((a) => a.id),
  setup: ["recalibrate", "save_profile", "use_profile"],
  input: ["pick_sticker_colour", "lock_exposure", "head_mode", "eyebrow_lift"],
  krita: ["app_profile"],
  demo: ["simulate_tremor", "next_judge"],
} as const;

function Grid({ ids, ctx, pressedOf, cols }: { ids: readonly string[]; ctx: PageCtx; pressedOf?: (id: string) => boolean; cols?: 2 | 4 }) {
  return (
    <div className={`tile-grid${cols ? ` cols-${cols}` : ""}`}>
      {ids.map((id) => (
        <ActionTile key={id} id={id} run={ctx.run} pressed={pressedOf?.(id)} />
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------------- Steady
export function SteadyPage({ ctx }: { ctx: PageCtx }) {
  const mode = ctx.mirror?.mode ?? "normal";
  return (
    <>
      <SliderRow
        label="Steadiness"
        value={ctx.settings.steadiness}
        min={0}
        max={100}
        step={1}
        tileStep={5}
        format={(v) => String(v)}
        onChange={(v) => ctx.update({ steadiness: v })}
      />
      <Grid
        ids={PAGE_LAYOUT.steady}
        ctx={ctx}
        pressedOf={(id) =>
          id === "dots" ? mode === "dots" : id === "hatch" ? mode === "hatch" || mode === "hatch_alternate" : id === "quiet" ? ctx.settings.quiet : false
        }
      />
    </>
  );
}

// ----------------------------------------------------------------------------- Presets
/** Hand presets (§2, exact names). Own page since the Steady page overflowed 320 × 900 with them. */
export function PresetsPage({ ctx }: { ctx: PageCtx }) {
  return (
    <>
      <Grid ids={PAGE_LAYOUT.presets} ctx={ctx} cols={2} />
      <p className="note">Each preset sets Steadiness, gain, hold times and Latch for how your hand is today. Change any slider afterwards.</p>
    </>
  );
}

// ----------------------------------------------------------------------------- Modes
export function ModesPage({ ctx }: { ctx: PageCtx }) {
  const mode = ctx.mirror?.mode ?? "normal";
  const s = ctx.settings;
  const ms = (v: number) => `${v} ms`;
  return (
    <>
      <Grid ids={PAGE_LAYOUT.modes} ctx={ctx} pressedOf={(id) => (id === "dash" ? mode === "dash" : false)} />
      <SliderRow label="Hatch lag" value={s.hatchLagMs} min={80} max={250} step={10} tileStep={10} format={ms} onChange={(v) => ctx.update({ hatchLagMs: v })} />
      <SliderRow label="Dash pause" value={s.dashPauseMs} min={100} max={600} step={50} tileStep={50} format={ms} onChange={(v) => ctx.update({ dashPauseMs: v })} />
    </>
  );
}

// ----------------------------------------------------------------------------- Setup
const LANDMARK_NAMES: Array<[number, string]> = [
  [LANDMARK_CHOICES.knuckle, "Index knuckle"],
  [LANDMARK_CHOICES.precise, "Fingertip (Precise)"],
  [LANDMARK_CHOICES.middle_knuckle, "Middle knuckle"],
  [LANDMARK_CHOICES.wrist, "Wrist"],
];
const ADVANCED = Array.from({ length: 21 }, (_, i) => i).filter((i) => !LANDMARK_NAMES.some(([n]) => n === i));
const LANDMARK_ORDER = [...LANDMARK_NAMES.map(([n]) => n), ...ADVANCED];

export function landmarkName(i: number) {
  return LANDMARK_NAMES.find(([n]) => n === i)?.[1] ?? `Point ${i}`;
}

export function SetupPage({ ctx }: { ctx: PageCtx }) {
  const s = ctx.settings;
  const krita = ctx.mirror?.target === "krita";
  const custom = ctx.profiles.slice(0, 5);
  return (
    <>
      <div className="field-row">
        <div className="field">
          <label htmlFor="camera-select">Camera</label>
          <select
            id="camera-select"
            value={ctx.source === "replay" ? "replay" : (ctx.cameraId ?? "")}
            disabled={ctx.source === "replay"}
            onChange={(e) => ctx.chooseCamera(e.target.value)}
          >
            {ctx.source === "replay" ? (
              <option value="replay">Replay: {ctx.replayName ?? "file"}</option>
            ) : ctx.cameras.length ? (
              ctx.cameras.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label}
                </option>
              ))
            ) : (
              <option value="">No camera yet</option>
            )}
          </select>
        </div>
        <Tile label="Next camera" onPress={ctx.nextCamera} disabled={ctx.source === "replay" || ctx.cameras.length < 2} />
      </div>
      <div className="tile-grid">
        <Tile label="Mirror camera" pressed={s.mirrorCamera} onPress={() => ctx.update({ mirrorCamera: !s.mirrorCamera })} />
        <Tile label="Rotate camera" pressed={s.rotateCamera} onPress={() => ctx.update({ rotateCamera: !s.rotateCamera })} />
        <ActionTile id="recalibrate" run={ctx.run} />
        <Tile label="Use last setup" onPress={ctx.useLastSetup} disabled={!ctx.hasLastSetup} />
        <Tile
          label="Draw in Krita"
          pressed={krita}
          disabled={!ctx.helperOpen}
          title={ctx.helperOpen ? undefined : "Start the helper (npm run helper) to draw in Krita."}
          onPress={() => ctx.setTarget(krita ? "canvas" : "krita")}
        />
        <ActionTile id="save_profile" run={ctx.run} />
      </div>
      <div className="tile-grid" role="group" aria-label="Profiles">
        <ActionTile id="use_profile" run={ctx.run} />
        {custom.map((name) => (
          <Tile
            key={name}
            label={name}
            current={ctx.activeProfile === name}
            title={`Use the ${name} profile`}
            onPress={() => ctx.applyProfile(name)}
          />
        ))}
      </div>
    </>
  );
}

// ----------------------------------------------------------------------------- Input
export function InputPage({ ctx }: { ctx: PageCtx }) {
  const s = ctx.settings;
  return (
    <>
      <div className="tile-grid">
        <Tile
          label="Colour cap"
          pressed={ctx.trackSource === "colorcap"}
          disabled={ctx.source === "replay"}
          title="Track a bright sticker on a glove, brace or fingertip instead of the hand."
          onPress={() => ctx.setTrackSource(ctx.trackSource === "colorcap" ? "hand" : "colorcap")}
        />
        <ActionTile id="pick_sticker_colour" run={ctx.run} disabled={ctx.trackSource !== "colorcap"} />
        <ActionTile id="lock_exposure" run={ctx.run} pressed={ctx.exposureLocked} disabled={ctx.source === "replay"} />
        <ActionTile id="head_mode" run={ctx.run} pressed={!!s.headMode} />
        <ActionTile id="eyebrow_lift" run={ctx.run} pressed={!!s.eyebrowLift} />
        <Tile
          label="Pointer point"
          title="Which part of the hand moves the pointer. Index knuckle is the default; Advanced offers every point."
          disabled={!!s.headMode}
          onPress={() => {
            const i = LANDMARK_ORDER.indexOf(s.landmark);
            ctx.update({ landmark: LANDMARK_ORDER[(i + 1) % LANDMARK_ORDER.length] ?? 5 });
          }}
        >
          <span className="tile-sub">{landmarkName(s.landmark)}</span>
        </Tile>
        <Tile
          label="Browser speech fallback"
          pressed={s.webSpeechFallback}
          onPress={() => ctx.update({ webSpeechFallback: !s.webSpeechFallback })}
        />
      </div>
      <div className="tile-grid cols-4">
        <Tile label="Dwell click" pressed={s.dwellClickEnabled} onPress={() => ctx.update({ dwellClickEnabled: !s.dwellClickEnabled })} />
        <Tile label="All dwell" pressed={s.inputs.dwell} onPress={() => ctx.update({ inputs: { ...s.inputs, dwell: !s.inputs.dwell } })} />
        <Tile label="Keys" pressed={s.inputs.keys} onPress={() => ctx.update({ inputs: { ...s.inputs, keys: !s.inputs.keys } })} />
        <Tile label="Camera" pressed={s.inputs.camera} onPress={() => ctx.update({ inputs: { ...s.inputs, camera: !s.inputs.camera } })} />
      </div>
      {s.webSpeechFallback && (
        <p className="note">
          With this on, if Cartesia is unavailable your microphone audio goes to Google (Chrome&apos;s speech recognition) while
          the mic is open.
        </p>
      )}
    </>
  );
}

// ----------------------------------------------------------------------------- Krita
export function KritaPage({ ctx }: { ctx: PageCtx }) {
  const krita = ctx.mirror?.target === "krita";
  const gain = ctx.settings.gainOverride ?? ctx.mirror?.gain ?? 3;
  const app = ctx.settings.appProfile ?? "krita";
  return (
    <>
      <div className="tile-grid">
        <Tile
          label="Mark corners"
          onPress={ctx.markCorners}
          disabled={!krita}
          title="Hold still on Krita's canvas top-left corner, then bottom-right."
        />
        <ActionTile id="app_profile" run={ctx.run} label={app === "photoshop" ? "App: Photoshop" : "App: Krita"} />
      </div>
      <SliderRow
        label="Gain"
        value={Math.round(gain * 2) / 2}
        min={GAIN_MIN}
        max={GAIN_MAX_SLIDER}
        step={0.5}
        tileStep={0.5}
        format={(v) => `${v.toFixed(1)} times`}
        onChange={(v) => ctx.update({ gainOverride: v })}
      />
      {app === "photoshop" && <p className="hint">Photoshop: shortcuts only.</p>}
      {ctx.marking && <p className="hint">{ctx.marking}</p>}
    </>
  );
}

// ----------------------------------------------------------------------------- Timing
export function TimingPage({ ctx }: { ctx: PageCtx }) {
  const s = ctx.settings;
  const ms = (v: number) => `${v} ms`;
  const sec = (v: number) => `${(v / 1000).toFixed(1)} s`;
  return (
    <>
      <SliderRow label="Pen-down hold" value={s.dwellDownMs} min={500} max={1500} step={50} tileStep={50} format={ms} onChange={(v) => ctx.update({ dwellDownMs: v })} />
      <SliderRow label="Pen-up hold" value={s.dwellUpMs} min={800} max={3000} step={50} tileStep={50} format={ms} onChange={(v) => ctx.update({ dwellUpMs: v })} />
      <SliderRow label="Mic silence" value={s.micSilenceMs} min={1000} max={8000} step={50} tileStep={500} format={sec} onChange={(v) => ctx.update({ micSilenceMs: v })} />
      <SliderRow label="Mic limit" value={s.micCapMs} min={15000} max={60000} step={50} tileStep={5000} format={sec} onChange={(v) => ctx.update({ micCapMs: v })} />
    </>
  );
}

// ----------------------------------------------------------------------------- Demo
function TraceCanvas({ strokes, getMirror }: { strokes: StrokeStore; getMirror: () => MirrorState | null }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== Math.round(w * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#fbfaf7";
      ctx.fillRect(0, 0, w, h);
      const m = getMirror();
      const raw: Vec2[] = m?.rawTrail ?? [];
      const smooth: Vec2[] = strokes.trail;
      const all = [...raw, ...smooth];
      if (all.length < 2) return;
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const p of all) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      const span = Math.max(maxX - minX, maxY - minY, 60);
      const k = (Math.min(w, h) - 16) / span;
      const ox = (w - (maxX - minX) * k) / 2;
      const oy = (h - (maxY - minY) * k) / 2;
      const line = (pts: Vec2[], color: string, width: number) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        pts.forEach((p, i) => {
          const x = ox + (p.x - minX) * k;
          const y = oy + (p.y - minY) * k;
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        ctx.stroke();
      };
      line(raw, "rgba(200,40,40,0.45)", 1.5);
      line(smooth, "#1d4ed8", 2.5);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [strokes, getMirror]);
  return (
    <canvas
      ref={ref}
      className="trace-canvas"
      role="img"
      aria-label="Live trace: raw path in red under the smoothed path in blue"
    />
  );
}

export function DemoPage({ ctx }: { ctx: PageCtx }) {
  const m = ctx.mirror;
  const rate = ctx.metrics.commandsTried
    ? `${Math.round((100 * ctx.metrics.commandsOk) / ctx.metrics.commandsTried)} %`
    : "none yet";
  const c = ctx.metrics.claude;
  return (
    <>
      <div className="tile-grid">
        <ActionTile id="simulate_tremor" run={ctx.run} pressed={ctx.settings.simulateTremor} span={2} />
        <ActionTile id="next_judge" run={ctx.run} />
      </div>
      {ctx.settings.simulateTremor && <p className="caption">Simulated tremor</p>}
      <TraceCanvas strokes={ctx.strokes} getMirror={ctx.getMirror} />
      <dl className="metrics" aria-live="off" data-testid="metrics">
        <div>
          <dt>Deviation</dt>
          <dd data-metric="deviation">{m?.deviationPx != null ? `${m.deviationPx.toFixed(1)} px` : "–"}</dd>
        </div>
        <div>
          <dt>Last stroke</dt>
          <dd data-metric="last-stroke">{m?.lastStrokeMs != null ? `${(m.lastStrokeMs / 1000).toFixed(1)} s` : "–"}</dd>
        </div>
        <div>
          <dt>Commands</dt>
          <dd data-metric="commands">{rate}</dd>
        </div>
        <div>
          <dt>Claude</dt>
          <dd data-metric="claude">
            {c.calls} calls, {c.accepted} ok, {c.timeouts} timeouts
          </dd>
        </div>
        <div>
          <dt>Camera</dt>
          <dd data-metric="camera-fps">{m ? `${m.cameraFps} fps` : "–"}</dd>
        </div>
        <div>
          <dt>Detection</dt>
          <dd data-metric="detection-fps">{m ? `${m.detectionFps} fps` : "–"}</dd>
        </div>
        <div>
          <dt>Helper trip</dt>
          <dd data-metric="helper-rtt">{m?.helperRttMs != null ? `${Math.round(m.helperRttMs)} ms` : "–"}</dd>
        </div>
      </dl>
    </>
  );
}

// ----------------------------------------------------------------------------- Paint
function TypedBox({ ctx }: { ctx: PageCtx }) {
  const [text, setText] = useState("");
  const enabled = true;
  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    await ctx.submitTyped(t);
  };
  return (
    <form
      className="field-row"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="field">
        <label htmlFor="typed-command">Command</label>
        <input
          id="typed-command"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={text}
          disabled={!enabled}
          placeholder="e.g. steadier"
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <button type="submit" className="tile tile-primary" disabled={!enabled}>
        <span className="tile-label">Run</span>
      </button>
    </form>
  );
}

export function PaintPage({ ctx }: { ctx: PageCtx }) {
  return (
    <>
      <TypedBox ctx={ctx} />
      <Grid ids={PAGE_LAYOUT.paint} ctx={ctx} cols={4} pressedOf={(id) => (id === "eraser" ? ctx.eraserOn : false)} />
    </>
  );
}

// ----------------------------------------------------------------------------- Colour
export function ColourPage({ ctx }: { ctx: PageCtx }) {
  const skin = ctx.skinHex;
  return (
    <div className="tile-grid cols-4">
      {PAGE_LAYOUT.colour.map((id) => {
        if (id === "skin") {
          // Until a skin colour is saved, the Skin tile reads "Save current colour as skin" (no default hex).
          return skin ? (
            <ActionTile key={id} id="skin" run={ctx.run}>
              <span className="swatch" style={{ background: skin }} aria-hidden="true" />
            </ActionTile>
          ) : (
            <ActionTile key="save_skin" id="save_skin" run={ctx.run} span={2} />
          );
        }
        if (id === "save_skin") return skin ? <ActionTile key={id} id={id} run={ctx.run} span={2} /> : null;
        const hex = id.startsWith("colour_") ? COLOUR_HEX[id.slice(7)] : null;
        return (
          <ActionTile key={id} id={id} run={ctx.run}>
            {hex && <span className="swatch" style={{ background: hex }} aria-hidden="true" />}
          </ActionTile>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------------------- View / Layers
export function ViewPage({ ctx }: { ctx: PageCtx }) {
  return (
    <>
      <Grid ids={PAGE_LAYOUT.view} ctx={ctx} />
      {ctx.numbers && (
        <p className="numbers-list" aria-live="off">
          {ctx.numbers.map((i) => `${i.n} ${i.label}`).join(" · ")}
        </p>
      )}
    </>
  );
}

export function LayersPage({ ctx }: { ctx: PageCtx }) {
  return <Grid ids={PAGE_LAYOUT.layers} ctx={ctx} />;
}
