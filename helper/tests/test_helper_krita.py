"""§5 keys (Krita activation), Krita relay (id passthrough, keystroke fallback), window rect."""

import asyncio

import pytest

from steadyhelper_testkit import FakePlugin, mid, rig, wait_until  # noqa: I001

from steadyhelper.config import KRITA_BUNDLE_ID
from steadyhelper.fakes import FakeSystem
from steadyhelper.macos import pick_main_window

pytestmark = pytest.mark.P1


# ---------------------------------------------------------------- keys
@pytest.mark.asyncio
async def test_keys_activates_krita_first_then_posts():
    system = FakeSystem(frontmost="com.google.Chrome", activation_delay_pumps=3)
    async with rig(system=system) as r:
        async with r.client() as c:
            rid = mid()
            await c.send({"t": "keys", "id": rid, "combo": "cmd+z"})
            m = await c.recv_id(rid)
            assert m == {"t": "ack", "id": rid, "ok": True}
            assert r.system.activations == 1
            # posted only once Krita was frontmost
            assert r.keys.posted == [("cmd+z", KRITA_BUNDLE_ID)]


@pytest.mark.asyncio
async def test_keys_skips_activation_when_krita_already_front():
    async with rig(system=FakeSystem(frontmost=KRITA_BUNDLE_ID)) as r:
        async with r.client() as c:
            rid = mid()
            await c.send({"t": "keys", "id": rid, "combo": "]"})
            assert (await c.recv_id(rid))["ok"] is True
            assert r.system.activations == 0
            assert r.keys.posted == [("]", KRITA_BUNDLE_ID)]


@pytest.mark.asyncio
async def test_keys_fails_cleanly_when_krita_not_running():
    async with rig(system=FakeSystem(krita_running=False)) as r:
        async with r.client() as c:
            rid = mid()
            await c.send({"t": "keys", "id": rid, "combo": "cmd+z"})
            m = await c.recv_id(rid)
            assert m == {"t": "ack", "id": rid, "ok": False, "error": "krita_not_running"}
            assert r.keys.posted == []
            assert r.system.activations == 0


@pytest.mark.asyncio
async def test_keys_never_posted_into_another_app_if_activation_times_out():
    async with rig(system=FakeSystem(frontmost="com.google.Chrome", activation_works=False)) as r:
        async with r.client() as c:
            loop = asyncio.get_running_loop()
            t0 = loop.time()
            rid = mid()
            await c.send({"t": "keys", "id": rid, "combo": "delete"})
            m = await c.recv_id(rid)
            assert m["ok"] is False and m["error"] == "krita_not_frontmost"
            assert loop.time() - t0 < 0.5  # waited ≤ 150 ms (plus slack), never hung
            assert r.keys.posted == []


@pytest.mark.asyncio
async def test_keys_bad_combo():
    async with rig(system=FakeSystem(frontmost=KRITA_BUNDLE_ID)) as r:
        async with r.client() as c:
            rid = mid()
            await c.send({"t": "keys", "id": rid, "combo": "hyper+q"})
            m = await c.recv_id(rid)
            assert m["ok"] is False and m["error"] == "bad_combo"


# ---------------------------------------------------------------- relay
@pytest.mark.asyncio
async def test_relay_forwards_id_and_returns_krita_reply():
    plugin = await FakePlugin().start()
    plugin.replies["canvas_rect"] = {"rect": {"x": 64, "y": 120, "w": 1180, "h": 860}}
    try:
        async with rig(plugin_port=plugin.port) as r:
            async with r.client() as c:
                if not c.hello["krita"]:
                    st = await c.recv_type("krita_state")
                    assert st["connected"] is True
                rid = "0b6a1f0e-0009-4000-8000-000000000009"
                await c.send({"t": "krita", "id": rid, "cmd": "action", "action": "edit_undo", "fallback_keys": "cmd+z"})
                m = await c.recv_id(rid)
                assert m["t"] == "krita_reply" and m["ok"] is True and m["via"] == "plugin"
                assert plugin.requests[-1] == {"id": rid, "cmd": "action", "action": "edit_undo"}
                assert r.keys.posted == []  # plugin up: no keystrokes
                rid2 = mid()
                await c.send({"t": "krita", "id": rid2, "cmd": "canvas_rect"})
                m = await c.recv_id(rid2)
                assert m["rect"] == {"x": 64, "y": 120, "w": 1180, "h": 860}
    finally:
        await plugin.stop()


@pytest.mark.asyncio
async def test_relay_passes_plugin_errors_through():
    plugin = await FakePlugin().start()
    plugin.replies["color"] = {"ok": False, "error": "bad_hex"}
    try:
        async with rig(plugin_port=plugin.port) as r:
            assert await wait_until(lambda: r.server.relay.connected)
            async with r.client() as c:
                rid = mid()
                await c.send({"t": "krita", "id": rid, "cmd": "color", "hex": "#zzz"})
                m = await c.recv_id(rid)
                assert m == {"t": "krita_reply", "id": rid, "ok": False, "via": "plugin", "echo": "color", "error": "bad_hex"}
    finally:
        await plugin.stop()


