"""Ring overlay logic (P3): state → shape/colour/visibility, ≤ 60 Hz throttle, auto-disable.

No real window is ever opened: the AppKit view is replaced by a fake; overlay.py is not imported.
"""

import asyncio
import sys

import pytest

from steadyhelper_testkit import mid, rig, wait_until  # noqa: I001

from steadyhelper import ring as R
from steadyhelper.config import KRITA_BUNDLE_ID, FKEY_KEYCODES

pytestmark = pytest.mark.P3


class FakeView:
    def __init__(self, fail_on_apply=False):
        self.frames = []
        self.closed = False
        self.fail_on_apply = fail_on_apply

    def apply(self, frame):
        if self.fail_on_apply:
            raise RuntimeError("AppKit exploded")
        self.frames.append(frame)

    def close(self):
        self.closed = True


class ManualMain:
    """Stands in for AppHelper.callAfter / callLater: queued, run by the test."""

    def __init__(self):
        self.now_q = []
        self.later_q = []

    def post(self, fn):
        self.now_q.append(fn)

    def post_later(self, delay, fn):
        self.later_q.append((delay, fn))

    def run_now(self):
        q, self.now_q = self.now_q, []
        for fn in q:
            fn()

    def run_later(self):
        q, self.later_q = self.later_q, []
        for _, fn in q:
            fn()


def test_overlay_module_not_imported_by_tests():
    assert "steadyhelper.overlay" not in sys.modules


@pytest.mark.parametrize(
    "state,shape,color,progress_shown,dashed",
    [
        ("hover", "hollow", R.BLUE, True, False),
        ("drawing", "filled", R.ORANGE, False, False),
        ("outside", "hollow", R.GREY, False, True),
        ("lost", "question", R.AMBER, False, True),
    ],
)
def test_state_to_shape_and_colour(state, shape, color, progress_shown, dashed):
    f = R.frame_for(state, 0.4, 812, 433)
    assert f.visible and f.shape == shape and f.color == color
    assert f.show_progress is progress_shown and f.dashed is dashed
    assert (f.x, f.y) == (812.0, 433.0)
    assert f.progress == (0.4 if progress_shown else 0.0)


def test_states_differ_by_shape_not_only_colour():
    shapes = {(R.frame_for(s, 0.5, 0, 0).shape, R.frame_for(s, 0.5, 0, 0).dashed) for s in ("hover", "drawing", "outside", "lost")}
    assert len(shapes) == 4


def test_hidden_paused_and_unknown_states_hide():
    assert R.frame_for("hidden", 1, 0, 0) == R.HIDDEN
    assert R.frame_for("hover", 1, 0, 0, paused=True) == R.HIDDEN
    assert R.frame_for("bogus", 1, 0, 0) == R.HIDDEN


def test_progress_clamped():
    assert R.frame_for("hover", 1.7, 0, 0).progress == 1.0
    assert R.frame_for("hover", -2, 0, 0).progress == 0.0


def test_window_is_small_and_centred_never_full_screen():
    assert R.RING_WINDOW_PT == 160.0
    ox, oy = R.window_origin(812, 433, 1117)
    assert (ox, oy) == (812 - 80, 1117 - 433 - 80)  # Cocoa: bottom-left origin, y up
    assert R.RING_WINDOW_PT < 320  # never covers the 320 px Chrome strip, let alone a screen


def test_throttle_60hz_newest_wins_and_hides_immediately():
    th = R.RingThrottle(60)
    a = R.frame_for("hover", 0.1, 0, 0)
    b = R.frame_for("hover", 0.2, 1, 0)
    c = R.frame_for("hover", 0.3, 2, 0)
    assert th.submit(a, 0.0) == a
    assert th.submit(b, 0.005) is None
    assert th.submit(c, 0.010) is None  # c replaces b
    assert th.due_in(0.010) == pytest.approx(1 / 60 - 0.010)
    assert th.flush(0.012) is None  # too early
    assert th.flush(0.017) == c
    assert th.submit(c, 0.05) is None  # identical: dropped
    assert th.submit(R.HIDDEN, 0.051) == R.HIDDEN  # visibility change never waits


def test_throttle_rate_over_one_second_of_120hz_input():
    th = R.RingThrottle(60)
    drawn = 0
    for i in range(120):
        t = i / 120
        if th.submit(R.frame_for("hover", i / 120, i, 0), t) is not None:
            drawn += 1
        if th.flush(t) is not None:
            drawn += 1
    assert drawn <= 61


def test_controller_posts_to_main_thread_and_flushes_pending():
    t = [0.0]
    main = ManualMain()
    view = FakeView()
    ctl = R.OverlayController(view, main.post, main.post_later, clock=lambda: t[0])
    ctl.submit({"state": "hover", "progress": 0.1, "x": 1, "y": 2})
    assert view.frames == []  # nothing drawn off the main thread
    main.run_now()
    assert view.frames[-1].progress == pytest.approx(0.1)
    t[0] = 0.005
    ctl.submit({"state": "drawing", "progress": 0, "x": 3, "y": 4})
    main.run_now()
    assert len(view.frames) == 1  # throttled
    assert len(main.later_q) == 1
    t[0] = 0.02
    main.run_later()
    assert view.frames[-1].shape == "filled" and (view.frames[-1].x, view.frames[-1].y) == (3.0, 4.0)


