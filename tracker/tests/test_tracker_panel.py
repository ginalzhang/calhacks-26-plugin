"""Panel server (127.0.0.1:8767): newest wins, ack, state forwarding/throttle, preview, permissions, typed."""

import asyncio

import pytest

from trackertest_kit import ManualSource, PanelClient, rig, wait_until
from steadytracker.panel_server import PanelServer

pytestmark = pytest.mark.P1

PERM_KEYS = {"t", "camera", "microphone", "accessibility", "input_monitoring"}


@pytest.mark.asyncio
async def test_hello_gets_cameras_and_permissions(tmp_path):
    async with rig(tmp_path, permissions={"camera": True, "microphone": False, "accessibility": True, "input_monitoring": False}) as r:
        p = await r.panel()
        assert await wait_until(lambda: p.of("permissions") and p.of("cameras"))
        perm = p.of("permissions")[0]
        assert set(perm) == PERM_KEYS
        assert perm == {"t": "permissions", "camera": True, "microphone": False, "accessibility": True, "input_monitoring": False}
        cams = p.of("cameras")[0]
        assert cams["list"] == [{"index": 0, "name": "FaceTime HD Camera"}, {"index": 1, "name": "iPhone Desk View Camera"}]
        assert cams["selected"] == 0
        await p.close()


@pytest.mark.asyncio
async def test_permissions_change_is_pushed(tmp_path):
    perms = {"camera": False, "microphone": False, "accessibility": True, "input_monitoring": True}
    async with rig(tmp_path, permissions=perms, permissions_period=0.05) as r:
        p = await r.panel()
        assert await wait_until(lambda: p.of("permissions"))
        r.app._permissions_probe = lambda: {**perms, "camera": True}
        assert await wait_until(lambda: len(p.of("permissions")) == 2)
        assert p.of("permissions")[-1]["camera"] is True
        await p.close()


@pytest.mark.asyncio
async def test_newest_panel_wins_and_old_is_closed(tmp_path):
    async with rig(tmp_path) as r:
        a = await r.panel()
        assert await wait_until(lambda: a.of("cameras"))
        b = await r.panel(hello=False)
        # a connection that has not said hello does not replace the current panel
        await b.send({"t": "action", "id": "x0", "action": "undo", "source": "tile"})
        assert await wait_until(lambda: b.ack_for("x0") is not None)
        assert b.ack_for("x0") == {"t": "ack", "id": "x0", "ok": False, "error": "hello_first"}
        assert not a.closed
        await b.send({"t": "hello", "plugin_version": "2", "krita_version": "5"})
        assert await wait_until(lambda: a.closed, 2.0)
        await b.send({"t": "action", "id": "x1", "action": "undo", "source": "tile"})
        assert await wait_until(lambda: b.ack_for("x1") is not None)
        assert b.ack_for("x1")["ok"] is True
        assert await wait_until(lambda: any(m.get("action") == "undo" for m in r.brain_msgs("action")))
        await b.close()


@pytest.mark.asyncio
async def test_non_json_line_closes_connection(tmp_path):
    async with rig(tmp_path) as r:
        p = await r.panel(hello=False)
        await p.send_raw(b"POST / HTTP/1.1\r\nHost: 127.0.0.1:8767\r\n\r\n")
        assert await wait_until(lambda: p.closed, 2.0)
        assert not r.brain_msgs("action")


@pytest.mark.asyncio
async def test_acks_and_errors(tmp_path):
    async with rig(tmp_path) as r:
        p = await r.panel()
        await p.send({"t": "bogus", "id": "b1"})
        await p.send({"t": "panel_rect", "id": "b2", "rect": {"x": 1}})
        await p.send({"t": "panel_rect", "id": "b3", "rect": {"x": 1500, "y": 60, "w": 220, "h": 900}})
        await p.send({"t": "camera", "id": "b4", "index": 7})
        await p.send({"t": "camera", "id": "b5", "index": 1})
        assert await wait_until(lambda: p.ack_for("b5") is not None)
        assert p.ack_for("b1") == {"t": "ack", "id": "b1", "ok": False, "error": "unknown_type"}
        assert p.ack_for("b2")["ok"] is False
        assert p.ack_for("b3")["ok"] is True
        assert p.ack_for("b4") == {"t": "ack", "id": "b4", "ok": False, "error": "no_camera"}
        assert p.ack_for("b5")["ok"] is True
        assert r.source.selections == [1]
        assert p.of("cameras")[-1]["selected"] == 1
        assert r.app.store.tracker_prefs()["camera"] == "iPhone Desk View Camera"
        assert await wait_until(lambda: any((m["rects"].get("panel") or {}).get("x") == 1500 for m in r.brain_msgs("rects")))
        assert r.app.pointer.chrome_rect == {"x": 1500.0, "y": 60.0, "w": 220.0, "h": 900.0}
        await p.send({"t": "panel_rect", "id": "b6", "rect": None})  # panel hidden
        assert await wait_until(lambda: p.ack_for("b6") is not None)
        assert p.ack_for("b6")["ok"] is True
        assert r.app.pointer.chrome_rect == r.system.krita_window_rect()  # hidden panel → Krita's window
        assert await wait_until(lambda: r.brain_msgs("rects")[-1]["rects"]["panel"] is None)
        await p.close()


