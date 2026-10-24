#!/usr/bin/env bash
# `npm run fake-helper`: the test double for the helper (no pointer, no keys).
# ws://127.0.0.1:18765 + HTTP control http://127.0.0.1:18767 (docs/PROTOCOL.md › Fake helper).
# Extra args pass through (--ws-port, --http-port, --quiet). Needs only `websockets`.
set -euo pipefail
cd "$(dirname "$0")/.."
for cand in .venv/bin/python helper/.venv/bin/python; do
  if [ -x "$cand" ] && "$cand" -c "import websockets" 2>/dev/null; then
    exec "$cand" scripts/fake_helper.py "$@"
  fi
done
PY=${STEADY_PYTHON:-$(command -v python3.12 || command -v python3.11 || command -v python3)}
"$PY" -m venv .venv
.venv/bin/pip install -q -r helper/requirements-dev.txt
exec .venv/bin/python scripts/fake_helper.py "$@"