@pytest.mark.asyncio
async def test_relay_falls_back_to_keystrokes_when_plugin_down():
    # nothing listens on this port → plugin down
    async with rig(plugin_port=1, system=FakeSystem(frontmost="com.google.Chrome")) as r:
        async with r.client() as c:
            assert c.hello["krita"] is False
            rid = mid()
            await c.send({"t": "krita", "id": rid, "cmd": "action", "action": "edit_undo", "fallback_keys": "cmd+z"})
            m = await c.recv_id(rid)
            assert m == {"t": "krita_reply", "id": rid, "ok": True, "via": "keys"}
            assert r.keys.posted == [("cmd+z", KRITA_BUNDLE_ID)]
            rid = mid()
            await c.send({"t": "krita", "id": rid, "cmd": "color", "hex": "#1d4ed8"})
            m = await c.recv_id(rid)
            assert m == {"t": "krita_reply", "id": rid, "ok": False, "error": "plugin_down"}


@pytest.mark.asyncio
async def test_relay_fallback_when_krita_not_running():
    async with rig(plugin_port=1, system=FakeSystem(krita_running=False)) as r:
        async with r.client() as c:
            rid = mid()
            await c.send({"t": "krita", "id": rid, "cmd": "action", "action": "edit_undo", "fallback_keys": "cmd+z"})
            m = await c.recv_id(rid)
            assert m["ok"] is False and m["via"] == "keys" and m["error"] == "krita_not_running"


@pytest.mark.asyncio
async def test_krita_state_follows_plugin_socket_and_reconnects():
    plugin = await FakePlugin().start()
    port = plugin.port
    async with rig(plugin_port=port) as r:
        async with r.client() as c:
            if not c.hello["krita"]:
                assert (await c.recv_type("krita_state"))["connected"] is True
            await plugin.stop()
            assert (await c.recv_type("krita_state"))["connected"] is False
            rid = mid()
            await c.send({"t": "krita", "id": rid, "cmd": "ping"})
            assert (await c.recv_id(rid))["error"] == "plugin_down"
            plugin2 = await FakePlugin().start(port)
            try:
                assert (await c.recv_type("krita_state", timeout=3))["connected"] is True
                rid = mid()
                await c.send({"t": "krita", "id": rid, "cmd": "ping"})
                assert (await c.recv_id(rid))["ok"] is True
            finally:
                await plugin2.stop()


@pytest.mark.asyncio
async def test_slow_plugin_does_not_block_moves():
    """A pending krita request must not stall the receive loop (watchdog would fire)."""
    plugin = await FakePlugin().start()
    try:
        async with rig(plugin_port=plugin.port) as r:
            assert await wait_until(lambda: r.server.relay.connected)
            async with r.client() as c:
                await plugin.stop()  # requests will now fail/timeout
                await c.send({"t": "move", "id": mid(), "x": 1, "y": 1})
                await c.send({"t": "down", "id": mid()})
                await c.send({"t": "krita", "id": mid(), "cmd": "list_actions"})
                for i in range(5):
                    await asyncio.sleep(0.05)
                    await c.send({"t": "move", "id": mid(), "x": 2 + i, "y": 2})
                assert r.server.pointer.is_down
    finally:
        await plugin.stop()


# ---------------------------------------------------------------- window rect
@pytest.mark.asyncio
async def test_krita_window_rect_emitted_every_period():
    async with rig(window_rect_period=0.05, system=FakeSystem(frontmost=KRITA_BUNDLE_ID)) as r:
        async with r.client() as c:
            m1 = await c.recv_type("krita_window_rect")
            m2 = await c.recv_type("krita_window_rect")
            assert m1["rect"] == {"x": 0.0, "y": 25.0, "w": 1400.0, "h": 1060.0}
            assert m1["id"] != m2["id"]
            assert m2["frontmost"] is True
            r.system.krita_rect = {"x": 10.0, "y": 40.0, "w": 900.0, "h": 700.0}
            m3 = await c.recv_type("krita_window_rect", rect={"x": 10.0, "y": 40.0, "w": 900.0, "h": 700.0})
            assert m3["t"] == "krita_window_rect"
            r.system.krita_running = False
            m4 = await c.recv_type("krita_window_rect", rect=None)
            assert m4["frontmost"] is False
            # no more rects while Krita is not running
            await asyncio.sleep(0.15)
            with pytest.raises(asyncio.TimeoutError):
                await c.recv_type("krita_window_rect", timeout=0.15)


def test_pick_main_window_largest_layer0_of_pid():
    wins = [
        {"kCGWindowOwnerPID": 7, "kCGWindowLayer": 0, "kCGWindowBounds": {"X": 0, "Y": 0, "Width": 3000, "Height": 2000}},
        {"kCGWindowOwnerPID": 42, "kCGWindowLayer": 0, "kCGWindowBounds": {"X": 0, "Y": 25, "Width": 1400, "Height": 1060}},
        {"kCGWindowOwnerPID": 42, "kCGWindowLayer": 0, "kCGWindowBounds": {"X": 100, "Y": 100, "Width": 300, "Height": 200}},
        {"kCGWindowOwnerPID": 42, "kCGWindowLayer": 3, "kCGWindowBounds": {"X": 0, "Y": 0, "Width": 5000, "Height": 5000}},
        {"kCGWindowOwnerPID": 42, "kCGWindowLayer": 0, "kCGWindowBounds": {"X": 5, "Y": 5, "Width": 20, "Height": 4000}},
    ]
    assert pick_main_window(wins, 42) == {"x": 0.0, "y": 25.0, "w": 1400.0, "h": 1060.0}
    assert pick_main_window(wins, 99) is None
