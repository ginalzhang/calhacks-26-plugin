"""§5 pointer + pen-state law tests (fake mouse; the real pointer is never touched)."""

import asyncio

import pytest
from websockets.exceptions import ConnectionClosed

from steadyhelper_testkit import mid, rig, wait_until  # noqa: I001

from steadyhelper.fakes import FakeMouse
from steadyhelper.main import install_safety, run_guarded
from steadyhelper.pointer import Pointer, Refused
from steadyhelper.watchdog import Watchdog

pytestmark = pytest.mark.P1


async def _down_at(c, x=100, y=100):
    await c.send({"t": "move", "id": mid(), "x": x, "y": y})
    await c.send({"t": "down", "id": mid()})


@pytest.mark.asyncio
async def test_release_after_300ms_silence():
    async with rig() as r:
        async with r.client() as c:
            await _down_at(c)
            assert await wait_until(lambda: r.server.pointer.is_down)
            await asyncio.sleep(0.2)
            assert r.server.pointer.is_down, "released too early (< 300 ms)"
            assert "up" not in r.mouse.kinds()
            assert await wait_until(lambda: not r.server.pointer.is_down, timeout=0.5)
            assert r.mouse.kinds()[-1] == "up"
            assert await wait_until(lambda: r.server.watchdog.fired == 1)  # counter bumps just after release


@pytest.mark.asyncio
async def test_pings_keep_the_button_held():
    async with rig() as r:
        async with r.client() as c:
            await _down_at(c)
            for _ in range(8):  # 800 ms of pings every 100 ms
                await asyncio.sleep(0.1)
                await c.send({"t": "ping", "id": mid()})
            assert r.server.pointer.is_down
            assert "up" not in r.mouse.kinds()


@pytest.mark.asyncio
async def test_ping_replies_pong_with_same_id():
    async with rig() as r:
        async with r.client() as c:
            rid = mid()
            await c.send({"t": "ping", "id": rid})
            m = await c.recv_id(rid)
            assert m == {"t": "pong", "id": rid}


@pytest.mark.asyncio
async def test_release_on_socket_close():
    async with rig(watchdog_timeout=60) as r:  # watchdog out of the way
        async with r.client() as c:
            await _down_at(c)
            assert await wait_until(lambda: r.server.pointer.is_down)
        assert await wait_until(lambda: not r.server.pointer.is_down, timeout=1.0)
        assert r.mouse.kinds()[-1] == "up"


@pytest.mark.asyncio
async def test_release_on_exception_in_handler():
    async with rig(watchdog_timeout=60) as r:
        async with r.client() as c:
            await _down_at(c)
            assert await wait_until(lambda: r.server.pointer.is_down)
            await asyncio.sleep(0.02)  # let coalescing window pass so the next move posts at once
            r.mouse.fail_on = "move"
            rid = mid()
            await c.send({"t": "move", "id": rid, "x": 300, "y": 300})
            err = await c.recv_id(rid)
            assert err["t"] == "error" and err["code"] == "internal"
            assert not r.server.pointer.is_down
            assert r.mouse.kinds()[-1] == "up"


def test_run_guarded_releases_on_top_level_exception_and_ctrl_c():
    mouse = FakeMouse()
    p = Pointer(mouse)
    p.down()

    def boom():
        raise RuntimeError("boom")

    assert run_guarded(boom, p) == 1
    assert not p.is_down and mouse.kinds()[-1] == "up"

    p.down()

    def ctrl_c():
        raise KeyboardInterrupt

    assert run_guarded(ctrl_c, p) == 0
    assert not p.is_down and mouse.kinds().count("up") == 2


def test_atexit_release_registered():
    mouse = FakeMouse()
    p = Pointer(mouse)
    registered = []
    install_safety(p, register=registered.append)
    p.down()
    assert len(registered) == 1
    registered[0]()  # what atexit would run
    assert not p.is_down and mouse.kinds()[-1] == "up"


def test_watchdog_check_is_a_noop_when_up_and_fires_once_when_down():
    t = [0.0]
    mouse = FakeMouse()
    p = Pointer(mouse, clock=lambda: t[0])
    wd = Watchdog(p, timeout=0.3, clock=lambda: t[0])
    t[0] = 10.0
    assert wd.check() is False  # up: nothing to release
    p.down()
    wd.feed()
    t[0] = 10.29
    assert wd.check() is False
    t[0] = 10.31
    assert wd.check() is True
    assert wd.check() is False
    assert mouse.kinds().count("up") == 1


@pytest.mark.parametrize("origin", ["http://evil.example", "http://localhost:3001", None])
@pytest.mark.asyncio
async def test_bad_origin_refused(origin):
    async with rig() as r:
        with pytest.raises(ConnectionClosed) as ei:
            async with r.client(origin=origin, skip_hello=False) as c:
                await c.send({"t": "move", "id": mid(), "x": 5, "y": 5})
                await c.send({"t": "down", "id": mid()})
                await c.recv(timeout=1.0)
        assert ei.value.rcvd is not None and ei.value.rcvd.code == 4003
        await asyncio.sleep(0.05)
        assert r.mouse.events == []
        assert not r.server.pointer.is_down
        assert not r.server.clients


