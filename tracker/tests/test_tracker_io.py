"""Hotkeys → brain, Krita relay round trip (fake bridge), fallback keys, click gating, pause."""

import asyncio

import pytest

from trackertest_kit import FakePlugin, rig, wait_until
from steadyhelper.config import FKEY_KEYCODES, KRITA_BUNDLE_ID
from steadyhelper.krita_relay import KritaRelay


pytestmark = pytest.mark.P1


@pytest.mark.asyncio
async def test_hotkey_reaches_brain_only_while_krita_is_frontmost(tmp_path):
    async with rig(tmp_path) as r:
        await asyncio.sleep(0.1)  # a tick refreshes the frontmost app
        consume, emitted = r.app.router.handle(FKEY_KEYCODES["f8"], True)
        assert consume and emitted == ["pen"]
        r.app.router.handle(FKEY_KEYCODES["f8"], False)
        consume, emitted = r.app.router.handle(FKEY_KEYCODES["f10"], True)
        assert emitted == ["ptt_down"]
        consume, emitted = r.app.router.handle(FKEY_KEYCODES["f10"], False)
        assert emitted == ["ptt_up"]
        assert await wait_until(lambda: [m["key"] for m in r.brain_msgs("hotkey")] == ["pen", "ptt_down", "ptt_up"])
        assert all(isinstance(m["now"], float) for m in r.brain_msgs("hotkey"))
        # Chrome (or anything else) in front: the key passes through and nothing is sent
        r.system.frontmost = "com.google.Chrome"
        await asyncio.sleep(0.1)
        consume, emitted = r.app.router.handle(FKEY_KEYCODES["f9"], True)
        assert (consume, emitted) == (False, [])


@pytest.mark.asyncio
async def test_hotkey_pause_releases_at_once(tmp_path):
    async with rig(tmp_path, env_extra={"FAKE_BRAIN_UP": "9999"}) as r:
        await asyncio.sleep(0.1)
        for _ in range(5):
            r.source.push()
        assert await wait_until(lambda: r.app.pointer.is_down)
        r.app.router.handle(FKEY_KEYCODES["f9"], True)
        assert not r.app.pointer.is_down  # released on the key-tap thread, before the brain reacts
        assert await wait_until(lambda: any(e["data"]["reason"] == "hotkey" for e in r.helper_events("released")))


@pytest.mark.asyncio
async def test_keymap_from_settings(tmp_path):
    async with rig(tmp_path) as r:
        await asyncio.sleep(0.1)
        p = await r.panel()
        await p.send({"t": "settings", "id": "k", "settings": {"keymap": {"F4": "pen_toggle", "F5": "pause"}}})
        assert await wait_until(lambda: p.ack_for("k") is not None)
        _, emitted = r.app.router.handle(FKEY_KEYCODES["f4"], True)
        assert emitted == ["pen"]
        r.app.router.handle(FKEY_KEYCODES["f4"], False)
        assert r.app.router.handle(FKEY_KEYCODES["f8"], True) == (False, [])
        await p.close()


@pytest.mark.asyncio
async def test_krita_relay_round_trip_with_fake_bridge(tmp_path):
    plugin = await FakePlugin().start()
    relay = KritaRelay("127.0.0.1", plugin.port, reconnect_s=0.05)
    try:
        async with rig(tmp_path, relay=relay, rects_period=0.1) as r:
            assert await wait_until(lambda: relay.connected)
            assert await wait_until(lambda: any(e["data"]["connected"] for e in r.helper_events("krita_state")))
            # canvas rect polled from the bridge → brain rects
            assert await wait_until(lambda: any((m["rects"].get("canvas") or {}).get("w") == 800.0 for m in r.brain_msgs("rects")))
            p = await r.panel()
            await p.send({"t": "action", "id": "a", "action": "krita_test", "source": "tile"})
            assert await wait_until(lambda: r.helper_events("krita_reply"))
            req = [q for q in plugin.requests if q.get("cmd") == "action"][0]
            assert req == {"id": "k1", "cmd": "action", "action": "edit_undo"}  # no t, no fallback_keys
            reply = r.helper_events("krita_reply")[0]["data"]
            assert reply["id"] == "k1" and reply["ok"] is True and reply["via"] == "plugin"
            assert r.keys.posted == []
            await p.close()
    finally:
        await plugin.stop()