@pytest.mark.asyncio
async def test_brain_messages_forwarded_to_panel(tmp_path):
    async with rig(tmp_path) as r:
        p = await r.panel()
        await p.send({"t": "action", "id": "d1", "action": "dialog_test", "source": "tile"})
        assert await wait_until(lambda: p.of("dialog") and p.of("status"))
        assert p.of("dialog")[0] == {
            "t": "dialog", "dialog_id": "d1", "kind": "confirm", "text": "Clear layer?",
            "options": [{"id": "confirm", "label": "Clear"}, {"id": "cancel", "label": "Cancel"}],
        }
        assert p.of("status")[0] == {"t": "status", "text": "did dialog_test", "level": "status"}
        r.app._on_brain({"t": "dialog_close", "dialog_id": "d1"})
        r.app._on_brain({"t": "status", "text": "", "level": "alert"})
        assert await wait_until(lambda: p.of("dialog_close"))
        assert p.of("dialog_close")[0] == {"t": "dialog_close", "dialog_id": "d1"}
        assert await wait_until(lambda: p.of("status")[-1] == {"t": "status", "text": "", "level": "alert"})
        await p.send({"t": "dialog_answer", "id": "d2", "dialog_id": "d1", "answer": "confirm"})
        assert await wait_until(lambda: r.brain_msgs("dialog_answer"))
        assert r.brain_msgs("dialog_answer")[0]["answer"] == "confirm"
        await p.close()


@pytest.mark.asyncio
async def test_state_forwarding_only_on_change_and_throttled(tmp_path):
    async with rig(tmp_path) as r:
        p = await r.panel()
        assert await wait_until(lambda: p.of("cameras"))
        for i in range(10):
            r.app._on_brain({"t": "state", "state": {"pen": "HOVER", "n": i, "paused": False}})
        await asyncio.sleep(0.03)
        assert len(p.of("state")) == 1 and p.of("state")[0]["state"]["n"] == 0
        assert await wait_until(lambda: len(p.of("state")) == 2, 1.0)
        assert p.of("state")[1]["state"]["n"] == 9  # newest wins
        await asyncio.sleep(0.15)
        r.app._on_brain({"t": "state", "state": {"pen": "HOVER", "n": 9, "paused": False}})  # unchanged
        await asyncio.sleep(0.15)
        assert len(p.of("state")) == 2
        # a newly connected panel gets the last state at once
        q = await r.panel()
        assert await wait_until(lambda: q.of("state"))
        assert q.of("state")[0]["state"]["n"] == 9
        await q.close()


@pytest.mark.asyncio
async def test_state_rate_is_at_most_15hz():
    sent = []

    async def h(msg):
        return True, None

    srv = await PanelServer(h, port=0).start()
    srv.send = lambda m: sent.append(m) or True  # type: ignore[assignment]
    t0 = asyncio.get_running_loop().time()
    while asyncio.get_running_loop().time() - t0 < 0.6:
        srv.send_state({"n": len(sent), "x": asyncio.get_running_loop().time()})
        await asyncio.sleep(0.005)
    await asyncio.sleep(0.1)
    assert 6 <= len(sent) <= 11, len(sent)
    await srv.stop()


@pytest.mark.asyncio
async def test_preview_only_when_enabled_and_at_most_5fps(tmp_path):
    calls = []

    def enc(image, point, mirror, rotate, score):
        calls.append((point, mirror, rotate))
        return b"\xff\xd8jpeg"

    async with rig(tmp_path, encoder=enc, preview_interval=0.2) as r:
        p = await r.panel()

        async def feed(seconds):
            t0 = asyncio.get_running_loop().time()
            while asyncio.get_running_loop().time() - t0 < seconds:
                r.source.push()
                await asyncio.sleep(1 / 30)

        await feed(0.5)
        assert not p.of("preview")  # settings.preview is off
        await p.send({"t": "settings", "id": "s", "settings": {"preview": True, "mirrorCamera": True}})
        await feed(1.05)
        n = len(p.of("preview"))
        assert 3 <= n <= 6, n
        pv = p.of("preview")[0]
        assert pv["w"] == 160 and pv["h"] == 120 and pv["jpeg_b64"] == "/9hqcGVn"
        assert calls[-1][1] is True and calls[-1][0] is not None
        await asyncio.sleep(0.5)  # no new frames → no new previews
        assert len(p.of("preview")) <= n + 1
        await p.send({"t": "settings", "id": "s2", "settings": {"preview": False}})
        await asyncio.sleep(0.05)
        m = len(p.of("preview"))
        await feed(0.5)
        assert len(p.of("preview")) == m
        await p.close()


