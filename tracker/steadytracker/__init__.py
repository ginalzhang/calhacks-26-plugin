"""Steady Tracker: the hidden process behind the Krita panel.

Camera (OpenCV AVFoundation) → MediaPipe HandLandmarker → brain (`node tracker/brain/dist/brain.mjs`)
→ pointer + watchdog (helper/steadyhelper) · Krita relay → bridge 8766 · panel server 127.0.0.1:8767.
Contracts: tracker/PROTOCOL.md, tracker/brain/protocol.ts.

`tracker/steadytracker/voice/**` belongs to agent E and is imported lazily (app.load_voice).
"""

from __future__ import annotations

import os
import sys

VERSION = "0.1.0"

#: <repo>/tracker/steadytracker/__init__.py → <repo>
REPO = os.environ.get("STEADY_REPO") or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_HELPER = os.path.join(REPO, "helper")
if os.path.isdir(_HELPER) and _HELPER not in sys.path:
    # Reuse the helper's pointer, watchdog, hotkeys, keys, krita_relay, macos, permissions.
    sys.path.insert(0, _HELPER)
