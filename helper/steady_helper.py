#!/usr/bin/env python3
"""Steady helper entry point: `npm run helper` (scripts/run-helper.sh) runs this file.

Pointer (Quartz CGEvent), 300 ms watchdog, consumed global F-keys, Krita activation and
window rect, Krita plugin relay. WebSocket ws://127.0.0.1:8765 (Origin http://localhost:3000 only).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from steadyhelper.main import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
