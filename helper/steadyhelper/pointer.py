"""Pointer state: the helper's half of the pen-state law.

Thread-safe (the watchdog thread and the asyncio thread both call it). The mouse
backend is injected (QuartzMouse for real, FakeMouse in tests).

- move while up → mouse-moved; move while down → left-mouse-dragged.
- moves are coalesced to ≤ 120 Hz: `move()` posts at once if the last post was long
  enough ago, else stores the target and returns the delay after which `flush()` must be
  called. Button events flush the pending move first so they land at the latest point.
- while paused: `down` is refused, `click` is honoured only inside chrome_rect, and moves
  are clamped to chrome_rect (defence in depth; the Worker clamps too).
- `release()` is idempotent and never raises: it is what every fail-safe calls.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Callable, Dict, Optional, Tuple

from .config import MIN_MOVE_INTERVAL_S

log = logging.getLogger("steady.pointer")

Rect = Dict[str, float]


class Refused(Exception):
    """Raised by down()/click() when the pen-state law forbids it. `code` is a protocol error code."""

    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.code = code


def inside(rect: Optional[Rect], x: float, y: float) -> bool:
    if not rect:
        return False
    return rect["x"] <= x <= rect["x"] + rect["w"] and rect["y"] <= y <= rect["y"] + rect["h"]


def clamp_to(rect: Rect, x: float, y: float) -> Tuple[float, float]:
    return (
        min(max(x, rect["x"]), rect["x"] + rect["w"]),
        min(max(y, rect["y"]), rect["y"] + rect["h"]),
    )


class Pointer:
    def __init__(
        self,
        mouse,
        *,
        enabled: bool = True,
        clock: Callable[[], float] = time.monotonic,
        min_interval: float = MIN_MOVE_INTERVAL_S,
    ) -> None:
        self._mouse = mouse
        self.enabled = enabled
        self._clock = clock
        self._min_interval = min_interval
        self._lock = threading.RLock()
        self.is_down = False
        self.paused = False
        self.chrome_rect: Optional[Rect] = None
        self._pos: Optional[Tuple[float, float]] = None
        self._pending: Optional[Tuple[float, float]] = None
        self._last_post = float("-inf")
        self.releases: int = 0  # count of actual button releases (diagnostics/tests)

    # -- position ---------------------------------------------------------------------------
    def position(self) -> Tuple[float, float]:
        with self._lock:
            if self._pending is not None:
                return self._pending
            if self._pos is not None:
                return self._pos
            try:
                return self._mouse.position()
            except Exception:
                return (0.0, 0.0)

    def _post_move(self, x: float, y: float) -> None:
        self._pos = (x, y)
        self._pending = None
        self._last_post = self._clock()
        if self.enabled:
            self._mouse.move(x, y, self.is_down)

    def move(self, x: float, y: float) -> float:
        """Returns 0 if posted now, else seconds until flush() should be called."""
        with self._lock:
            if self.paused and self.chrome_rect:
                x, y = clamp_to(self.chrome_rect, x, y)
            now = self._clock()
            elapsed = now - self._last_post
            if elapsed >= self._min_interval:
                self._post_move(x, y)
                return 0.0
            self._pending = (x, y)
            return self._min_interval - elapsed

    def flush(self) -> None:
        with self._lock:
            if self._pending is not None:
                x, y = self._pending
                self._post_move(x, y)

    # -- buttons -------------------------------------------------------------------------------
    def down(self) -> None:
        with self._lock:
            if self.paused:
                raise Refused("paused", "Steady is paused; resume first.")
            self.flush()
            if self.is_down:
                return
            x, y = self.position()
            self.is_down = True
            self._pos = (x, y)
            if self.enabled:
                self._mouse.left_down(x, y)

    def up(self) -> None:
        self.release("up")

    def release(self, reason: str = "") -> bool:
        """Lift the left button if held. Idempotent; never raises. Returns True if it released."""
        with self._lock:
            if not self.is_down:
                return False
            try:
                self.flush()  # the stroke reaches its last point (as a drag) before lifting
            except Exception:
                log.exception("flush during release failed")
            self.is_down = False
            self.releases += 1
            x, y = self._pos if self._pos is not None else (0.0, 0.0)
            try:
                if self.enabled:
                    self._mouse.left_up(x, y)
            except Exception:
                log.exception("left_up failed during release (%s)", reason)
            log.info("released button (%s)", reason)
            return True

    def click(self, x: float, y: float) -> None:
        with self._lock:
            if self.paused and not inside(self.chrome_rect, x, y):
                raise Refused("outside_chrome", "While paused, clicks only land inside Steady's window.")
            self.release("click")
            self._pending = None
            self._pos = (x, y)
            self._last_post = self._clock()
            if self.enabled:
                self._mouse.move(x, y, False)
                self._mouse.left_down(x, y)
                self._mouse.left_up(x, y)

    # -- pause ----------------------------------------------------------------------------------
    def pause(self) -> None:
        with self._lock:
            self.release("pause")
            self.paused = True

    def resume(self) -> None:
        with self._lock:
            self.paused = False

    def set_chrome_rect(self, rect: Rect) -> None:
        with self._lock:
            self.chrome_rect = dict(rect)
