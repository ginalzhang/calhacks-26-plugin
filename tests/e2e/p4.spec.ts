/**
 * @P4 Playwright: hand presets, profiles, numbered overlay for Krita widgets, app profile (Photoshop).
 * Names: tiles by actions.ts label (exact). Values from §2 "Hand presets".
 */
import { test } from "@playwright/test";
import {
  expect,
  fakeHelper,
  findTile,
  openPanelPage,
  openSteady,
  state,
  statusText,
  targetKrita,
  tile,
  typeCommand,
  waitForHelperOpen,
  type HelperMsg,
} from "./helpers";

const SETTINGS_KEY = "steady.settings.v1";

async function settings(page: import("@playwright/test").Page): Promise<Record<string, unknown>> {
  return page.evaluate((k) => JSON.parse(window.localStorage.getItem(k) ?? "{}"), SETTINGS_KEY);
}

/** §2: name → expected values. Only what each preset documents is asserted. */
const PRESETS: Array<{ label: string; steadiness: number; gain?: number; dwellDownMs?: number; latch?: boolean }> = [
  { label: "Sore joints, steady hand", steadiness: 25, gain: 3 },
  { label: "Shakes when holding still or reaching", steadiness: 70 },
  { label: "Slow movements, shakes at rest", steadiness: 45, gain: 4, dwellDownMs: 1200, latch: true },
  { label: "Hard to hold still", steadiness: 60, latch: true },
];

test.describe("P4 without a helper", () => {
  test("@P4 hand preset tiles set the documented values", async ({ page }) => {
    await openSteady(page, { replay: "rest-still", helper: "off" });
    for (const p of PRESETS) {
      const t = await findTile(page, p.label);
      await expect(t, `"${p.label}" tile enabled (P4)`).toBeEnabled({ timeout: 3_000 });
      await t.click();
      await expect.poll(async () => (await state(page)).steadiness, { message: `${p.label}: Steadiness` }).toBe(p.steadiness);
      if (p.gain !== undefined) await expect.poll(async () => (await state(page)).gain, { message: `${p.label}: gain` }).toBe(p.gain);
      if (p.latch !== undefined) await expect.poll(async () => (await state(page)).latch, { message: `${p.label}: Latch` }).toBe(p.latch);
      if (p.dwellDownMs !== undefined) {
        await expect.poll(async () => (await settings(page)).dwellDownMs, { message: `${p.label}: pen-down dwell` }).toBe(p.dwellDownMs);
      }
    }
    // "Hard to hold still" shows the pedal tip once (non-blocking).
    await expect.poll(() => statusText(page)).toMatch(/pedal|pen key|say up/i);
  });

  test("@P4 profile save / use round-trip", async ({ page }) => {
    await openSteady(page, { replay: "rest-still", helper: "off" });
    await (await findTile(page, "Steadiness down")).click(); // 50 → 45
    await expect.poll(async () => (await state(page)).steadiness).toBe(45);
    await typeCommand(page, "save profile evening");
    await expect.poll(() => statusText(page)).toMatch(/evening/i);
    await (await findTile(page, "Steadiness up")).click();
    await tile(page, "Steadiness up").click(); // → 55
    await expect.poll(async () => (await state(page)).steadiness).toBe(55);
    await typeCommand(page, "profile evening");
    await expect.poll(async () => (await state(page)).steadiness).toBe(45);
    // Pre-created profiles exist (§0 rule 8).
    await openPanelPage(page, "Setup");
    await expect(page.getByText(/Steady day/).first()).toBeVisible();
    await expect(page.getByText(/Shaky day/).first()).toBeVisible();
  });
});

const WIDGETS = [
  { n: 1, label: "Freehand brush tool", rect: { x: 100, y: 200, w: 40, h: 40 } },
  { n: 2, label: "Eraser", rect: { x: 100, y: 260, w: 40, h: 40 } },
  { n: 3, label: "Fill tool", rect: { x: 100, y: 320, w: 40, h: 40 } },
];

test.describe("P4 with the fake helper", () => {
  test.beforeEach(async () => {
    test.skip(!(await fakeHelper.available()), "fake helper not reachable");
    await fakeHelper.reset();
    await fakeHelper.config({ krita: true, payloads: { list_widgets: { widgets: WIDGETS } } });
  });

  test("@P4 Show numbers sends a numbers message; 'click 1' clicks the item's centre", async ({ page }) => {
    await openSteady(page, { replay: "wander", helper: "fake" });
    await waitForHelperOpen(page);
    await fakeHelper.send({ t: "krita_state", connected: true });
    await page.waitForTimeout(800);
    const show = await findTile(page, "Show numbers");
    await expect(show).toBeEnabled({ timeout: 3_000 });
    await show.click();
    let numbers: HelperMsg | undefined;
    await expect
      .poll(async () => {
        numbers = (await fakeHelper.messages()).find((m) => m.t === "numbers" && Array.isArray(m.items));
        return !!numbers;
      }, { message: "helper received numbers {items}", timeout: 5_000 })
      .toBe(true);
    const items = numbers!.items as Array<{ n: number; rect: { x: number; y: number; w: number; h: number } }>;
    expect(items.length).toBeGreaterThan(0);
    const one = items.find((i) => i.n === 1)!;
    expect(one, "item 1 exists").toBeTruthy();
    await fakeHelper.reset();
    await typeCommand(page, "click 1");
    let click: HelperMsg | undefined;
    await expect
      .poll(async () => {
        click = (await fakeHelper.messages()).find((m) => m.t === "click");
        return !!click;
      }, { message: "helper received click", timeout: 5_000 })
      .toBe(true);
    expect(Number(click!.x)).toBeCloseTo(one.rect.x + one.rect.w / 2, 0);
    expect(Number(click!.y)).toBeCloseTo(one.rect.y + one.rect.h / 2, 0);
    // Hide numbers clears the badges.
    await fakeHelper.reset();
    await typeCommand(page, "hide numbers");
    await expect
      .poll(async () => (await fakeHelper.messages()).some((m) => m.t === "numbers" && m.items === null), { timeout: 5_000 })
      .toBe(true);
  });

  test("@P4 app profile Photoshop: typed 'undo' sends keys cmd+z, not a krita message", async ({ page }) => {
    await openSteady(page, { replay: "wander", helper: "fake" });
    await waitForHelperOpen(page);
    await fakeHelper.send({ t: "krita_state", connected: true });
    await targetKrita(page);
    await typeCommand(page, "photoshop mode");
    await expect.poll(() => statusText(page)).toMatch(/photoshop/i);
    await fakeHelper.reset();
    await typeCommand(page, "undo");
    await expect
      .poll(async () => (await fakeHelper.messages()).find((m) => m.t === "keys"), { message: "keys message", timeout: 5_000 })
      .toMatchObject({ t: "keys", combo: "cmd+z" });
    const krita = (await fakeHelper.messages()).filter((m) => m.t === "krita" && m.cmd === "action");
    expect(krita, "no krita action while the Photoshop profile is on").toEqual([]);
    // Back to Krita: undo goes through the plugin again.
    await typeCommand(page, "krita mode");
    await fakeHelper.reset();
    await typeCommand(page, "undo");
    await expect
      .poll(async () => (await fakeHelper.messages()).some((m) => m.t === "krita" || m.t === "keys"), { timeout: 5_000 })
      .toBe(true);
    expect((await fakeHelper.messages()).some((m) => m.t === "krita")).toBe(true);
  });
});
