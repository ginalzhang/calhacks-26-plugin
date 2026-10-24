"""Ring overlay, AppKit half (P3, §5 last bullet). Thin by design: all decisions live in ring.py.

Imported only when the overlay is enabled (never by tests: it would open a real window).

- 160×160 pt borderless NSWindow, transparent, ignores mouse events, NSStatusWindowLevel + 1,
  joins all Spaces / stationary / full-screen auxiliary / ignores cycle, no shadow. NEVER
  full-screen (Chrome's occlusion heuristic would mark Chrome hidden and stall tracking).
- A CAShapeLayer ring + progress arc + filled disc + "?" CATextLayer, redrawn from RingFrame.
- `run_app_with_overlay()` runs AppHelper.runEventLoop on the main thread and the asyncio
  WebSocket server in a background thread; redraws reach the main thread via
  AppHelper.callAfter / callLater (≤ 60 Hz, throttled in ring.OverlayController).
"""

from __future__ import annotations

import logging
import math
import signal
import threading
from typing import Callable, List, Optional, Tuple

from .ring import RING_LINE_PT, RING_RADIUS_PT, RING_WINDOW_PT, OverlayController, RingFrame, window_origin

log = logging.getLogger("steady.overlay")


class AppKitRingView:
    """Must be constructed and `apply`-ed on the main thread."""

    def __init__(self) -> None:
        import AppKit
        import Quartz
        from PyObjCTools import AppHelper

        self._A, self._Q, self._H = AppKit, Quartz, AppHelper
        A, Q = AppKit, Quartz
        size = RING_WINDOW_PT
        win = A.NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            A.NSMakeRect(0, 0, size, size), A.NSWindowStyleMaskBorderless, A.NSBackingStoreBuffered, False
        )
        win.setOpaque_(False)
        win.setBackgroundColor_(A.NSColor.clearColor())
        win.setIgnoresMouseEvents_(True)
        win.setLevel_(A.NSStatusWindowLevel + 1)
        win.setCollectionBehavior_(
            A.NSWindowCollectionBehaviorCanJoinAllSpaces
            | A.NSWindowCollectionBehaviorStationary
            | A.NSWindowCollectionBehaviorFullScreenAuxiliary
            | A.NSWindowCollectionBehaviorIgnoresCycle
        )
        win.setHasShadow_(False)
        win.setReleasedWhenClosed_(False)
        content = win.contentView()
        content.setWantsLayer_(True)
        root = content.layer()
        scale = float(A.NSScreen.mainScreen().backingScaleFactor()) if A.NSScreen.mainScreen() else 2.0

        c = size / 2.0
        r = RING_RADIUS_PT
        circle = Q.CGPathCreateWithEllipseInRect(Q.CGRectMake(c - r, c - r, 2 * r, 2 * r), None)
        arc = Q.CGPathCreateMutable()
        # clockwise from 12 o'clock (layer y is up)
        Q.CGPathAddArc(arc, None, c, c, r, math.pi / 2, math.pi / 2 - 2 * math.pi, True)

        def shape(path):
            layer = Q.CAShapeLayer.layer()
            layer.setFrame_(Q.CGRectMake(0, 0, size, size))
            layer.setPath_(path)
            layer.setFillColor_(None)
            layer.setLineWidth_(RING_LINE_PT)
            layer.setContentsScale_(scale)
            root.addSublayer_(layer)
            return layer

        self._disc = shape(circle)
        self._track = shape(circle)
        self._track.setLineWidth_(RING_LINE_PT / 2)
        self._progress = shape(arc)
        self._progress.setLineCap_("round")
        text = Q.CATextLayer.layer()
        text.setFrame_(Q.CGRectMake(c - r, c - r - 4, 2 * r, 2 * r))
        text.setString_("?")
        text.setFontSize_(40.0)
        text.setAlignmentMode_("center")
        text.setContentsScale_(scale)
        root.addSublayer_(text)
        self._text = text
        self._win = win
        self._shown = False

    def _cg(self, rgba: Tuple[float, float, float, float], alpha_scale: float = 1.0):
        r, g, b, a = rgba
        return self._Q.CGColorCreateGenericRGB(r, g, b, a * alpha_scale)

    def apply(self, frame: RingFrame) -> None:
        A, Q = self._A, self._Q
        if not frame.visible:
            if self._shown:
                self._win.orderOut_(None)
                self._shown = False
            return
        screens = A.NSScreen.screens()
        primary_h = float(screens[0].frame().size.height) if screens and len(screens) else 0.0
        ox, oy = window_origin(frame.x, frame.y, primary_h)
        Q.CATransaction.begin()
        Q.CATransaction.setDisableActions_(True)
        try:
            col = self._cg(frame.color)
            self._track.setStrokeColor_(col)
            self._track.setLineDashPattern_([6, 4] if frame.dashed else None)
            self._disc.setStrokeColor_(None)
            self._disc.setFillColor_(self._cg(frame.color, 0.35) if frame.shape == "filled" else None)
            self._progress.setStrokeColor_(col)
            self._progress.setHidden_(not frame.show_progress)
            self._progress.setStrokeEnd_(frame.progress)
            self._text.setForegroundColor_(col)
            self._text.setHidden_(frame.shape != "question")
        finally:
            Q.CATransaction.commit()
        self._win.setFrameOrigin_(A.NSMakePoint(ox, oy))
        if not self._shown:
            self._win.orderFrontRegardless()
            self._shown = True

    def close(self) -> None:
        win = self._win
        try:
            self._H.callAfter(win.orderOut_, None)
        except Exception:
            pass


