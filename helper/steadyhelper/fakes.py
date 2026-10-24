"""In-memory fakes for tests: never touch the real pointer, keyboard or apps."""

from __future__ import annotations

import threading
from typing import Dict, List, Optional, Tuple

from .config import KRITA_BUNDLE_ID
from .keys import KeyStroke


class FakeMouse:
    def __init__(self) -> None:
        self.events: List[Tuple[str, float, float]] = []
        self._pos = (0.0, 0.0)
        self.fail_on: Optional[str] = None  # "move" | "left_down" | "left_up" → raise once
        self._lock = threading.Lock()

    def _maybe_fail(self, what: str) -> None:
        if self.fail_on == what:
            self.fail_on = None
            raise RuntimeError(f"fake {what} failure")

    def move(self, x: float, y: float, drag: Optional[str]) -> None:
        """drag: None → "move", "left" → "drag", "middle" → "middle_drag"."""
        self._maybe_fail("move")
        kind = {None: "move", "left": "drag", "middle": "middle_drag"}[drag]
        with self._lock:
            self.events.append((kind, x, y))
            self._pos = (x, y)

    def left_down(self, x: float, y: float) -> None:
        self._maybe_fail("left_down")
        with self._lock:
            self.events.append(("down", x, y))

    def left_up(self, x: float, y: float) -> None:
        self._maybe_fail("left_up")
        with self._lock:
            self.events.append(("up", x, y))

    def middle_down(self, x: float, y: float) -> None:
        self._maybe_fail("middle_down")
        with self._lock:
            self.events.append(("middle_down", x, y))

    def middle_up(self, x: float, y: float) -> None:
        self._maybe_fail("middle_up")
        with self._lock:
            self.events.append(("middle_up", x, y))

    def position(self) -> Tuple[float, float]:
        return self._pos

    def kinds(self) -> List[str]:
        with self._lock:
            return [e[0] for e in self.events]


class FakeKeyPoster:
    def __init__(self, system: "FakeSystem | None" = None) -> None:
        self.posted: List[Tuple[str, Optional[str]]] = []  # (combo, frontmost at post time)
        self._system = system

    def post(self, stroke: KeyStroke) -> None:
        front = self._system.frontmost_bundle_id() if self._system else None
        self.posted.append((stroke.combo, front))


class FakeSystem:
    """Frontmost app / Krita process / window list provider."""

    def __init__(
        self,
        *,
        frontmost: Optional[str] = "com.google.Chrome",
        krita_running: bool = True,
        krita_rect: Optional[Dict[str, float]] = None,
        activation_works: bool = True,
        activation_delay_pumps: int = 0,
    ) -> None:
        self.frontmost = frontmost
        self.krita_running = krita_running
        self.krita_rect = krita_rect if krita_rect is not None else {"x": 0.0, "y": 25.0, "w": 1400.0, "h": 1060.0}
        self.activation_works = activation_works
        self.activation_delay_pumps = activation_delay_pumps
        self._pending_activation = -1
        self.activations = 0
        self.pumps = 0

    def pump(self) -> None:
        self.pumps += 1
        if self._pending_activation > 0:
            self._pending_activation -= 1
        if self._pending_activation == 0:
            self._pending_activation = -1
            self.frontmost = KRITA_BUNDLE_ID

    def frontmost_bundle_id(self) -> Optional[str]:
        return self.frontmost

    def krita_pid(self) -> Optional[int]:
        return 4242 if self.krita_running else None

    def activate_krita(self) -> bool:
        if not self.krita_running:
            return False
        self.activations += 1
        if self.activation_works:
            if self.activation_delay_pumps <= 0:
                self.frontmost = KRITA_BUNDLE_ID
            else:
                self._pending_activation = self.activation_delay_pumps
        return True

    def krita_window_rect(self) -> Optional[Dict[str, float]]:
        return dict(self.krita_rect) if self.krita_running and self.krita_rect else None

    def screen(self) -> Dict[str, float]:
        return {"w": 1728.0, "h": 1117.0, "scale": 2.0}
