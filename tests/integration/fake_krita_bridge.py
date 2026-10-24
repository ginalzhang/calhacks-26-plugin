#!/usr/bin/env python3
"""The REAL Krita-plugin bridge (krita-plugin/pykrita/steady/bridge.py + dispatch.py) outside Krita.

Backed by krita-plugin/tests' FakeAdapter; the main thread drains the queue every 20 ms like
Krita's QTimer. Every handled command is printed as `CMD <json>` (stdout). SIGTERM/SIGINT stop it.

  .venv/bin/python tests/integration/fake_krita_bridge.py --port 28866
"""
from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "krita-plugin" / "pykrita"))
sys.path.insert(0, str(ROOT / "krita-plugin" / "tests"))

from krita_fakes import FakeAdapter  # noqa: E402
from steady.bridge import Bridge  # noqa: E402
from steady.dispatch import dispatch  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=28866)
    args = ap.parse_args()
    adapter = FakeAdapter()

    def handle(cmd: dict) -> dict:
        print("CMD " + json.dumps(cmd, separators=(",", ":"))[:300], flush=True)
        return dispatch(cmd, adapter)

    bridge = Bridge(handle, host="127.0.0.1", port=args.port, log=lambda m: print(m, flush=True))
    bridge.start()
    stop = {"now": False}

    def on_sig(*_):
        stop["now"] = True

    signal.signal(signal.SIGTERM, on_sig)
    signal.signal(signal.SIGINT, on_sig)
    while not stop["now"]:
        bridge.drain()
        time.sleep(0.02)
    bridge.stop()
    print("fake krita bridge stopped", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