@pytest.mark.asyncio
async def test_plugin_down_uses_fallback_keys_then_plain_keys(tmp_path):
    async with rig(tmp_path) as r:  # no relay → plugin down
        p = await r.panel()
        await p.send({"t": "action", "id": "a", "action": "krita_test", "source": "tile"})
        await p.send({"t": "action", "id": "b", "action": "keys_test", "source": "tile"})
        assert await wait_until(lambda: len(r.helper_events("krita_reply")) == 2)
        replies = {e["data"]["id"]: e["data"] for e in r.helper_events("krita_reply")}
        assert replies["k1"] == {"id": "k1", "ok": True, "via": "keys"}
        assert replies["k2"] == {"id": "k2", "ok": True, "via": "keys"}
        assert r.keys.posted == [("cmd+z", KRITA_BUNDLE_ID), ("cmd+z", KRITA_BUNDLE_ID)]
        # Krita not running → clean error, nothing posted
        r.system.krita_running = False
        await p.send({"t": "action", "id": "c", "action": "keys_test", "source": "tile"})
        assert await wait_until(lambda: len(r.helper_events("krita_reply")) == 3)
        assert r.helper_events("krita_reply")[-1]["data"]["error"] == "krita_not_running"
        assert len(r.keys.posted) == 2
        await p.close()


@pytest.mark.asyncio
async def test_click_gating(tmp_path):
    async with rig(tmp_path, rects_period=0.05) as r:
        assert await wait_until(lambda: r.app.krita_rect is not None)  # FakeSystem: 0,25 1400×1060
        p = await r.panel()
        await p.send({"t": "action", "id": "a", "action": "click_test", "arg": 500, "source": "tile"})
        assert await wait_until(lambda: "down" in r.mouse.kinds())
        assert r.mouse.kinds()[-3:] == ["move", "down", "up"]
        n = len(r.mouse.events)
        await p.send({"t": "action", "id": "b", "action": "click_test", "arg": 1600, "source": "tile"})  # outside Krita
        assert await wait_until(lambda: r.helper_events("refused_down"))
        ev = r.helper_events("refused_down")[0]["data"]
        assert ev["code"] == "outside_krita" and ev["click"] is True and "message" in ev
        assert len(r.mouse.events) == n
        await p.close()


@pytest.mark.asyncio
async def test_pause_state_refuses_down_and_clamps(tmp_path):
    async with rig(tmp_path) as r:
        p = await r.panel()
        await p.send({"t": "panel_rect", "id": "r", "rect": {"x": 1500, "y": 60, "w": 200, "h": 800}})
        await p.send({"t": "action", "id": "a", "action": "pause", "source": "tile"})
        assert await wait_until(lambda: r.app.pointer.paused)
        for _ in range(5):
            r.source.push()
        assert await wait_until(lambda: r.helper_events("refused_down"))
        assert r.helper_events("refused_down")[0]["data"]["code"] == "paused"
        assert "down" not in r.mouse.kinds()
        r.app._pen({"type": "move", "x": 10, "y": 10})
        await asyncio.sleep(0.05)
        assert r.mouse.events[-1][1:] == (1500.0, 60.0)  # clamped to the panel rect
        # panel hidden while paused → clamp to Krita's main window (FakeSystem 0,25 1400×1060)
        await p.send({"t": "panel_rect", "id": "h", "rect": None})
        assert await wait_until(lambda: p.ack_for("h") is not None)
        r.app._pen({"type": "move", "x": 2000, "y": 5})
        await asyncio.sleep(0.05)
        assert r.mouse.events[-1][1:] == (1400.0, 25.0)
        await p.send({"t": "action", "id": "b", "action": "pause", "source": "tile"})
        assert await wait_until(lambda: not r.app.pointer.paused)
        await p.close()


@pytest.mark.asyncio
async def test_down_refused_when_krita_not_frontmost(tmp_path):
    async with rig(tmp_path, frontmost="com.apple.finder") as r:
        for _ in range(5):
            r.source.push()
        assert await wait_until(lambda: r.helper_events("refused_down"))
        assert r.helper_events("refused_down")[0]["data"]["code"] == "krita_not_frontmost"
        assert "down" not in r.mouse.kinds()


@pytest.mark.asyncio
async def test_krita_quitting_releases(tmp_path):
    async with rig(tmp_path, rects_period=0.05, env_extra={"FAKE_BRAIN_UP": "9999"}) as r:
        assert await wait_until(lambda: r.app.krita_rect is not None)
        for _ in range(5):
            r.source.push()
        assert await wait_until(lambda: r.app.pointer.is_down)
        r.system.krita_running = False
        assert await wait_until(lambda: not r.app.pointer.is_down)
        assert await wait_until(lambda: any(e["data"]["reason"] == "krita_gone" for e in r.helper_events("released")))


@pytest.mark.asyncio
async def test_quit_stops_the_app(tmp_path):
    async with rig(tmp_path) as r:
        p = await r.panel()
        await p.send({"t": "quit", "id": "q"})
        assert await wait_until(lambda: r.app.stop_event.is_set())
        assert p.ack_for("q")["ok"] is True
        await p.close()
