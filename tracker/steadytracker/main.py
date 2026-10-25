"""`python -m steadytracker` (scripts/run-tracker.sh; Steady Tracker.app runs that script).

Flags: --panel-port 8767 · --plugin-port 8766 · --no-input · --fake-camera <replay.json> · -v
(plus --brain-cmd, --model, --data-dir, --no-hotkeys, --no-voice, --replay-speed, --replay-loop for dev/tests).

--no-input: never posts mouse or key events (a recording FakeMouse stands in), never installs the key
tap, never activates apps and never shows or requests a permission prompt (grants are only read).
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import shlex
import signal
import sys
from collections import deque
from typing import Any, Callable, Dict, List, Optional

from . import REPO, VERSION
from .config import BRAIN_BUNDLE, PANEL_HOST, PANEL_PORT, PLUGIN_PORT, data_dir, default_model_path

log = logging.getLogger("steady.tracker")


def parse_args(argv=None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="steadytracker", description="Steady Tracker: camera, brain, pointer, panel server.")
    ap.add_argument("--panel-port", type=int, default=PANEL_PORT)
    ap.add_argument("--plugin-port", type=int, default=PLUGIN_PORT)
    ap.add_argument("--no-input", action="store_true", help="never touch the real pointer/keys; no prompts")
    ap.add_argument("--no-hotkeys", action="store_true", help="do not install the global F-key tap")
    ap.add_argument("--no-voice", action="store_true", help="do not load the voice module")
    ap.add_argument("--fake-camera", metavar="REPLAY_JSON", default=None, help="replay landmarks instead of the camera")
    ap.add_argument("--replay-speed", type=float, default=1.0)
    ap.add_argument("--replay-loop", action="store_true")
    ap.add_argument("--brain-cmd", default=None, help="override the brain command (default: node tracker/brain/dist/brain.mjs)")
    ap.add_argument("--model", default=None, help="hand_landmarker.task path")
    ap.add_argument("--data-dir", default=None, help="settings dir (default ~/Library/Application Support/Steady)")
    ap.add_argument("-v", "--verbose", action="store_true")
    return ap.parse_args(argv)


class BoundedFakeMouse:
    """--no-input / no-Accessibility stand-in: records the last 2000 events, posts nothing."""

    def __init__(self) -> None:
        from steadyhelper.fakes import FakeMouse

        self._inner = FakeMouse()
        self._inner.events = deque(maxlen=2000)  # type: ignore[assignment]

    def __getattr__(self, name):
        return getattr(self._inner, name)


def build_app(args: argparse.Namespace, *, overrides: Optional[Dict[str, Any]] = None):
    """Wire the real (or overridden) components. `overrides` keys: system, key_poster, mouse,
    permissions_probe, source, voice_factory, hotkey_listener, preview_encoder, relay."""
    from steadyhelper.krita_relay import KritaRelay
    from steadyhelper.pointer import Pointer

    from . import permissions as perms_mod
    from .app import TrackerApp
    from .brain import default_brain_cmd
    from .camera import CameraSource, ReplaySource, pick_default
    from .envkeys import load_keys
    from .persistence import Store

    o = dict(overrides or {})
    holder: Dict[str, Any] = {}  # lets the camera's warning callback reach the app built below
    no_input = bool(args.no_input)
    store = Store(args.data_dir or data_dir())

    # system: read-only queries (frontmost app, Krita window, screens) are fine even with --no-input
    system = o.get("system")
    if system is None:
        from steadyhelper.macos import MacSystem

        system = MacSystem()

    # pointer + keys
    real_pointer = False
    mouse = o.get("mouse")
    if mouse is None:
        if no_input:
            mouse = BoundedFakeMouse()
        else:
            from steadyhelper.macos import QuartzMouse

            mouse = QuartzMouse()
            real_pointer = True
    pointer = Pointer(mouse, enabled=True)
    key_poster = o.get("key_poster")
    if key_poster is None:
        if no_input:
            from steadyhelper.fakes import FakeKeyPoster

            key_poster = FakeKeyPoster()
        else:
            from steadyhelper.macos import QuartzKeyPoster

            key_poster = QuartzKeyPoster()

    # frame source
    source = o.get("source")
    if source is None:
        if args.fake_camera:
            source = ReplaySource(args.fake_camera, speed=args.replay_speed, loop=args.replay_loop)
        else:
            from .landmarks import HandTracker

            model = args.model or default_model_path()

            def warn(text: str) -> None:
                app = holder.get("app")
                if app is not None:
                    app.on_voice_status(text, "alert")

            source = CameraSource(lambda: HandTracker(model, on_warning=warn), on_warning=warn)
            source.selected = pick_default(source.cameras(), store.tracker_prefs().get("camera"))

    # brain
    brain_cmd: List[str] = shlex.split(args.brain_cmd) if args.brain_cmd else default_brain_cmd(BRAIN_BUNDLE)

    # hotkeys
    hotkey_listener = o.get("hotkey_listener")
    if hotkey_listener is None and not no_input and not args.no_hotkeys:
        from steadyhelper.hotkeys import start_listener

        def hotkey_listener(router):
            return start_listener(router, os.getpid())

    if no_input:
        hotkey_listener = None

    # voice (agent E)
    voice_factory = o.get("voice_factory")
    keys = load_keys()
    if voice_factory is None and not args.no_voice:
        voice_factory = lambda app: load_voice(app, keys)  # noqa: E731

    preview_encoder = o.get("preview_encoder")
    if preview_encoder is None:
        try:
            from .preview import cv2_encoder

            import cv2  # noqa: F401

            preview_encoder = cv2_encoder
        except Exception:
            log.warning("cv2 unavailable: no camera preview")

    relay = o.get("relay")
    if relay is None:
        relay = KritaRelay("127.0.0.1", args.plugin_port)

    app = TrackerApp(
        source=source,
        brain_cmd=brain_cmd,
        pointer=pointer,
        system=system,
        key_poster=key_poster,
        store=store,
        relay=relay,
        panel_host=PANEL_HOST,
        panel_port=args.panel_port,
        permissions_probe=o.get("permissions_probe") or perms_mod.probe,
        allow_input=not no_input,
        real_pointer=real_pointer,
        hotkey_listener=hotkey_listener,
        voice_factory=voice_factory,
        preview_encoder=preview_encoder,
        request_microphone=None if no_input else perms_mod.request_microphone,
        keys=keys,
    )
    holder["app"] = app
    return app


def load_voice(app, keys: Dict[str, str]):
    """Agent E's VoiceController (tracker/steadytracker/voice). Expected interface:
        VoiceController(tracker=app, keys=keys)
          .on_mic(open: bool, reason: str)      # brain `mic` (ptt | tile | quiet | dialog)
          .speak(text: str)                      # brain `speak`
          .resolve_text(text, state) -> Resolution dict | awaitable | None   # Claude fallback (optional)
          .close()
        and calls back app.on_transcript(text), app.on_voice_status(text, level), app.on_mic_state(open, reason).
    Missing module → None (typed + tiles + F-keys still work)."""
    try:
        from .voice import VoiceController  # type: ignore
    except Exception as exc:
        log.info("voice module unavailable (%s); voice is off", type(exc).__name__)
        return None
    try:
        return VoiceController(tracker=app, keys=keys)
    except TypeError:
        return VoiceController()


async def _run(app, install_signals: bool = True) -> None:
    await app.start()
    loop = asyncio.get_running_loop()
    if install_signals:
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            try:
                loop.add_signal_handler(sig, lambda s=sig: (app.pointer.release(f"signal {s}"), app.request_stop()))
            except (NotImplementedError, RuntimeError, ValueError):
                pass
    print(f"Steady Tracker {VERSION} ready: panel 127.0.0.1:{app.panel.port}.", flush=True)
    try:
        await app.stop_event.wait()
    finally:
        await app.stop()


def main(argv=None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    from steadyhelper.main import install_safety, run_guarded

    if args.no_input:
        print("--no-input: Steady will not move the pointer, post keys, switch apps or listen to keys.", flush=True)
    else:
        from . import permissions as perms_mod

        perms_mod.request_startup(camera=not args.fake_camera)
    try:
        app = build_app(args)
    except OSError as exc:
        print(f"Steady Tracker could not start: {exc}", file=sys.stderr, flush=True)
        return 1
    install_safety(app.pointer)
    try:
        return run_guarded(lambda: asyncio.run(_run(app)), app.pointer)
    except OSError as exc:  # pragma: no cover
        print(f"Steady Tracker could not start: {exc}", file=sys.stderr, flush=True)
        return 1
