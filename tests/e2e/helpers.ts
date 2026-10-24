/**
 * Shared Playwright helpers for Steady (agent F).
 *
 * Everything targets the contract names only:
 *   - window.__steady (SteadyTestHooks, src/pipeline/types.ts)
 *   - tiles = <button>s named by actions.ts `label`; page tabs "Steady", "Setup", "Timing", "Demo", …
 *   - slider labelled "Steadiness"; practice canvas aria-label="Practice canvas"
 *   - URL: ?source=replay&replay=<name>, ?helper=ws://127.0.0.1:18765 | off, ?demo=1
 *   - fake helper HTTP control on 127.0.0.1:18767 (docs/PROTOCOL.md)
 */
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import type { Calibration, MirrorState, SteadyTestHooks } from "../../src/pipeline/types";

/** Set by playwright.config.ts (28765/28767 when the app is not on http://localhost:3000). */
export const FAKE_HELPER_WS = `ws://127.0.0.1:${process.env.FAKE_WS_PORT ?? "18765"}`;
export const FAKE_HELPER_HTTP = `http://127.0.0.1:${process.env.FAKE_HTTP_PORT ?? "18767"}`;
export const CALIBRATION_KEY = "steady.calibration.v1";

export type HelperMsg = { t: string; id?: string; [k: string]: unknown };

// ---------------------------------------------------------------------------
// URL + page boot
// ---------------------------------------------------------------------------

export interface OpenOpts {
  replay: string;
  helper?: "off" | "fake";
  demo?: boolean;
  /** Seed a stored calibration before load (default true) so tests skip calibration. */
  calibrated?: boolean;
  /** Extra query params (e.g. target=krita). */
  extra?: Record<string, string>;
}

export function steadyUrl(o: OpenOpts): string {
  const q = new URLSearchParams({ source: "replay", replay: o.replay });
  q.set("helper", o.helper === "fake" ? FAKE_HELPER_WS : "off");
  if (o.demo) q.set("demo", "1");
  for (const [k, v] of Object.entries(o.extra ?? {})) q.set(k, v);
  return `/?${q.toString()}`;
}

/** A plausible stored calibration: the 80 px circle of calibration-sequence.json, padded 20 %. */
export const SEED_CALIBRATION: Calibration = {
  restJitterRMS: 0.3,
  kineticJitterRMS: 0.8,
  box: { x: 224, y: 144, w: 192, h: 192 },
  gain: 2,
  handedness: "Right",
  flipX: false,
  flipY: false,
  suggestedSteadiness: 10,
  createdAt: 1761340000000,
};

export async function seedCalibration(page: Page, cal: Calibration | null = SEED_CALIBRATION): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      try {
        if (value === null) window.localStorage.clear();
        else window.localStorage.setItem(key as string, value as string);
      } catch {
        /* storage unavailable */
      }
    },
    [CALIBRATION_KEY, cal === null ? null : JSON.stringify({ Right: cal, Left: { ...cal, handedness: "Left" } })],
  );
}

/** Navigate, wait for window.__steady, accept "Use last setup" if offered. */
export async function openSteady(page: Page, o: OpenOpts): Promise<void> {
  if (o.calibrated !== false) await seedCalibration(page);
  else await seedCalibration(page, null);
  await page.goto(steadyUrl(o));
  await waitForHooks(page);
  if (o.calibrated !== false) {
    // "Next launch offers Use last setup" (§2): it lives on the Setup page.
    let useLast = page.getByRole("button", { name: /use last setup/i });
    if (!(await useLast.isVisible().catch(() => false))) {
      const setup = await pageTab(page, "Setup");
      if (setup) await setup.click();
      useLast = page.getByRole("button", { name: /use last setup/i });
    }
    if (await useLast.isEnabled().catch(() => false)) {
      await useLast.click();
      await waitForState(page, (s) => s.calibrated, { timeout: 3_000, what: "calibrated after Use last setup" }).catch(() => undefined);
    }
    const home = await pageTab(page, o.demo ? "Demo" : "Steady");
    if (home) await home.click();
  }
}

