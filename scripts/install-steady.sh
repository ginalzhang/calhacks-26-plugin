#!/usr/bin/env bash
# Steady (Krita plugin build): one-command install for a human.
#
#   bash scripts/install-steady.sh            # install / update everything (safe to run again)
#   bash scripts/install-steady.sh --dry-run  # print every step and what it would run; change nothing
#   bash scripts/install-steady.sh --rebuild-tracker   # also rebuild Steady Tracker.app (see step 8)
#
# Steps: prerequisites -> npm install -> brain bundle -> tracker Python venv -> hand model
#        -> plugin action table -> Krita plugin -> "Steady Tracker.app" -> next steps.
# Every step prints what it does. Steps that are already done are skipped. Nothing here asks for
# macOS permissions; those dialogs appear the first time you press Start in Krita's Steady panel.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DRY=0
REBUILD=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY=1 ;;
    --rebuild-tracker) REBUILD=1 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install-steady: unknown option $arg (use --dry-run, --rebuild-tracker or --help)" >&2; exit 2 ;;
  esac
done

STEP=0
WARNINGS=()
step() { STEP=$((STEP + 1)); echo; echo "== Step $STEP: $* =="; }
ok()   { echo "   ok: $*"; }
skip() { echo "   skip: $*"; }
warn() { echo "   WARNING: $*"; WARNINGS+=("$*"); }
INCOMPLETE=0
missing_part() { warn "$*"; INCOMPLETE=1; }
run() {
  # Print the command, then run it unless --dry-run.
  echo "   \$ $*"
  if [ "$DRY" = 1 ]; then echo "     (dry run: not executed)"; return 0; fi
  "$@"
}
has_npm_script() { node -e "process.exit(require('./package.json').scripts?.[process.argv[1]] ? 0 : 1)" "$1" 2>/dev/null; }

echo "Steady installer (Krita plugin build)"
echo "Repo: $ROOT"
[ "$DRY" = 1 ] && echo "DRY RUN: nothing will be installed, built or changed."

# ------------------------------------------------------------------ 1. prerequisites (read-only)
step "Check prerequisites (macOS on Apple silicon, Krita, Node 20+, Python 3.12)"
MISSING=0
if [ "$(uname -s)" = "Darwin" ]; then
  ok "macOS $(sw_vers -productVersion 2>/dev/null || echo '?')"
else
  echo "   MISSING: Steady's plugin build runs on macOS only (this is $(uname -s))."; MISSING=1
fi
if [ "$(uname -m)" = "arm64" ]; then
  ok "Apple silicon (arm64)"
else
  echo "   MISSING: Apple silicon (arm64) Mac required; this is $(uname -m)."; MISSING=1
fi

KRITA_APP=""
for cand in "/Applications/krita.app" "/Applications/Krita.app"; do
  [ -d "$cand" ] && { KRITA_APP="$cand"; break; }
done
if [ -n "$KRITA_APP" ]; then
  KV="$(defaults read "$KRITA_APP/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo '?')"
  ok "Krita $KV at $KRITA_APP"
  case "$KV" in
    5.3*) ;;
    6*) warn "Krita $KV is not supported; Steady is tested on Krita 5.3.x (https://krita.org/en/download/)." ;;
    *) warn "Krita $KV: Steady is tested on Krita 5.3.x." ;;
  esac
else
  echo "   MISSING: Krita in /Applications. Download Krita 5.3.x from https://krita.org/en/download/,"
  echo "            drag krita into Applications, open it once, quit it."
  MISSING=1
fi

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -ge 20 ]; then ok "Node $(node -v) ($(command -v node))"
  else echo "   MISSING: Node 20 or newer (found $(node -v)). Run: brew install node"; MISSING=1; fi
else
  echo "   MISSING: Node 20 or newer. Run: brew install node"; MISSING=1
fi

PY312="${STEADY_PYTHON:-$(command -v python3.12 || true)}"
[ -z "$PY312" ] && [ -x /opt/homebrew/bin/python3.12 ] && PY312=/opt/homebrew/bin/python3.12
if [ -n "$PY312" ] && "$PY312" -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else 1)' 2>/dev/null; then
  ok "Python $("$PY312" -c 'import platform; print(platform.python_version())') ($PY312)"
else
  echo "   MISSING: Python 3.12 (the tracker's MediaPipe/OpenCV/pyobjc wheels need 3.12). Run:"
  echo "            brew install python@3.12"
  MISSING=1
fi

if xcrun --find clang >/dev/null 2>&1 || command -v cc >/dev/null 2>&1; then
  ok "C compiler (Command Line Tools) for Steady Tracker's launcher"
