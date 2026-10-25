/**
 * Steady brain entry point (agent B). Spawned by the tracker as
 *   node tracker/brain/dist/brain.mjs
 * Reads one ToBrain JSON object per stdin line, writes one FromBrain JSON object per stdout line.
 * stdout carries protocol lines ONLY; every log goes to stderr. stdin EOF / SIGTERM / SIGINT act
 * like `shutdown` (pen lifted, exit 0).
 */
import { createInterface } from "node:readline";
import { createBrain } from "./core";

const toStderr = (...args: unknown[]) => {
  try {
    process.stderr.write(`[brain] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
  } catch {
    /* ignore */
  }
};
// Nothing may print to stdout except protocol lines.
console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.debug = toStderr;
console.error = toStderr;

let exiting = false;
function exit(code: number) {
  if (exiting) return;
  exiting = true;
  // stdout to a pipe is asynchronous on macOS: flush before exiting.
  process.stdout.write("", () => process.exit(code));
  setTimeout(() => process.exit(code), 500).unref();
}

const brain = createBrain(
  (m) => {
    if (exiting && m.t !== "pen" && m.t !== "state" && m.t !== "mic" && m.t !== "error") return;
    process.stdout.write(`${JSON.stringify(m)}\n`);
  },
  { log: toStderr, onShutdown: () => exit(0) },
);

process.stdout.on("error", (e) => {
  toStderr(`stdout error: ${String(e)}`);
  process.exit(0); // the tracker is gone; it releases the button itself
});

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg: unknown;
  try {
    msg = JSON.parse(s);
  } catch (e) {
    toStderr(`bad JSON line: ${s.slice(0, 200)}`);
    process.stdout.write(`${JSON.stringify({ t: "error", text: `bad JSON: ${String((e as Error).message)}` })}\n`);
    return;
  }
  brain.handle(msg);
});
rl.on("close", () => {
  if (!brain.shutDown) brain.handle({ t: "shutdown" });
  exit(0);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (!brain.shutDown) brain.handle({ t: "shutdown" });
    exit(0);
  });
}

process.on("uncaughtException", (e) => {
  toStderr(`uncaught: ${e?.stack ?? String(e)}`);
  brain.emergencyLift(`internal: ${String(e?.message ?? e)}`);
});
process.on("unhandledRejection", (e) => {
  toStderr(`unhandled rejection: ${String(e)}`);
  brain.emergencyLift(`internal: ${String(e)}`);
});

toStderr("started");
