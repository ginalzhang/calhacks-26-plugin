"""Steady panel widgets against stub PyQt5/krita (qt_stub.py): the widget tree builds, tiles send the
right messages, dialogs answer, privacy shows once, permissions deep-link, the plugin registers the
docker + menu. Real Krita rendering is a NEEDS-HUMAN item; a real-PyQt5 offscreen build runs when
PyQt5 is installed (it is not in the shared venv)."""
from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import textwrap

import pytest

import qt_stub
from krita_fakes import PYKRITA, ROOT  # noqa: F401  (puts pykrita on sys.path)

pytestmark = pytest.mark.P1


def all_tiles(panel):
    out = []
    for tiles in panel.action_tiles.values():
        out += tiles
    return out


@pytest.fixture()
def env():
    with qt_stub.stubbed() as app:
        import steady.panel as panel
        from steady.tracker_client import TrackerClient

        client = TrackerClient(port=1)
        sent = []
        client.send = lambda m: (sent.append(m), True)[1]
        hub = panel.Hub(app=app, client=client, plugin_version="test", probe=False)
        hub.ctl._send = client.send
        panel.Hub._instance = hub
        docker = panel.SteadyDocker()
        docker.show()
        yield panel, hub, docker, sent, app
        panel.Hub._instance = None


STATE = {"pen": "HOVER", "tracking": "Tracking", "reason": None, "paused": False, "latch": False, "mode": "normal",
         "calibrated": True, "calibrating": None, "detectionFps": 24, "cameraFps": 30, "kritaConnected": True,
         "micOpen": False, "quiet": False, "deviationPx": 2.5, "rawTrail": [{"x": 1, "y": 2}, {"x": 3, "y": 4}],
         "undoLabel": "Brush", "gain": 3.0,
         "settings": {"steadiness": 50, "dwellDownMs": 800, "inputs": {"camera": True, "voice": True, "dwell": True,
                                                                      "keys": True}}}


def connect(hub, **st):
    hub.ctl.on_connected()
    s = dict(STATE)
    s.update(st)
    hub.ctl.on_message({"t": "state", **s})  # flattened, as Steady Tracker's panel_server sends it


def test_imports_with_stub_qt_and_builds_the_tree(env):
    panel, hub, docker, sent, app = env
    p = docker.panel
    assert docker.widget() is p
    assert set(p.pages) == {pid for pid, _ in panel.PAGES}
    ids = {a["id"] for a in hub.table.actions if a["page"] != "dialog"}
    assert set(p.action_tiles) == ids
    assert all(len(t) == 1 for t in p.action_tiles.values())  # exactly one tile per action
    assert len(p.sliders) == 9
    assert p.pages["steady"].isVisible() and not p.pages["setup"].isVisible()
    assert p.start_tile.text_label() == "Start"
    assert p.status.text() == "Tracker off. Press Start."


def test_header_render_and_pause_resume(env):
    panel, hub, docker, sent, app = env
    p = docker.panel
    connect(hub, paused=True, pen="DRAWING", tracking="Weak")
    pause = p.action_tiles["pause"][0]
    assert pause.text_label() == "Resume" and not pause.isCheckable()
    assert pause.accessibleName() == "Resume"
    pen = p.action_tiles["pen_toggle"][0]
    assert pen.isCheckable() and pen.isChecked() and pen.accessibleName() == "Pen"
    assert p.tracking.text() == "Weak" and p.fps.text() == "24 fps"
    assert p.krita.text() == "Krita ✓" and p.krita.accessibleName() == "Krita connected"
    assert p.undo.isVisible() and p.undo.full_text() == "Undo: Brush"
    assert p.start_tile.text_label() == "Stop"
    pause.click()
    assert sent[-1]["action"] == "pause" and sent[-1]["variant"] == "resume"
    hub.ctl.on_message({"t": "state", "state": {"paused": False}})
    assert pause.text_label() == "Pause"


def test_compact_header_hides_empty_lines(env):
    panel, hub, docker, sent, app = env
    p = docker.panel
    assert not p.heard.isVisible() and not p.undo.isVisible() and not p.alert_box.isVisible()
    hub.client.started = True
    p.render_header()
    assert p.status.full_text() == "Connecting to Steady Tracker…"
    connect(hub, undoLabel=None)
    assert p.status.full_text() == "Ready" and not p.undo.isVisible()
    long = "Tracking back. Pen is up. " * 6
    hub.ctl.on_message({"t": "status", "text": long, "level": "status"})
    assert p.status.full_text() == long and p.status.toolTip() == long  # elided on screen, full in tooltip
    hub.ctl.on_message({"t": "heard", "text": "undo", "via": "grammar"})
    assert p.heard.isVisible() and p.heard.full_text() == "Heard: undo"
    hub.ctl.on_message({"t": "state", "undoLabel": "Brush stroke"})
    assert p.undo.isVisible()