@pytest.mark.asyncio
async def test_typed_grammar_match_and_nomatch_without_voice(tmp_path):
    async with rig(tmp_path) as r:
        p = await r.panel()
        await p.send({"t": "typed", "id": "t1", "text": "undo"})
        assert await wait_until(lambda: p.of("heard"))
        assert p.ack_for("t1")["ok"] is True
        assert p.of("heard")[0] == {"t": "heard", "text": "undo", "via": "grammar"}
        assert await wait_until(lambda: any(m["action"] == "undo" and m["source"] == "typed" for m in r.brain_msgs("action")))
        parse = [m for m in r.brain_msgs("parse") if m["id"].startswith("p-")][0]
        assert parse["opts"]["mode"] == "typed"
        await p.send({"t": "typed", "id": "t2", "text": "make it sparkle"})
        assert await wait_until(lambda: any("Didn't catch that" in m["text"] for m in p.of("status")))
        st = [m for m in p.of("status") if "Didn't" in m["text"]][0]
        assert st["text"] == 'Didn\'t catch that. Try: "undo" or "redo".'
        await p.close()


class FakeVoice:
    def __init__(self):
        self.calls = []

    def submit_text(self, text, mode="typed"):
        self.calls.append(("submit_text", text, mode))

    def on_brain_mic(self, open_, reason):
        self.calls.append(("on_brain_mic", open_, reason))

    def speak(self, text):
        self.calls.append(("speak", text))
        return True

    def on_settings(self, s):
        self.calls.append(("on_settings", s.get("quiet")))

    def dialog_answer(self, did, answer):
        self.calls.append(("dialog_answer", did, answer))
        return did.startswith("v-dlg-")

    def shutdown(self):
        self.calls.append(("shutdown",))


@pytest.mark.asyncio
async def test_voice_hooks(tmp_path):
    v = FakeVoice()
    async with rig(tmp_path, voice=v) as r:
        p = await r.panel()
        await p.send({"t": "typed", "id": "v1", "text": "blue bigger"})
        await p.send({"t": "mic", "id": "v2", "on": True})
        await p.send({"t": "action", "id": "v3", "action": "speak_test", "source": "tile"})
        await p.send({"t": "dialog_answer", "id": "v4", "dialog_id": "v-dlg-1", "answer": "choice_one"})
        assert await wait_until(lambda: ("speak", "Pen down") in v.calls and ("on_brain_mic", True, "tile") in v.calls)
        assert ("submit_text", "blue bigger", "typed") in v.calls
        assert not r.brain_msgs("dialog_answer")  # E's own dialog never reaches the brain
        mic = [m for m in r.brain_msgs("action") if m["action"] == "mic"][0]
        assert mic["variant"] == "on" and mic["source"] == "tile"
        # E's callbacks (called from E's threads)
        loop = asyncio.get_running_loop()
        res = await loop.run_in_executor(None, r.app.parse_blocking, "undo", {"mode": "voice"})
        assert res["kind"] == "match"
        r.app.voice_dispatch("size", None, 40, "claude")
        r.app.on_voice_heard("big brush", "claude")
        r.app.on_mic_state(False, "silence")
        r.app.on_voice_dialog({"t": "dialog", "dialog_id": "v-dlg-2", "kind": "clarify", "text": "Which?", "options": []})
        assert await wait_until(lambda: p.of("heard") and p.of("dialog"))
        assert p.of("heard")[-1] == {"t": "heard", "text": "big brush", "via": "claude"}
        assert await wait_until(lambda: any(m["action"] == "size" and m["arg"] == 40 and m["source"] == "claude" for m in r.brain_msgs("action")))
        assert await wait_until(lambda: any(m["action"] == "mic" and m.get("variant") == "closed" for m in r.brain_msgs("action")))
        kw = r.app.voice_kwargs({"ANTHROPIC_API_KEY": "x"})
        assert {"parse", "dispatch", "status", "heard", "speak_enabled", "settings_getter", "keys", "dialog", "dialog_open", "aliases_getter", "on_mic"} <= set(kw)
        await p.close()
    assert ("shutdown",) in v.calls
