#!/usr/bin/env python3
"""Fake brain for tracker tests: speaks the tracker ↔ brain line protocol (tracker/brain/protocol.ts).

Env:
  FAKE_BRAIN_LOG    append every received message (except frame/tick unless FAKE_BRAIN_LOG_ALL=1) as JSON lines
  FAKE_BRAIN_MODE   normal | stall (go silent after pen down) | crash (exit 3 after pen down, once per
                    FAKE_BRAIN_FLAG file) | crash_always
  FAKE_BRAIN_DOWN / FAKE_BRAIN_UP   hand-frame numbers for pen down / up (default 5 / 15)
Pen law of the fake: every hand frame → move to (100 + 1000·x, 100 + 1000·y) of landmark 5; frame DOWN →
[move, down]; frame UP → [up]. Every tick while down → `pen {events: []}` heartbeat (unless stalled).
"""

import json
import os
import sys

LOG = os.environ.get("FAKE_BRAIN_LOG")
LOG_ALL = os.environ.get("FAKE_BRAIN_LOG_ALL") == "1"
MODE = os.environ.get("FAKE_BRAIN_MODE", "normal")
FLAG = os.environ.get("FAKE_BRAIN_FLAG")
DOWN = int(os.environ.get("FAKE_BRAIN_DOWN", "5"))
UP = int(os.environ.get("FAKE_BRAIN_UP", "15"))


def out(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def log(msg):
    if LOG and (LOG_ALL or msg.get("t") not in ("frame", "tick")):
        with open(LOG, "a") as f:
            f.write(json.dumps(msg) + "\n")


def main():
    n = 0
    down = False
    stalled = False
    paused = False
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        log(msg)
        t = msg.get("t")
        if t == "shutdown":
            return 0
        if stalled:
            continue
        if t == "init":
            out({"t": "ready", "version": "fake"})
        elif t == "frame":
            hands = msg["frame"].get("hands") or []
            if not hands:
                continue
            n += 1
            p = hands[0]["landmarks"][5]
            x, y = 100 + 1000 * p["x"], 100 + 1000 * p["y"]
            if n == DOWN:
                out({"t": "pen", "events": [{"type": "move", "x": x, "y": y}, {"type": "down", "x": x, "y": y}]})
                down = True
                if MODE == "stall":
                    stalled = True
                elif MODE == "crash_always" or (MODE == "crash" and FLAG and not os.path.exists(FLAG)):
                    if FLAG:
                        open(FLAG, "w").close()
                    sys.stdout.flush()
                    os._exit(3)
            elif n == UP:
                out({"t": "pen", "events": [{"type": "up", "x": x, "y": y, "reason": "dwell"}]})
                down = False
            else:
                out({"t": "pen", "events": [{"type": "move", "x": x, "y": y}]})
        elif t == "tick":
            if down:
                out({"t": "pen", "events": []})
        elif t == "parse":
            text = msg["text"].strip().lower()
            if text == "undo":
                res = {"kind": "match", "commands": [{"action": "undo"}], "fuzzy": False}
            elif text == "big brush":
                res = {"kind": "match", "commands": [{"action": "size", "arg": 40}], "fuzzy": False}
            else:
                res = {"kind": "nomatch", "closest": ["undo", "redo"]}
            out({"t": "parsed", "id": msg["id"], "result": res})
        elif t == "action":
            a = msg["action"]
            if a == "krita_test":
                out({"t": "krita", "id": "k1", "cmd": {"cmd": "action", "action": "edit_undo"}, "fallback_keys": "cmd+z"})
            elif a == "keys_test":
                out({"t": "keys", "id": "k2", "combo": "cmd+z"})
            elif a == "click_test":
                out({"t": "pen", "events": [{"type": "click", "x": msg.get("arg") or 0, "y": msg.get("arg") or 0}]})
            elif a == "pause":
                paused = not paused
                out({"t": "state", "state": {"paused": paused, "pen": "up"}})
            elif a == "mic":
                out({"t": "mic", "open": msg.get("variant") == "on", "reason": "tile"})
            elif a == "speak_test":
                out({"t": "speak", "text": "Pen down"})
            elif a == "dialog_test":
                out({"t": "dialog", "dialog_id": "d1", "kind": "confirm", "text": "Clear layer?", "options": [{"id": "confirm", "label": "Clear"}, {"id": "cancel", "label": "Cancel"}]})
            elif a == "steadier":
                out({"t": "settings_changed", "settings": {"steadiness": 70}})
            out({"t": "status", "text": "did " + a, "level": "status"})
        elif t == "calibrate":
            out({"t": "calibration", "calibration": {"handedness": "Left", "gain": 3, "createdAt": 5}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
