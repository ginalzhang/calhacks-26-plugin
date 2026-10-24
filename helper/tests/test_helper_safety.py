"""Safety review fixes (R2, R5, R7, R8, H1/H2). Fake mouse / fake system only."""

import asyncio

import pytest
from websockets.exceptions import ConnectionClosed

from steadyhelper_testkit import EXAMPLES, mid, rig, wait_until  # noqa: I001

from steadyhelper.config import FKEY_KEYCODES, KRITA_BUNDLE_ID
from steadyhelper.fakes import FakeMouse, FakeSystem
from steadyhelper.macos import cocoa_to_quartz, usable_at
from steadyhelper.main import parse_args
from steadyhelper.permissions import _real_checks
from steadyhelper.pointer import Pointer
from steadyhelper.protocol import validate_helper_msg
from steadyhelper.server import HelperServer

pytestmark = pytest.mark.P1


# ---------------------------------------------------------------- R2: one Worker at a time
@pytest.mark.asyncio
async def test_newest_client_wins_and_old_buttons_are_released():
    async with rig(watchdog_timeout=60) as r:
        async with r.client() as a:
            await a.send({"t": "move", "id": mid(), "x": 10, "y": 10})
            await a.send({"t": "down", "id": mid()})
            assert await wait_until(lambda: r.server.pointer.is_down)
            async with r.client() as b:
                # the old connection is closed with 4001 and its button released at once
                with pytest.raises(ConnectionClosed) as ei:
                    await a.recv(timeout=1.0)
                assert ei.value.rcvd is not None and ei.value.rcvd.code == 4001
                assert not r.server.pointer.is_down
                assert len(r.server.clients) == 1
                # the new client can draw, and the old socket's close path does NOT lift it
                await b.send({"t": "move", "id": mid(), "x": 20, "y": 20})
                await b.send({"t": "down", "id": mid()})
                assert await wait_until(lambda: r.server.pointer.is_down)
                await asyncio.sleep(0.1)
                assert r.server.pointer.is_down
                # hotkeys reach only the newest client
                r.system.frontmost = KRITA_BUNDLE_ID
                assert await wait_until(lambda: r.server._frontmost == KRITA_BUNDLE_ID)
                r.server.router.handle(FKEY_KEYCODES["f7"], True)
                assert (await b.recv_type("hotkey"))["key"] == "undo"


@pytest.mark.asyncio
async def test_old_client_pings_cannot_feed_the_watchdog_after_replacement():
    async with rig() as r:
        async with r.client() as a:
            async with r.client() as b:
                await b.send({"t": "move", "id": mid(), "x": 1, "y": 1})
                await b.send({"t": "down", "id": mid()})
                assert await wait_until(lambda: r.server.pointer.is_down)
                with pytest.raises(ConnectionClosed):
                    for _ in range(6):
                        await a.send({"t": "ping", "id": mid()})
                        await asyncio.sleep(0.1)
                # the old socket is closed, so only b feeds the watchdog; b went silent → released
                assert await wait_until(lambda: not r.server.pointer.is_down, timeout=1.0)


# ---------------------------------------------------------------- R5: queue while held
def test_burst_while_held_is_drained_in_order_not_coalesced():
    t = [0.0]
    m = FakeMouse()
    p = Pointer(m, clock=lambda: t[0])
    p.move(100, 100)
    p.down()
    pts = [(110, 120), (130, 90), (150, 140), (170, 80), (200, 100)]
    for x, y in pts:
        p.move(x, y)
    p.up()
    # the hover move just posted, so every drag waits its 1/120 s turn; the up is queued behind them
    assert m.kinds() == ["move", "down"]
    assert p.queued == 6  # 5 moves + up
    for i in range(1, 6):
        t[0] = i * 0.01  # 100 Hz pumps, each past the 1/120 s interval
        p.pump()
    assert m.events == [("move", 100, 100), ("down", 100, 100)] + [("drag", x, y) for x, y in pts] + [("up", 200, 100)]
    assert p.queued == 0 and not p.is_down


def test_queue_drains_at_most_120hz():
    t = [0.0]
    m = FakeMouse()
    p = Pointer(m, clock=lambda: t[0])
    p.down()
    for i in range(50):
        p.move(i, i)
    posted_at_t0 = m.kinds().count("drag")
    assert posted_at_t0 == 1
    t[0] = 0.1  # 100 ms later: at most 12 more
    while p.pump() == 0 and p.queued:
        pass
    p.pump()
    assert m.kinds().count("drag") == 1 + 1  # one per pump call when due
    # the delay returned tells the server when to come back
    assert 0 < p.next_delay() <= 1 / 120 + 1e-9


def test_hover_moves_still_coalesce():
    t = [0.0]
    m = FakeMouse()
    p = Pointer(m, clock=lambda: t[0])
    p.move(1, 1)
    p.move(2, 2)
    p.move(3, 3)
    t[0] = 0.01
    p.pump()
    assert m.events == [("move", 1, 1), ("move", 3, 3)]


