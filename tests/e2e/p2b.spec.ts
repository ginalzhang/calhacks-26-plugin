/**
 * @P2b Playwright: stroke-mode tiles, quiet mode, aliases, destructive dialogs, break nudge.
 * Names: tiles by actions.ts label (exact), toggles expose aria-pressed; dialogs are role="alertdialog".
 */
import { test } from "@playwright/test";
import {
  expect,
  fakeHelper,
  openPanelPage,
  openSteady,
  state,
  statusText,
  tile,
  typeCommand,
  waitForHelperOpen,
  waitForState,
  type HelperMsg,
} from "./helpers";

const ALIASES_KEY = "steady.aliases.v1";

test.describe("P2b without a helper", () => {
  test("@P2b Hatch tile toggles Hatch and the status says 'Hatch: forward passes only'", async ({ page }) => {
    await openSteady(page, { replay: "rest-still", helper: "off" });
    await openPanelPage(page, "Steady");
    const hatch = tile(page, "Hatch");
    await expect(hatch).toBeEnabled();
    await expect(hatch).toHaveAttribute("aria-pressed", "false");
    await hatch.click();
    await expect(hatch).toHaveAttribute("aria-pressed", "true");
    await waitForState(page, (s) => s.mode === "hatch" || s.mode === "hatch_alternate", { timeout: 3_000, what: "mode hatch" });
    await expect.poll(() => statusText(page)).toMatch(/Hatch: forward passes only/);
    // Exit by the same tile (also: pen key, "stop hatching", "brush", Pause).
    await hatch.click();
    await expect(hatch).toHaveAttribute("aria-pressed", "false");
    await waitForState(page, (s) => s.mode === "normal", { timeout: 3_000, what: "mode normal after Hatch off" });
  });

  test("@P2b quiet mode turns the Mic off", async ({ page }) => {
    await openSteady(page, { replay: "rest-still", helper: "off" });
    await openPanelPage(page, "Steady");
    const quiet = tile(page, "Quiet");
    await expect(quiet).toBeEnabled();
    await quiet.click();
    await expect(quiet).toHaveAttribute("aria-pressed", "true");
    const mic = tile(page, "Mic");
    await expect(mic).toHaveAttribute("aria-pressed", "false");
    // While quiet, pressing Mic must not open it.
    if (await mic.isEnabled()) {
      await mic.click();
      await expect(mic).toHaveAttribute("aria-pressed", "false");
    }
    await quiet.click();
    await expect(quiet).toHaveAttribute("aria-pressed", "false");
  });

  test("@P2b break nudge appears after 20 min with the pen up, shows session time, and 'Later' dismisses it", async ({ page }) => {
    await openSteady(page, { replay: "rest-still", helper: "off" }); // not ?demo=1: the nudge is off in Demo mode
    const hasHook = await page.evaluate(
      () => typeof (window as unknown as { __steady?: { advanceSessionClock?: unknown } }).__steady?.advanceSessionClock === "function",
    );
    expect(hasHook, "MISSING HOOK: window.__steady.advanceSessionClock(ms) (requested in DECISIONS.md) so tests need not wait 20 min").toBe(true);
    await page.evaluate(() =>
      (window as unknown as { __steady: { advanceSessionClock: (ms: number) => void } }).__steady.advanceSessionClock(20 * 60 * 1000 + 1000),
    );
    const later = tile(page, "Later");
    await expect(later).toBeVisible({ timeout: 5_000 });
    // Non-blocking: no modal, the rest of the panel still works, and it shows elapsed session time.
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByText(/\b20\b/).first()).toBeVisible();
    await later.click();
    await expect(later).toBeHidden();
  });
});

test.describe("P2b with the fake helper", () => {
  test.beforeEach(async () => {
    test.skip(!(await fakeHelper.available()), "fake helper not reachable");
    await fakeHelper.reset();
    await fakeHelper.config({ krita: true });
  });

  test("@P2b typed 'alias fluffy' names the current brush; 'alias blue' is refused as taken", async ({ page }) => {
    await openSteady(page, { replay: "rest-still", helper: "fake" });
    await waitForHelperOpen(page);
    await fakeHelper.send({ t: "krita_state", connected: true });
    await page.waitForTimeout(800); // let list_presets / get_state replies land
    await typeCommand(page, "alias fluffy");
    await expect
      .poll(async () => page.evaluate((k) => window.localStorage.getItem(k) ?? "", ALIASES_KEY), { timeout: 5_000 })
      .toMatch(/fluffy/);
    await typeCommand(page, "alias blue");
    await expect.poll(() => statusText(page)).toMatch(/That word is taken/);
    expect(await page.evaluate((k) => window.localStorage.getItem(k) ?? "", ALIASES_KEY)).not.toMatch(/"blue"/);
    // Using the alias selects the stored preset through the plugin.
    await fakeHelper.reset();
    await typeCommand(page, "fluffy");
    await expect
      .poll(async () => (await fakeHelper.messages()).find((m) => m.t === "krita" && m.cmd === "preset"), { timeout: 5_000 })
      .toBeTruthy();
  });

  test("@P2b Delete layer: alertdialog, focus on Cancel, Esc cancels, typed 'yes' confirms and reaches Krita", async ({ page }) => {
    await openSteady(page, { replay: "rest-still", helper: "fake" });
    await waitForHelperOpen(page);
    await fakeHelper.send({ t: "krita_state", connected: true });
    await page.waitForTimeout(800);
    await openPanelPage(page, "Layers");
    const del = tile(page, "Delete layer");
    await expect(del).toBeEnabled();
    await del.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await expect(dialog.getByRole("button", { name: "Confirm", exact: true })).toBeVisible();
    // Esc cancels, nothing reaches Krita, focus returns to the invoking tile.
    await fakeHelper.reset();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(del).toBeFocused();
    await page.waitForTimeout(300);
    const destructive = (msgs: HelperMsg[]) =>
      msgs.filter((m) => (m.t === "krita" && !["list_actions", "list_presets", "get_state", "canvas_rect", "window_rect", "session_init", "ping"].includes(String(m.cmd))) || m.t === "keys");
    expect(destructive(await fakeHelper.messages()), "Esc sends nothing to Krita").toEqual([]);
    // Reopen; typed "yes" (the typed-command path) confirms.
    await del.click();
    await expect(dialog).toBeVisible();
    await page.evaluate(() => (window as unknown as { __steady: { typed: (t: string) => Promise<void> } }).__steady.typed("yes"));
    await expect(dialog).toBeHidden();
    await expect.poll(async () => destructive(await fakeHelper.messages()).length, { timeout: 5_000 }).toBeGreaterThan(0);
    expect((await state(page)).paused).toBe(false);
  });
});