def test_controller_pause_hides_and_resume_waits_for_next_ring():
    t = [0.0]
    main = ManualMain()
    view = FakeView()
    ctl = R.OverlayController(view, main.post, main.post_later, clock=lambda: t[0])
    ctl.submit({"state": "hover", "progress": 0.5, "x": 1, "y": 1})
    main.run_now()
    t[0] = 0.001
    ctl.set_paused(True)
    main.run_now()
    assert view.frames[-1] == R.HIDDEN
    t[0] = 0.1
    ctl.submit({"state": "hover", "progress": 0.6, "x": 1, "y": 1})
    main.run_now()
    assert len(view.frames) == 2 and view.frames[-1] == R.HIDDEN  # stays hidden while paused
    t[0] = 0.2
    ctl.set_paused(False)
    main.run_now()
    assert view.frames[-1].visible
    t[0] = 0.3
    ctl.hide()
    main.run_now()
    assert view.frames[-1] == R.HIDDEN


def test_controller_disables_itself_on_any_view_exception_once():
    reasons = []
    main = ManualMain()
    view = FakeView(fail_on_apply=True)
    ctl = R.OverlayController(view, main.post, main.post_later, on_disabled=reasons.append)
    ctl.submit({"state": "hover", "progress": 0.1, "x": 1, "y": 2})
    main.run_now()
    assert ctl.disabled and view.closed
    assert len(reasons) == 1 and "AppKit exploded" in reasons[0]
    ctl.submit({"state": "hover", "progress": 0.2, "x": 1, "y": 2})
    main.run_now()
    assert len(reasons) == 1


def _threadsafe_controller(view):
    loop = asyncio.get_running_loop()
    return R.OverlayController(
        view,
        lambda fn: loop.call_soon_threadsafe(fn),
        lambda d, fn: loop.call_later(d, fn),
    )


@pytest.mark.asyncio
async def test_server_drives_overlay_from_ring_pause_and_f9():
    view = FakeView()
    ctl = _threadsafe_controller(view)
    async with rig() as r:
        r.server.overlay = ctl
        ctl._on_disabled = r.server._on_overlay_disabled
        r.system.frontmost = KRITA_BUNDLE_ID
        async with r.client() as c:
            await c.send({"t": "ring", "id": mid(), "state": "hover", "progress": 0.4, "x": 812, "y": 433})
            assert await wait_until(lambda: view.frames and view.frames[-1].visible)
            rid = mid()
            await c.send({"t": "pause", "id": rid})
            await c.recv_id(rid)
            assert await wait_until(lambda: view.frames[-1] == R.HIDDEN)
            rid = mid()
            await c.send({"t": "resume", "id": rid})
            await c.recv_id(rid)
            await asyncio.sleep(0.03)
            await c.send({"t": "ring", "id": mid(), "state": "lost", "progress": 0, "x": 5, "y": 5})
            assert await wait_until(lambda: view.frames[-1].shape == "question")
            # F9 hides at once, before the Worker's `pause` arrives
            assert await wait_until(lambda: r.server._frontmost == KRITA_BUNDLE_ID)
            await asyncio.sleep(0.03)
            r.server.router.handle(FKEY_KEYCODES["f9"], True)
            assert await wait_until(lambda: view.frames[-1] == R.HIDDEN)
            r.server.router.handle(FKEY_KEYCODES["f9"], False)
            await asyncio.sleep(0.03)
            await c.send({"t": "ring", "id": mid(), "state": "drawing", "progress": 0, "x": 5, "y": 5})
            assert await wait_until(lambda: view.frames[-1].visible)
        # Worker gone → ring hidden
        assert await wait_until(lambda: view.frames[-1] == R.HIDDEN)


@pytest.mark.asyncio
async def test_overlay_failure_sends_overlay_disabled_warning_now_and_to_later_clients():
    view = FakeView(fail_on_apply=True)
    ctl = _threadsafe_controller(view)
    async with rig() as r:
        r.server.overlay = ctl
        ctl._on_disabled = r.server._on_overlay_disabled
        async with r.client() as c:
            await c.send({"t": "ring", "id": mid(), "state": "hover", "progress": 0.4, "x": 1, "y": 1})
            w = await c.recv_type("warning")
            assert w["code"] == "overlay_disabled" and w["message"]
            assert ctl.disabled
            rid = mid()
            await c.send({"t": "ping", "id": rid})  # helper keeps working
            assert (await c.recv_id(rid))["t"] == "pong"
        async with r.client(skip_hello=False) as c2:
            assert (await c2.recv())["t"] == "hello"
            w2 = await c2.recv()
            assert w2["t"] == "warning" and w2["code"] == "overlay_disabled"


def test_cli_has_no_overlay_flag():
    from steadyhelper.main import parse_args

    assert parse_args([], env={}).no_overlay is False
    assert parse_args(["--no-overlay"], env={}).no_overlay is True
