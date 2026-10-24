#!/usr/bin/env bash
# demo-check.sh N — the phase gate (§0 "Phase N is done when npm test, pytest and demo-check.sh N pass").
#
#   scripts/demo-check.sh P0 | P1 | P2a | P2b | P3     (also accepts 0, 1, 2a, 2b, 3)
#
# Runs, for every tag ≤ N:
#   1. npx tsc --noEmit
#   2. Vitest   -t "@P0|@P1…"            (src/**/*.test.ts, tests/unit/**)
#   3. pytest   -m "P0 or P1 …"          via scripts/run-pytest.sh ("no tests collected" = pass)
#   4. Playwright --grep "@P0|@P1…"      (its webServer starts `npm run dev` and the fake helper,
#                                          reusing running ones, and stops what it started; pages run
#                                          ReplaySource via ?source=replay)
# then prints PASS / FAIL per definition-of-done item of each phase ≤ N (each item mapped to the tests
# that proxy it) and NEEDS HUMAN for real-hardware items. Exits non-zero on any FAIL.
#
# Env: SKIP_E2E=1 (skip Playwright; its items FAIL), KEEP_OUT=1 (keep the result directory).
# Owner: agent F.
set -uo pipefail
cd "$(dirname "$0")/.."

arg="${1:-}"
case "$arg" in
  P0|0) N=P0 ;; P1|1) N=P1 ;; P2a|2a|p2a) N=P2a ;; P2b|2b|p2b) N=P2b ;; P3|3) N=P3 ;; P4|4) N=P4 ;;
  *) echo "usage: scripts/demo-check.sh P0|P1|P2a|P2b|P3|P4   (or 0|1|2a|2b|3|4)" >&2; exit 2 ;;
esac

ALL=(P0 P1 P2a P2b P3 P4)
TAGS=()
for p in "${ALL[@]}"; do TAGS+=("$p"); [ "$p" = "$N" ] && break; done
GREP=$(printf '@%s|' "${TAGS[@]}"); GREP="${GREP%|}"           # @P0|@P1
PYM=$(printf '%s or ' "${TAGS[@]}"); PYM="${PYM% or }"          # P0 or P1

# Port: STEADY_PORT/BASE_URL if set; otherwise playwright.config.ts picks one: this checkout's own dev
# server only if it runs with NEXT_PUBLIC_STEADY_TEST=1 (test URL params are ignored otherwise), else :3000
# if free, else the first free port from 3100, and starts `next dev` there with NEXT_PUBLIC_STEADY_TEST=1.
# A non-3000 origin is passed to the fake helper with --origin.
[ -n "${STEADY_PORT:-}" ] && export STEADY_PORT

