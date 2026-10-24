/**
 * @P2a Playwright: the typed-command box (same grammar as voice).
 * §10: typed "steadier" moves the slider; typed "blue" produces a `krita` message; keys do nothing
 * inside the typed box.
 *
 * The typed box is found by role textbox with an accessible name containing "command" or "type".
 */
import { test } from "@playwright/test";
import {
  expect,
  fakeHelper,
  openPanelPage,
  openSteady,
  sliderValue,
  state,
  steadinessSlider,
  strokeCount,
  typeCommand,
  typedBox,
  waitForHelperOpen,
} from "./helpers";

test.describe("P2a typed box", () => {
  test("@P2a typed \"steadier\" moves the Steadiness slider +10", async ({ page }) => {
    await openSteady(page, { replay: "rest-still", helper: "off" });
    if (!(await steadinessSlider(page).isVisible().catch(() => false))) await openPanelPage(page, "Steady");
    const slider = steadinessSlider(page);
    const v0 = await sliderValue(slider);
    await typeCommand(page, "steadier");
    await expect.poll(async () => (await state(page)).steadiness).toBe(Math.min(100, v0 + 10));
    if (!(await slider.isVisible().catch(() => false))) await openPanelPage(page, "Steady");
    await expect.poll(() => sliderValue(slider)).toBe(Math.min(100, v0 + 10));
  });

  test("@P2a typed \"blue\" produces a krita message", async ({ page }) => {
    test.skip(!(await fakeHelper.available()), "fake helper not running");
    await fakeHelper.reset();
    await openSteady(page, { replay: "rest-still", helper: "fake" });
    await waitForHelperOpen(page);
    await fakeHelper.send({ t: "krita_state", connected: true });
    await page.waitForTimeout(500);
    await typeCommand(page, "blue");
    await expect
      .poll(async () => (await fakeHelper.messages()).find((m) => m.t === "krita" && m.cmd === "color"), { timeout: 5_000 })
      .toMatchObject({ t: "krita", cmd: "color", hex: "#1d4ed8" });
  });

  test("@P2a keys do nothing inside the typed box", async ({ page }) => {
    await openSteady(page, { replay: "rest-still", helper: "off" });
    const box = await typedBox(page);
    await box.focus();
    const before = await state(page);
    const strokes = await strokeCount(page);
    for (const key of ["F8", "F9", "F7", "F6", "F5", "F3"]) await page.keyboard.press(key);
    await page.keyboard.type("down");
    await page.waitForTimeout(500);
    const after = await state(page);
    expect(after.pen).toBe(before.pen);
    expect(after.paused).toBe(before.paused);
    expect(after.latch).toBe(before.latch);
    expect(await strokeCount(page)).toBe(strokes);
    await expect(box).toHaveValue("down");
    await expect(box).toBeFocused();
  });
});
