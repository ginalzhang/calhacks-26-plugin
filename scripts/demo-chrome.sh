#!/usr/bin/env bash
# npm run demo-chrome — a dedicated Chrome for Steady (§1).
# Own profile (.steady-chrome) so its camera/mic permissions and flags never touch your normal Chrome.
# The flags stop Chrome throttling the page when Krita covers it; keep the window as a 320 px strip
# beside Krita (or on a second display), never fully behind Krita. The header's fps counter proves it is alive.
#
# Env: STEADY_URL (default http://localhost:3000?demo=1), STEADY_CHROME (path to the Chrome binary),
#      STEADY_STRIP=0 to skip the 320 px window size.
# Owner: agent F.
set -euo pipefail
cd "$(dirname "$0")/.."

URL="${STEADY_URL:-http://localhost:3000?demo=1}"
CHROME="${STEADY_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE="$PWD/.steady-chrome"

if [ ! -x "$CHROME" ]; then
  echo "Google Chrome not found at: $CHROME" >&2
  echo "Install Chrome from https://www.google.com/chrome/ or set STEADY_CHROME to its binary." >&2
  exit 1
fi

ORIGIN="$(printf '%s' "$URL" | sed -E 's#^(https?://[^/?]+).*#\1#')"
if ! curl -s -o /dev/null --max-time 2 "$ORIGIN"; then
  echo "Note: nothing answers on $ORIGIN yet. Start it in another terminal with: npm run dev" >&2
elif ! curl -s --max-time 2 "$ORIGIN" | grep -q "<title>Steady</title>"; then
  echo "Warning: $ORIGIN is answering but it is not Steady (another project's dev server?)." >&2
  echo "Run Steady on another port: npm run dev -- -p 3100; npm run helper -- --origin http://localhost:3100;" >&2
  echo "STEADY_URL='http://localhost:3100?demo=1' npm run demo-chrome" >&2
fi

mkdir -p "$PROFILE"
ARGS=(
  --user-data-dir="$PROFILE"
  --no-first-run
  --no-default-browser-check
  --disable-backgrounding-occluded-windows
  --disable-renderer-backgrounding
  --disable-background-timer-throttling
  --autoplay-policy=no-user-gesture-required
)
if [ "${STEADY_STRIP:-1}" != 0 ]; then
  ARGS+=(--window-size=320,1000 --window-position=0,25)
fi

echo "Launching dedicated Chrome (profile: .steady-chrome) at $URL"
exec "$CHROME" "${ARGS[@]}" --new-window "$URL"