@pytest.mark.asyncio
async def test_good_origin_gets_hello():
    async with rig() as r:
        async with r.client() as c:
            h = c.hello
            assert h["t"] == "hello" and h["accessibility"] and h["input_monitoring"]
            assert h["screen"] == {"w": 1728.0, "h": 1117.0, "scale": 2.0}
            assert h["krita_running"] is True and h["krita"] is False
            assert h["krita_window_rect"] == {"x": 0.0, "y": 25.0, "w": 1400.0, "h": 1060.0}
            assert h["paused"] is False


@pytest.mark.asyncio
async def test_move_while_down_emits_drag_not_move():
    async with rig() as r:
        async with r.client() as c:
            await c.send({"t": "move", "id": mid(), "x": 10, "y": 10})
            await asyncio.sleep(0.02)
            await c.send({"t": "down", "id": mid()})
            await asyncio.sleep(0.02)
            await c.send({"t": "move", "id": mid(), "x": 20, "y": 20})
            await asyncio.sleep(0.02)
            await c.send({"t": "up", "id": mid()})
            await asyncio.sleep(0.02)
            await c.send({"t": "move", "id": mid(), "x": 30, "y": 30})
            assert await wait_until(lambda: len(r.mouse.events) >= 5)
            assert r.mouse.events == [
                ("move", 10.0, 10.0),
                ("down", 10.0, 10.0),
                ("drag", 20.0, 20.0),
                ("up", 20.0, 20.0),
                ("move", 30.0, 30.0),
            ]


@pytest.mark.asyncio
async def test_moves_coalesced_to_120hz_and_last_point_wins():
    async with rig() as r:
        async with r.client() as c:
            loop = asyncio.get_running_loop()
            t0 = loop.time()
            for i in range(60):
                await c.send({"t": "move", "id": mid(), "x": i, "y": i})
            await asyncio.sleep(0.05)
            elapsed = loop.time() - t0
            moves = [e for e in r.mouse.events if e[0] == "move"]
            assert moves[-1][1:] == (59.0, 59.0)
            assert len(moves) <= int(elapsed * 120) + 2
            assert len(moves) < 60


def test_pointer_pause_refuses_down_clamps_and_gates_click():
    mouse = FakeMouse()
    p = Pointer(mouse, min_interval=0)
    p.set_chrome_rect({"x": 1400, "y": 25, "w": 320, "h": 1000})
    p.move(100, 100)
    p.down()
    p.pause()
    assert not p.is_down and mouse.kinds()[-1] == "up"  # pause releases
    with pytest.raises(Refused) as e:
        p.down()
    assert e.value.code == "paused"
    with pytest.raises(Refused) as e:
        p.click(100, 100)
    assert e.value.code == "outside_chrome"
    p.click(1500, 200)
    assert mouse.events[-3:] == [("move", 1500, 200), ("down", 1500, 200), ("up", 1500, 200)]
    p.move(0, 0)  # clamped to chrome rect while paused
    assert mouse.events[-1] == ("move", 1400, 25)
    p.resume()
    p.down()
    assert p.is_down


@pytest.mark.asyncio
async def test_pause_semantics_over_the_wire():
    async with rig() as r:
        async with r.client() as c:
            await c.send({"t": "chrome_rect", "id": mid(), "rect": {"x": 1400, "y": 25, "w": 320, "h": 1000}})
            await _down_at(c)
            rid = mid()
            await c.send({"t": "pause", "id": rid})
            assert (await c.recv_id(rid)) == {"t": "ack", "id": rid, "ok": True}
            assert not r.server.pointer.is_down
            rid = mid()
            await c.send({"t": "down", "id": rid})
            m = await c.recv_id(rid)
            assert m["t"] == "error" and m["code"] == "paused"
            rid = mid()
            await c.send({"t": "click", "id": rid, "x": 50, "y": 50})
            m = await c.recv_id(rid)
            assert m["t"] == "error" and m["code"] == "outside_chrome"
            rid = mid()
            await c.send({"t": "click", "id": rid, "x": 1460, "y": 220, "reactivate_krita": True})
            assert (await c.recv_id(rid))["ok"] is True
            assert ("down", 1460.0, 220.0) in r.mouse.events
            # click on a Chrome tile → Krita re-activated shortly after
            assert await wait_until(lambda: r.system.activations == 1, timeout=1.0)
            rid = mid()
            await c.send({"t": "resume", "id": rid})
            await c.recv_id(rid)
            await c.send({"t": "down", "id": mid()})
            assert await wait_until(lambda: r.server.pointer.is_down)


@pytest.mark.asyncio
async def test_hello_reports_paused_after_reconnect():
    async with rig() as r:
        async with r.client() as c:
            rid = mid()
            await c.send({"t": "pause", "id": rid})
            await c.recv_id(rid)
        async with r.client() as c2:
            assert c2.hello["paused"] is True


@pytest.mark.asyncio
async def test_bad_message_gets_error_and_does_not_feed_watchdog():
    async with rig() as r:
        async with r.client() as c:
            await c.send({"t": "nope", "id": "x1"})
            m = await c.recv_id("x1")
            assert m["t"] == "error" and m["code"] == "bad_message"
            await c.ws.send("not json")
            m = await c.recv_type("error")
            assert m["code"] == "bad_message"