export async function waitForHooks(page: Page, timeout = 30_000): Promise<void> {
  await page
    .waitForFunction(() => {
      const s = (window as unknown as { __steady?: SteadyTestHooks }).__steady;
      return !!s && typeof s.state === "function" && s.state() !== null;
    }, undefined, { timeout })
    .catch(() => {
      throw new Error(
        "MISSING HOOK: window.__steady.state() never returned a MirrorState (agent B installs SteadyTestHooks on window.__steady).",
      );
    });
}

// ---------------------------------------------------------------------------
// window.__steady wrappers
// ---------------------------------------------------------------------------

export async function state(page: Page): Promise<MirrorState> {
  // The page may re-create its Worker (e.g. after "Use last setup"); tolerate a brief null.
  const end = Date.now() + 5_000;
  for (;;) {
    const s = await page.evaluate(() => (window as unknown as { __steady?: SteadyTestHooks }).__steady?.state() ?? null);
    if (s) return s;
    if (Date.now() > end) throw new Error("window.__steady.state() stayed null for 5 s");
    await page.waitForTimeout(100);
  }
}

export async function strokeCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __steady: SteadyTestHooks }).__steady.strokeCount());
}

export async function dispatch(page: Page, actionId: string): Promise<void> {
  await page.evaluate((id) => (window as unknown as { __steady: SteadyTestHooks }).__steady.dispatch(id), actionId);
}

/** Poll MirrorState until pred holds. Returns the matching state. */
export async function waitForState(
  page: Page,
  pred: (s: MirrorState) => boolean,
  { timeout = 20_000, interval = 50, what = "condition" } = {},
): Promise<MirrorState> {
  const end = Date.now() + timeout;
  let last: MirrorState | null = null;
  while (Date.now() < end) {
    last = await state(page);
    if (pred(last)) return last;
    await page.waitForTimeout(interval);
  }
  throw new Error(`Timed out after ${timeout} ms waiting for ${what}. Last state: ${JSON.stringify(summary(last))}`);
}

export function summary(s: MirrorState | null): unknown {
  if (!s) return null;
  const { rawTrail: _r, helperHello: _h, ...rest } = s;
  return rest;
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------

/** A tile by its actions.ts label. */
export function tile(page: Page, label: string | RegExp): Locator {
  return page.getByRole("button", { name: label, exact: typeof label === "string" });
}

/** A page tab ("Steady", "Setup", …). Tabs may be role=tab or buttons. */
export async function pageTab(page: Page, name: string): Promise<Locator | null> {
  const asTab = page.getByRole("tab", { name, exact: true });
  if ((await asTab.count()) > 0) return asTab.first();
  const asButton = page.getByRole("button", { name, exact: true });
  if ((await asButton.count()) > 0) return asButton.first();
  return null;
}

export async function openPanelPage(page: Page, name: string): Promise<Locator> {
  const tab = await pageTab(page, name);
  if (!tab) throw new Error(`MISSING UI: no page tab named "${name}" (role=tab or button, exact name).`);
  await tab.click();
  return tab;
}

/** The visible page container: role=tabpanel, else [data-page], else the practice/side panel. */
export async function visiblePanel(page: Page): Promise<Locator> {
  for (const sel of ['[role="tabpanel"]:visible', "[data-page]:visible"]) {
    const l = page.locator(sel);
    if ((await l.count()) > 0) return l.first();
  }
  throw new Error('MISSING UI: no visible page container (expected role="tabpanel" or [data-page]).');
}

export function steadinessSlider(page: Page): Locator {
  return page.getByRole("slider", { name: "Steadiness" });
}

export async function sliderValue(slider: Locator): Promise<number> {
  const now = await slider.getAttribute("aria-valuenow");
  if (now !== null) return Number(now);
  return Number(await slider.inputValue());
}

/**
 * The − and + tiles either side of a slider (§0 rule 6). Strategy: the nearest ancestor of the
 * slider that contains ≥ 2 buttons; the first button is −, the last is +. Also accepts
 * explicitly named tiles ("Steadiness −", "Less steady", …).
 */
export async function plusMinusTiles(page: Page, slider: Locator): Promise<{ minus: Locator; plus: Locator }> {
  const named = {
    minus: page.getByRole("button", { name: /steadiness.*(−|-|minus|less|decrease|down)|(−|-|minus|decrease).*steadiness/i }),
    plus: page.getByRole("button", { name: /steadiness.*(\+|plus|more|increase|up)|(\+|plus|increase).*steadiness/i }),
  };
  if ((await named.minus.count()) === 1 && (await named.plus.count()) === 1) return named;
  for (let depth = 1; depth <= 4; depth++) {
    const anc = slider.locator(`xpath=${Array(depth).fill("..").join("/")}`);
    const buttons = anc.getByRole("button");
    if ((await buttons.count()) >= 2) return { minus: buttons.first(), plus: buttons.last() };
  }
  throw new Error("MISSING UI: no − / + tiles found beside the Steadiness slider.");
}

export function practiceCanvas(page: Page): Locator {
  return page.getByLabel("Practice canvas");
}

/** Number of non-background pixels on the practice canvas (the canvas may be a <canvas> or contain one). */
export async function inkedPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const host = document.querySelector('[aria-label="Practice canvas"]');
    if (!host) return -1;
    const canvases: HTMLCanvasElement[] =
      host instanceof HTMLCanvasElement ? [host] : Array.from(host.querySelectorAll("canvas"));
    let inked = 0;
    for (const c of canvases) {
      const ctx = c.getContext("2d");
      if (!ctx || c.width === 0 || c.height === 0) continue;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const bg = [d[0], d[1], d[2], d[3]];
      for (let i = 0; i < d.length; i += 16) {
        if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) + Math.abs(d[i + 3] - bg[3]) > 60) inked++;
      }
    }
    return inked;
  });
}

