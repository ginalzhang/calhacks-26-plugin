// Regenerates tracker/steadytracker/voice/data/ts_reference.json from the TypeScript sources, so the Python
// voice parity tests follow src/actions.ts. Run after editing the action table: node scripts/gen-voice-reference.mjs
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "steady-ref-"));
const entry = join(dir, "entry.ts");
writeFileSync(
  entry,
  `export { SYSTEM_BLOCK } from ${JSON.stringify(process.cwd() + "/src/app/api/command/systemBlock.ts")};
   export { CLAUDE_ACTION_IDS } from ${JSON.stringify(process.cwd() + "/src/app/api/command/schema.ts")};
   export { sttKeyterms } from ${JSON.stringify(process.cwd() + "/src/voice/keyterms.ts")};`,
);
const out = join(dir, "ref.mjs");
await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error",
  alias: { "@": process.cwd() + "/src" } });
const m = await import(pathToFileURL(out).href);
const path = "tracker/steadytracker/voice/data/ts_reference.json";
const ref = JSON.parse(readFileSync(path, "utf8"));
const ids = m.CLAUDE_ACTION_IDS;
ref.claudeActionIds = ids;
ref.keyterms = m.sttKeyterms();
ref.systemBlock = m.SYSTEM_BLOCK;
// outputFormat embeds the action enum in several places: replace every enum that equals the old id list.
const oldIds = JSON.stringify(JSON.parse(readFileSync(path, "utf8")).claudeActionIds);
ref.outputFormat = JSON.parse(JSON.stringify(ref.outputFormat).split(oldIds).join(JSON.stringify(ids)));
writeFileSync(path, JSON.stringify(ref, null, 2) + "\n");
console.log(`wrote ${path}: ${ids.length} Claude ids, ${ref.keyterms.length} keyterms`);
