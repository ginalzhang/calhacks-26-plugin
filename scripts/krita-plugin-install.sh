#!/usr/bin/env bash
# Installs the Steady Krita plugin into Krita's per-user Python plugin folder (macOS):
#   ~/Library/Application Support/krita/pykrita/{steady.desktop, steady/}
# Override the destination with KRITA_PYKRITA_DIR=/some/dir (used by the tests).
# Safe to run again: it replaces only Steady's own files.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/krita-plugin/pykrita"
DEST="${KRITA_PYKRITA_DIR:-$HOME/Library/Application Support/krita/pykrita}"

if [ ! -f "$SRC/steady.desktop" ] || [ ! -f "$SRC/steady/__init__.py" ]; then
  echo "Steady plugin sources not found in $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"
rm -rf "$DEST/steady"
mkdir -p "$DEST/steady"
cp "$SRC/steady.desktop" "$DEST/steady.desktop"
cp "$SRC"/steady/*.py "$DEST/steady/"

echo "Installed the Steady Krita plugin to:"
echo "  $DEST/steady.desktop"
echo "  $DEST/steady/"
echo
echo "Next (once):"
echo "  1. Open Krita (5.3.x is the tested version)."
echo "  2. Krita menu > Settings... (or Settings > Configure Krita) > Python Plugin Manager."
echo "  3. Tick 'Steady', press OK, then quit and reopen Krita."
echo "  4. Check: Tools > Scripts > 'Steady: connection status' says 'listening on 127.0.0.1:8766'."
echo "Full guide: scripts/krita-setup.md"

if command -v pgrep >/dev/null 2>&1 && pgrep -xq krita 2>/dev/null; then
  echo
  echo "Krita is running: quit and reopen it to load this version of the plugin."
fi
