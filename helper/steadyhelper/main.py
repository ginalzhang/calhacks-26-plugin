"""Entry point wiring: permissions → pointer → server → hotkeys; every exit path releases the button."""

from __future__ import annotations

import argparse
import asyncio
import atexit
import logging
import os
import signal
import sys
from typing import Callable, Optional

from . import VERSION
from .config import ALLOWED_ORIGIN, PLUGIN_HOST, PLUGIN_PORT, WS_HOST, WS_PORT
from .permissions import (
    STARTUP_WARNING,
    accessibility_message,
    check_permissions,
    detect_warnings,
    input_monitoring_message,
)
from .origins import ENV_VAR, BadOrigin, resolve_origins
from .pointer import Pointer

log = logging.getLogger("steady")


def install_safety(pointer: Pointer, register: Callable = atexit.register) -> Callable[[], None]:
    """Register the atexit release. Returns the release function (also used by signal handlers)."""

    def release_on_exit() -> None:
        try:
            pointer.release("exit")
        except Exception:
            pass

    register(release_on_exit)
    return release_on_exit


def run_guarded(fn: Callable[[], object], pointer: Pointer) -> int:
    """Top-level try/except: any exception releases the button before propagating as exit code 1."""
    try:
        fn()
        return 0
    except KeyboardInterrupt:
        pointer.release("Ctrl-C")
        return 0
    except BaseException:
        pointer.release("top-level exception")
        log.exception("helper crashed")
        return 1
    finally:
        pointer.release("exit")


def parse_args(argv=None, env=None) -> argparse.Namespace:
    """Parse CLI args; `args.origins` is the validated allowed-Origin list (exits 2 on a bad one)."""
    ap = argparse.ArgumentParser(description="Steady helper: pointer, hotkeys, Krita relay.")
    ap.add_argument("--host", default=WS_HOST)
    ap.add_argument("--port", type=int, default=WS_PORT)
    ap.add_argument(
        "--origin",
        action="append",
        default=None,
        help=f"allowed WebSocket Origin, repeatable (default {ALLOWED_ORIGIN}; env {ENV_VAR}=a,b). "
        "Only http(s)://localhost or 127.0.0.1 with an optional port.",
    )
    ap.add_argument("--plugin-port", type=int, default=PLUGIN_PORT)
    ap.add_argument("--no-hotkeys", action="store_true", help="do not install the global key tap")
    ap.add_argument("--no-pointer", action="store_true", help="pointer-less mode (never post mouse events)")
    ap.add_argument("--no-overlay", action="store_true", help="no ring overlay window (P3); the side panel still shows state")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    try:
        args.origins = resolve_origins(args.origin, os.environ if env is None else env)
    except BadOrigin as e:
        ap.error(str(e))
    return args


async def _serve(args, pointer: Pointer, perms, warnings=None, overlay=None, on_ready=None) -> None:
    from .hotkeys import start_listener
    from .krita_relay import KritaRelay
    from .macos import MacSystem, QuartzKeyPoster
    from .server import HelperServer

    system = MacSystem()
    relay = KritaRelay(PLUGIN_HOST, args.plugin_port)
    server = HelperServer(
        pointer=pointer,
        system=system,
        key_poster=QuartzKeyPoster(),
        relay=relay,
        permissions=perms,
        host=args.host,
        port=args.port,
        allowed_origins=args.origins,
        warnings=warnings,
        overlay=overlay,
    )
    await server.start()
    listener = None
    if not args.no_hotkeys and perms.input_monitoring:
        listener = start_listener(server.router, os.getpid())
    elif not args.no_hotkeys:
        print("Global F-keys are OFF until Input Monitoring is granted (see above).", flush=True)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        try:
            loop.add_signal_handler(sig, lambda s=sig: (pointer.release(f"signal {s}"), stop.set()))
        except (NotImplementedError, RuntimeError, ValueError):
            pass  # not the main thread (overlay mode): the Cocoa main thread handles signals
    if on_ready is not None:
        on_ready(loop, stop)
    print(f"Steady helper {VERSION} ready on ws://{args.host}:{server.port}. Ctrl-C to quit.", flush=True)
    try:
        await stop.wait()
    finally:
        pointer.release("shutdown")
        if listener is not None:
            try:
                listener.stop()
            except Exception:
                pass
        await server.stop()


def main(argv=None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    perms = check_permissions()
    print(f"Steady helper {VERSION}. Launched from: {perms.app_name}.", flush=True)
    if not perms.accessibility:
        print("\n!! " + accessibility_message(perms.app_name), flush=True)
        print("!! Running in POINTER-LESS mode: Steady will not move or click the pointer.\n", flush=True)
    if not perms.input_monitoring:
        print("\n!! " + input_monitoring_message(perms.app_name) + "\n", flush=True)
    print("Note: " + STARTUP_WARNING, flush=True)
    warnings = []
    try:
        from .macos import running_process_names

        warnings = detect_warnings(running_process_names())
    except Exception:
        log.exception("conflict detection failed")
    for _code, note in warnings:
        print("Warning: " + note, flush=True)

    if args.no_pointer or not perms.accessibility:
        from .fakes import FakeMouse

        mouse = FakeMouse()  # records only; nothing is posted
        pointer = Pointer(mouse, enabled=False)
    else:
        from .macos import QuartzMouse

        pointer = Pointer(QuartzMouse(), enabled=True)

    install_safety(pointer)
    if not args.no_overlay:
        try:
            from .overlay import run_app_with_overlay
        except Exception as e:
            log.exception("ring overlay unavailable")
            warnings.append(("overlay_disabled", f"The pointer ring is off ({type(e).__name__}). Steady works without it."))
        else:
            return run_guarded(
                lambda: run_app_with_overlay(
                    lambda overlay, on_ready: asyncio.run(
                        _serve(args, pointer, perms, warnings, overlay=overlay, on_ready=on_ready)
                    ),
                    pointer,
                    warnings,
                ),
                pointer,
            )
    return run_guarded(lambda: asyncio.run(_serve(args, pointer, perms, warnings)), pointer)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