def test_queue_is_bounded_oldest_moves_dropped():
    t = [0.0]
    m = FakeMouse()
    p = Pointer(m, clock=lambda: t[0], queue_max=5)
    p.down()
    for i in range(11):
        p.move(i, 0)  # move 0 posts, 1..10 queue (bound 5 → 1..5 dropped)
    assert p.queued == 5 and p.dropped_moves == 5
    for k in range(1, 7):
        t[0] = k / 100
        p.pump()
    assert [e[1] for e in m.events if e[0] == "drag"] == [0, 6, 7, 8, 9, 10]


def test_safety_release_drops_the_queue_and_lifts_now():
    t = [0.0]
    m = FakeMouse()
    p = Pointer(m, clock=lambda: t[0])
    p.down()
    for i in range(10):
        p.move(i, i)
    p.up()
    assert p.release("watchdog") is True
    assert m.kinds()[-1] == "up" and p.queued == 0
    assert m.kinds().count("drag") == 1


def test_buttons_after_a_queued_up_keep_their_order():
    """Hatch replay: down, moves, up, hover move, down, moves, up — all in one burst."""
    t = [0.0]
    m = FakeMouse()
    p = Pointer(m, clock=lambda: t[0])
    p.down()
    p.move(1, 0)
    p.move(2, 0)
    p.up()
    p.move(0, 5)  # pen up travel (queued behind the up)
    p.down()
    p.move(1, 5)
    p.up()
    for k in range(1, 10):
        t[0] = k / 100
        p.pump()
    assert m.kinds() == ["down", "drag", "drag", "up", "move", "down", "drag", "up"]


@pytest.mark.asyncio
async def test_burst_over_the_wire_keeps_its_shape():
    async with rig() as r:
        async with r.client() as c:
            await c.send({"t": "move", "id": mid(), "x": 100, "y": 100})
            await asyncio.sleep(0.02)
            msgs = [{"t": "down", "id": mid()}]
            pts = [(110, 120), (130, 90), (150, 140), (170, 80), (200, 100)]
            msgs += [{"t": "move", "id": mid(), "x": x, "y": y} for x, y in pts]
            msgs += [{"t": "up", "id": mid()}]
            for m in msgs:
                await c.send(m)
            assert await wait_until(lambda: "up" in r.mouse.kinds(), timeout=1.0)
            drags = [(e[1], e[2]) for e in r.mouse.events if e[0] == "drag"]
            assert drags == [(float(x), float(y)) for x, y in pts]
            assert r.mouse.kinds()[-1] == "up"


# ---------------------------------------------------------------- R7: released
@pytest.mark.asyncio
async def test_released_sent_for_watchdog():
    async with rig() as r:
        async with r.client() as c:
            await c.send({"t": "down", "id": mid()})
            m = await c.recv_type("released", timeout=1.5)
            assert (m["reason"], m["button"]) == ("watchdog", "left")
            assert validate_helper_msg(m) is None


@pytest.mark.asyncio
async def test_released_for_pause_hotkeys_middle_and_exception_but_not_for_up():
    async with rig(watchdog_timeout=60) as r:
        r.system.frontmost = KRITA_BUNDLE_ID
        async with r.client() as c:
            assert await wait_until(lambda: r.server._frontmost == KRITA_BUNDLE_ID)

            async def hold(kind="down"):
                await c.send({"t": kind, "id": mid()})
                await wait_until(lambda: r.server.pointer.any_down)

            # up: Worker asked → no `released`
            await hold()
            await c.send({"t": "up", "id": mid()})
            await hold()
            rid = mid()
            await c.send({"t": "pause", "id": rid})
            m = await c.recv_type("released")
            assert (m["reason"], m["button"]) == ("pause", "left")
            assert not [x for x in c.inbox if x.get("t") == "released" and x is not m]
            rid = mid()
            await c.send({"t": "resume", "id": rid})
            await c.recv_id(rid)
            # pause again with nothing held: no `released`
            await hold()
            r.server.router.handle(FKEY_KEYCODES["f8"], True)
            assert (await c.recv_type("released"))["reason"] == "hotkey"
            r.server.router.handle(FKEY_KEYCODES["f8"], False)
            await hold("middle_down")
            r.server.router.handle(FKEY_KEYCODES["f10"], True)
            m = await c.recv_type("released")
            assert (m["reason"], m["button"]) == ("ptt", "middle")
            r.server.router.handle(FKEY_KEYCODES["f10"], False)
            await hold()
            await asyncio.sleep(0.02)
            r.mouse.fail_on = "move"
            await c.send({"t": "move", "id": mid(), "x": 5, "y": 5})
            assert (await c.recv_type("released"))["reason"] == "exception"


@pytest.mark.asyncio
async def test_no_released_when_nothing_was_held():
    async with rig() as r:
        async with r.client() as c:
            rid = mid()
            await c.send({"t": "pause", "id": rid})
            await c.recv_id(rid)
            await asyncio.sleep(0.4)
            await c.send({"t": "ping", "id": "p"})
            m = await c.recv_id("p")
            assert m["t"] == "pong"
            assert not [x for x in c.inbox if x.get("t") == "released"]