// ---------------------------------------------------------------------------
// Fake helper HTTP control
// ---------------------------------------------------------------------------

export const fakeHelper = {
  async available(): Promise<boolean> {
    try {
      const r = await fetch(`${FAKE_HELPER_HTTP}/messages`);
      return r.ok;
    } catch {
      return false;
    }
  },
  async reset(): Promise<void> {
    await fetch(`${FAKE_HELPER_HTTP}/reset`, { method: "POST" });
  },
  async messages(): Promise<HelperMsg[]> {
    const r = await fetch(`${FAKE_HELPER_HTTP}/messages`);
    const body = (await r.json()) as unknown;
    if (Array.isArray(body)) return body as HelperMsg[];
    const maybe = body as { messages?: HelperMsg[] };
    return maybe.messages ?? [];
  },
  async send(msg: HelperMsg): Promise<void> {
    await fetch(`${FAKE_HELPER_HTTP}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: `pw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...msg }),
    });
  },
  async config(cfg: Record<string, unknown>): Promise<boolean> {
    try {
      const r = await fetch(`${FAKE_HELPER_HTTP}/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cfg),
      });
      return r.ok;
    } catch {
      return false;
    }
  },
};

export async function waitForHelperOpen(page: Page, timeout = 15_000): Promise<MirrorState> {
  return waitForState(page, (s) => s.helper === "open", { timeout, what: "helper === 'open' (fake helper connected)" });
}

/** Switch the Worker's target to Krita via the Setup page's "Draw in Krita" tile (needs the helper open). */
export async function targetKrita(page: Page): Promise<MirrorState> {
  await openPanelPage(page, "Setup");
  const t = tile(page, "Draw in Krita");
  await expect(t, 'Setup page tile "Draw in Krita"').toBeEnabled({ timeout: 10_000 });
  if ((await t.getAttribute("aria-pressed")) !== "true") await t.click();
  return waitForState(page, (s) => s.target === "krita", { timeout: 5_000, what: "target === 'krita'" });
}

// ---------------------------------------------------------------------------
// Window geometry: screen points ↔ client CSS px (100 % zoom)
// ---------------------------------------------------------------------------

export interface WinRect {
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
}

export async function windowRect(page: Page): Promise<WinRect> {
  return page.evaluate(() => ({
    screenX: window.screenX,
    screenY: window.screenY,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  }));
}

/** Browser chrome sits above the viewport; side borders split evenly. */
export function clientToScreen(w: WinRect, cx: number, cy: number): { x: number; y: number } {
  const side = Math.max(0, (w.outerWidth - w.innerWidth) / 2);
  const top = Math.max(0, w.outerHeight - w.innerHeight - side);
  return { x: w.screenX + side + cx, y: w.screenY + top + cy };
}

export function screenToClient(w: WinRect, sx: number, sy: number): { x: number; y: number } {
  const side = Math.max(0, (w.outerWidth - w.innerWidth) / 2);
  const top = Math.max(0, w.outerHeight - w.innerHeight - side);
  return { x: sx - w.screenX - side, y: sy - w.screenY - top };
}

// ---------------------------------------------------------------------------
// Camera px → target units mapping (fit from the probe fixture)
// ---------------------------------------------------------------------------

export interface Mapping {
  target: MirrorState["target"];
  sx: number;
  sy: number;
  ox: number;
  oy: number;
}

const PROBE = { A: { x: 260, y: 200 }, B: { x: 380, y: 200 }, C: { x: 380, y: 280 } };

/**
 * Loads replay "probe" with the given options and fits camera px → target units from the
 * pointer plateaus at stations A, B, C (lazy-brush lag corrected along the approach direction).
 */
export async function fitMapping(
  page: Page,
  o: Omit<OpenOpts, "replay">,
  prepare?: (page: Page) => Promise<unknown>,
): Promise<Mapping> {
  const replay = prepare ? await serveWithLead(page, "probe", 8) : "probe";
  await openSteady(page, { ...o, replay });
  if (prepare) await prepare(page);
  const plateaus: Array<{ x: number; y: number }> = [];
  let run: Array<{ x: number; y: number }> = [];
  let target: MirrorState["target"] = "canvas";
  const end = Date.now() + 20_000;
  while (Date.now() < end && plateaus.length < 3) {
    const s = await state(page);
    target = s.target;
    const p = s.pointer;
    if (p) {
      const prev = run[run.length - 1];
      if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < 0.75) run.push(p);
      else run = [p];
      if (run.length === 15) {
        const lastPlateau = plateaus[plateaus.length - 1];
        if (!lastPlateau || Math.hypot(p.x - lastPlateau.x, p.y - lastPlateau.y) > 10) plateaus.push({ ...p });
      }
    }
    await page.waitForTimeout(60);
  }
  if (plateaus.length < 3) {
    throw new Error(`Probe saw ${plateaus.length}/3 pointer plateaus; state().pointer must report the pointer in target units.`);
  }
  const s0 = await state(page);
  const R = lazyRadius(s0.steadiness);
  const [a, bRaw, cRaw] = plateaus;
  const corr = (p: { x: number; y: number }, from: { x: number; y: number }) => {
    const d = Math.hypot(p.x - from.x, p.y - from.y) || 1;
    return { x: p.x + (R * (p.x - from.x)) / d, y: p.y + (R * (p.y - from.y)) / d };
  };
  const b = corr(bRaw, a);
  const c = corr(cRaw, bRaw);
  const sx = (b.x - a.x) / (PROBE.B.x - PROBE.A.x);
  const sy = (c.y - b.y) / (PROBE.C.y - PROBE.B.y);
  return { target, sx, sy, ox: a.x - sx * PROBE.A.x, oy: a.y - sy * PROBE.A.y };
}

/** Steadiness → lazy radius (target units), §2 knots. */
export function lazyRadius(steadiness: number): number {
  const k: Array<[number, number]> = [
    [0, 4],
    [50, 12],
    [100, 30],
  ];
  const s = Math.max(0, Math.min(100, steadiness));
  for (let i = 1; i < k.length; i++) {
    if (s <= k[i][0]) {
      const f = (s - k[i - 1][0]) / (k[i][0] - k[i - 1][0]);
      return k[i - 1][1] + f * (k[i][1] - k[i - 1][1]);
    }
  }
  return 30;
}

/** Camera px that put the pointer at a client-space point (tile centre). */
export async function cameraPointForClient(page: Page, m: Mapping, cx: number, cy: number): Promise<{ x: number; y: number }> {
  let tx: number;
  let ty: number;
  if (m.target === "krita") {
    const p = clientToScreen(await windowRect(page), cx, cy);
    tx = p.x;
    ty = p.y;
  } else {
    const box = await practiceCanvas(page).boundingBox();
    if (!box) throw new Error("MISSING UI: practice canvas (aria-label='Practice canvas') has no bounding box.");
    tx = cx - box.x;
    ty = cy - box.y;
  }
  return { x: (tx - m.ox) / m.sx, y: (ty - m.oy) / m.sy };
}

// ---------------------------------------------------------------------------
// Dynamic fixtures (served with page.route; same compact format as scripts/gen-replay.mjs)
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Wander slowly around the frame centre for leadSeconds (no dwell), glide to `at`, hold still. */
export function dwellAtFixture(at: { x: number; y: number }, { leadSeconds = 6, holdSeconds = 20, name = "dwell-at" } = {}) {
  const rand = mulberry32(7);
  const pts: Array<[number, number, number, number]> = [];
  const fps = 30;
  let f = 0;
  const push = (x: number, y: number) => {
    pts.push([Math.round((f * 1000) / fps), +(x + (rand() - 0.5) * 0.4).toFixed(2), +(y + (rand() - 0.5) * 0.4).toFixed(2), 0.95]);
    f++;
  };
  // Lead-in: circle r 40 px at 0.6 Hz (≈ 150 px/s), never slow enough to count as a dwell.
  const wx = (s: number) => 320 + 40 * Math.cos(2 * Math.PI * 0.6 * s);
  const wy = (s: number) => 240 + 40 * Math.sin(2 * Math.PI * 0.6 * s);
  for (let i = 0; i < leadSeconds * fps; i++) push(wx(i / fps), wy(i / fps));
  const from = { x: wx(leadSeconds), y: wy(leadSeconds) };
  const glide = Math.max(1, Math.round((Math.hypot(at.x - from.x, at.y - from.y) / 150) * fps));
  for (let i = 1; i <= glide; i++) push(from.x + ((at.x - from.x) * i) / glide, from.y + ((at.y - from.y) * i) / glide);
  for (let i = 0; i < holdSeconds * fps; i++) push(at.x, at.y);
  return { format: "compact", name, fps, width: 640, height: 480, landmark: 5, handedness: "Right", loop: false, points: pts };
}

/**
 * A committed fixture with `seconds` of slow wandering (never still) prepended, so a test has time to
 * flip settings (e.g. "Draw in Krita") before the interesting part starts. Served as `<name>-lead`.
 */
export async function serveWithLead(page: Page, name: string, seconds = 6): Promise<string> {
  const file = path.join(__dirname, "../fixtures/replay", `${name}.json`);
  const f = JSON.parse(fs.readFileSync(file, "utf8")) as { points: Array<[number, number, number, number] | null> };
  const first = f.points.find((p) => p !== null) ?? [0, 320, 240, 0.95];
  const fps = 30;
  const n = Math.round(seconds * fps);
  const lead: Array<[number, number, number, number]> = [];
  for (let i = 0; i < n; i++) {
    // circle (r 40 px, 0.6 Hz ≈ 150 px/s, never still) that starts and ends on the fixture's first point
    const a = 2 * Math.PI * (Math.round(0.6 * seconds) / seconds) * (i / fps);
    lead.push([Math.round((i * 1000) / fps), +(first[1] - 40 + 40 * Math.cos(a)).toFixed(2), +(first[2] + 40 * Math.sin(a)).toFixed(2), 0.95]);
  }
  const shift = Math.round((n * 1000) / fps);
  const points = [...lead, ...f.points.map((p) => (p === null ? null : ([p[0] + shift, p[1], p[2], p[3]] as [number, number, number, number])))];
  const out = `${name}-lead`;
  await serveFixture(page, out, { ...f, name: out, points });
  return out;
}

export async function serveFixture(page: Page, name: string, body: unknown): Promise<void> {
  // context.route also covers the dedicated Worker that fetches the replay file.
  await page.context().route(`**/replay/${name}.json`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }),
  );
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function note(testInfo: TestInfo, type: string, description: string): void {
  testInfo.annotations.push({ type, description });
  console.log(`[${type}] ${testInfo.title}: ${description}`);
}

export { expect };
