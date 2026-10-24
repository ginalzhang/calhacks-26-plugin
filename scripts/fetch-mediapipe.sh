#!/usr/bin/env bash
# Self-host MediaPipe assets (P3, §1) under public/mediapipe/ so tracking works offline at the judging table.
#   public/mediapipe/wasm/vision_wasm_*.{js,wasm}   copied from node_modules/@mediapipe/tasks-vision/wasm (no network)
#   public/mediapipe/hand_landmarker.task           float16 model from Google storage (network, once)
# Idempotent: skips files that are already present and the right size. src/tracking/assets.ts HEAD-checks
# these and falls back to jsDelivr / Google storage when they're missing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="1.1.1"
SRC="$ROOT/node_modules/@mediapipe/tasks-vision/wasm"
DEST="$ROOT/public/mediapipe"
MODEL_URL="https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
MODEL="$DEST/hand_landmarker.task"

mkdir -p "$DEST/wasm"

# --- wasm (from the installed package; must match the pinned version)
if [[ ! -d "$SRC" ]]; then
  echo "fetch-mediapipe: $SRC missing; run npm install first" >&2
  exit 1
fi
installed="$(node -p "require('$ROOT/node_modules/@mediapipe/tasks-vision/package.json').version" 2>/dev/null || echo unknown)"
if [[ "$installed" != "$VERSION" ]]; then
  echo "fetch-mediapipe: warning: installed tasks-vision is $installed, expected $VERSION" >&2
fi
for f in "$SRC"/vision_wasm_*; do
  name="$(basename "$f")"
  if [[ -f "$DEST/wasm/$name" ]] && cmp -s "$f" "$DEST/wasm/$name"; then
    continue
  fi
  cp "$f" "$DEST/wasm/$name"
  echo "copied wasm/$name"
done

# --- model (network)
if [[ -s "$MODEL" ]] && [[ "$(wc -c < "$MODEL")" -gt 1000000 ]]; then
  echo "model present ($(wc -c < "$MODEL" | tr -d ' ') bytes)"
else
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  if curl -fsSL --retry 2 --max-time 120 -o "$tmp/hand_landmarker.task" "$MODEL_URL"; then
    size="$(wc -c < "$tmp/hand_landmarker.task" | tr -d ' ')"
    # A .task file is a zip (a "PK" header within the first bytes); refuse an HTML error page.
    if [[ "$size" -lt 1000000 ]] || ! head -c 8 "$tmp/hand_landmarker.task" | LC_ALL=C grep -aq PK; then
      echo "fetch-mediapipe: downloaded model looks wrong ($size bytes); keeping the CDN fallback" >&2
      exit 1
    fi
    mv "$tmp/hand_landmarker.task" "$MODEL"
    echo "downloaded hand_landmarker.task ($size bytes)"
  else
    echo "fetch-mediapipe: model download failed (offline?); the app falls back to $MODEL_URL" >&2
    exit 1
  fi
fi

du -sh "$DEST" | awk '{print "public/mediapipe total: " $1}'