def run_app_with_overlay(
    serve: Callable[[Optional[OverlayController], Callable], None],
    pointer,
    warnings: List[Tuple[str, str]],
) -> None:
    """Main thread: Cocoa event loop + overlay. Background thread: `serve(overlay, on_ready)`,
    which runs the asyncio server and calls `on_ready(loop, stop_event)` once it is up.

    If the window cannot be created, `serve` gets overlay=None and an `overlay_disabled`
    warning is appended to `warnings` (sent to every client after `hello`).
    """
    import AppKit
    from PyObjCTools import AppHelper

    app = AppKit.NSApplication.sharedApplication()
    app.setActivationPolicy_(AppKit.NSApplicationActivationPolicyAccessory)  # no Dock icon, never steals focus

    overlay: Optional[OverlayController] = None
    try:
        overlay = OverlayController(AppKitRingView(), AppHelper.callAfter, AppHelper.callLater)
    except Exception as e:
        log.exception("could not create the ring overlay; continuing without it")
        warnings.append(("overlay_disabled", f"The pointer ring is off ({type(e).__name__}). Steady works without it."))

    ready = {}
    errors: List[BaseException] = []

    def on_ready(loop, stop_event) -> None:
        ready["loop"], ready["stop"] = loop, stop_event

    def request_stop() -> None:
        loop, stop = ready.get("loop"), ready.get("stop")
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(stop.set)

    def server_thread() -> None:
        try:
            serve(overlay, on_ready)
        except BaseException as e:  # noqa: BLE001 - re-raised on the main thread
            errors.append(e)
            pointer.release("server thread exception")
        finally:
            AppHelper.callAfter(AppHelper.stopEventLoop)

    def on_signal(signum, _frame) -> None:
        pointer.release(f"signal {signum}")
        request_stop()
        AppHelper.stopEventLoop()

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, on_signal)

    def tick() -> None:  # gives Python a chance to run signal handlers while Cocoa runs
        AppHelper.callLater(0.25, tick)

    t = threading.Thread(target=server_thread, name="steady-server", daemon=True)
    t.start()
    AppHelper.callLater(0.25, tick)
    try:
        AppHelper.runEventLoop(installInterrupt=False)
    finally:
        pointer.release("event loop ended")
        request_stop()
        t.join(timeout=3)
    if errors:
        raise errors[0]
