#!/usr/bin/env bash
# Steady Tracker (tracker/steadytracker): camera + MediaPipe + brain + pointer + hotkeys + Krita relay + panel
# server on 127.0.0.1:8767. Steady Tracker.app runs this script; you can also run it from a terminal
# (then macOS attributes Camera/Accessibility/Input Monitoring to the terminal app, not "Steady Tracker").
#
#   scripts/run-tracker.sh [--panel-port 8767] [--plugin-port 8766] [--no-input] [--fake-camera replay.json] [-v]
#
# 1. venv tracker/.venv (python3.12), reinstalls tracker/requirements.txt when it changed (stamp file)
# 2. builds tracker/brain/dist/brain.mjs if missing (npm run brain:build)
# 3. hand model: public/mediapipe/hand_landmarker.task, else float16 download to
#    ~/Library/Application Support/Steady/models/hand_landmarker.task
set -euo pipefail
# Launched from Krita (via `open`), the tracker inherits Krita's Python environment (PYTHONHOME/PYTHONPATH pointing
# at Krita's bundled Python 3.13), which makes our Python 3.12 load the wrong stdlib and crash at import time.
# Clear every PYTHON* variable (and pyenv/conda/virtualenv leftovers) before anything runs Python.
for v in $(env | sed -n 's/^\(PYTHON[A-Z_]*\)=.*/\1/p'); do unset "$v"; done
unset VIRTUAL_ENV CONDA_PREFIX __PYVENV_LAUNCHER__ || true
cd "$(dirname "$0")/.."
REPO=$(pwd)
VENV=tracker/.venv
PY=${STEADY_PYTHON:-$(command -v python3.12 || true)}
if [ ! -x "$VENV/bin/python" ]; then
  if [ -z "$PY" ]; then
    echo "Steady Tracker needs Python 3.12 (mediapipe/pyobjc wheels). Install with: brew install python@3.12" >&2
    exit 1
  fi
  echo "Creating $VENV with $PY ..."
  "$PY" -m venv "$VENV"
fi
STAMP="$VENV/.requirements.sha"
SUM=$(shasum tracker/requirements.txt | cut -d' ' -f1)
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$SUM" ]; then
  echo "Installing tracker requirements ..."
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q -r tracker/requirements.txt
  echo "$SUM" > "$STAMP"
fi

# Node for the brain (LaunchServices gives apps a minimal PATH).
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
if [ ! -f tracker/brain/dist/brain.mjs ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "Steady Tracker needs Node.js (brew install node) to build its brain." >&2
    exit 1
  fi
  echo "Building the brain (npm run brain:build) ..."
  [ -d node_modules ] || npm install --no-audit --no-fund
  npm run -s brain:build
fi
if [ -z "${STEADY_NODE:-}" ]; then
  STEADY_NODE=$(command -v node || true)
  export STEADY_NODE
fi

MODEL_URL="https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
if [ -z "${STEADY_HAND_MODEL:-}" ]; then
  if [ -f public/mediapipe/hand_landmarker.task ]; then
    STEADY_HAND_MODEL="$REPO/public/mediapipe/hand_landmarker.task"
  else
    MODELS="$HOME/Library/Application Support/Steady/models"
    STEADY_HAND_MODEL="$MODELS/hand_landmarker.task"
    if [ ! -s "$STEADY_HAND_MODEL" ]; then
      mkdir -p "$MODELS"
      echo "Downloading the hand model (float16) ..."
      curl -fsSL "$MODEL_URL" -o "$STEADY_HAND_MODEL.part" && mv "$STEADY_HAND_MODEL.part" "$STEADY_HAND_MODEL"
    fi
  fi
  export STEADY_HAND_MODEL
fi

export STEADY_REPO="$REPO"
export PYTHONPATH="$REPO/tracker:$REPO/helper${PYTHONPATH:+:$PYTHONPATH}"
exec "$VENV/bin/python" -m steadytracker "$@"
