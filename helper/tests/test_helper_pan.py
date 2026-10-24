"""Pan (P3): middle_down / middle_up hold the middle button; every fail-safe releases it."""

import asyncio

import pytest

from steadyhelper_testkit import mid, rig, wait_until  # noqa: I001

from steadyhelper.fakes import FakeMouse
from steadyhelper.pointer import Pointer, Refused
from steadyhelper.watchdog import Watchdog

pytestmark = pytest.mark.P3


def test_middle_drag_sequence():
    m = FakeMouse()
    p = Pointer(m, min_interval=0)
    p.move(10, 10)
    p.middle_down()
    p.move(20, 25)
    p.middle_up()
    p.move(30, 30)
    assert m.events == [
        ("move", 10, 10),
        ("middle_down", 10, 10),
        ("middle_drag", 20, 25),
        ("middle_up", 20, 25),
        ("move", 30, 30),
    ]


def test_lowering_one_button_lifts_the_other():
    m = FakeMouse()
    p = Pointer(m, min_interval=0)
    p.down()
    p.middle_down()
    assert not p.is_down and p.is_middle_down
    p.down()
    assert p.is_down and not p.is_middle_down
    assert m.kinds() == ["down", "up", "middle_down", "middle_up", "down"]


def test_release_pause_and_watchdog_release_the_middle_button():
    t = [0.0]
    m = FakeMouse()
    p = Pointer(m, clock=lambda: t[0], min_interval=0)
    p.middle_down()
    assert p.release("x") is True and m.kinds()[-1] == "middle_up"
    assert p.release("x") is False  # idempotent
    p.middle_down()
    p.pause()
    assert not p.any_down and m.kinds()[-1] == "middle_up"
    with pytest.raises(Refused) as e:
        p.middle_down()
    assert e.value.code == "paused"
    p.resume()
    wd = Watchdog(p, timeout=0.3, clock=lambda: t[0])
    p.middle_down()
    wd.feed()
    t[0] = 0.31
    assert wd.check() is True
    assert m.kinds()[-1] == "middle_up"


@pytest.mark.asyncio
async def test_pan_over_the_wire_and_release_on_silence_and_close():
    async with rig() as r:
        async with r.client() as c:
            await c.send({"t": "move", "id": mid(), "x": 100, "y": 100})
            await c.send({"t": "middle_down", "id": mid()})
            await asyncio.sleep(0.02)
            await c.send({"t": "move", "id": mid(), "x": 140, "y": 120})
            assert await wait_until(lambda: ("middle_drag", 140.0, 120.0) in r.mouse.events)
            # 300 ms of silence releases the middle button
            assert await wait_until(lambda: not r.server.pointer.is_middle_down, timeout=1.0)
            assert r.mouse.kinds()[-1] == "middle_up"
            await c.send({"t": "middle_down", "id": mid()})
            assert await wait_until(lambda: r.server.pointer.is_middle_down)
        # socket close
        assert await wait_until(lambda: not r.server.pointer.is_middle_down, timeout=1.0)


@pytest.mark.asyncio
async def test_middle_down_refused_while_paused_over_the_wire():
    async with rig() as r:
        async with r.client() as c:
            rid = mid()
            await c.send({"t": "pause", "id": rid})
            await c.recv_id(rid)
            rid = mid()
            await c.send({"t": "middle_down", "id": rid})
            m = await c.recv_id(rid)
            assert m["t"] == "error" and m["code"] == "paused"
            assert "middle_down" not in r.mouse.kinds()
