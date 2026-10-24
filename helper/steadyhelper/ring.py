"""Ring overlay logic (P3, §5 last bullet). Pure: no AppKit imports, fully unit-tested.

`ring` message state → what the 160×160 pt ring window shows, and a ≤ 60 Hz throttle.
The AppKit view (`overlay.py`) only draws `RingFrame`s it is handed on the main thread.

Shapes (state is never colour-only, §0 rule 6):
  hover    → hollow ring + dwell-progress arc            (blue)
  drawing  → filled disc + ring                           (orange)
  outside  → hollow ring, dashed, no progress            (grey: nothing clicks here)
  lost     → "?" glyph in a dashed hollow ring            (amber)
  hidden   → window hidden
Paused (or F9 before the Worker answers) hides the ring regardless of state.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Tuple

log = logging.getLogger("steady.ring")

#: Window size in points. NEVER full-screen: Chrome's occlusion heuristic marks Chrome hidden
#: when any window above fully contains its frame, which would stall tracking.
RING_WINDOW_PT = 160.0
RING_RADIUS_PT = 28.0
RING_LINE_PT = 6.0
MAX_HZ = 60.0

RGBA = Tuple[float, float, float, float]

BLUE: RGBA = (0.11, 0.31, 0.85, 0.95)
ORANGE: RGBA = (0.90, 0.38, 0.0, 0.95)
GREY: RGBA = (0.45, 0.45, 0.45, 0.85)
AMBER: RGBA = (0.80, 0.55, 0.0, 0.95)

STATES = ("hover", "drawing", "outside", "lost", "hidden")

#: state → (shape, colour, show_progress, dashed)
STYLE: Dict[str, Tuple[str, RGBA, bool, bool]] = {
    "hover": ("hollow", BLUE, True, False),
    "drawing": ("filled", ORANGE, False, False),
    "outside": ("hollow", GREY, False, True),
    "lost": ("question", AMBER, False, True),
}


@dataclass(frozen=True)
class RingFrame:
    visible: bool
    x: float = 0.0  # pointer, Quartz global points (top-left origin)
    y: float = 0.0
    shape: str = "hollow"  # "hollow" | "filled" | "question"
    color: RGBA = BLUE
    progress: float = 0.0  # 0..1 dwell fill (drawn only when show_progress)
    show_progress: bool = False
    dashed: bool = False


HIDDEN = RingFrame(visible=False)


def frame_for(state: str, progress: float, x: float, y: float, paused: bool = False) -> RingFrame:
    if paused or state == "hidden" or state not in STYLE:
        return HIDDEN
    shape, color, show_progress, dashed = STYLE[state]
    p = min(1.0, max(0.0, float(progress))) if show_progress else 0.0
    return RingFrame(True, float(x), float(y), shape, color, p, show_progress, dashed)


def window_origin(x: float, y: float, primary_screen_h: float, size: float = RING_WINDOW_PT) -> Tuple[float, float]:
    """Cocoa window origin (bottom-left, y up from the primary screen's bottom) that centres a
    `size`-point window on the Quartz point (x, y) (top-left origin, y down)."""
    return (x - size / 2.0, primary_screen_h - y - size / 2.0)


class RingThrottle:
    """≤ max_hz frames; the newest frame always wins; identical frames are dropped.

    submit(frame, now) → frame to draw now, or None (then `pending` holds it and
    `due_in(now)` says when to call `flush(now)`).
    """

    def __init__(self, max_hz: float = MAX_HZ) -> None:
        self.min_interval = 1.0 / max_hz
        self._last_t = float("-inf")
        self._last: Optional[RingFrame] = None
        self.pending: Optional[RingFrame] = None

    def submit(self, frame: RingFrame, now: float) -> Optional[RingFrame]:
        if frame == self._last and self.pending is None:
            return None
        # visibility changes are never delayed (hide must be immediate)
        if now - self._last_t >= self.min_interval or (self._last is not None and frame.visible != self._last.visible):
            return self._emit(frame, now)
        self.pending = frame
        return None

    def due_in(self, now: float) -> Optional[float]:
        if self.pending is None:
            return None
        return max(0.0, self.min_interval - (now - self._last_t))

    def flush(self, now: float) -> Optional[RingFrame]:
        if self.pending is None or now - self._last_t < self.min_interval:
            return None
        frame = self.pending
        if frame == self._last:
            self.pending = None
            return None
        return self._emit(frame, now)

    def _emit(self, frame: RingFrame, now: float) -> RingFrame:
        self.pending = None
        self._last = frame
        self._last_t = now
        return frame


class OverlayController:
    """Thread-safe front end used by the server (asyncio thread).

    `view` has `apply(frame)` and `close()` and must be called on the main thread: every call
    goes through `post(fn)` (AppHelper.callAfter in production) and pending throttled frames
    through `post_later(delay, fn)` (AppHelper.callLater). Any exception from the view
    disables the overlay for good and calls `on_disabled(reason)` once.
    """

    def __init__(
        self,
        view,
        post: Callable[[Callable[[], None]], None],
        post_later: Callable[[float, Callable[[], None]], None],
        *,
        clock: Callable[[], float] = time.monotonic,
        on_disabled: Optional[Callable[[str], None]] = None,
        max_hz: float = MAX_HZ,
    ) -> None:
        self._view = view
        self._post = post
        self._post_later = post_later
        self._clock = clock
        self._on_disabled = on_disabled
        self._throttle = RingThrottle(max_hz)
        self._lock = threading.Lock()
        self._flush_scheduled = False
        self._last_state: Tuple[str, float, float, float] = ("hidden", 0.0, 0.0, 0.0)
        self.paused = False
        self.disabled = False
        self.disabled_reason: Optional[str] = None

    # -- inputs (any thread) ---------------------------------------------------------------
    def submit(self, msg: Dict[str, Any]) -> None:
        state = (str(msg.get("state")), float(msg.get("progress", 0)), float(msg.get("x", 0)), float(msg.get("y", 0)))
        with self._lock:
            self._last_state = state
        self._push()

    def set_paused(self, paused: bool) -> None:
        with self._lock:
            self.paused = paused
        self._push()

    def hide(self) -> None:
        """Hide now (F9, Worker disconnected). The next `ring` message shows it again unless paused."""
        with self._lock:
            self._last_state = ("hidden", 0.0, 0.0, 0.0)
        self._push()

    # -- internals ----------------------------------------------------------------------------
    def _push(self) -> None:
        if self.disabled:
            return
        with self._lock:
            s, p, x, y = self._last_state
            frame = frame_for(s, p, x, y, self.paused)
            now = self._clock()
            out = self._throttle.submit(frame, now)
            delay = self._throttle.due_in(now)
            schedule = delay is not None and not self._flush_scheduled
            if schedule:
                self._flush_scheduled = True
        if out is not None:
            self._safe_post(lambda f=out: self._apply(f))
        if schedule:
            try:
                self._post_later(delay, self._flush)
            except Exception as e:
                self.disable(f"post_later failed: {e}")

    def _flush(self) -> None:
        with self._lock:
            self._flush_scheduled = False
            out = self._throttle.flush(self._clock())
            again = self._throttle.due_in(self._clock())
            if again is not None:
                self._flush_scheduled = True
        if out is not None:
            self._apply(out)  # already on the main thread
        if again is not None:
            try:
                self._post_later(again, self._flush)
            except Exception as e:
                self.disable(f"post_later failed: {e}")

    def _safe_post(self, fn: Callable[[], None]) -> None:
        try:
            self._post(fn)
        except Exception as e:
            self.disable(f"post failed: {e}")

    def _apply(self, frame: RingFrame) -> None:
        if self.disabled:
            return
        try:
            self._view.apply(frame)
        except Exception as e:  # any AppKit failure: turn the overlay off for good
            log.exception("ring overlay failed; disabling it")
            self.disable(f"{type(e).__name__}: {e}")

    def disable(self, reason: str) -> None:
        with self._lock:
            if self.disabled:
                return
            self.disabled = True
            self.disabled_reason = reason
        try:
            self._view.close()
        except Exception:
            pass
        if self._on_disabled:
            try:
                self._on_disabled(reason)
            except Exception:
                log.exception("on_disabled failed")