else
  warn "no C compiler: run  xcode-select --install  (without it Steady Tracker gets a bash launcher and macOS may attribute the camera to the wrong app)"
fi

if [ "$MISSING" = 1 ]; then
  if [ "$DRY" = 1 ]; then
    warn "prerequisites missing (see MISSING lines above); a real run would stop here"
  else
    echo; echo "Install the missing prerequisites above, then run this script again."; exit 1
  fi
fi

# ------------------------------------------------------------------ 2. npm install
step "Node packages (npm install)"
if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then
  skip "node_modules already present"
else
  run npm install
fi

# ------------------------------------------------------------------ 3. brain bundle
step "Build the brain (tracker/brain/dist/brain.mjs: Steady's tested TypeScript pipeline as one Node file)"
if has_npm_script brain:build; then
  run npm run brain:build
  [ "$DRY" = 1 ] || { [ -f tracker/brain/dist/brain.mjs ] && ok "tracker/brain/dist/brain.mjs" || missing_part "brain:build ran but tracker/brain/dist/brain.mjs is missing"; }
else
  missing_part "package.json has no 'brain:build' script yet (agent B); the tracker cannot start without tracker/brain/dist/brain.mjs"
fi

# ------------------------------------------------------------------ 4. tracker venv
step "Tracker Python environment (tracker/.venv: MediaPipe, OpenCV, sounddevice, pyobjc)"
if [ -f scripts/run-tracker.sh ] && grep -q -- '--check' scripts/run-tracker.sh; then
  echo "   (scripts/run-tracker.sh --check creates/updates tracker/.venv and verifies imports, then exits)"
  run env STEADY_PYTHON="$PY312" bash scripts/run-tracker.sh --check
elif [ -f tracker/requirements.txt ]; then
  VENV=tracker/.venv
  if [ -x "$VENV/bin/python" ]; then skip "$VENV exists"; else run "$PY312" -m venv "$VENV"; fi
  STAMP="$VENV/.requirements.sha"
  SUM="$(shasum tracker/requirements.txt | cut -d' ' -f1)"
  if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$SUM" ]; then
    skip "tracker/requirements.txt unchanged since the last install"
  else
    run "$VENV/bin/pip" install -q --upgrade pip
    run "$VENV/bin/pip" install -q -r tracker/requirements.txt
    if [ "$DRY" = 1 ]; then echo "   \$ echo $SUM > $STAMP"; echo "     (dry run: not executed)"; else echo "$SUM" > "$STAMP"; fi
  fi
else
  missing_part "neither 'scripts/run-tracker.sh --check' nor tracker/requirements.txt exists yet (agent C)"
fi

# ------------------------------------------------------------------ 5. hand model
step "MediaPipe hand model (hand_landmarker.task, downloaded once, then tracking needs no network)"
MODEL=public/mediapipe/hand_landmarker.task
if [ -s "$MODEL" ] && [ "$(wc -c < "$MODEL")" -gt 1000000 ]; then
  skip "$MODEL present ($(wc -c < "$MODEL" | tr -d ' ') bytes)"
else
  run bash scripts/fetch-mediapipe.sh
fi

# ------------------------------------------------------------------ 6. plugin action table
step "Generate the panel's action table from src/actions.ts"
if [ -f scripts/gen-plugin-actions.mjs ]; then
  run node scripts/gen-plugin-actions.mjs
else
  skip "scripts/gen-plugin-actions.mjs not present (the plugin ships its table pre-generated)"
fi

# ------------------------------------------------------------------ 7. Krita plugin
step "Install the Steady Krita plugin (~/Library/Application Support/krita/pykrita/)"
run bash scripts/krita-plugin-install.sh