def test_page_row_prev_next_and_all_pages(env):
    panel, hub, docker, sent, app = env
    p = docker.panel
    assert p.page_tile.text_label() == "Steady" and p.pages["steady"].isVisible()
    p.next_page.click()
    assert p.page_tile.text_label() == "Presets" and p.pages["presets"].isVisible()
    p.prev_page.click()
    p.prev_page.click()
    assert hub.ctl.page == "demo" and p.pages["demo"].isVisible()  # wraps around
    p.page_tile.click()  # show all pages
    assert p.page_menu.isVisible() and not p.pages["demo"].isVisible()
    assert len(p.page_buttons) == 12 and p.page_buttons["demo"].property("current") is True
    p.page_buttons["layers"].click()
    assert not p.page_menu.isVisible() and p.pages["layers"].isVisible() and hub.ctl.page == "layers"


def test_request_room_asks_the_main_window(env, monkeypatch):
    panel, hub, docker, sent, app = env
    calls = []

    class QWin:
        def height(self): return 1000
        def resizeDocks(self, docks, sizes, orient): calls.append((docks, sizes, orient))

    class Win:
        def qwindow(self): return QWin()

    app.activeWindow = lambda: Win()
    hub.give_room()
    assert calls == [([docker], [700], "Vertical")]
    QWin.height = lambda self: 1400
    hub.show_panel()
    assert calls[-1][1] == [840]
    app.activeWindow = lambda: None  # never raises into Krita
    assert panel.request_room(docker) in (True, False)


def test_toggle_click_follows_state_not_the_click(env):
    panel, hub, docker, sent, app = env
    connect(hub)
    latch = docker.panel.action_tiles["latch"][0]
    latch.click()
    assert sent[-1]["action"] == "latch"
    hub.ctl.on_message({"t": "state", "state": {"latch": False}})  # tracker says still off
    assert not latch.isChecked()


def test_always_listening_toggle_note_and_mic_line(env):
    panel, hub, docker, sent, app = env
    connect(hub)
    p = docker.panel
    assert not p.always_note.isVisible()
    p.setting_tiles["alwaysListen"].click()
    assert sent[-1]["settings"] == {"alwaysListen": True}
    assert p.always_note.isVisible() and p.always_note.text() == (
        "Always listening is on: the mic stays open on this Mac, and only when you speak is that audio sent to "
        "Cartesia.")
    hub.ctl.on_message({"t": "state", "micOpen": True})
    mic = p.action_tiles["mic"][0]
    assert mic.text_label() == "Mic" and mic.accessibleName() == "Mic" and mic.sub.text() == "Listening"
    mic.click()
    assert sent[-1]["settings"] == {"alwaysListen": False}
    assert not p.always_note.isVisible()
    assert p.privacy_text.text() == panel.PRIVACY_TEXT  # first-run text unchanged
    row = next(r for r in p.sliders if r.spec.key == "utteranceEndMs")
    assert row.value.text() == "450 ms"


def test_phase_disabled_tiles_keep_labels(env):
    panel, hub, docker, sent, app = env
    hub.table.build_phase = "P0"
    docker.panel.render_all()
    brush = docker.panel.action_tiles["brush"][0]
    assert brush.text_label() == "Brush" and not brush.isEnabled()
    assert docker.panel.action_tiles["undo"][0].isEnabled()
    hub.table.build_phase = "P4"


def test_slider_tiles_and_typed_box(env):
    panel, hub, docker, sent, app = env
    connect(hub)
    row = next(r for r in docker.panel.sliders if r.spec.key == "steadiness")
    row.up.click()
    assert sent[-1]["settings"] == {"steadiness": 55}
    assert row.slider.value() == 55 and row.value.text() == "55"
    row.slider.setValue(70)  # keyboard path
    assert sent[-1]["settings"] == {"steadiness": 70}
    docker.panel.typed.setText("make it blue")
    docker.panel.typed.returnPressed.emit()
    assert sent[-1] == {"t": "typed", "id": sent[-1]["id"], "text": "make it blue"}
    assert docker.panel.typed.text() == ""


