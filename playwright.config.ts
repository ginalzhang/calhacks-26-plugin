/**
 * Playwright: ReplaySource (no camera) + the fake helper (scripts/fake_helper.py, ws 18765 / http 18767).
 * Tests carry phase tags in their titles (@P0, @P1, @P2a, …); run one phase with
 *   npx playwright test --grep "@P0|@P1"
 * or the whole phase gate with scripts/demo-check.sh P1.
 *
 * Env:
 *   STEADY_PORT    port of this checkout's app (sets BASE_URL=http://localhost:$STEADY_PORT)
 *   BASE_URL       default: this repo's own running `next dev` (found via lsof), else
 *                  http://localhost:3000 if free, else http://localhost:3100 (started here)
 *   FAKE_WS_PORT / FAKE_HTTP_PORT  fake helper ports (default 18765/18767; 28765/28767 when the
 *                  app is not on :3000; the fake helper is then started with `--origin <BASE_URL origin>`)
 *   AXE_GATE=1     axe violations fail the test (set by the lead at the 22:00 freeze); otherwise logged
 *   NO_WEBSERVER=1 do not start anything (servers already running)
 *
 * Owner: agent F.
 */
import { defineConfig, devices } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = __dirname;

/** Port of a `next dev` already serving THIS checkout, or null. Another checkout on :3000 must not be reused. */
function ownServerPort(): { own: number | null; foreignOn3000: boolean } {
  let own: number | null = null;
  let foreignOn3000 = false;
  try {
    const out = execSync("lsof -nP -iTCP -sTCP:LISTEN -Fpn", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    let pid = "";
    for (const line of out.split("\n")) {
      if (line.startsWith("p")) pid = line.slice(1);
      else if (line.startsWith("n")) {
        const port = Number(line.split(":").pop());
        if (!(port >= 3000 && port < 3200)) continue;
        let cwd = "";
        try {
          cwd = execSync(`lsof -a -p ${pid} -d cwd -Fn`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
            .split("\n")
            .find((l) => l.startsWith("n"))!
            .slice(1);
        } catch {
          /* ignore */
        }
        if (cwd === root) own = own ?? port;
        else if (port === 3000) foreignOn3000 = true;
      }
    }
  } catch {
    /* lsof unavailable: fall back to defaults */
  }
  return { own, foreignOn3000 };
}

if (!process.env.BASE_URL && process.env.STEADY_PORT) process.env.BASE_URL = `http://localhost:${process.env.STEADY_PORT}`;
const found = process.env.BASE_URL ? { own: null, foreignOn3000: false } : ownServerPort();
const BASE_URL =
  process.env.BASE_URL ??
  (found.own ? `http://localhost:${found.own}` : found.foreignOn3000 ? "http://localhost:3100" : "http://localhost:3000");
process.env.BASE_URL = BASE_URL;
const appOrigin = new URL(BASE_URL).origin;
const port = Number(new URL(BASE_URL).port || 80);
const onDefaultOrigin = appOrigin === "http://localhost:3000";
const FAKE_WS_PORT = process.env.FAKE_WS_PORT ?? (onDefaultOrigin ? "18765" : "28765");
const FAKE_HTTP_PORT = process.env.FAKE_HTTP_PORT ?? (onDefaultOrigin ? "18767" : "28767");
// Read by tests/e2e/helpers.ts (workers inherit the environment).
process.env.FAKE_WS_PORT = FAKE_WS_PORT;
process.env.FAKE_HTTP_PORT = FAKE_HTTP_PORT;

const python = fs.existsSync(path.join(root, ".venv/bin/python")) ? ".venv/bin/python" : "python3";
const haveFakeHelper = fs.existsSync(path.join(root, "scripts/fake_helper.py"));
const fakeHelperCmd =
  `${python} scripts/fake_helper.py --ws-port ${FAKE_WS_PORT} --http-port ${FAKE_HTTP_PORT}` +
  (onDefaultOrigin ? "" : ` --origin ${appOrigin}`);

type WebServer = NonNullable<Parameters<typeof defineConfig>[0]["webServer"]>;
const webServer: WebServer = [];
if (!process.env.NO_WEBSERVER) {
  webServer.push({
    command: `npx next dev -p ${port}`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  });
  if (haveFakeHelper) {
    webServer.push({
      command: fakeHelperCmd,
      url: `http://127.0.0.1:${FAKE_HTTP_PORT}/health`,
      reuseExistingServer: true,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "pipe",
    });
  }
}

export default defineConfig({
  testDir: "tests/e2e",
  // Replay fixtures play in real time; the fake helper is a single shared recorder → run serially.
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["json", { outputFile: process.env.PW_JSON ?? "test-results/playwright.json" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // The side panel is a 320 px strip (§0 rule 6).
    viewport: { width: 320, height: 900 },
    permissions: [],
    launchOptions: {
      args: [
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--autoplay-policy=no-user-gesture-required",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    },
  },
  projects: [
    {
      name: "chromium-strip",
      use: { ...devices["Desktop Chrome"], viewport: { width: 320, height: 900 }, deviceScaleFactor: 1 },
    },
  ],
  webServer,
});