# ------------------------------------------------------------------ 8. tracker app
step "Build and install \"Steady Tracker.app\" (the hidden camera/voice/pointer app the panel launches)"
# The app is only a launcher for scripts/run-tracker.sh (repo path baked in), so tracker code changes do NOT
# need a rebuild. It is ad-hoc signed and every rebuild changes the signature, which can make macOS forget the
# Camera / Accessibility / Input Monitoring grants. So: build once, rebuild only when the build script or the
# repo path changed, or with --rebuild-tracker.
INSTALLED_APP="$HOME/Applications/Steady Tracker.app"
APP_STAMP="$HOME/Library/Application Support/Steady/installed-tracker-app.sha"
if [ -f scripts/build-tracker-app.sh ]; then
  APP_SUM="$( { shasum scripts/build-tracker-app.sh | cut -d' ' -f1; echo "$ROOT"; } | shasum | cut -d' ' -f1)"
  # An app installed before this script existed (no stamp) is adopted if it launches this repo and is newer
  # than the build script, so a first run of the installer does not throw away permissions already granted.
  if [ "$REBUILD" = 0 ] && [ -d "$INSTALLED_APP" ] && [ ! -f "$APP_STAMP" ] \
     && grep -aqF "$ROOT" "$INSTALLED_APP/Contents/MacOS/steady-tracker" 2>/dev/null \
     && [ "$INSTALLED_APP/Contents/MacOS/steady-tracker" -nt scripts/build-tracker-app.sh ]; then
    skip "$INSTALLED_APP already built from this repo (adopted, not rebuilt; --rebuild-tracker forces it)"
    if [ "$DRY" = 1 ]; then echo "   \$ echo <sha> > \"$APP_STAMP\""; echo "     (dry run: not executed)"
    else mkdir -p "$(dirname "$APP_STAMP")"; echo "$APP_SUM" > "$APP_STAMP"; fi
  elif [ "$REBUILD" = 0 ] && [ -d "$INSTALLED_APP" ] && [ -f "$APP_STAMP" ] && [ "$(cat "$APP_STAMP")" = "$APP_SUM" ]; then
    skip "$INSTALLED_APP is up to date (not rebuilt, so macOS keeps its permissions; --rebuild-tracker forces it)"
  else
    [ -d "$INSTALLED_APP" ] && echo "   note: rebuilding changes the app's signature; if Start then fails, re-grant \"Steady Tracker\" (NEEDS-HUMAN.md item 19)"
    run bash scripts/build-tracker-app.sh --install
    if [ "$DRY" = 1 ]; then
      echo "   \$ echo <sha> > \"$APP_STAMP\""; echo "     (dry run: not executed)"
    else
      mkdir -p "$(dirname "$APP_STAMP")"; echo "$APP_SUM" > "$APP_STAMP"
      [ -d "$INSTALLED_APP" ] && ok "$INSTALLED_APP" || missing_part "build-tracker-app.sh ran but $INSTALLED_APP is missing"
    fi
  fi
else
  missing_part "scripts/build-tracker-app.sh not present yet (agent C); the panel's Start button needs Steady Tracker.app"
fi

# ------------------------------------------------------------------ 9. keys (read-only)
step "API keys (optional)"
for key in CARTESIA_API_KEY ANTHROPIC_API_KEY; do
  if [ -f .env.local ] && grep -Eq "^${key}=.+" .env.local; then ok "$key is set in .env.local"
  else
    case "$key" in
      CARTESIA_API_KEY) echo "   not set: $key (voice is off; the panel says \"key missing\"; tiles, keys and the typed box still work)" ;;
      *) echo "   not set: $key (unmatched commands go to a local mock instead of Claude; the panel says \"Claude key missing\")" ;;
    esac
  fi
done
[ -f .env.local ] || echo "   To add keys: cp .env.example .env.local, then fill in CARTESIA_API_KEY and ANTHROPIC_API_KEY."

# ------------------------------------------------------------------ done
echo
if [ "$DRY" = 1 ]; then echo "== Dry run finished: nothing was changed. =="; else echo "== Install finished. =="; fi
if [ "${#WARNINGS[@]}" -gt 0 ]; then
  echo "Warnings:"; for w in "${WARNINGS[@]}"; do echo "  - $w"; done
fi
if [ "$DRY" = 0 ] && [ "$INCOMPLETE" = 1 ]; then
  echo; echo "Steady is NOT fully installed (see the warnings above). Fix them and run this script again."
fi
if pgrep -xq krita 2>/dev/null; then
  echo; echo "Krita is running: quit it (Cmd+Q) and open it again so it loads this version of the plugin."
fi
cat <<'EOF'

Next steps (in Krita):
  1. Krita › Preferences… (Settings › Configure Krita…) › Python Plugin Manager › tick "Steady" › OK.
     Skip this if Steady is already ticked.
  2. Quit Krita (Cmd+Q) and open it again (needed after every install: Krita loads plugins at start).
  3. Settings › Dockers › Steady (or Tools › Steady › Show panel). Dock the panel at the side.
  4. Press Start at the top of the panel. It launches "Steady Tracker" (no Dock icon).
  5. When macOS asks, allow Camera and Microphone for "Steady Tracker". Then turn "Steady Tracker" on
     under System Settings › Privacy & Security › Accessibility and › Input Monitoring (the panel's
     "Open … settings" buttons go straight there). Press Stop, then Start.
  6. Setup page: pick your camera (Desk View if listed), press Calibrate, rest your hand, hold still
     to lower the pen, hold still again to lift it.
Checklist: NEEDS-HUMAN.md. Step-by-step with System Settings links: scripts/human-setup.md.
EOF
[ "$DRY" = 0 ] && [ "$INCOMPLETE" = 1 ] && exit 1
exit 0
