#!/usr/bin/env bash
# Runs pytest for the helper (helper/tests) and the Krita plugin (krita-plugin/tests) in a shared venv.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${STEADY_PYTHON:-$(command -v python3.12 || command -v python3.11 || command -v python3)}
if [ ! -x .venv/bin/python ]; then
  "$PY" -m venv .venv
fi
.venv/bin/pip install -q -r helper/requirements-dev.txt
exec .venv/bin/python -m pytest "$@"
