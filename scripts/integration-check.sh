#!/usr/bin/env bash
# integration-check.sh — the REAL helper process against the REAL plugin bridge and the REAL page.
#
#   scripts/integration-check.sh            # both suites
#   SKIP_PW=1 scripts/integration-check.sh  # pytest part only
#
# 1. pytest tests/integration (-m "P1 or P2a"): real plugin bridge.py (fake adapter, fake GUI drain thread)
#    <-> real helper subprocess <-> websockets client (hello, krita round trip, krita_state, fallback_keys,
#    ping/pong, Origin refusal, watchdog/socket-close/SIGTERM release via a logging fake mouse).
# 2. Playwright tests/integration/playwright.integration.config.ts: Chrome page (?source=replay&helper=ws://…
#    &target=krita) <-> real helper <-> real bridge; Demo metrics show the helper round trip.
#
# SAFETY: the helper always runs through tests/integration/safe_helper.py, which seals CGEventPost, the key
# poster, Krita activation, the global key tap and the permission prompts, and requires
# --no-pointer --no-hotkeys --no-overlay. Nothing here moves the pointer, clicks, posts keys or opens windows.
# Ports: helper/plugin 28865+ (pytest 28875+), app $INTEG_APP_PORT (first free from 3200, never 3000; dev server runs with NEXT_PUBLIC_STEADY_TEST=1), helper/plugin: free ephemeral ports. Every process
# is stopped by PID by its owner (pytest fixtures / Playwright webServer). Owner: agent H.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
PY=.venv/bin/python
[ -x "$PY" ] || { echo "integration-check: .venv missing (run scripts/run-pytest.sh once)"; exit 2; }

OUT=$(mktemp -d "${TMPDIR:-/tmp}/steady-integration.XXXXXX")
export INTEG_OUT="$OUT"
echo "integration-check  ($(date '+%Y-%m-%d %H:%M:%S %Z'))  results: $OUT"

free_port() { # first port >= $1 that is free on 127.0.0.1 (default range 28865+)
  "$PY" -c 'import socket,sys
p=int(sys.argv[1])
while True:
    s=socket.socket()
    try:
        s.bind(("127.0.0.1",p)); s.close(); print(p); break
    except OSError:
        p+=1' "${1:-28865}"; }
listener_cwd() { # port -> cwd of the listener ("" if none)
  local pid; pid=$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1)
  [ -n "$pid" ] && lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'
}

# App port: first FREE port in 3200.. (never 3000, which another workspace uses). Never reused: the page needs
# a dev server started with NEXT_PUBLIC_STEADY_TEST=1 (the config starts it and stops it).
APP=${INTEG_APP_PORT:-}
if [ -z "$APP" ]; then
  for p in $(seq 3200 3299); do
    [ -z "$(listener_cwd "$p")" ] && ! lsof -nP -iTCP:"$p" -sTCP:LISTEN -t >/dev/null 2>&1 && { APP=$p; break; }
  done
fi
export INTEG_APP_PORT=$APP STEADY_INTEG_APP_PORT=$APP
export INTEG_HELPER_PORT=${INTEG_HELPER_PORT:-$(free_port 28865)}
export INTEG_PLUGIN_PORT=${INTEG_PLUGIN_PORT:-$(free_port $((INTEG_HELPER_PORT + 1)))}
# pytest's own helpers/bridges: 28875+ (each test picks the first free one; never the Playwright pair)
export STEADY_INTEG_PORT_BASE=${STEADY_INTEG_PORT_BASE:-28875}
export STEADY_INTEG_OUT="$OUT/pytest-logs"
echo "ports: app $INTEG_APP_PORT  helper $INTEG_HELPER_PORT  plugin $INTEG_PLUGIN_PORT"

printf '\n=== pytest tests/integration (helper <-> plugin bridge) ===\n'
"$PY" -m pytest tests/integration -m "P1 or P2a" -p no:cacheprovider -rA --junitxml="$OUT/pytest.xml" 2>&1 | tee "$OUT/pytest.txt"
PYT=${PIPESTATUS[0]}

if [ "${SKIP_PW:-}" = 1 ]; then
  printf '\n=== playwright: skipped (SKIP_PW=1) ===\n'; PW=skip
else
  printf '\n=== playwright (page <-> real helper <-> real bridge) ===\n'
  PW_OUTPUT_DIR="$OUT/pw-artifacts" npx playwright test -c tests/integration/playwright.integration.config.ts 2>&1 | tee "$OUT/playwright.txt"
  PW=${PIPESTATUS[0]}
fi

blocked=$(cat "$OUT"/helper.log "$STEADY_INTEG_OUT"/*.log 2>/dev/null | grep -c "INTEGRATION-BLOCKED" || true)

printf '\n================ integration-check ================\n'
res() { [ "$2" = 0 ] && echo "PASS  $1" || { [ "$2" = skip ] && echo "SKIP  $1" || echo "FAIL  $1 (exit $2)"; }; }
res "helper <-> plugin bridge (pytest)" "$PYT"
res "page <-> real helper (playwright)" "$PW"
if [ "$blocked" = 0 ]; then echo "PASS  no real input attempted by the helper (0 INTEGRATION-BLOCKED lines)"; else echo "FAIL  helper attempted $blocked real input event(s); see $OUT"; fi
lsof -nP -iTCP:"$INTEG_HELPER_PORT" -iTCP:"$INTEG_PLUGIN_PORT" -sTCP:LISTEN >/dev/null 2>&1 && echo "WARN  a helper/bridge port is still listening"

if [ "$PYT" = 0 ] && { [ "$PW" = 0 ] || [ "$PW" = skip ]; } && [ "$blocked" = 0 ]; then
  echo "integration-check: PASS"; [ "${KEEP_OUT:-}" = 1 ] || rm -rf "$OUT"; exit 0
fi
echo "integration-check: FAIL  (logs: $OUT)"; exit 1
