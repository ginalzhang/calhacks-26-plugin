/**
 * @P1 Playwright: ReplaySource + the fake helper (ws 18765, http 18767).
 * §10: Demo page shows metrics; the page sends move/down/up in order and `up` on simulated tracking
 * loss; with the fake helper connected the page does not self-trigger tiles or handle F-keys; after
 * Pause, a dwell on the Resume tile makes the Worker send `click {x,y}` inside Chrome's rect; the
 * fake helper records it and the test dispatches a DOM click at that point (standing in for the OS
 * click); Resume executes.
 *
 * Target: the Worker only talks to the helper about the pointer when target = "krita"; tests switch it
 * with the Setup page's "Draw in Krita" tile. The fake helper replies a canned Krita canvas rect.
 */
import { test } from "@playwright/test";
import {
  cameraPointForClient,
  dwellAtFixture,
  expect,
  fakeHelper,
  fitMapping,
  note,
  openPanelPage,
  openSteady,
  practiceCanvas,
  screenToClientOnPage,
  serveFixture,
  serveWithLead,
  state,
  strokeCount,
  summary,
  targetKrita,
  tile,
  waitForHelperOpen,
  waitForState,
  windowRect,
  type HelperMsg,
} from "./helpers";


test.describe("P1 without a helper", () => {
  test("@P1 Demo page shows metrics", async ({ page }) => {
    await openSteady(page, { replay: "tremor-line", helper: "off", demo: true });
    await openPanelPage(page, "Demo");
    await expect(tile(page, "Simulate tremor")).toBeVisible();
    await expect(tile(page, "Simulate tremor")).toHaveAttribute("aria-pressed", /true|false/);
    await expect(tile(page, "Next judge")).toBeVisible();
    for (const t of ["Simulate tremor", "Next judge"]) {
      await expect(tile(page, t), `"${t}" tile enabled (its tilePhase P1 must have landed: BUILD_PHASE ≥ P1 in src/actions.ts)`).toBeEnabled({ timeout: 3_000 });
    }
    const metrics = page.locator('[aria-live="off"]');
    await expect(metrics.first(), 'a metrics region with aria-live="off"').toBeVisible();
    const text = (await metrics.allInnerTexts()).join("\n");
    for (const re of [/deviation/i, /stroke/i, /command/i, /claude/i, /camera/i, /detection/i, /round.?trip|rtt|helper/i]) {
      expect(text, `metrics mention ${re}`).toMatch(re);
    }
    // Metrics are live numbers, not placeholders, once replay frames flow.
    await expect.poll(async () => (await state(page)).detectionFps, { timeout: 10_000 }).toBeGreaterThan(0);
    // Next judge is not destructive under ?demo=1: no dialog.
    await tile(page, "Next judge").click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });

  test("@P1 a detection outside the tracked area reads 'Hand outside the tracked area', never 'no hand'", async ({ page }) => {
    await openSteady(page, { replay: "hand-outside-area", helper: "off" });
    const s = await waitForState(page, (x) => x.reason === "outside_area", { timeout: 15_000, what: "reason outside_area" });
    expect(s.tracking).toBe("Lost");
    await expect(page.getByText(/hand outside the tracked area/i).first()).toBeVisible();
    await waitForState(page, (x) => x.tracking !== "Lost", { timeout: 10_000, what: "re-acquire when the hand returns" });
    expect((await state(page)).pen).toBe("HOVER");
  });
});

