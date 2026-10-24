"""Pointer state: the helper's half of the pen-state law.

Thread-safe (the watchdog thread and the asyncio thread both call it). The mouse
backend is injected (QuartzMouse for real, FakeMouse in tests).

- move while up → mouse-moved; move while down → left-mouse-dragged (middle → other-dragged).
- Rate ≤ 120 Hz, two regimes (review R5):
  * no button held and nothing queued: hover moves are COALESCED (the newest point wins);
  * a button held, or anything still queued: every move, and every button event that follows,
    goes into an ordered QUEUE drained at ≤ 120 Hz, so burst replays (Repeat stroke, Hatch's
    look-ahead replay, Dash) keep their shape and `up` lands after the stroke's last point.
    The queue is bounded to 2 s of moves (oldest moves dropped first).
  `move()` / `down()` / ... return the delay after which `pump()` must be called (0 = nothing
  pending); the server schedules it with call_later.
- while paused: `down`/`middle_down` are refused, `click` is honoured only inside chrome_rect,
  and moves are clamped to chrome_rect (defence in depth; the Worker clamps too).
- `release()` is the fail-safe: immediate, idempotent, never raises; it DROPS the queue and lifts
  both buttons. `on_release(reason, button)` is called for every button actually released.
- pan (P3): `middle_down`/`middle_up` hold the middle button. Lowering one button lifts the other.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Callable, Deque, Dict, Optional, Tuple

from .config import MAX_MOVE_HZ, MIN_MOVE_INTERVAL_S

log = logging.getLogger("steady.pointer")

Rect = Dict[str, float]
#: Queue bound while a button is held: 2 s of moves at 120 Hz.
QUEUE_MAX = int(2 * MAX_MOVE_HZ)


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
        queue_max: int = QUEUE_MAX,
    ) -> None:
        self._mouse = mouse
        self.enabled = enabled
        self._clock = clock
        self._min_interval = min_interval
        self._queue_max = queue_max
        self._lock = threading.RLock()
        self.is_down = False
        self.is_middle_down = False
        self.paused = False
        self.chrome_rect: Optional[Rect] = None
        self._pos: Optional[Tuple[float, float]] = None
        self._pending: Optional[Tuple[float, float]] = None  # coalesced hover point
        self._queue: Deque[tuple] = deque()  # ("move", x, y) | ("down",) | ("up",) | ("mdown",) | ("mup",)
        self._last_post = float("-inf")
        self.releases: int = 0  # count of actual button releases (diagnostics/tests)
        self.dropped_moves: int = 0
        #: Called as on_release(reason, "left"|"middle") for every button actually released.
        self.on_release: Optional[Callable[[str, str], None]] = None

    # -- state ---------------------------------------------------------------------------------
    @property
    def any_down(self) -> bool:
        return self.is_down or self.is_middle_down

    @property
    def queued(self) -> int:
        return len(self._queue)

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

    def _drag_kind(self) -> Optional[str]:
        if self.is_down:
            return "left"
        if self.is_middle_down:
            return "middle"
        return None

    def _queuing(self) -> bool:
        return self.any_down or bool(self._queue)

    def _post_move(self, x: float, y: float) -> None:
        self._pos = (x, y)
        self._pending = None
        self._last_post = self._clock()
        if self.enabled:
            self._mouse.move(x, y, self._drag_kind())

    def _enqueue(self, item: tuple) -> None:
        if item[0] == "move":
            n_moves = sum(1 for i in self._queue if i[0] == "move")
            if n_moves >= self._queue_max:
                for idx, it in enumerate(self._queue):
                    if it[0] == "move":
                        del self._queue[idx]
                        self.dropped_moves += 1
                        break
        self._queue.append(item)

    def next_delay(self) -> float:
        """Seconds until pump() has work (0 = nothing pending)."""
        with self._lock:
            if not self._queue and self._pending is None:
                return 0.0
            return max(1e-4, self._min_interval - (self._clock() - self._last_post))

    # -- moves ----------------------------------------------------------------------------------
    def move(self, x: float, y: float) -> float:
        """Returns 0 if nothing is pending afterwards, else seconds until pump() should be called."""
        with self._lock:
            if self.paused and self.chrome_rect:
                x, y = clamp_to(self.chrome_rect, x, y)
            if self._queuing():
                self._enqueue(("move", float(x), float(y)))
                return self.pump()
            now = self._clock()
            elapsed = now - self._last_post
            if elapsed >= self._min_interval:
                self._post_move(x, y)
                return 0.0
            self._pending = (x, y)
            return self._min_interval - elapsed

    def pump(self) -> float:
        """Post what is due: the coalesced hover point, or queue items in order (moves at
        ≤ 120 Hz; button events as soon as their turn comes). Returns the delay until the next
        call is needed, 0 when nothing is left."""
        with self._lock:
            if self._pending is not None and not self._queue:
                if self._clock() - self._last_post >= self._min_interval:
                    x, y = self._pending
                    self._post_move(x, y)
                    return 0.0
                return self.next_delay()
            while self._queue:
                item = self._queue[0]
                if item[0] == "move":
                    if self._clock() - self._last_post < self._min_interval:
                        return self.next_delay()
                    self._queue.popleft()
                    self._post_move(item[1], item[2])
                    continue
                self._queue.popleft()
                if item[0] == "down":
                    self._do_down()
                elif item[0] == "up":
                    self._release_left("up")
                elif item[0] == "mdown":
                    self._do_middle_down()
                elif item[0] == "mup":
                    self._release_middle("middle_up")
            return 0.0

    def flush(self) -> None:
        """Post the coalesced hover point now (tests / shutdown). Does not drain the queue."""
        with self._lock:
            if self._pending is not None:
                x, y = self._pending
                self._post_move(x, y)

    # -- buttons (Worker-requested; ordered behind queued moves) --------------------------------
    def down(self) -> float:
        with self._lock:
            if self.paused:
                raise Refused("paused", "Steady is paused; resume first.")
            if self._queue:
                self._enqueue(("down",))
                return self.pump()
            self.flush()
            self._do_down()
            return 0.0

    def up(self) -> float:
        with self._lock:
            if self._queue:
                self._enqueue(("up",))
                return self.pump()
            self._release_left("up")
            return 0.0

    def middle_down(self) -> float:
        with self._lock:
            if self.paused:
                raise Refused("paused", "Steady is paused; resume first.")
            if self._queue:
                self._enqueue(("mdown",))
                return self.pump()
            self.flush()
            self._do_middle_down()
            return 0.0

    def middle_up(self) -> float:
        with self._lock:
            if self._queue:
                self._enqueue(("mup",))
                return self.pump()
            self._release_middle("middle_up")
            return 0.0

    def _do_down(self) -> None:
        if self.paused or self.is_down:
            return
        self._release_middle("down")
        x, y = self.position()
        self.is_down = True
        self._pos = (x, y)
        if self.enabled:
            self._mouse.left_down(x, y)

    def _do_middle_down(self) -> None:
        if self.paused or self.is_middle_down:
            return
        self._release_left("pan")
        x, y = self.position()
        self.is_middle_down = True
        self._pos = (x, y)
        if self.enabled:
            self._mouse.middle_down(x, y)

    # -- fail-safe release ------------------------------------------------------------------------
    def release(self, reason: str = "") -> bool:
        """Drop queued moves and lift BOTH buttons now. Idempotent; never raises. True if it released any."""
        with self._lock:
            if self._queue:
                log.info("dropping %d queued pointer events (%s)", len(self._queue), reason)
                self._queue.clear()
            middle = self._release_middle(reason)
            left = self._release_left(reason)
            return left or middle

    def _notify(self, reason: str, button: str) -> None:
        cb = self.on_release
        if cb is not None:
            try:
                cb(reason, button)
            except Exception:
                log.exception("on_release callback failed")

    def _release_middle(self, reason: str) -> bool:
        with self._lock:
            if not self.is_middle_down:
                return False
            self.is_middle_down = False
            self.releases += 1
            x, y = self._pos if self._pos is not None else (0.0, 0.0)
            try:
                if self.enabled:
                    self._mouse.middle_up(x, y)
            except Exception:
                log.exception("middle_up failed during release (%s)", reason)
            log.info("released middle button (%s)", reason)
            self._notify(reason, "middle")
            return True

    def _release_left(self, reason: str) -> bool:
        with self._lock:
            if not self.is_down:
                return False
            self.is_down = False
            self.releases += 1
            x, y = self._pos if self._pos is not None else (0.0, 0.0)
            try:
                if self.enabled:
                    self._mouse.left_up(x, y)
            except Exception:
                log.exception("left_up failed during release (%s)", reason)
            log.info("released button (%s)", reason)
            self._notify(reason, "left")
            return True

    # -- click / pause ------------------------------------------------------------------------------
    def click(self, x: float, y: float) -> None:
        with self._lock:
            if self.paused and not inside(self.chrome_rect, x, y):
                raise Refused("outside_chrome", "While paused, clicks only land inside Steady's window.")
            self.release("click")
            self._pending = None
            self._pos = (x, y)
            self._last_post = self._clock()
            if self.enabled:
                self._mouse.move(x, y, None)
                self._mouse.left_down(x, y)
                self._mouse.left_up(x, y)

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
