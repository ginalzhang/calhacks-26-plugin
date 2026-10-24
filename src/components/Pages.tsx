"use client";
/**
 * Side-panel pages (§0 rule 6). Each fits 320 × 900 at 100 % without scrolling; pages were added
 * rather than shrinking a tile or a gap. Tiles come from ACTIONS by `page`.
 */
import { useEffect, useRef, useState } from "react";
import { ACTIONS, COLOUR_HEX, type PageId } from "../actions";
import { LANDMARK_CHOICES } from "../tracking/LandmarkSource";
import type { MirrorState, SteadySettings, Vec2 } from "../pipeline/types";
import { GAIN_MAX_SLIDER, GAIN_MIN } from "../pipeline/types";
import { ActionTile } from "./ActionTile";
import { SliderRow } from "./SliderRow";
import { Tile } from "./Tile";
import type { CameraInfo } from "../tracking/camera";
import type { StrokeStore } from "./strokes";

export interface DemoMetrics {
  commandsTried: number;
  commandsOk: number;
  claude: { calls: number; accepted: number; timeouts: number };
}

export interface PageCtx {
  settings: SteadySettings;
  mirror: MirrorState | null;
  run: (id: string, el: HTMLElement | null) => void;
  update: (patch: Partial<SteadySettings>) => void;
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
  // paint
  submitTyped: (text: string) => Promise<void>;
  skinHex: string | null;
  eraserOn: boolean;
  trackSource: "hand" | "colorcap";
  setTrackSource: (k: "hand" | "colorcap") => void;
  exposureLocked: boolean;
  // demo
  metrics: DemoMetrics;
  strokes: StrokeStore;
  getMirror: () => MirrorState | null;
}

const tilesFor = (page: PageId) => ACTIONS.filter((a) => a.page === page);