OUT=$(mktemp -d "${TMPDIR:-/tmp}/steady-demo-check.XXXXXX")
# Isolation from concurrent Playwright runs in this checkout: private artifacts dir and a private fake
# helper (fresh free ports; playwright.config.ts starts it and stops it afterwards).
export PW_OUTPUT_DIR="$OUT/pw-artifacts"
if [ -z "${FAKE_WS_PORT:-}" ]; then
  read -r FAKE_WS_PORT FAKE_HTTP_PORT < <(python3 -c 'import socket
ps=[]
for _ in range(2):
    s=socket.socket(); s.bind(("127.0.0.1",0)); ps.append(s)
print(*[s.getsockname()[1] for s in ps])')
  export FAKE_WS_PORT FAKE_HTTP_PORT
fi
LOG="$OUT/log.txt"
echo "demo-check $N  ($(date '+%Y-%m-%d %H:%M %Z'))  tags: $GREP"
echo "results: $OUT"

step() { # name, command...
  local name="$1"; shift
  printf '\n=== %s ===\n' "$name" | tee -a "$LOG"
  "$@" 2>&1 | tee -a "$LOG"
  return "${PIPESTATUS[0]}"
}

step "typecheck (tsc --noEmit)" npx tsc --noEmit; TSC=$?

step "vitest -t \"$GREP\"" npx vitest run -t "$GREP" --passWithNoTests \
  --reporter=default --reporter=json --outputFile.json="$OUT/vitest.json"; VITEST=$?

step "pytest -m \"$PYM\"" bash scripts/run-pytest.sh -m "$PYM" --junitxml="$OUT/pytest.xml"; PYTEST=$?
[ "$PYTEST" = 5 ] && { echo "(pytest: no tests collected → pass)"; PYTEST=0; }

if [ "${SKIP_E2E:-}" = 1 ]; then
  echo; echo "=== playwright: skipped (SKIP_E2E=1) ==="; PW=1
else
  export PW_JSON="$OUT/playwright.json"
  step "playwright --grep \"$GREP\"" npx playwright test --grep "$GREP"; PW=$?
fi

N="$N" OUT="$OUT" TSC=$TSC VITEST=$VITEST PYTEST=$PYTEST PW=$PW node - <<'NODE'
const fs = require("fs");
const path = require("path");
const OUT = process.env.OUT;
const PHASES = ["P0", "P1", "P2a", "P2b", "P3", "P4"];
const upto = PHASES.slice(0, PHASES.indexOf(process.env.N) + 1);
const inScope = new RegExp(`@(${upto.join("|")})\\b`);

// ---- collect results: [{suite, title, status: "pass"|"fail"|"skip"}] ----
const results = [];
try {
  const v = JSON.parse(fs.readFileSync(path.join(OUT, "vitest.json"), "utf8"));
  for (const f of v.testResults ?? [])
    for (const a of f.assertionResults ?? [])
      results.push({ suite: "vitest", title: a.fullName ?? a.title, status: a.status === "passed" ? "pass" : a.status === "failed" ? "fail" : "skip" });
} catch {}
try {
  const x = fs.readFileSync(path.join(OUT, "pytest.xml"), "utf8");
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(x))) {
    const attrs = m[1];
    const name = (attrs.match(/\bname="([^"]*)"/) || [])[1] || "";
    const cls = (attrs.match(/\bclassname="([^"]*)"/) || [])[1] || "";
    const body = m[3] || "";
    const status = /<(failure|error)\b/.test(body) ? "fail" : /<skipped\b/.test(body) ? "skip" : "pass";
    results.push({ suite: "pytest", title: `${cls}::${name}`, status });
  }
} catch {}
try {
  const p = JSON.parse(fs.readFileSync(path.join(OUT, "playwright.json"), "utf8"));
  const walk = (s, prefix) => {
    for (const spec of s.specs ?? [])
      for (const t of spec.tests ?? []) {
        const st = t.status === "expected" || t.status === "flaky" ? "pass" : t.status === "skipped" ? "skip" : "fail";
        results.push({ suite: "playwright", title: `${prefix}${spec.title}`, status: st });
      }
    for (const c of s.suites ?? []) walk(c, `${prefix}${c.title && !c.title.endsWith(".ts") ? c.title + " › " : ""}`);
  };
  for (const s of p.suites ?? []) walk(s, "");
} catch {}

