/**
 * @P0 axe-core accessibility report on every side-panel page at 100 % and 200 % zoom (§0 rule 6).
 * Violations are logged and attached to the report; they fail the test only when AXE_GATE=1
 * (the lead sets it at the 22:00 freeze). Pages that do not exist yet are skipped with a note.
 *
 * 200 % zoom is emulated as Chrome does it: the 320 × 900 window becomes a 160 × 450 CSS-px
 * viewport at deviceScaleFactor 2. At 200 % vertical scrolling is allowed but the header must stay pinned.
 */
import { test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expect, note, openSteady, pageTab } from "./helpers";

const GATE = process.env.AXE_GATE === "1";
const PAGES = ["Steady", "Modes", "Setup", "Input", "Timing", "Krita", "Demo", "Paint", "Colour", "View", "Layers"];
const ZOOMS: Array<{ label: string; viewport: { width: number; height: number }; dsf: number }> = [
  { label: "100%", viewport: { width: 320, height: 900 }, dsf: 1 },
  { label: "200%", viewport: { width: 160, height: 450 }, dsf: 2 },
];

for (const z of ZOOMS) {
  test.describe(`axe at ${z.label}`, () => {
    test.use({ viewport: z.viewport, deviceScaleFactor: z.dsf });

    test(`@P0 axe report, all pages, ${z.label} zoom${GATE ? " (gate)" : ""}`, async ({ page }, testInfo) => {
      await openSteady(page, { replay: "rest-still", helper: "off", demo: true });
      const all: Array<{ page: string; id: string; impact: string | null | undefined; nodes: number; help: string }> = [];
      const missing: string[] = [];
      for (const name of PAGES) {
        const tab = await pageTab(page, name);
        if (!tab) {
          missing.push(name);
          continue;
        }
        await tab.click();
        await page.waitForTimeout(250);
        const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
        for (const v of res.violations) all.push({ page: name, id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help });
        if (z.label === "200%") {
          // Header stays pinned at 200 %: scroll to the bottom; the page tabs must still be in view.
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(100);
          const box = await tab.boundingBox();
          if (!box || box.y < -1 || box.y > z.viewport.height) {
            all.push({ page: name, id: "steady-header-not-pinned", impact: "serious", nodes: 1, help: "Header must stay pinned at 200 %" });
          }
          await page.evaluate(() => window.scrollTo(0, 0));
        }
      }
      if (missing.length) note(testInfo, "pages-missing", missing.join(", "));
      await testInfo.attach(`axe-${z.label}.json`, { body: JSON.stringify(all, null, 2), contentType: "application/json" });
      note(
        testInfo,
        "axe",
        all.length === 0 ? "0 violations" : all.map((v) => `${v.page}:${v.id}(${v.impact},${v.nodes})`).join("; "),
      );
      expect(missing.length, `no page tabs found at all`).toBeLessThan(PAGES.length);
      if (GATE) expect(all, "AXE_GATE=1: zero violations").toEqual([]);
    });
  });
}
