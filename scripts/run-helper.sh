#!/usr/bin/env bash
# `npm run helper`: create helper/.venv (python3.12) if missing, install helper/requirements.txt
# when it changed, then run the Steady helper. Extra args go to the helper (e.g. --no-hotkeys, -v).
#
# The helper moves the REAL pointer. macOS grants Accessibility + Input Monitoring to the terminal
# app that runs this script (Terminal, iTerm, ...), not to python: see NEEDS-HUMAN.md.
set -euo pipefail
cd "$(dirname "$0")/.."
VENV=helper/.venv
PY=${STEADY_PYTHON:-$(command -v python3.12 || command -v python3.11 || true)}
if [ ! -x "$VENV/bin/python" ]; then
  if [ -z "$PY" ]; then
    echo "Steady helper needs Python 3.11 or 3.12 (pyobjc/pynput wheels). Install with: brew install python@3.12" >&2
    exit 1
  fi
  echo "Creating $VENV with $PY ..."
  "$PY" -m venv "$VENV"
fi
STAMP="$VENV/.requirements.sha"
SUM=$(shasum helper/requirements.txt | cut -d' ' -f1)
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$SUM" ]; then
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q -r helper/requirements.txt
  echo "$SUM" > "$STAMP"
fi
exec "$VENV/bin/python" helper/steady_helper.py "$@"