// ---- definition-of-done items → proxy tests ----
// kind "auto": PASS iff ≥ 1 matching test and every match passed. kind "human": always NEEDS HUMAN.
const pw = (re) => ({ suite: "playwright", re });
const vt = (re) => ({ suite: "vitest", re });
const py = (re) => ({ suite: "pytest", re });
const allOf = (suite, tag) => ({ suite, re: tag === "*" ? /./ : new RegExp(`@${tag}\\b`), all: true });
const DOD = {
  P0: [
    ["Pointer cursor on Steady's practice canvas (ReplaySource)", [pw(/@P0 dwell toggles pen/)]],
    ["Hold still to start drawing (pen-down dwell)", [pw(/@P0 dwell toggles pen/), vt(/dwell/i)]],
    ["Draws a stroke (a word shape) on the practice canvas", [pw(/a stroke appears/)]],
    ["Hold still to stop (pen-up dwell; slow stroke never lifts)", [pw(/@P0 dwell toggles pen/), vt(/40 ?px\/s|never (triggers|lifts)|pen-up/i)]],
    ["A resting hand toggles the pen at most once", [pw(/resting hand toggles the pen at most once/)]],
    ["The Undo key undoes", [pw(/Undo key undoes/)]],
    ["Steadiness slider and its ± tiles change the result", [pw(/Steadiness ± tiles/), vt(/steadiness/i)]],
    ["Calibration steps 1–2 complete", [pw(/calibration steps 1–2/)]],
    ["Each P0 page fits 320×900 at 100 % (Steady, Setup, Timing)", [pw(/@P0 page "(Steady|Setup|Timing)" fits/)]],
    ["axe report produced at 100 % and 200 % (hard gate only with AXE_GATE=1)", [pw(/axe report/)]],
    ["Pipeline acceptance targets + every @P0 Vitest", [allOf("vitest", "P0")]],
    ["Real webcam: within 60 s of npm run dev a resting hand moves the cursor (knuckle landmark)", "human"],
    ["Real webcam: a person writes a legible word and the Steadiness change is visible", "human"],
  ],
  P1: [
    ["Demo page: Simulate tremor, metrics, Next judge", [pw(/Demo page shows metrics/), pw(/page "Demo" fits/)]],
    ["Worker sends move/down/up to the helper in order (stroke reaches the helper)", [pw(/move\/down\/up in order/)]],
    ["Covering the camera mid-stroke ends the stroke with no scribble (score-0.5 replay)", [pw(/up on simulated tracking loss/), vt(/score.?0\.5|tracking.?los|300 ?ms/i)]],
    ["Helper releases the button (watchdog 300 ms, socket close, exception) — fake mouse", [py(/release|watchdog/i)]],
    ["F9 releases everything; helper is the single key source (page ignores F-keys)", [pw(/ignores F-keys/), py(/hotkey|pause/i)]],
    ["Resume tile reachable by dwell (click inside Chrome's rect, no self-trigger)", [pw(/dwell on Resume sends click/)]],
    ["Every @P1 Vitest (mapping, clamp, rect gating, hand lock, protocol round-trip)", [allOf("vitest", "P1")]],
    ["Every @P1 pytest (helper §5)", [allOf("pytest", "*")]],
    ["Real Krita: the same resting hand paints a stroke in Krita via the helper", "human"],
    ["Real Krita: covering the camera mid-stroke ends the Krita stroke cleanly", "human"],
    ["Real Mac: F9 pauses and the Resume tile works by dwell with Krita focused", "human"],
    ["Real Mac: Chrome strip beside Krita keeps the fps counter running while Krita is focused", "human"],
  ],
  P2a: [
    ["Typed \"steadier\" moves the slider", [pw(/typed "steadier"/)]],
    ["Typed \"blue\" produces a krita message", [pw(/typed "blue"/)]],
    ["Keys do nothing inside the typed box", [pw(/keys do nothing inside the typed box/)]],
    ["P2a pages fit 320×900 (Paint, Colour, View, Layers)", [pw(/@P2a page "/)]],
    ["Grammar, keyterms, zod, Claude log (every @P2a Vitest)", [allOf("vitest", "P2a")]],
    ["Krita plugin dispatcher (every @P2a pytest)", [allOf("pytest", "*")]],
    ["Real Krita 5.3.x: plugin loads, \"blue\" changes the colour, F5/F6 no longer open popups", "human"],
    ["Real Krita: dwell-click hits an enlarged toolbox button", "human"],
    ["Real mic + keys: Cartesia Ink 2 hears \"blue\", \"bigger\", \"undo that\"; Claude moment works", "human"],
  ],
  P2b: [
    ["Hatch tile toggles Hatch; status \"Hatch: forward passes only\"", [pw(/Hatch tile toggles Hatch/)]],
    ["Hatch/Dots pipeline (forward passes only, look-ahead buffer, stationary hand never inks)", [vt(/hatch|dots?\b/i)]],
    ["Quiet mode turns the mic (and TTS, earcons) off", [pw(/quiet mode turns the Mic off/)]],
    ["Aliases: \"alias fluffy\" stored; a colliding alias is refused (\"That word is taken\")", [pw(/alias fluffy/), vt(/alias/i)]],
    ["Destructive confirm: alertdialog, focus on Cancel, Esc cancels, typed \"yes\" confirms", [pw(/Delete layer: alertdialog/)]],
    ["Break nudge after 20 min, non-blocking, \"Later\" dismisses", [pw(/break nudge/)]],
    ["Every @P2b Vitest", [allOf("vitest", "P2b")]],
    ["Every @P2b Playwright", [allOf("playwright", "P2b")]],
    ["Real Krita: Hatch over the parallel ruler inks forward passes only", "human"],
    ["Real Mac: Sonic TTS speaks \"Saved\"/\"New layer\" and never while the mic is open", "human"],
    ["Real mic: \"call this brush fluffy\", then \"fluffy\" selects that preset in Krita", "human"],
  ],
  P3: [
    ["Sketch / Ink mode / Shade tiles set Steadiness 25 / 70 / 10", [pw(/Sketch \/ Ink mode \/ Shade/)]],
    ["Dash / Repeat / pan / pick pipeline", [vt(/dash|repeat|pan\b|pick/i)]],
    ["Every @P3 Vitest", [allOf("vitest", "P3")]],
    ["Every @P3 Playwright", [allOf("playwright", "P3")]],
    ["Every @P3 pytest (ring overlay, middle-button pan, keymap)", [allOf("pytest", "*")]],
    ["Real Mac: ring overlay visible over Krita; Krita's brush outline still shows through it", "human"],
    ["Real hand in a glove/brace: Colour cap sticker is tracked and paints", "human"],
    ["Real Mac: self-hosted MediaPipe assets load with the network off", "human"],
  ],
  P4: [
    ["Hand preset tiles set the documented Steadiness / gain / dwell / Latch", [pw(/hand preset tiles/)]],
    ["Profiles: save and use round-trip; \"Steady day\" and \"Shaky day\" exist", [pw(/profile save \/ use/)]],
    ["Show numbers → helper `numbers {items}`; \"click 1\" clicks the item centre", [pw(/Show numbers sends a numbers message/)]],
    ["App profile Photoshop: typed \"undo\" sends keys cmd+z, not krita", [pw(/app profile Photoshop/)]],
    ["Presets, profiles, re-baseline, head mode, eyebrow detector (every @P4 Vitest)", [allOf("vitest", "P4")]],
    ["New pages Modes, Input, Krita fit 320×900 at 100 %", [pw(/@P4 page "(Modes|Input|Krita)" fits/)]],
    ["Every @P4 Playwright", [allOf("playwright", "P4")]],
    ["Every pytest ≤ P4 (helper numbers badges, Photoshop map, plugin list_widgets)", [allOf("pytest", "*")]],
    ["Real face: Head mode moves the pointer with the nose; gain 6× feels usable", "human"],
    ["Real face: an eyebrow lift lifts the pen, and talking or blinking does not", "human"],
    ["Real Krita: numbered badges line up over Krita's widgets; \"click 5\" clicks the right one", "human"],
    ["Real Photoshop: undo / brush / bigger / smaller shortcuts work through the Photoshop profile", "human"],
  ],
};

let fails = 0;
const line = (s, label, why) => console.log(`${s.padEnd(11)} ${label}${why ? `  — ${why}` : ""}`);
console.log("\n================ definition of done ================");
const steps = { typecheck: +process.env.TSC, vitest: +process.env.VITEST, pytest: +process.env.PYTEST, playwright: +process.env.PW };
for (const [k, v] of Object.entries(steps)) {
  line(v === 0 ? "PASS" : "FAIL", `step: ${k}`, v === 0 ? "" : `exit ${v}`);
  if (v !== 0) fails++;
}
for (const ph of upto) {
  console.log(`\n--- ${ph} ---`);
  for (const [label, proxies] of DOD[ph]) {
    if (proxies === "human") {
      line("NEEDS HUMAN", label, "see NEEDS-HUMAN.md");
      continue;
    }
    const matched = [];
    for (const p of proxies) {
      // Vitest/Playwright titles carry their phase tag; tests tagged above N were filtered out (shown as
      // skipped) and do not count. pytest is already filtered by -m and its names carry no tag.
      const hits = results.filter((r) => r.suite === p.suite && p.re.test(r.title) && (r.suite === "pytest" || inScope.test(r.title)));
      matched.push(...hits);
    }
    const failed = matched.filter((r) => r.status !== "pass");
    if (matched.length === 0) {
      fails++;
      line("FAIL", label, "no matching test ran");
    } else if (failed.length) {
      fails++;
      line("FAIL", label, failed.map((r) => `${r.suite}:${r.status}:${r.title}`).slice(0, 3).join(" | "));
    } else {
      line("PASS", label, `${matched.length} test(s)`);
    }
  }
}
const scoped = results.filter((r) => r.suite === "pytest" || inScope.test(r.title));
const n = (s) => scoped.filter((r) => r.status === s).length;
console.log(`\ntotals (tags ≤ ${process.env.N}): ${n("pass")} passed, ${n("fail")} failed, ${n("skip")} skipped (vitest+pytest+playwright)`);
console.log(fails ? `\ndemo-check ${process.env.N}: FAIL (${fails} item(s))` : `\ndemo-check ${process.env.N}: PASS`);
process.exit(fails ? 1 : 0);
NODE
RC=$?
[ "${KEEP_OUT:-}" = 1 ] || [ "$RC" != 0 ] || rm -rf "$OUT"
exit $RC
