"""Watchdog thread: releases the button if no message arrived for 300 ms.

Every valid message from any Worker connection calls `feed()` (moves and pings included).
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Callable

from .config import WATCHDOG_S, WATCHDOG_TICK_S

log = logging.getLogger("steady.watchdog")


class Watchdog:
    def __init__(
        self,
        pointer,
        *,
        timeout: float = WATCHDOG_S,
        tick: float = WATCHDOG_TICK_S,
        clock: Callable[[], float] = time.monotonic,
        on_release: Callable[[], None] | None = None,
    ) -> None:
        self._pointer = pointer
        self.timeout = timeout
        self._tick = tick
        self._clock = clock
        self._last = clock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._on_release = on_release
        self.fired = 0

    def feed(self) -> None:
        self._last = self._clock()

    def check(self) -> bool:
        """One watchdog step (also used directly by tests). Returns True if it released."""
        if self._pointer.is_down and self._clock() - self._last > self.timeout:
            if self._pointer.release("watchdog: no message for %d ms" % int(self.timeout * 1000)):
                self.fired += 1
                if self._on_release:
                    try:
                        self._on_release()
                    except Exception:
                        log.exception("on_release callback failed")
                return True
        return False

    def _run(self) -> None:
        while not self._stop.wait(self._tick):
            try:
                self.check()
            except Exception:  # never let the watchdog die
                log.exception("watchdog check failed")
                try:
                    self._pointer.release("watchdog error")
                except Exception:
                    pass

    def start(self) -> "Watchdog":
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="steady-watchdog", daemon=True)
            self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1)
            self._thread = None
