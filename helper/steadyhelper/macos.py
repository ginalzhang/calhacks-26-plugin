"""Real macOS backends (Quartz CGEvent, NSWorkspace, CGWindowList).

Everything here touches the real system and is therefore NOT exercised by pytest
beyond pure helpers (`pick_main_window`). Tests inject the fakes in `fakes.py`.

Interfaces (duck-typed):
  MouseBackend : move(x, y, drag: None|"left"|"middle") · left_down/left_up(x, y)
                 middle_down/middle_up(x, y) · position() -> (x, y)
  KeyPoster    : post(stroke: KeyStroke)
  System       : frontmost_bundle_id() · krita_pid() · activate_krita() -> bool
                 krita_window_rect() -> rect | None · screen() -> {w,h,scale} · pump()
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Iterable, Optional, Tuple

from .config import KRITA_BUNDLE_ALIASES, KRITA_BUNDLE_ID
from .keys import KeyStroke

log = logging.getLogger("steady.macos")

Rect = Dict[str, float]


# --- pure helpers (tested) ---------------------------------------------------------

def pick_main_window(windows: Iterable[Dict[str, Any]], pid: int) -> Optional[Rect]:
    """Largest layer-0 window owned by `pid`, from CGWindowListCopyWindowInfo dicts."""
    best: Optional[Rect] = None
    best_area = 0.0
    for w in windows:
        try:
            if int(w.get("kCGWindowOwnerPID", -1)) != pid:
                continue
            if int(w.get("kCGWindowLayer", -1)) != 0:
                continue
            b = w.get("kCGWindowBounds") or {}
            x, y = float(b.get("X", 0)), float(b.get("Y", 0))
            ww, hh = float(b.get("Width", 0)), float(b.get("Height", 0))
        except (TypeError, ValueError):
            continue
        area = ww * hh
        if ww < 50 or hh < 50:
            continue  # tooltips, drag images
        if area > best_area:
            best_area = area
            best = {"x": x, "y": y, "w": ww, "h": hh}
    return best


def usable_at(x: float, y: float, screens) -> Optional[bool]:
    """Is (x, y) inside the usable area (visibleFrame: no menu bar, no Dock) of the screen that
    contains it? `screens` = [(frame, visible_frame)] in Quartz points. None = unknown geometry.
    A point on no screen is not usable."""
    if not screens:
        return None
    for frame, visible in screens:
        fx, fy, fw, fh = frame["x"], frame["y"], frame["w"], frame["h"]
        if fx <= x < fx + fw and fy <= y < fy + fh:
            vx, vy, vw, vh = visible["x"], visible["y"], visible["w"], visible["h"]
            return vx <= x < vx + vw and vy <= y < vy + vh
    return False


def cocoa_to_quartz(x: float, y: float, w: float, h: float, primary_h: float) -> Rect:
    """Cocoa rect (bottom-left origin of the primary screen, y up) → Quartz (top-left, y down)."""
    return {"x": float(x), "y": float(primary_h - (y + h)), "w": float(w), "h": float(h)}


# --- pointer ----------------------------------------------------------------------------

class QuartzMouse:
    """Posts CGEvents to kCGHIDEventTap. Global points, top-left origin."""

    def __init__(self) -> None:
        import Quartz  # noqa: F401  (fail early if pyobjc is missing)

        self._Q = Quartz

    def _post(self, etype: int, x: float, y: float, click_state: int = 0, button=None) -> None:
        Q = self._Q
        ev = Q.CGEventCreateMouseEvent(None, etype, (x, y), Q.kCGMouseButtonLeft if button is None else button)
        if click_state:
            Q.CGEventSetIntegerValueField(ev, Q.kCGMouseEventClickState, click_state)
        Q.CGEventPost(Q.kCGHIDEventTap, ev)

    def move(self, x: float, y: float, drag) -> None:
        Q = self._Q
        if drag == "left":
            self._post(Q.kCGEventLeftMouseDragged, x, y)
        elif drag == "middle":
            self._post(Q.kCGEventOtherMouseDragged, x, y, button=Q.kCGMouseButtonCenter)
        else:
            self._post(Q.kCGEventMouseMoved, x, y)

    def middle_down(self, x: float, y: float) -> None:
        Q = self._Q
        self._post(Q.kCGEventOtherMouseDown, x, y, 1, button=Q.kCGMouseButtonCenter)

    def middle_up(self, x: float, y: float) -> None:
        Q = self._Q
        self._post(Q.kCGEventOtherMouseUp, x, y, 1, button=Q.kCGMouseButtonCenter)

    def left_down(self, x: float, y: float) -> None:
        self._post(self._Q.kCGEventLeftMouseDown, x, y, 1)

    def left_up(self, x: float, y: float) -> None:
        self._post(self._Q.kCGEventLeftMouseUp, x, y, 1)

    def position(self) -> Tuple[float, float]:
        Q = self._Q
        loc = Q.CGEventGetLocation(Q.CGEventCreate(None))
        return float(loc.x), float(loc.y)


class QuartzKeyPoster:
    def __init__(self) -> None:
        import Quartz

        self._Q = Quartz

    def post(self, stroke: KeyStroke) -> None:
        Q = self._Q
        for down in (True, False):
            ev = Q.CGEventCreateKeyboardEvent(None, stroke.keycode, down)
            Q.CGEventSetFlags(ev, stroke.flags)
            Q.CGEventPost(Q.kCGHIDEventTap, ev)


# --- system -------------------------------------------------------------------------------

class MacSystem:
    """`target_bundle` is the drawing app (Krita by default; `--app photoshop`). The method names
    say "krita" because the protocol fields do; they mean "the selected drawing app"."""

    def __init__(self, target_bundle: str = KRITA_BUNDLE_ID) -> None:
        self.target_bundle = target_bundle
        import AppKit
        import Quartz

        self._A = AppKit
        self._Q = Quartz

    def pump(self) -> None:
        """Run the current (main) thread's run loop briefly.

        NSWorkspace.frontmostApplication() is updated by notifications delivered on the
        main run loop; in a plain Python process nothing runs that loop, so the value goes
        stale. The server calls this every 50 ms from the main thread.
        """
        A = self._A
        try:
            A.NSRunLoop.currentRunLoop().runMode_beforeDate_(
                A.NSDefaultRunLoopMode, A.NSDate.dateWithTimeIntervalSinceNow_(0.001)
            )
        except Exception:  # pragma: no cover - defensive
            log.debug("run loop pump failed", exc_info=True)

    def frontmost_bundle_id(self) -> Optional[str]:
        app = self._A.NSWorkspace.sharedWorkspace().frontmostApplication()
        bid = str(app.bundleIdentifier()) if app is not None and app.bundleIdentifier() else None
        return KRITA_BUNDLE_ID if bid in KRITA_BUNDLE_ALIASES else bid

    def _krita_app(self):
        ids = KRITA_BUNDLE_ALIASES if self.target_bundle in KRITA_BUNDLE_ALIASES else (self.target_bundle,)
        for bid in ids:
            apps = self._A.NSRunningApplication.runningApplicationsWithBundleIdentifier_(bid)
            if apps and len(apps):
                return apps[0]
        return None

    def krita_pid(self) -> Optional[int]:
        app = self._krita_app()
        return int(app.processIdentifier()) if app is not None else None

    def activate_krita(self) -> bool:
        app = self._krita_app()
        if app is None:
            return False
        return bool(app.activateWithOptions_(self._A.NSApplicationActivateIgnoringOtherApps))

    def krita_window_rect(self) -> Optional[Rect]:
        pid = self.krita_pid()
        if pid is None:
            return None
        Q = self._Q
        infos = Q.CGWindowListCopyWindowInfo(
            Q.kCGWindowListOptionOnScreenOnly | Q.kCGWindowListExcludeDesktopElements, Q.kCGNullWindowID
        )
        return pick_main_window([dict(w) for w in (infos or [])], pid)

    def screens(self):
        """[(frame, visible_frame)] for every display, Quartz points."""
        A = self._A
        ss = A.NSScreen.screens()
        if not ss or not len(ss):
            return []
        h0 = float(ss[0].frame().size.height)

        def conv(r):
            return cocoa_to_quartz(r.origin.x, r.origin.y, r.size.width, r.size.height, h0)

        return [(conv(s.frame()), conv(s.visibleFrame())) for s in ss]

    def visible_frame(self) -> Optional[Rect]:
        """NSScreen.mainScreen().visibleFrame() in Quartz points (hello.visible_frame)."""
        A = self._A
        ss = A.NSScreen.screens()
        main = A.NSScreen.mainScreen()
        if main is None or not ss or not len(ss):
            return None
        h0 = float(ss[0].frame().size.height)
        r = main.visibleFrame()
        return cocoa_to_quartz(r.origin.x, r.origin.y, r.size.width, r.size.height, h0)

    def screen(self) -> Dict[str, float]:
        Q = self._Q
        did = Q.CGMainDisplayID()
        b = Q.CGDisplayBounds(did)
        w, h = float(b.size.width), float(b.size.height)
        mode = Q.CGDisplayCopyDisplayMode(did)
        scale = 1.0
        try:
            if mode is not None and w > 0:
                scale = float(Q.CGDisplayModeGetPixelWidth(mode)) / w
        except Exception:  # pragma: no cover
            pass
        return {"w": w, "h": h, "scale": scale}


def running_process_names() -> list:
    """Names of running processes (best effort, for startup warnings)."""
    import subprocess

    try:
        out = subprocess.run(["ps", "-axco", "comm="], capture_output=True, text=True, timeout=2).stdout
    except Exception:
        return []
    return [line.strip() for line in out.splitlines() if line.strip()]


def own_pid() -> int:
    return os.getpid()