function TileGrid({ page, ctx, pressedOf }: { page: PageId; ctx: PageCtx; pressedOf?: (id: string) => boolean }) {
  return (
    <div className="tile-grid">
      {tilesFor(page).map((a) => (
        <ActionTile key={a.id} id={a.id} run={ctx.run} pressed={pressedOf?.(a.id)} />
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
      <TileGrid
        page="steady"
        ctx={ctx}
        pressedOf={(id) =>
          id === "dots"
            ? mode === "dots"
            : id === "hatch"
              ? mode === "hatch" || mode === "hatch_alternate"
              : id === "dash"
                ? mode === "dash"
                : id === "quiet"
                  ? ctx.settings.quiet
                  : false
        }
      />
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
        <Tile
          label="Colour cap"
          pressed={ctx.trackSource === "colorcap"}
          disabled={ctx.source === "replay"}
          title="Track a bright sticker on a glove, brace or fingertip instead of the hand."
          onPress={() => ctx.setTrackSource(ctx.trackSource === "colorcap" ? "hand" : "colorcap")}
        />
        <ActionTile id="recalibrate" run={ctx.run} />
        <Tile label="Use last setup" onPress={ctx.useLastSetup} disabled={!ctx.hasLastSetup} />
        <ActionTile id="pick_sticker_colour" run={ctx.run} disabled={ctx.trackSource !== "colorcap"} />
        <ActionTile id="lock_exposure" run={ctx.run} pressed={ctx.exposureLocked} disabled={ctx.source === "replay"} />
        <Tile
          label="Draw in Krita"
          pressed={krita}
          disabled={!ctx.helperOpen}
          title={ctx.helperOpen ? undefined : "Start the helper (npm run helper) to draw in Krita."}
          onPress={() => ctx.setTarget(krita ? "canvas" : "krita")}
        />
        <Tile
          label="Browser speech fallback"
          pressed={s.webSpeechFallback}
          onPress={() => ctx.update({ webSpeechFallback: !s.webSpeechFallback })}
        />
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

// ----------------------------------------------------------------------------- Timing
export function TimingPage({ ctx }: { ctx: PageCtx }) {
  const s = ctx.settings;
  const ms = (v: number) => `${v} ms`;
  const sec = (v: number) => `${(v / 1000).toFixed(1)} s`;
  return (
    <>
      <SliderRow
        label="Pen-down hold"
        value={s.dwellDownMs}
        min={500}
        max={1500}
        step={50}
        tileStep={50}
        format={ms}
        onChange={(v) => ctx.update({ dwellDownMs: v })}
      />
      <SliderRow
        label="Pen-up hold"
        value={s.dwellUpMs}
        min={800}
        max={3000}
        step={50}
        tileStep={50}
        format={ms}
        onChange={(v) => ctx.update({ dwellUpMs: v })}
      />
      <SliderRow
        label="Mic silence"
        value={s.micSilenceMs}
        min={1000}
        max={8000}
        step={50}
        tileStep={500}
        format={sec}
        onChange={(v) => ctx.update({ micSilenceMs: v })}
      />
      <SliderRow
        label="Mic limit"
        value={s.micCapMs}
        min={15000}
        max={60000}
        step={50}
        tileStep={5000}
        format={sec}
        onChange={(v) => ctx.update({ micCapMs: v })}
      />
      <SliderRow
        label="Hatch lag"
        value={s.hatchLagMs}
        min={80}
        max={250}
        step={10}
        tileStep={10}
        format={ms}
        onChange={(v) => ctx.update({ hatchLagMs: v })}
      />
<SliderRow
        label="Dash pause"
        value={s.dashPauseMs}
        min={100}
        max={600}
        step={50}
        tileStep={50}
        format={ms}
        onChange={(v) => ctx.update({ dashPauseMs: v })}
      />
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
      <TileGrid page="paint" ctx={ctx} pressedOf={(id) => (id === "eraser" ? ctx.eraserOn : false)} />
    </>
  );
}

// ----------------------------------------------------------------------------- Colour
export function ColourPage({ ctx }: { ctx: PageCtx }) {
  const skin = ctx.skinHex;
  return (
    <div className="tile-grid">
      {tilesFor("colour").map((a) => {
        if (a.id === "skin") {
          // Until a skin colour is saved, the Skin tile reads "Save current colour as skin" (no default hex).
          return skin ? (
            <ActionTile key={a.id} id="skin" run={ctx.run}>
              <span className="swatch" style={{ background: skin }} aria-hidden="true" />
            </ActionTile>
          ) : (
            <ActionTile key="save_skin" id="save_skin" run={ctx.run} span={2} />
          );
        }
        if (a.id === "save_skin") return skin ? <ActionTile key={a.id} id={a.id} run={ctx.run} span={2} /> : null;
        const hex = a.id.startsWith("colour_") ? COLOUR_HEX[a.id.slice(7)] : null;
        return (
          <ActionTile key={a.id} id={a.id} run={ctx.run}>
            {hex && <span className="swatch" style={{ background: hex }} aria-hidden="true" />}
          </ActionTile>
        );
      })}
    </div>
  );
}

export function SimplePage({ page, ctx }: { page: PageId; ctx: PageCtx }) {
  return <TileGrid page={page} ctx={ctx} />;
}

/** View page: Krita view tiles, plus where the pointer lands in Krita (corner marking, gain). */
export function ViewPage({ ctx }: { ctx: PageCtx }) {
  const s = ctx.settings;
  const krita = ctx.mirror?.target === "krita";
  const gain = ctx.settings.gainOverride ?? ctx.mirror?.gain ?? 3;
  return (
    <>
      <TileGrid page="view" ctx={ctx} />
      <div className="tile-grid">
        <Tile
          label="Mark corners"
          onPress={ctx.markCorners}
          disabled={!krita}
          title="Hold still on Krita's canvas top-left corner, then bottom-right."
        />
        <Tile
          label="Pointer point"
          span={2}
          title="Which part of the hand moves the pointer. Index knuckle is the default; Advanced offers every point."
          onPress={() => {
            const i = LANDMARK_ORDER.indexOf(s.landmark);
            ctx.update({ landmark: LANDMARK_ORDER[(i + 1) % LANDMARK_ORDER.length] ?? 5 });
          }}
        >
          <span className="tile-sub">{landmarkName(s.landmark)}</span>
        </Tile>
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
            <div className="tile-grid cols-4">
        <Tile
          label="Dwell click"
          pressed={s.dwellClickEnabled}
          onPress={() => ctx.update({ dwellClickEnabled: !s.dwellClickEnabled })}
        />
        <Tile
          label="All dwell"
          pressed={s.inputs.dwell}
          onPress={() => ctx.update({ inputs: { ...s.inputs, dwell: !s.inputs.dwell } })}
        />
        <Tile
          label="Keys"
          pressed={s.inputs.keys}
          onPress={() => ctx.update({ inputs: { ...s.inputs, keys: !s.inputs.keys } })}
        />
        <Tile
          label="Camera"
          pressed={s.inputs.camera}
          onPress={() => ctx.update({ inputs: { ...s.inputs, camera: !s.inputs.camera } })}
        />
      </div>
      {ctx.marking && <p className="hint">{ctx.marking}</p>}
    </>
  );
}