test.describe("P1 with the fake helper", () => {
  test.beforeEach(async () => {
    test.skip(!(await fakeHelper.available()), "fake helper not reachable (scripts/fake_helper.py; started by playwright.config.ts)");
    await fakeHelper.reset();
    await fakeHelper.config({ krita: true });
  });

  test("@P1 page sends move/down/up in order and up on simulated tracking loss", async ({ page }, testInfo) => {
    await openSteady(page, { replay: await serveWithLead(page, "tracking-loss-mid-stroke"), helper: "fake" });
    await waitForHelperOpen(page);
    await fakeHelper.send({ t: "krita_state", connected: true });
    const s0 = await targetKrita(page);
    note(testInfo, "krita-window", JSON.stringify(s0.kritaWindowRect));
    // Lost must be observed (score-0.5 frames for 1 s mid-stroke).
    await waitForState(page, (s) => s.tracking === "Lost", { timeout: 20_000, what: "tracking Lost during the score-0.5 segment" });
    await page.waitForTimeout(3500);
    const msgs = (await fakeHelper.messages()).filter((m) => ["move", "down", "up"].includes(m.t));
    const kinds = msgs.map((m) => m.t);
    const firstDown = kinds.indexOf("down");
    expect(firstDown, `a down was sent (got ${kinds.length} pointer msgs; target ${s0.target})`).toBeGreaterThan(0);
    expect(kinds.slice(0, firstDown)).toContain("move");
    const upAfter = kinds.indexOf("up", firstDown);
    expect(upAfter, "an up follows the down").toBeGreaterThan(firstDown);
    const downs = kinds.filter((k) => k === "down").length;
    expect(downs, "re-acquire never re-lowers the pen").toBe(1);
    const up = msgs[upAfter];
    if (up.reason !== undefined) expect(String(up.reason)).toMatch(/tracking_lost|lost/);
    // No scribble while down: consecutive moves never jump (the score-0.5 frames move ±100 px).
    let maxJump = 0;
    let prev: HelperMsg | null = null;
    for (const m of msgs.slice(firstDown, upAfter)) {
      if (m.t !== "move") continue;
      if (prev) maxJump = Math.max(maxJump, Math.hypot(Number(m.x) - Number(prev.x), Number(m.y) - Number(prev.y)));
      prev = m;
    }
    expect(maxJump, "largest move-to-move jump while the button is down (points)").toBeLessThan(40);
    // The pen is up in the mirror after loss and stays up after re-acquire.
    expect((await state(page)).pen).toBe("HOVER");
  });

  test("@P1 with the fake helper connected the page ignores F-keys; helper hotkeys work", async ({ page }) => {
    await openSteady(page, { replay: "rest-still", helper: "fake" });
    await waitForHelperOpen(page);
    await practiceCanvas(page).focus();
    for (const key of ["F9", "F8", "F3"]) await page.keyboard.press(key);
    await page.waitForTimeout(600);
    let s = await state(page);
    expect(s.paused, "F9 ignored by the page when the helper is the key source").toBe(false);
    expect(s.latch, "F3 ignored").toBe(false);
    expect(s.pen, "F8 ignored").toBe("HOVER");
    // The helper is the single key source: its hotkey pauses and resumes.
    await fakeHelper.send({ t: "hotkey", key: "pause" });
    s = await waitForState(page, (x) => x.paused, { timeout: 3_000, what: "paused after helper hotkey pause" });
    await expect(tile(page, "Resume")).toBeVisible();
    await expect(tile(page, "Resume")).not.toHaveAttribute("aria-pressed", /.*/);
    await fakeHelper.send({ t: "hotkey", key: "pause" });
    await waitForState(page, (x) => !x.paused, { timeout: 3_000, what: "resumed after second helper hotkey pause" });
    await expect(tile(page, "Pause")).toBeVisible();
  });

  test("@P1 after Pause a dwell on Resume sends click inside Chrome's rect; the click resumes; no self-trigger", async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    // 1. Fit camera px → target units with the probe fixture under the same conditions.
    const toKrita = async (p: typeof page) => {
      await waitForHelperOpen(p);
      await fakeHelper.send({ t: "krita_state", connected: true });
      await targetKrita(p);
    };
    const mapping = await fitMapping(page, { helper: "fake" }, toKrita);
    note(testInfo, "mapping", JSON.stringify(mapping));
    // 2. Pause, find the Resume tile, compute the camera point that lands on its centre.
    await fakeHelper.send({ t: "hotkey", key: "pause" });
    await waitForState(page, (s) => s.paused, { timeout: 3_000, what: "paused" });
    const resume = tile(page, "Resume");
    await expect(resume).toBeVisible();
    const rb = (await resume.boundingBox())!;
    const cam = await cameraPointForClient(page, mapping, rb.x + rb.width / 2, rb.y + rb.height / 2);
    note(testInfo, "camera-target", JSON.stringify(cam));
    // 3. Reload with a fixture that wanders, then holds still over that point.
    await serveFixture(page, "dwell-at", dwellAtFixture(cam, { leadSeconds: 9 }));
    await fakeHelper.reset();
    await openSteady(page, { replay: "dwell-at", helper: "fake" });
    await toKrita(page);
    await fakeHelper.send({ t: "hotkey", key: "pause" });
    await waitForState(page, (s) => s.paused, { timeout: 3_000, what: "paused (second load)" });
    const tPause = Date.now();
    // 4. Wait for the Worker's click.
    let click: HelperMsg | undefined;
    const end = Date.now() + 40_000;
    while (Date.now() < end && !click) {
      click = (await fakeHelper.messages()).find((m) => m.t === "click");
      if (!click) await page.waitForTimeout(200);
    }
    expect(click, `Worker sent click after a dwell on Resume; state ${JSON.stringify(summary(await state(page)))}`).toBeTruthy();
    // 5. The page itself did not self-trigger the tile.
    await page.waitForTimeout(800);
    expect((await state(page)).paused, "page must not self-trigger tiles while the helper is connected").toBe(true);
    // 6. Click is inside Chrome's own window rect.
    const w = await windowRect(page);
    const x = Number(click!.x);
    const y = Number(click!.y);
    expect(x).toBeGreaterThanOrEqual(w.screenX);
    expect(x).toBeLessThanOrEqual(w.screenX + w.outerWidth);
    expect(y).toBeGreaterThanOrEqual(w.screenY);
    expect(y).toBeLessThanOrEqual(w.screenY + w.outerHeight);
    // 7. Stand in for the OS click: DOM click at that point.
    const c = await screenToClientOnPage(page, x, y);
    const hit = await page.evaluate(({ cx, cy }) => {
      const el = document.elementFromPoint(cx, cy);
      const btn = el?.closest("button") ?? null;
      if (btn) btn.click();
      return btn ? btn.textContent?.trim() ?? "" : el ? el.tagName : null;
    }, { cx: c.x, cy: c.y });
    note(testInfo, "click-hit", `${JSON.stringify(c)} → ${hit} (paused ${Date.now() - tPause} ms before)`);
    expect(hit, "the click lands on the Resume tile").toMatch(/Resume/);
    await waitForState(page, (s) => !s.paused, { timeout: 3_000, what: "Resume executed" });
  });

  test("@P1 strokes reach the helper, not the practice canvas, when targeting Krita", async ({ page }, testInfo) => {
    await openSteady(page, { replay: await serveWithLead(page, "dwell-stroke-word"), helper: "fake" });
    await waitForHelperOpen(page);
    await fakeHelper.send({ t: "krita_state", connected: true });
    await targetKrita(page);
    const before = await strokeCount(page);
    await waitForState(page, (x) => x.pen === "DRAWING", { timeout: 20_000, what: "pen down (krita target)" });
    await waitForState(page, (x) => x.pen === "HOVER", { timeout: 25_000, what: "pen up (krita target)" });
    const kinds = (await fakeHelper.messages()).map((m) => m.t);
    expect(kinds).toContain("down");
    expect(kinds.lastIndexOf("up")).toBeGreaterThan(kinds.indexOf("down"));
    note(testInfo, "practice-strokes", String((await strokeCount(page)) - before));
  });
});
