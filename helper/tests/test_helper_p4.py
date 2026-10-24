"""P4: numbered badges over Krita widgets (`numbers`) and the second app profile (`--app`)."""

import asyncio

import pytest

from steadyhelper_testkit import EXAMPLES, mid, rig, wait_until  # noqa: I001

from steadyhelper import ring as R
from steadyhelper.config import CHROME_BUNDLE_IDS, FKEY_KEYCODES, KRITA_BUNDLE_ID, PHOTOSHOP_BUNDLE_ID
from steadyhelper.fakes import FakeSystem
from steadyhelper.hotkeys import HotkeyRouter
from steadyhelper.main import parse_args
from steadyhelper.protocol import validate_worker_msg

pytestmark = pytest.mark.P4


# ------------------------------------------------------------------ badge layout (pure)
def item(n, x=100, y=200, w=64, h=64, label="Tool"):
    return {"n": n, "label": label, "rect": {"x": x, "y": y, "w": w, "h": h}}


def test_examples_validate():
    for name in ("numbers", "numbers_hide"):
        assert validate_worker_msg(EXAMPLES["worker_to_helper"][name]) is None
    assert validate_worker_msg({"t": "numbers", "id": "a", "items": [{"n": 1, "label": "x"}]}) is not None
    assert validate_worker_msg({"t": "numbers", "id": "a"}) is not None


def test_badge_at_rect_top_left_with_at_least_28pt_digits():
    (b,) = R.layout_badges([item(5, x=100, y=200, w=64, h=64)])
    assert (b.x, b.y) == (100.0, 200.0)
    assert b.font_pt >= 28 and b.full_size
    assert b.w <= 64 and b.h <= 64
    assert b.text == "5" and b.n == 5 and b.label == "Tool"


@pytest.mark.parametrize("w,h", [(36, 36), (48, 40), (64, 64), (200, 120), (120, 48), (300, 300)])
def test_badge_never_covers_more_than_its_rect(w, h):
    for n in (7, 42):
        (b,) = R.layout_badges([item(n, w=w, h=h)])
        assert b.w <= w and b.h <= h
        assert b.x == 100 and b.y == 200


def test_big_rects_get_bigger_digits_capped_at_40pt():
    (b,) = R.layout_badges([item(3, w=300, h=300)])
    assert b.font_pt == 40.0


def test_small_widgets_shrink_to_fit_and_are_flagged():
    (b,) = R.layout_badges([item(12, w=22, h=22)])  # a default-size Krita icon
    assert b.w <= 22 and b.h <= 22
    assert b.font_pt < 28 and not b.full_size
    (b2,) = R.layout_badges([item(1, w=36, h=36)])
    assert b2.full_size  # 28 pt plate is 35 pt tall


def test_layout_skips_bad_items_and_caps_count():
    items = [item(1, w=0), {"n": 2}, {"n": 3, "label": "x", "rect": {"x": "a"}}, item(4)]
    assert [b.n for b in R.layout_badges(items)] == [4]
    assert len(R.layout_badges([item(i) for i in range(1, 300)])) == R.MAX_BADGES
    assert R.layout_badges(None) == [] and R.layout_badges([]) == []


def test_badge_colours_high_contrast():
    def lum(c):
        def ch(v):
            return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4

        r, g, b, _ = c
        return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)

    ratio = (lum(R.BADGE_FG) + 0.05) / (lum(R.BADGE_BG) + 0.05)
    assert ratio >= 7.0


# ------------------------------------------------------------------ numbers over the wire
class FakeView:
    def __init__(self):
        self.frames, self.badges, self.closed = [], [], False

    def apply(self, frame):
        self.frames.append(frame)

    def apply_badges(self, badges):
        self.badges.append(list(badges))

    def close(self):
        self.closed = True


def controller(view):
    loop = asyncio.get_running_loop()
    return R.OverlayController(view, lambda fn: loop.call_soon_threadsafe(fn), lambda d, fn: loop.call_later(d, fn))


@pytest.mark.asyncio
async def test_numbers_drawn_acked_hidden_and_cleared_on_pause():
    view = FakeView()
    async with rig() as r:
        r.server.overlay = controller(view)
        async with r.client() as c:
            ex = dict(EXAMPLES["worker_to_helper"]["numbers"])
            await c.send(ex)
            assert (await c.recv_id(ex["id"])) == {"t": "ack", "id": ex["id"], "ok": True}
            assert await wait_until(lambda: view.badges and len(view.badges[-1]) == len(ex["items"]))
            assert [b.n for b in view.badges[-1]] == [i["n"] for i in ex["items"]]
            hide = EXAMPLES["worker_to_helper"]["numbers_hide"]
            await c.send(hide)
            assert (await c.recv_id(hide["id"]))["ok"] is True
            assert await wait_until(lambda: view.badges[-1] == [])
            # draw again, then pause clears them
            rid = mid()
            await c.send({"t": "numbers", "id": rid, "items": [item(1), item(2, y=300)]})
            await c.recv_id(rid)
            assert await wait_until(lambda: len(view.badges[-1]) == 2)
            rid = mid()
            await c.send({"t": "pause", "id": rid})
            await c.recv_id(rid)
            assert await wait_until(lambda: view.badges[-1] == [])
            # while paused: refused
            rid = mid()
            await c.send({"t": "numbers", "id": rid, "items": [item(1)]})
            assert (await c.recv_id(rid)) == {"t": "ack", "id": rid, "ok": False, "error": "paused"}
            assert view.badges[-1] == []
            rid = mid()
            await c.send({"t": "resume", "id": rid})
            await c.recv_id(rid)
            assert view.badges[-1] == []  # stay off until the Worker sends them again
            rid = mid()
            await c.send({"t": "numbers", "id": rid, "items": [item(9)]})
            await c.recv_id(rid)
            assert await wait_until(lambda: [b.n for b in view.badges[-1]] == [9])
        # Worker gone → badges cleared
        assert await wait_until(lambda: view.badges[-1] == [])


