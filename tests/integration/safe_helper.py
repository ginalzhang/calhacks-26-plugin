#!/usr/bin/env python3
"""Integration launcher for the REAL Steady helper with every real-input path sealed.

Runs `steadyhelper.main.main(argv)` (the same entry point as helper/steady_helper.py: real CLI
parsing, Origin check, WebSocket server, Krita relay, watchdog, Pointer, MacSystem reads) after
patching, in this process only, everything that could emit a real input event or a system dialog:

  * Quartz.CGEventPost / CGEventPostToPid / CGEventPostToPSN / CGWarpMouseCursorPosition /
    CGDisplayMoveCursorToPoint  -> no-op that logs "INTEGRATION-BLOCKED <name>"
  * steadyhelper.macos.QuartzKeyPoster -> recorder (logs "INTEGRATION-BLOCKED key_post <combo>")
  * steadyhelper.macos.MacSystem.activate_krita -> no-op (logs "INTEGRATION-BLOCKED activate_krita")
  * steadyhelper.hotkeys.start_listener -> refused (no global key tap)
  * permission checks -> non-prompting preflights (AXIsProcessTrusted, CGPreflightListenEventAccess);
    the real helper calls AXIsProcessTrustedWithOptions(prompt=True) and CGRequestListenEventAccess,
    which can open macOS permission dialogs even with --no-pointer --no-hotkeys.

Why a shim: `--no-pointer` only swaps the MOUSE backend. The helper still builds a real
QuartzKeyPoster and a real MacSystem, so `keys` and `krita {fallback_keys}` activate Krita and post
real keystrokes whenever Accessibility is granted and Krita is running (see DECISIONS.md, Agent H).

Required argv: --no-hotkeys --no-overlay, and --no-pointer or --no-input unless STEADY_SHIM_FAKE_POINTER=1.
`--no-input` (agent C, safety fix): when the helper supports it, the shim adds it automatically (pointer-less
runs) and keeps every patch above as defence in depth; when it does not, `--no-input` is translated to
`--no-pointer`.
STEADY_SHIM_FAKE_POINTER=1: the pointer is ENABLED but backed by a logging fake mouse
("FAKE-MOUSE <event> x y" on stderr), with accessibility reported as granted, so the watchdog and
release paths are observable. Nothing reaches the OS either way (CGEventPost is sealed).
"""
from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "helper"))

FAKE_POINTER = os.environ.get("STEADY_SHIM_FAKE_POINTER") == "1"


def _err(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def helper_supports(flag: str) -> bool:
    import contextlib
    import io

    from steadyhelper.main import parse_args

    try:
        with contextlib.redirect_stderr(io.StringIO()):
            parse_args([flag], env={})
        return True
    except SystemExit:
        return False


def _normalise_flags(argv) -> list:
    """Enforce the safety flags; add/translate --no-input. Returns the argv passed to main()."""
    argv = list(argv)
    need = ["--no-hotkeys", "--no-overlay"]
    missing = [f for f in need if f not in argv]
    if not FAKE_POINTER and "--no-pointer" not in argv and "--no-input" not in argv:
        missing.append("--no-pointer|--no-input")
    if missing:
        _err(f"safe_helper: refusing to start without {' '.join(missing)}")
        sys.exit(3)
    has_no_input = helper_supports("--no-input")
    if has_no_input and not FAKE_POINTER and "--no-input" not in argv:
        argv.append("--no-input")
    if not has_no_input and "--no-input" in argv:
        argv = [a for a in argv if a != "--no-input"]
        if "--no-pointer" not in argv:
            argv.append("--no-pointer")
        _err("safe_helper: this helper has no --no-input yet; using --no-pointer (shim still seals keys)")
    _err(f"safe_helper: helper --no-input support: {has_no_input}")
    return argv


def _seal_quartz() -> None:
    import Quartz

    for name in (
        "CGEventPost",
        "CGEventPostToPid",
        "CGEventPostToPSN",
        "CGWarpMouseCursorPosition",
        "CGDisplayMoveCursorToPoint",
    ):
        if hasattr(Quartz, name):

            def blocked(*_a, _n=name, **_k):
                _err(f"INTEGRATION-BLOCKED {_n}")
                return 0

            setattr(Quartz, name, blocked)


def _patch_helper() -> None:
    from steadyhelper import hotkeys, macos, main as main_mod, permissions

    class BlockedKeyPoster:
        def __init__(self) -> None:
            self.posted = []

        def post(self, stroke) -> None:
            self.posted.append(stroke.combo)
            _err(f"INTEGRATION-BLOCKED key_post {stroke.combo}")

    def blocked_activate(self) -> bool:
        _err("INTEGRATION-BLOCKED activate_krita")
        return False

    def blocked_listener(*_a, **_k):
        _err("INTEGRATION-BLOCKED start_listener")
        raise RuntimeError("global key tap disabled by the integration shim")

    macos.QuartzKeyPoster = BlockedKeyPoster
    macos.MacSystem.activate_krita = blocked_activate
    hotkeys.start_listener = blocked_listener

    def non_prompting_checks():
        import Quartz
        from ApplicationServices import AXIsProcessTrusted

        def request_listen():
            return None  # never CGRequestListenEventAccess (it can open a dialog)

        def ax():
            return True if FAKE_POINTER else bool(AXIsProcessTrusted())

        def listen():
            return bool(Quartz.CGPreflightListenEventAccess())

        return request_listen, ax, listen

    permissions._real_checks = non_prompting_checks

    if FAKE_POINTER:

        class LoggingMouse:
            def __init__(self) -> None:
                self._pos = (0.0, 0.0)

            def _log(self, kind, x, y):
                _err(f"FAKE-MOUSE {kind} {x:.1f} {y:.1f}")

            def move(self, x, y, drag):
                self._pos = (x, y)
                self._log({None: "move", "left": "drag", "middle": "middle_drag"}[drag], x, y)

            def left_down(self, x, y):
                self._log("down", x, y)

            def left_up(self, x, y):
                self._log("up", x, y)

            def middle_down(self, x, y):
                self._log("middle_down", x, y)

            def middle_up(self, x, y):
                self._log("middle_up", x, y)

            def position(self):
                return self._pos

        macos.QuartzMouse = LoggingMouse
    else:

        class NoMouse:
            def __init__(self) -> None:
                _err("INTEGRATION-BLOCKED QuartzMouse()")
                raise RuntimeError("real mouse disabled by the integration shim")

        macos.QuartzMouse = NoMouse

    _err(f"safe_helper: sealed (fake_pointer={FAKE_POINTER}); main={main_mod.__name__}")


def run(argv) -> int:
    argv = _normalise_flags(argv)
    _seal_quartz()
    _patch_helper()
    from steadyhelper.main import main

    return main(argv)


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
