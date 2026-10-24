/**
 * @P0 Playwright: ReplaySource, no helper (?helper=off), practice canvas only.
 * §10: calibration steps 1–2 complete; dwell toggles pen on the practice canvas; a stroke appears;
 * the Steadiness ± tiles move the slider; the Undo key undoes; per-page scrollHeight ≤ clientHeight
 * at 100 %; axe report (hard gate only with AXE_GATE=1).
 */
import { test } from "@playwright/test";
import {
  expect,
  inkedPixels,
  openPanelPage,
  openSteady,
  pageTab,
  plusMinusTiles,
  practiceCanvas,
  sliderValue,
  state,
  steadinessSlider,
  strokeCount,
  summary,
  tile,
  waitForState,
  CALIBRATION_KEY,
} from "./helpers";
import type { Page } from "@playwright/test";

/** Load the word fixture; fall back to a cold start with calibration if the stored one isn't used. */
async function drawWord(page: Page): Promise<void> {
  // openSteady applies the seeded calibration via Setup › "Use last setup" (drawing uncalibrated is also allowed).
  await openSteady(page, { replay: "dwell-stroke-word", helper: "off" });
}

test.describe("P0 practice canvas", () => {
  // Practice mode: a normal Chrome window, panel beside the practice canvas. (In the 320 px strip the
  // canvas stacks below the fold; the strip is the Krita layout.)
  test.use({ viewport: { width: 1280, height: 900 } });
  test("@P0 calibration steps 1–2 complete", async ({ page }) => {
    await openSteady(page, { replay: "calibration-sequence", helper: "off", calibrated: false });
    const seen = new Set<number>();
    // Calibration may start on first run; if not, press the Recalibrate tile (Setup page).
    await page.waitForTimeout(1500);
    let s = await state(page);
    if (!s.calibrating && !s.calibrated) {
      const recal = tile(page, "Recalibrate");
      if (!(await recal.isVisible().catch(() => false))) await openPanelPage(page, "Setup");
      await recal.click();
    }
    const end = Date.now() + 40_000;
    while (Date.now() < end) {
      s = await state(page);
      if (s.calibrating) seen.add(s.calibrating.step);
      if (s.calibrated && !s.calibrating && seen.size > 0) break;
      await page.waitForTimeout(100);
    }
    expect(seen.has(1), `step 1 seen (steps seen: ${[...seen]})`).toBe(true);
    expect(seen.has(2), `step 2 seen (steps seen: ${[...seen]})`).toBe(true);
    expect(s.calibrated, `calibrated; last state ${JSON.stringify(summary(s))}`).toBe(true);
    expect(s.gain).toBeGreaterThanOrEqual(2);
    expect(s.gain).toBeLessThanOrEqual(4);
    const stored = await page.evaluate((k) => window.localStorage.getItem(k), CALIBRATION_KEY);
    expect(stored, "calibration persisted to localStorage").not.toBeNull();
  });

  test("@P0 dwell toggles pen on the practice canvas and a stroke appears", async ({ page }) => {
    await drawWord(page);
    const before = await strokeCount(page);
    const down = await waitForState(page, (s) => s.pen === "DRAWING", { timeout: 20_000, what: "pen DRAWING after a still hold" });
    expect(down.target).toBe("canvas");
    await waitForState(page, (s) => s.pen === "HOVER", { timeout: 25_000, what: "pen back to HOVER after the pen-up hold" });
    await expect.poll(() => strokeCount(page), { timeout: 5_000 }).toBeGreaterThan(before);
    expect(await inkedPixels(page), "practice canvas has ink").toBeGreaterThan(20);
    // The word fixture ends drifting away: no second stroke may start by itself.
    await page.waitForTimeout(2500);
    expect(await strokeCount(page)).toBe(before + 1);
  });

  test("@P0 a resting hand toggles the pen at most once", async ({ page }) => {
    // §3 arming: a hand that rests toggles at most once (the dwell lowers it; it never re-toggles).
    await openSteady(page, { replay: "rest-still", helper: "off" });
    let downs = 0;
    let prev = (await state(page)).pen;
    const end = Date.now() + 5_500;
    while (Date.now() < end) {
      const pen = (await state(page)).pen;
      if (prev === "HOVER" && pen === "DRAWING") downs++;
      prev = pen;
      await page.waitForTimeout(50);
    }
    expect(downs).toBeLessThanOrEqual(1);
  });

  test("@P0 Steadiness ± tiles move the slider", async ({ page }) => {
    await openSteady(page, { replay: "rest-still", helper: "off" });
    if (!(await steadinessSlider(page).isVisible().catch(() => false))) await openPanelPage(page, "Steady");
    const slider = steadinessSlider(page);
    await expect(slider).toBeVisible();
    await expect(slider).toHaveAttribute("aria-valuetext", /.+/);
    const { minus, plus } = await plusMinusTiles(page, slider);
    const v0 = await sliderValue(slider);
    await plus.click();
    await expect.poll(() => sliderValue(slider)).toBe(Math.min(100, v0 + 5));
    await minus.click();
    await minus.click();
    await expect.poll(() => sliderValue(slider)).toBe(Math.max(0, v0 - 5));
    await expect.poll(async () => (await state(page)).steadiness).toBe(Math.max(0, v0 - 5));
    // Tiles are ≥ 64×64 (§0 rule 6).
    for (const b of [minus, plus]) {
      const box = await b.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(64);
      expect(box!.height).toBeGreaterThanOrEqual(64);
    }
  });

  test("@P0 the Undo key undoes", async ({ page }) => {
    await drawWord(page);
    await waitForState(page, (s) => s.pen === "DRAWING", { timeout: 20_000, what: "pen down" });
    await waitForState(page, (s) => s.pen === "HOVER", { timeout: 25_000, what: "pen up" });
    await expect.poll(() => strokeCount(page), { timeout: 5_000 }).toBeGreaterThan(0);
    const n = await strokeCount(page);
    const canvas = practiceCanvas(page);
    await canvas.focus();
    await page.keyboard.press("F7");
    await expect.poll(() => strokeCount(page), { timeout: 3_000 }).toBe(n - 1);
    // The persistent "Undo: <last action>" affordance (§0 rule 7) exists as a tile.
    await expect(page.getByRole("button", { name: /^Undo/ }).first()).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Per-page fit at 320 × 900, 100 % (§0 rule 6)
// ---------------------------------------------------------------------------

const PAGES: Array<[string, string]> = [
  ["Steady", "@P0"],
  ["Setup", "@P0"],
  ["Timing", "@P0"],
  ["Demo", "@P1"],
  ["Paint", "@P2a"],
  ["Colour", "@P2a"],
  ["View", "@P2a"],
  ["Layers", "@P2a"],
  // Added in the P4 page reshuffle (B): Gain/Mark corners/App → Krita; input toggles/Pointer point/Head mode → Input; hatch options → Modes.
  ["Modes", "@P4"],
  ["Input", "@P4"],
  ["Krita", "@P4"],
];

for (const [name, tag] of PAGES) {
  test(`${tag} page "${name}" fits 320×900 at 100 % without scrolling`, async ({ page }, testInfo) => {
    await openSteady(page, { replay: "rest-still", helper: "off", demo: true });
    const tab = await pageTab(page, name);
    expect(tab, `page tab "${name}" exists`).not.toBeNull();
    await tab!.click();
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const panel =
        (Array.from(document.querySelectorAll('[role="tabpanel"], [data-page]')) as HTMLElement[]).find(
          (e) => e.offsetParent !== null,
        ) ?? null;
      const doc = document.scrollingElement as HTMLElement;
      return {
        panel: panel ? { sh: panel.scrollHeight, ch: panel.clientHeight } : null,
        doc: { sh: doc.scrollHeight, ch: doc.clientHeight },
      };
    });
    expect(m.panel, 'a visible role="tabpanel" (or [data-page]) container').not.toBeNull();
    expect(m.panel!.sh, `panel scrollHeight ${m.panel!.sh} ≤ clientHeight ${m.panel!.ch}`).toBeLessThanOrEqual(m.panel!.ch);
    // The practice canvas / camera may stack below the 320 px panel, so the document itself may scroll;
    // only the page container is asserted (§0 rule 6). Logged for information.
    testInfo.annotations.push({ type: "document", description: `scrollHeight ${m.doc.sh} / clientHeight ${m.doc.ch}` });
  });
}