@pytest.mark.asyncio
async def test_numbers_without_overlay_answers_overlay_disabled():
    async with rig() as r:  # rig has no overlay, like --no-overlay
        async with r.client() as c:
            rid = mid()
            await c.send({"t": "numbers", "id": rid, "items": [item(1)]})
            assert (await c.recv_id(rid)) == {"t": "ack", "id": rid, "ok": False, "error": "overlay_disabled"}


@pytest.mark.asyncio
async def test_numbers_after_overlay_failure_answers_overlay_disabled():
    view = FakeView()
    async with rig() as r:
        ctl = controller(view)
        ctl._on_disabled = r.server._on_overlay_disabled
        r.server.overlay = ctl
        ctl.disable("boom")
        async with r.client() as c:
            rid = mid()
            await c.send({"t": "numbers", "id": rid, "items": [item(1)]})
            m = await c.recv_id(rid)
            assert m["ok"] is False and m["error"] == "overlay_disabled"


def test_badge_view_exception_disables_overlay():
    reasons = []

    class Boom(FakeView):
        def apply_badges(self, badges):
            raise RuntimeError("no windows today")

    ctl = R.OverlayController(Boom(), lambda fn: fn(), lambda d, fn: None, on_disabled=reasons.append)
    ctl.show_numbers([item(1)])
    assert ctl.disabled and "no windows today" in reasons[0]


# ------------------------------------------------------------------ app selection (--app)
def test_cli_app_selection():
    assert parse_args([], env={}).app_bundle == KRITA_BUNDLE_ID
    a = parse_args(["--app", "photoshop"], env={})
    assert (a.app, a.app_bundle) == ("photoshop", PHOTOSHOP_BUNDLE_ID)
    assert parse_args([], env={"STEADY_APP": "Photoshop"}).app_bundle == PHOTOSHOP_BUNDLE_ID
    with pytest.raises(SystemExit):
        parse_args(["--app", "gimp"], env={})
    with pytest.raises(SystemExit):
        parse_args([], env={"STEADY_APP": "gimp"})


def test_hotkeys_consumed_for_the_selected_app_not_krita():
    emitted = []
    front = {"b": PHOTOSHOP_BUNDLE_ID}
    r = HotkeyRouter(emitted.append, lambda: front["b"], lambda: True, app_bundle=PHOTOSHOP_BUNDLE_ID)
    assert r.handle(FKEY_KEYCODES["f8"], True) == (True, ["pen"])
    r.handle(FKEY_KEYCODES["f8"], False)
    front["b"] = KRITA_BUNDLE_ID
    assert r.handle(FKEY_KEYCODES["f8"], True) == (False, [])  # Krita is "another app" now
    r.handle(FKEY_KEYCODES["f8"], False)
    front["b"] = next(iter(CHROME_BUNDLE_IDS))
    assert r.handle(FKEY_KEYCODES["f8"], True)[0] is True


@pytest.mark.asyncio
async def test_keys_go_to_photoshop_after_activating_it():
    system = FakeSystem(frontmost="com.google.Chrome", target_bundle=PHOTOSHOP_BUNDLE_ID, activation_delay_pumps=2)
    async with rig(system=system) as r:
        assert r.server.app_bundle == PHOTOSHOP_BUNDLE_ID
        async with r.client() as c:
            rid = mid()
            await c.send({"t": "keys", "id": rid, "combo": "cmd+="})
            assert (await c.recv_id(rid))["ok"] is True
            assert r.keys.posted == [("cmd+=", PHOTOSHOP_BUNDLE_ID)]
            # plugin-less app: `krita` messages fall back to keys (no relay)
            rid = mid()
            await c.send({"t": "krita", "id": rid, "cmd": "action", "action": "edit_undo", "fallback_keys": "cmd+z"})
            m = await c.recv_id(rid)
            assert m["ok"] is True and m["via"] == "keys"
            assert r.keys.posted[-1] == ("cmd+z", PHOTOSHOP_BUNDLE_ID)


@pytest.mark.asyncio
async def test_keys_refused_when_krita_front_but_photoshop_selected():
    system = FakeSystem(frontmost=KRITA_BUNDLE_ID, target_bundle=PHOTOSHOP_BUNDLE_ID, activation_works=False)
    async with rig(system=system) as r:
        async with r.client() as c:
            rid = mid()
            await c.send({"t": "keys", "id": rid, "combo": "b"})
            m = await c.recv_id(rid)
            assert m["ok"] is False and m["error"] == "krita_not_frontmost"
            assert r.keys.posted == []


@pytest.mark.asyncio
async def test_window_rect_reports_the_selected_app():
    system = FakeSystem(frontmost=PHOTOSHOP_BUNDLE_ID, target_bundle=PHOTOSHOP_BUNDLE_ID)
    async with rig(system=system, window_rect_period=0.05) as r:
        async with r.client() as c:
            m = await c.recv_type("krita_window_rect")
            assert m["rect"] is not None and m["frontmost"] is True
