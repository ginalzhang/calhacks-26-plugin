/**
 * Integration Playwright config (agent H): the page against the REAL helper process.
 * Separate from playwright.config.ts (agent F) — its own testDir, testMatch (*.pw.ts), ports and outputDir.
 *
 * Starts (unless NO_WEBSERVER=1):
 *   1. `NEXT_PUBLIC_STEADY_TEST=1 next dev -p $INTEG_APP_PORT` (default 3200; the page honours source=replay,
 *      target= and helper= only with that build flag, so an already-running server is never reused: the port
 *      must be free),
 *   2. the real plugin bridge with a fake adapter (tests/integration/fake_krita_bridge.py) on $INTEG_PLUGIN_PORT (28866),
 *   3. the real helper, sealed (tests/integration/safe_helper.py --no-pointer --no-hotkeys --no-overlay)
 *      on $INTEG_HELPER_PORT (28865) with --origin http://localhost:$INTEG_APP_PORT.
 * Logs: $INTEG_OUT/{helper,bridge}.log (default /tmp/steady-integration).
 *
 *   npx playwright test -c tests/integration/playwright.integration.config.ts
 */
import { defineConfig, devices } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const APP_PORT = Number(process.env.INTEG_APP_PORT ?? "3200");
const HELPER_PORT = Number(process.env.INTEG_HELPER_PORT ?? "28865");
const PLUGIN_PORT = Number(process.env.INTEG_PLUGIN_PORT ?? "28866");
const OUT = process.env.INTEG_OUT ?? "/tmp/steady-integration";
fs.mkdirSync(OUT, { recursive: true });
process.env.INTEG_APP_PORT = String(APP_PORT);
process.env.INTEG_HELPER_PORT = String(HELPER_PORT);
process.env.INTEG_PLUGIN_PORT = String(PLUGIN_PORT);
process.env.INTEG_OUT = OUT;

/** cwd of the process listening on `port`, or null when nothing listens. */
function listenerCwd(port: number): string | null {
  try {
    const pid = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")[0]
      .trim();
    if (!pid) return null;
    const line = execSync(`lsof -a -p ${pid} -d cwd -Fn`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .find((l) => l.startsWith("n"));
    return line ? line.slice(1) : "?";
  } catch {
    return null;
  }
}

if (!process.env.NO_WEBSERVER) {
  const cwd = listenerCwd(APP_PORT);
  if (cwd !== null) {
    throw new Error(
      `port ${APP_PORT} is already in use (${cwd}); the integration run needs its own NEXT_PUBLIC_STEADY_TEST=1 dev server. Set INTEG_APP_PORT to a free port`,
    );
  }
}

const python = fs.existsSync(path.join(root, ".venv/bin/python")) ? ".venv/bin/python" : "python3";
const BASE_URL = `http://localhost:${APP_PORT}`;
const ORIGIN = BASE_URL;

type WebServer = NonNullable<Parameters<typeof defineConfig>[0]["webServer"]>;
const webServer: WebServer = process.env.NO_WEBSERVER
  ? []
  : [
      {
        command: `NEXT_PUBLIC_STEADY_TEST=1 npx next dev -p ${APP_PORT}`,
        cwd: root,
        env: { NEXT_PUBLIC_STEADY_TEST: "1" },
        url: BASE_URL,
        reuseExistingServer: false,
        timeout: 180_000,
        stdout: "ignore",
        stderr: "pipe",
        gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      },
      {
        command: `exec ${python} -u tests/integration/fake_krita_bridge.py --port ${PLUGIN_PORT} > ${OUT}/bridge.log 2>&1`,
        cwd: root,
        port: PLUGIN_PORT,
        reuseExistingServer: false,
        timeout: 20_000,
        gracefulShutdown: { signal: "SIGTERM", timeout: 3_000 },
      },
      {
        command:
          `exec env -u STEADY_ORIGIN -u STEADY_SHIM_FAKE_POINTER ${python} -u tests/integration/safe_helper.py ` +
          `--host 127.0.0.1 --port ${HELPER_PORT} --plugin-port ${PLUGIN_PORT} --origin ${ORIGIN} ` +
          `--no-pointer --no-hotkeys --no-overlay -v > ${OUT}/helper.log 2>&1`,
        cwd: root,
        port: HELPER_PORT,
        reuseExistingServer: false,
        timeout: 30_000,
        gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      },
    ];

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.pw\.ts$/,
  outputDir: process.env.PW_OUTPUT_DIR ?? path.join(OUT, "pw-artifacts"),
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [["list"], ["json", { outputFile: path.join(OUT, "playwright.json") }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 320, height: 900 },
    launchOptions: {
      args: [
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
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