def test_setup_page_preview_cameras_and_calibration(env):
    panel, hub, docker, sent, app = env
    connect(hub, calibrated=False, calibrating={"step": 1, "progress": 0.5, "prompt": "Rest your hand"})
    p = docker.panel
    p.set_page("setup")
    assert sent[-1]["settings"] == {"preview": True}
    assert p.calib_box.isVisible() and p.calib_prompt.text() == "Rest your hand" and p.calib_bar.value() == 50
    assert p.action_tiles["recalibrate"][0].text_label() == "Calibrate"
    hub.ctl.on_message({"t": "cameras", "list": [{"index": 0, "name": "FaceTime HD Camera"},
                                                 {"index": 1, "name": "Desk View Camera"}], "selected": 1})
    assert [t.text_label() for t in p.camera_tiles] == ["FaceTime HD Camera", "Desk View Camera"]
    assert p.camera_tiles[1].isChecked() and not p.camera_tiles[0].isChecked()
    p.camera_tiles[0].click()
    assert sent[-1]["t"] == "camera" and sent[-1]["index"] == 0
    p.action_tiles["recalibrate"][0].click()
    assert sent[-1]["t"] == "calibrate"
    p.setting_tiles["mirrorCamera"].click()
    assert sent[-1]["settings"] == {"mirrorCamera": True}
    p.pointer_tile.click()
    assert sent[-1]["settings"] == {"landmark": 8}
    hub.ctl.on_message({"t": "preview", "jpeg_b64": "/9j/", "w": 160, "h": 120})
    assert p.preview.pixmap() is not None
    p.action_tiles["use_last_setup"][0].click()
    assert sent[-1]["t"] == "action" and sent[-1]["action"] == "use_last_setup"
    assert list(p.profile_tiles) == ["Steady day", "Shaky day"]
    hub.ctl.on_message({"t": "state", "profiles": ["Steady day", "Shaky day", "Flare day"]})
    assert list(p.profile_tiles) == ["Steady day", "Shaky day", "Flare day"]
    p.profile_tiles["Flare day"].click()
    assert sent[-1]["action"] == "use_profile" and sent[-1]["variant"] == "Flare day"
    p.set_page("steady")
    assert sent[-1]["settings"] == {"preview": False}


def test_confirm_dialog_cancel_focused_and_answers(env):
    panel, hub, docker, sent, app = env
    connect(hub)
    hub.ctl.on_message({"t": "dialog", "dialog_id": "d1", "kind": "confirm", "text": "Delete this layer?",
                        "options": []})
    dlg = docker.panel.dialog
    assert dlg is not None and dlg.isVisible()
    assert list(dlg.buttons) == ["cancel", "confirm"]
    assert dlg.buttons["confirm"].text_label() == "Confirm" and dlg.cancel is dlg.buttons["cancel"]
    assert dlg.cancel.isDefault()
    dlg.buttons["confirm"].click()
    assert sent[-1]["t"] == "dialog_answer" and sent[-1]["dialog_id"] == "d1" and sent[-1]["answer"] == "confirm"
    assert docker.panel.dialog is None


def test_dialog_esc_cancels_and_tracker_close(env):
    panel, hub, docker, sent, app = env
    connect(hub)
    hub.ctl.on_message({"t": "dialog", "dialog_id": "c1", "kind": "clarify", "text": "Which one?",
                        "options": [{"id": "brush", "label": "Brush"}, {"id": "ink", "label": "Ink"}]})
    dlg = docker.panel.dialog
    assert [t.text_label() for t in dlg.buttons.values()] == ["1. Brush", "2. Ink", "Cancel"]
    dlg.reject()  # Esc
    assert sent[-1]["answer"] == "cancel" and docker.panel.dialog is None
    hub.ctl.on_message({"t": "dialog", "dialog_id": "d2", "kind": "confirm", "text": "Clear?", "options": []})
    n = len(sent)
    hub.ctl.on_message({"t": "dialog_close", "dialog_id": "d2"})  # answered by voice
    assert docker.panel.dialog is None and len(sent) == n


def test_privacy_shown_once(env):
    panel, hub, docker, sent, app = env
    p = docker.panel
    assert p.privacy.isVisible() and p.privacy_text.text() == panel.PRIVACY_TEXT
    p.privacy_ok.click()
    assert not p.privacy.isVisible()
    assert app.settings[("steady", "privacyAcknowledged")] == "1"
    p2 = panel.SteadyPanel(hub)
    assert not p2.privacy.isVisible()


