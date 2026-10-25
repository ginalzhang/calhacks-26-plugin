"""Tracker constants (ports, timings, paths). Mirrors tracker/PROTOCOL.md."""

from __future__ import annotations

import os
import time

from . import REPO

PANEL_HOST = "127.0.0.1"
PANEL_PORT = 8767
PLUGIN_PORT = 8766

#: Brain `tick` period (tracker/PROTOCOL.md §2).
TICK_S = 0.050
#: Release the held button when the brain has printed nothing for this long (pen-state law).
BRAIN_WATCHDOG_S = 0.300
#: Panel `state` at most 15 Hz, only on change.
STATE_MIN_INTERVAL_S = 1.0 / 15.0
#: Panel `preview` at most 5 fps, 160×120 JPEG.
PREVIEW_MIN_INTERVAL_S = 0.200
PREVIEW_W, PREVIEW_H = 160, 120
#: Krita window rect / canvas rect refresh → brain `rects` (only on change).
RECTS_PERIOD_S = 1.0
#: Permission re-check → panel `permissions` (only on change).
PERMISSIONS_PERIOD_S = 2.0
#: Wait this long for the brain's `parsed` reply to a typed/voice `parse`.
PARSE_TIMEOUT_S = 2.0
#: Brain restarts after a crash (tracker/PROTOCOL.md: "restarts the brain once").
BRAIN_MAX_RESTARTS = 1

CAMERA_W, CAMERA_H, CAMERA_FPS = 640, 480, 30
#: Every Nth camera frame gets a luma estimate (lighting warning).
LUMA_EVERY = 10

BRAIN_BUNDLE = os.path.join(REPO, "tracker", "brain", "dist", "brain.mjs")
REPO_MODEL = os.path.join(REPO, "public", "mediapipe", "hand_landmarker.task")
ENV_FILE = os.path.join(REPO, ".env.local")
KEY_NAMES = ("CARTESIA_API_KEY", "ANTHROPIC_API_KEY", "CARTESIA_VOICE_ID")


def data_dir() -> str:
    """~/Library/Application Support/Steady (STEADY_DATA_DIR overrides, for tests)."""
    return os.environ.get("STEADY_DATA_DIR") or os.path.expanduser("~/Library/Application Support/Steady")


def default_model_path() -> str:
    env = os.environ.get("STEADY_HAND_MODEL")
    if env:
        return env
    if os.path.isfile(REPO_MODEL):
        return REPO_MODEL
    return os.path.join(data_dir(), "models", "hand_landmarker.task")


_T0 = time.monotonic()


def now_ms() -> float:
    """The tracker's monotonic clock in ms (frame `t`, tick/action `now`). Never resets."""
    return (time.monotonic() - _T0) * 1000.0
