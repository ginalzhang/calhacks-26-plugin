/**
 * @P1 integration (agent H): the real page (Worker + helperClient) against the REAL helper process
 * (sealed: tests/integration/safe_helper.py --no-pointer --no-hotkeys --no-overlay) and the REAL plugin
 * bridge (tests/integration/fake_krita_bridge.py, fake adapter). Servers: playwright.integration.config.ts.
 */
import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import type { SteadyTestHooks } from "../../src/pipeline/types";
import { expect, openPanelPage, seedCalibration, state, waitForHooks, waitForState } from "../e2e/helpers";

const HELPER_PORT = process.env.INTEG_HELPER_PORT ?? "28865";
const OUT = process.env.INTEG_OUT ?? "/tmp/steady-integration";
const HELPER_WS = `ws://127.0.0.1:${HELPER_PORT}`;
const helperLog = () => fs.readFileSync(path.join(OUT, "helper.log"), "utf8");
const bridgeLog = () => fs.readFileSync(path.join(OUT, "bridge.log"), "utf8");

function url(extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ source: "replay", replay: "dwell-stroke-word", helper: HELPER_WS, target: "krita", ...extra });
  return `/?${q.toString()}`;
}

type Sent = { t?: string; cmd?: string };
const sent = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as { __steady: SteadyTestHooks }).__steady.sentToHelper() as unknown[]) as Promise<Sent[]>;

test.describe("page ↔ real helper", () => {
  test.afterEach(() => {
    // The shim logs INTEGRATION-BLOCKED whenever the helper tried to post a real event/key or activate Krita.
    expect(helperLog(), "helper attempted a real input event (sealed by the shim)").not.toContain("INTEGRATION-BLOCKED");
  });

  test("@P1 real helper: connection opens, hello arrives, pings flow, Krita bridge session", async ({ page }) => {
    await seedCalibration(page);
    await page.goto(url());
    await waitForHooks(page);

    const s = await waitForState(page, (m) => m.helper === "open" && m.helperHello !== null, {
      timeout: 20_000,
      what: "helper open + hello from the real helper",
    });
    const hello = s.helperHello!;
    expect(hello.t).toBe("hello");
    expect(hello.version).toMatch(/^\d+\.\d+/);
    expect(hello.screen.w).toBeGreaterThan(0);
    expect(typeof hello.accessibility).toBe("boolean");

    // pings → pongs: the Worker measures a round trip
    const withRtt = await waitForState(page, (m) => m.helperRttMs !== null, { timeout: 10_000, what: "helperRttMs non-null" });
    expect(withRtt.helperRttMs!).toBeGreaterThanOrEqual(0);
    expect(withRtt.helperRttMs!).toBeLessThan(250);
    expect((await sent(page)).some((m) => m.t === "ping" || m.t === "move")).toBe(true);

    // helper relay → real bridge: krita_state connected reaches the page, and the Worker's session
    // commands (session_init, list_actions, list_presets, canvas_rect) arrive at the plugin's dispatcher.
    await waitForState(page, (m) => m.kritaConnected, { timeout: 10_000, what: "kritaConnected via the real relay" });
    await expect.poll(() => bridgeLog(), { timeout: 10_000 }).toContain(`"cmd":"session_init"`);
    const blog = bridgeLog();
    for (const cmd of ["list_actions", "list_presets", "canvas_rect"]) expect(blog, `bridge saw ${cmd}`).toContain(`"cmd":"${cmd}"`);

    // target krita + replay: the pointer stream reaches the real helper (FakeMouse in --no-pointer mode).
    expect((await state(page)).target).toBe("krita");
    await expect.poll(async () => (await sent(page)).filter((m) => m.t === "move").length, { timeout: 15_000 }).toBeGreaterThan(5);
    expect(helperLog()).toContain(`listening on ws://127.0.0.1:${HELPER_PORT}`);
  });

  test("@P1 real helper: Demo metrics show the helper round trip", async ({ page }) => {
    await seedCalibration(page);
    await page.goto(url({ demo: "1" }));
    await waitForHooks(page);
    await waitForState(page, (m) => m.helper === "open" && m.helperRttMs !== null, { timeout: 20_000, what: "helper open with rtt" });
    await openPanelPage(page, "Demo");
    const rtt = page.locator('[data-metric="helper-rtt"]');
    await expect(rtt).toBeVisible();
    await expect(rtt).toHaveText(/^\d+ ms$/, { timeout: 10_000 });
  });

  test("@P1 real helper: a dwell stroke reaches the helper (down refused in pointer-less mode, up follows)", async ({ page }, testInfo) => {
    await seedCalibration(page);
    await page.goto(url());
    await waitForHooks(page);
    await waitForState(page, (m) => m.helper === "open", { timeout: 20_000, what: "helper open" });
    // dwell-stroke-word: hold 2.5 s (pen down), write 'mum', hold 3.5 s (pen up). ~15 s in real time.
    await expect.poll(async () => (await sent(page)).some((m) => m.t === "down"), { timeout: 25_000 }).toBe(true);
    // The real helper received `down` and, being pointer-less (no Accessibility / --no-pointer), refused it.
    await expect.poll(() => helperLog(), { timeout: 5_000 }).toMatch(/< TEXT '\{"t":"down"/);
    expect(helperLog()).toMatch(/> TEXT '\{"t": "error".*accessibility/);
    await expect.poll(async () => (await sent(page)).some((m) => m.t === "up"), { timeout: 25_000 }).toBe(true);
    const s = await state(page);
    expect(s.helper).toBe("open");
    testInfo.annotations.push({ type: "page-after-refused-down", description: `pen=${String((s as unknown as { pen?: string }).pen)} status=${String(s.status)}` });
  });
});