def test_permissions_box_opens_system_settings(env):
    panel, hub, docker, sent, app = env
    connect(hub)
    p = docker.panel
    assert not p.perm_box.isVisible()
    hub.ctl.on_message({"t": "permissions", "camera": False, "microphone": True, "accessibility": True,
                        "input_monitoring": True})
    assert p.perm_box.isVisible()
    buttons = [w for w in p.perm_lay.items if isinstance(w, panel.Tile)]
    texts = [w.text() for w in p.perm_lay.items if isinstance(w, qt_stub.QLabel)]
    assert any('"Steady Tracker"' in t for t in texts)
    buttons[0].click()
    assert qt_stub.QDesktopServices.opened == [
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"]
    hub.ctl.on_message({"t": "permissions", "camera": True, "microphone": True, "accessibility": True,
                        "input_monitoring": True})
    assert not p.perm_box.isVisible()


def test_panel_rect_and_disconnect(env):
    panel, hub, docker, sent, app = env
    connect(hub)
    hub.tick()
    assert sent[-1] == {"t": "panel_rect", "rect": {"x": 100, "y": 50, "w": 380, "h": 900}}
    docker.hide()
    hub.report_rect()
    assert sent[-1] == {"t": "panel_rect", "rect": None}  # hidden panel
    docker.show()
    hub.report_rect()
    assert sent[-1]["rect"]["w"] == 380
    hub.ctl.on_disconnected()
    assert docker.panel.tracking.text() == "Lost" and docker.panel.krita.text() == "Krita ✗"
    assert docker.panel.krita.accessibleName() == "Krita: waiting for tracker"
    assert docker.panel.status.full_text() == "Tracker off. Press Start."


def test_start_stop(env, monkeypatch):
    panel, hub, docker, sent, app = env
    monkeypatch.setattr(panel.launcher, "launch", lambda: (False, panel.INSTALL_HINT))
    hub.toggle_tracker()
    assert hub.client.started and docker.panel.status.text() == panel.INSTALL_HINT
    assert hub.client.sock.connects == [("127.0.0.1", 1)]
    connect(hub)
    hub.toggle_tracker()
    assert sent[-1]["t"] == "quit" and not hub.client.started


def test_hello_on_connect():
    with qt_stub.stubbed() as app:
        from steady.tracker_client import TrackerClient

        c = TrackerClient(port=1, hello=lambda: {"t": "hello", "plugin_version": "x", "krita_version": "5.3.4"})
        got = []
        c.on_message = got.append
        c.start()
        c.sock._state = 2
        c.sock.connected.emit()
        assert c.connected and b'"t":"hello"' in c.sock.written[0]
        c.sock.readAll = lambda: b'{"t":"status","text":"hi","level":"status"}\n{"t":"ack","id":"zz","ok":true}\n'
        c.sock.readyRead.emit()
        assert got == [{"t": "status", "text": "hi", "level": "status"}]
        c.sock._state = 0
        c.sock.disconnected.emit()
        assert not c.connected
        assert c.send({"t": "quit", "id": "q"}) is False


def test_plugin_registers_docker_and_menu():
    with qt_stub.stubbed() as app:
        import steady

        assert len(app.extensions) == 1 and steady.PANEL_ERROR == ""
        f = app.factories[0]
        assert (f.id, f.area, f.cls.__name__) == ("steady_panel", "DockRight", "SteadyDocker")

        created = []

        class Win:
            def createAction(self, aid, text, where):
                a = qt_stub.QPushButton()
                a.triggered = qt_stub.Signal()
                created.append((aid, text, where))
                return a

            def qwindow(self):
                return None

        app.extensions[0].createActions(Win())
        assert ("steady_menu", "Steady", "tools") in created
        assert [(a, t) for a, t, w in created if w == "tools/steady_menu"] == [
            ("steady_start_tracker", "Start tracker"), ("steady_stop_tracker", "Stop tracker"),
            ("steady_show_panel", "Show panel"), ("steady_status_menu", "Connection status")]
        assert ("steady_status", "Steady: connection status", "tools/scripts") in created


@pytest.mark.skipif(importlib.util.find_spec("PyQt5") is None, reason="PyQt5 not installed")
def test_real_pyqt5_offscreen_build(tmp_path):
    script = textwrap.dedent(f"""
        import os, sys, types
        os.environ["QT_QPA_PLATFORM"] = "offscreen"
        sys.path.insert(0, {str(PYKRITA)!r})
        from PyQt5.QtWidgets import QApplication, QDockWidget
        app = QApplication([])
        k = types.ModuleType("krita"); k.Krita = None; k.DockWidget = QDockWidget
        sys.modules["krita"] = k
        import steady.panel as panel
        from steady.tracker_client import TrackerClient
        hub = panel.Hub(app=None, client=TrackerClient(port=1), probe=False)
        p = panel.SteadyPanel(hub); p.resize(380, 900); p.show(); app.processEvents()
        for pid, _ in panel.PAGES:
            p.set_page(pid); app.processEvents()
        print("OK", len(p.action_tiles))
    """)
    out = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=60,
                         env=dict(os.environ, QT_QPA_PLATFORM="offscreen"))
    assert "OK" in out.stdout, out.stderr
