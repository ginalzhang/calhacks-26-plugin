/**
 * @P3 Playwright: smoothing presets. Sketch / Ink mode / Shade tiles set Steadiness to 25 / 70 / 10 (§2).
 */
import { test } from "@playwright/test";
import { expect, findTile, openPanelPage, openSteady, sliderValue, state, steadinessSlider } from "./helpers";

const PRESETS: Array<[string, number]> = [
  ["Sketch", 25],
  ["Ink mode", 70],
  ["Shade", 10],
];

test.describe("P3 smoothing presets", () => {
  test("@P3 Sketch / Ink mode / Shade tiles move Steadiness to 25 / 70 / 10", async ({ page }) => {
    await openSteady(page, { replay: "rest-still", helper: "off" });
    const slider = steadinessSlider(page);
    for (const [label, value] of PRESETS) {
      const t = await findTile(page, label);
      await expect(t, `"${label}" tile enabled (P3)`).toBeEnabled({ timeout: 3_000 });
      await t.click();
      await expect.poll(async () => (await state(page)).steadiness, { message: `${label} → ${value}` }).toBe(value);
      await openPanelPage(page, "Steady");
      await expect.poll(() => sliderValue(slider)).toBe(value);
    }
  });
});