def test_released_example_and_reason_mapping():
    assert validate_helper_msg(EXAMPLES["helper_to_worker"]["released"]) is None
    f = HelperServer.released_reason
    assert f("watchdog: no message for 300 ms") == "watchdog"
    assert f("pause") == "pause"
    assert f("hotkey pen") == "hotkey" and f("hotkey pause") == "hotkey"
    assert f("hotkey ptt_down") == "ptt"
    assert f("exception") == "exception" and f("exception in pump") == "exception"
    assert f("click") == "other"
    for quiet in ("up", "middle_up", "down", "pan", "socket closed", "replaced", "shutdown", "exit", "signal 2"):
        assert f(quiet) is None


# ---------------------------------------------------------------- R8: usable area
def test_usable_at_menu_bar_dock_and_second_screen():
    screens = [
        ({"x": 0, "y": 0, "w": 1728, "h": 1117}, {"x": 0, "y": 25, "w": 1728, "h": 1020}),
        ({"x": 1728, "y": 0, "w": 1920, "h": 1080}, {"x": 1728, "y": 25, "w": 1920, "h": 1055}),
    ]
    assert usable_at(800, 500, screens) is True
    assert usable_at(800, 10, screens) is False  # menu bar
    assert usable_at(800, 1100, screens) is False  # Dock
    assert usable_at(2000, 1070, screens) is True  # second screen, no Dock there
    assert usable_at(2000, 10, screens) is False
    assert usable_at(-50, 500, screens) is False  # off every screen
    assert usable_at(800, 500, []) is None


def test_cocoa_to_quartz():
    # primary 1117 tall; Cocoa visibleFrame (0, 72, 1728, 1020) = Dock 72 at bottom, menu bar 25 on top
    assert cocoa_to_quartz(0, 72, 1728, 1020, 1117) == {"x": 0.0, "y": 25.0, "w": 1728.0, "h": 1020.0}


@pytest.mark.asyncio
async def test_hello_visible_frame_and_click_outside_usable_refused():
    async with rig() as r:
        async with r.client() as c:
            assert c.hello["visible_frame"] == {"x": 0.0, "y": 25.0, "w": 1728.0, "h": 1020.0}
            assert validate_helper_msg(c.hello) is None
            for y in (10, 1100):  # menu bar, Dock
                rid = mid()
                await c.send({"t": "click", "id": rid, "x": 800, "y": y})
                assert (await c.recv_id(rid)) == {"t": "ack", "id": rid, "ok": False, "error": "outside_usable"}
            assert "down" not in r.mouse.kinds()
            rid = mid()
            await c.send({"t": "click", "id": rid, "x": 800, "y": 500})
            assert (await c.recv_id(rid))["ok"] is True


@pytest.mark.asyncio
async def test_unknown_screen_geometry_allows_click():
    system = FakeSystem()
    system.screen_list = []
    async with rig(system=system) as r:
        async with r.client() as c:
            assert c.hello["visible_frame"] is None
            rid = mid()
            await c.send({"t": "click", "id": rid, "x": 800, "y": 10})
            assert (await c.recv_id(rid))["ok"] is True


# ---------------------------------------------------------------- H1/H2: --no-input / --no-pointer
def test_cli_no_input_and_no_pointer_flags():
    a = parse_args(["--no-input"], env={})
    assert a.no_input and not a.no_pointer
    assert parse_args(["--no-pointer"], env={}).no_pointer


def test_no_input_never_requests_permissions():
    request_listen, _, _ = _real_checks(prompt=False)
    assert request_listen() is None  # CGRequestListenEventAccess is not called


@pytest.mark.asyncio
async def test_keys_and_activation_blocked_when_input_disabled():
    async with rig(system=FakeSystem(frontmost="com.google.Chrome"), plugin_port=1) as r:
        r.server.allow_keys = False
        r.server.allow_activation = False
        async with r.client() as c:
            rid = mid()
            await c.send({"t": "keys", "id": rid, "combo": "cmd+z"})
            assert (await c.recv_id(rid)) == {"t": "ack", "id": rid, "ok": False, "error": "input_disabled"}
            rid = mid()
            await c.send({"t": "krita", "id": rid, "cmd": "action", "action": "edit_undo", "fallback_keys": "cmd+z"})
            m = await c.recv_id(rid)
            assert m["ok"] is False and m["error"] == "input_disabled"
            rid = mid()
            await c.send({"t": "click", "id": rid, "x": 800, "y": 500, "reactivate_krita": True})
            await c.recv_id(rid)
            await asyncio.sleep(0.1)
            assert r.keys.posted == [] and r.system.activations == 0


@pytest.mark.asyncio
async def test_numbers_has_a_handler():
    async with rig() as r:
        async with r.client() as c:
            ex = EXAMPLES["worker_to_helper"]["numbers"]
            await c.send(ex)
            m = await c.recv_id(ex["id"])
            assert m["t"] == "ack"  # not error bad_message (ok:false overlay_disabled without overlay)
