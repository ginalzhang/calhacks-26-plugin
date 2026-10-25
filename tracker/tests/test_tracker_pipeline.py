"""Frames → brain → pointer, and the safety laws around the brain (watchdog, crash/restart)."""

import asyncio

import pytest

from trackertest_kit import REPLAY_DIR, ManualSource, rig, wait_until
from steadytracker.camera import ReplaySource

pytestmark = pytest.mark.P1


def _order_ok(kinds):
    assert "down" in kinds and "up" in kinds, kinds
    d, u = kinds.index("down"), kinds.index("up")
    assert d < u
    assert all(k == "move" for k in kinds[:d]), kinds[:d]
    between = kinds[d + 1 : u]
    assert between and all(k == "drag" for k in between), between
    assert all(k == "move" for k in kinds[u + 1 :])


@pytest.mark.asyncio
async def test_replay_frames_reach_pointer_in_order(tmp_path):
    src = ReplaySource(str(REPLAY_DIR / "dwell-stroke-word.json"), speed=10.0)
    async with rig(tmp_path, source=src) as r:
        assert await wait_until(lambda: "up" in r.mouse.kinds() and r.mouse.kinds().count("move") > 20, 6.0)
        _order_ok(r.mouse.kinds())
        assert r.app.frames_sent >= 20
        assert not r.app.pointer.is_down
        # frames are raw LandmarkFrames with strictly increasing t
        init = r.brain_msgs("init")
        assert len(init) == 1 and init[0]["calibration"] is None


@pytest.mark.asyncio
async def test_frame_messages_shape_and_monotonic_t(tmp_path):
    async with rig(tmp_path, env_extra={"FAKE_BRAIN_LOG_ALL": "1"}) as r:
        for _ in range(6):
            r.source.push()
        r.source.push(hand=False)
        assert await wait_until(lambda: len(r.brain_msgs("frame")) == 7)
        frames = [m["frame"] for m in r.brain_msgs("frame")]
        ts = [f["t"] for f in frames]
        assert ts == sorted(ts) and len(set(ts)) == len(ts)
        f = frames[0]
        assert set(f) >= {"t", "width", "height", "hands"}
        h = f["hands"][0]
        assert set(h) == {"landmarks", "score", "handedness"} and len(h["landmarks"]) == 21
        assert frames[-1]["hands"] == []
        ticks = r.brain_msgs("tick")
        assert ticks and all(isinstance(m["now"], float) for m in ticks)


@pytest.mark.asyncio
async def test_watchdog_releases_when_brain_stalls(tmp_path):
    async with rig(tmp_path, mode="stall") as r:
        for _ in range(5):
            r.source.push()
        assert await wait_until(lambda: r.app.pointer.is_down, 2.0)
        assert await wait_until(lambda: not r.app.pointer.is_down, 1.0), "watchdog did not release"
        assert r.mouse.kinds()[-1] == "up"
        assert r.app.watchdog.fired >= 1
        assert await wait_until(lambda: any(e["data"]["reason"] == "watchdog" for e in r.helper_events("released")))


@pytest.mark.asyncio
async def test_heartbeat_keeps_a_still_held_pen_down(tmp_path):
    """A live brain that prints nothing on frames (hand still) is kept alive by the parse heartbeat."""
    async with rig(tmp_path, env_extra={"FAKE_BRAIN_UP": "9999"}) as r:
        for _ in range(5):
            r.source.push()
        assert await wait_until(lambda: r.app.pointer.is_down, 2.0)
        await asyncio.sleep(0.7)  # no frames at all; only ticks + heartbeat
        assert r.app.pointer.is_down
        assert r.app.watchdog.fired == 0
        assert any(m["id"].startswith("hb-") for m in r.brain_msgs("parse"))


@pytest.mark.asyncio
async def test_brain_crash_releases_and_restarts_once(tmp_path):
    async with rig(tmp_path, mode="crash") as r:
        for _ in range(5):
            r.source.push()
        assert await wait_until(lambda: r.mouse.kinds().count("down") == 1, 2.0)
        assert await wait_until(lambda: r.app.brain_restarts == 1 and r.app.brain_ready, 4.0)
        assert not r.app.pointer.is_down
        assert r.mouse.kinds()[-1] == "up"
        assert len(r.brain_msgs("init")) == 2  # the new brain got init again
        assert not r.app.brain_dead


@pytest.mark.asyncio
async def test_second_crash_gives_up_with_alert(tmp_path):
    async with rig(tmp_path, mode="crash_always") as r:
        p = await r.panel()
        for _ in range(5):
            r.source.push()
        assert await wait_until(lambda: r.app.brain_restarts == 1 and r.app.brain_ready, 4.0)
        r.source._on_frame  # same source keeps feeding the new brain
        for _ in range(5):
            r.source.push()
        assert await wait_until(lambda: r.app.brain_dead, 4.0)
        assert not r.app.pointer.is_down
        assert r.app.brain_restarts == 1
        assert await wait_until(lambda: any("Quit and reopen" in m["text"] for m in p.of("status")))
        await p.close()


@pytest.mark.asyncio
async def test_init_carries_persisted_settings_and_calibrations(tmp_path):
    data = tmp_path / "data"
    async with rig(tmp_path, data_dir=data) as r:
        p = await r.panel()
        await p.send({"t": "settings", "id": "s1", "settings": {"steadiness": 80, "inputs": {"voice": False}}})
        await p.send({"t": "calibrate", "id": "c1", "steps": [1, 2, 3]})
        await p.send({"t": "action", "id": "a1", "action": "steadier", "source": "tile"})
        assert await wait_until(lambda: (data / "calibration.json").exists() and p.ack_for("a1") is not None)
        await asyncio.sleep(0.2)
        await p.close()
    async with rig(tmp_path, data_dir=data) as r2:
        init = r2.brain_msgs("init")[0]
        assert init["settings"]["steadiness"] == 70  # brain settings_changed wins (later)
        assert init["settings"]["inputs"] == {"voice": False}
        assert init["calibration"]["handedness"] == "Left"
        assert init["calibrations"]["Left"]["gain"] == 3
