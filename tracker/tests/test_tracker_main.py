"""--no-input wiring never builds a real mouse/key poster/key tap; the app bundle script output."""

import asyncio
import os
import plistlib
import shutil
import subprocess
import sys

import pytest

from trackertest_kit import FAKE_BRAIN, REPLAY_DIR, REPO, PanelClient, wait_until
from steadyhelper.config import KRITA_BUNDLE_ID
from steadyhelper.fakes import FakeKeyPoster, FakeSystem

pytestmark = pytest.mark.P1


def _boom(*a, **k):
    raise AssertionError("real input touched under --no-input")


@pytest.mark.asyncio
async def test_no_input_never_touches_real_pointer_or_keys(tmp_path, monkeypatch):
    import steadyhelper.hotkeys as hk
    import steadyhelper.macos as mac
    import steadytracker.permissions as perms
    from steadytracker.main import BoundedFakeMouse, build_app, parse_args

    monkeypatch.setattr(mac, "QuartzMouse", _boom)
    monkeypatch.setattr(mac, "QuartzKeyPoster", _boom)
    monkeypatch.setattr(hk, "start_listener", _boom)
    monkeypatch.setattr(perms, "request_startup", _boom)
    monkeypatch.setattr(perms, "request_microphone", _boom)
    monkeypatch.setenv("FAKE_BRAIN_LOG", str(tmp_path / "b.jsonl"))
    args = parse_args([
        "--no-input", "--no-voice", "--fake-camera", str(REPLAY_DIR / "dwell-stroke-word.json"),
        "--replay-speed", "10", "--panel-port", "0", "--plugin-port", "1",
        "--brain-cmd", f"{sys.executable} {FAKE_BRAIN}", "--data-dir", str(tmp_path / "d"),
    ])
    app = build_app(args, overrides={"system": FakeSystem(frontmost=KRITA_BUNDLE_ID), "permissions_probe": lambda: {}})
    assert isinstance(app.pointer._mouse, BoundedFakeMouse)
    assert isinstance(app.key_out.key_poster, FakeKeyPoster)
    assert app.key_out.allow is False
    assert app._hotkey_listener_factory is None
    assert app._request_microphone is None
    await app.start()
    try:
        assert await wait_until(lambda: "up" in app.pointer._mouse.kinds(), 6.0)  # recorded, never posted
        ok, err = await app.key_out.post("cmd+z")
        assert (ok, err) == (False, "input_disabled")
        assert app.key_out.key_poster.posted == []
        p = await PanelClient(app.panel.port).connect()
        assert await wait_until(lambda: p.of("permissions"))
        await p.close()
    finally:
        await app.stop()


def test_parse_args_defaults():
    from steadytracker.main import parse_args

    a = parse_args([])
    assert (a.panel_port, a.plugin_port, a.no_input, a.fake_camera, a.verbose) == (8767, 8766, False, None, False)


@pytest.mark.skipif(sys.platform != "darwin" or not shutil.which("codesign"), reason="macOS only")
def test_build_tracker_app_bundle(tmp_path):
    out = tmp_path / "build"
    env = {**os.environ, "STEADY_BUILD_DIR": str(out)}
    res = subprocess.run(["bash", str(REPO / "scripts" / "build-tracker-app.sh")], env=env, capture_output=True, text=True, timeout=120)
    assert res.returncode == 0, res.stderr + res.stdout
    app = out / "Steady Tracker.app"
    info = plistlib.loads((app / "Contents" / "Info.plist").read_bytes())
    assert info["CFBundleIdentifier"] == "org.steady.tracker"
    assert info["CFBundleName"] == "Steady Tracker"
    assert info["CFBundleExecutable"] == "steady-tracker"
    assert info["LSUIElement"] is True
    assert "Frames never leave this Mac" in info["NSCameraUsageDescription"]
    assert "Mic is open" in info["NSMicrophoneUsageDescription"]
    exe = app / "Contents" / "MacOS" / "steady-tracker"
    assert exe.exists() and os.access(exe, os.X_OK)
    assert subprocess.run(["codesign", "--verify", str(app)], capture_output=True).returncode == 0
    assert not (tmp_path / "Applications").exists()
