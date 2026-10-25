#!/usr/bin/env node
// Generates krita-plugin/pykrita/steady/actions.json from src/actions.ts (the single action table),
// so the Krita panel (Python, no Node at runtime) renders the same tiles, labels, pages and phases.
//
//   node scripts/gen-plugin-actions.mjs          # write the JSON
//   node scripts/gen-plugin-actions.mjs --check  # exit 1 if the committed JSON is stale
//
// actions.ts is bundled with esbuild (node_modules) when available, else imported with Node's
// built-in type stripping (Node >= 22.6 with --experimental-strip-types, default since Node 23.6).
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src", "actions.ts");
const OUT = join(ROOT, "krita-plugin", "pykrita", "steady", "actions.json");

async function loadActions() {
  let esbuild = null;
  try {
    esbuild = await import("esbuild");
  } catch {
    esbuild = null;
  }
  if (esbuild) {
    const dir = mkdtempSync(join(tmpdir(), "steady-actions-"));
    try {
      const file = join(dir, "actions.mjs");
      await esbuild.build({ entryPoints: [SRC], bundle: true, format: "esm", platform: "node", outfile: file, logLevel: "error" });
      return await import(pathToFileURL(file).href);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return await import(pathToFileURL(SRC).href);
}

function pick(a) {
  const out = {
    id: a.id,
    label: a.label,
    page: a.page,
    toggle: !!a.toggle,
    destructive: !!a.destructive,
    phase: a.phase,
    tilePhase: a.tilePhase ?? a.phase,
    key: a.key ?? null,
    help: a.help ?? null,
    arg: a.arg ?? null,
    typed: a.typed ?? null,
  };
  return out;
}

const m = await loadActions();
const doc = {
  _generated: "by scripts/gen-plugin-actions.mjs from src/actions.ts. Do not edit; rerun the script.",
  build_phase: m.BUILD_PHASE,
  phase_order: m.PHASE_ORDER,
  colour_hex: m.COLOUR_HEX,
  actions: m.ACTIONS.map(pick),
};
const text = JSON.stringify(doc, null, 2) + "\n";

if (process.argv.includes("--check")) {
  const cur = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (cur !== text) {
    console.error(`${OUT} is stale: run node scripts/gen-plugin-actions.mjs`);
    process.exit(1);
  }
  console.log("actions.json is up to date");
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT} (${doc.actions.length} actions, build phase ${doc.build_phase})`);
}
