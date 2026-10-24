"""Startup permission checks (§5) and the messages that name the launching terminal app.

macOS grants Accessibility / Input Monitoring to the *responsible* process (the terminal
app that launched the helper), not to python, so every message names that app.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
from dataclasses import dataclass
from typing import Callable, Iterable, List, Optional, Tuple

from .config import PRIVACY_ACCESSIBILITY_URL, PRIVACY_INPUT_MONITORING_URL

log = logging.getLogger("steady.permissions")

TERM_PROGRAM_NAMES = {
    "Apple_Terminal": "Terminal",
    "iTerm.app": "iTerm",
    "vscode": "Visual Studio Code",
    "WarpTerminal": "Warp",
    "ghostty": "Ghostty",
    "WezTerm": "WezTerm",
    "Hyper": "Hyper",
    "tmux": "Terminal (the app running tmux)",
}


@dataclass
class PermissionState:
    accessibility: bool
    input_monitoring: bool
    app_name: str

    @property
    def pointer_enabled(self) -> bool:
        return self.accessibility


def app_name_from_chain(commands: Iterable[str]) -> Optional[str]:
    """The responsible app from ancestor executable paths (nearest first).

    macOS attributes TCC grants to the top-most app bundle, so take the FURTHEST ancestor
    that is an app's executable (".app/Contents/MacOS/"), and name its outermost bundle.
    Paths like ".../com.conductor.app/bin/..." (a support folder, not a bundle executable)
    are skipped.
    """
    found = None
    for cmd in commands:
        if ".app/Contents/" not in cmd:
            continue
        m = re.search(r"/([^/]+)\.app/Contents/", cmd)
        if m:
            found = m.group(1)
    return found


def _ancestor_commands(pid: int, max_depth: int = 20) -> List[str]:
    out: List[str] = []
    for _ in range(max_depth):
        try:
            res = subprocess.run(
                ["ps", "-o", "ppid=", "-o", "comm=", "-p", str(pid)], capture_output=True, text=True, timeout=2
            ).stdout.strip()
        except Exception:
            break
        if not res:
            break
        parts = res.split(None, 1)
        if len(parts) < 2:
            break
        ppid, comm = int(parts[0]), parts[1]
        out.append(comm)
        if ppid <= 1:
            break
        pid = ppid
    return out


def launching_app_name(env: Optional[dict] = None, chain: Optional[List[str]] = None) -> str:
    """Name of the app that launched us (what to grant permissions to)."""
    env = os.environ if env is None else env
    if chain is None:
        chain = _ancestor_commands(os.getppid())
    name = app_name_from_chain(chain)
    if name:
        return name
    tp = env.get("TERM_PROGRAM")
    if tp:
        return TERM_PROGRAM_NAMES.get(tp, tp)
    return "the terminal app you launched Steady from"


def accessibility_message(app: str) -> str:
    return (
        f"Steady can't move the pointer: enable Accessibility for {app} in System Settings › "
        f"Privacy & Security › Accessibility ({PRIVACY_ACCESSIBILITY_URL}), then quit and reopen {app} "
        f"and run `npm run helper` again."
    )


def input_monitoring_message(app: str) -> str:
    return (
        f"Steady can't see the F-keys while Krita is in front: enable Input Monitoring for {app} in "
        f"System Settings › Privacy & Security › Input Monitoring ({PRIVACY_INPUT_MONITORING_URL}), "
        f"then quit and reopen {app} and run `npm run helper` again."
    )


STARTUP_WARNING = (
    "Before painting: turn OFF macOS Dwell Control, Head Pointer and Voice Control "
    "(System Settings › Accessibility › Pointer Control / Voice Control): they act on the same "
    "pointer and the same words. Unplug any drawing tablet: Krita can latch into tablet mode and "
    "ignore the mouse until it restarts."
)

TABLET_PROCESS_HINTS = ("Wacom", "WacomTabletDriver", "TabletDriver", "Huion", "XPPen", "PenTablet", "Gaomon")
CONFLICT_PROCESS_HINTS = ("VoiceControl",)


def detect_conflicts(process_names: Iterable[str]) -> List[str]:
    """Human-readable notes for running processes that conflict (tablet drivers, Voice Control)."""
    notes = []
    names = list(process_names)
    if any(any(h.lower() in n.lower() for h in TABLET_PROCESS_HINTS) for n in names):
        notes.append("A tablet driver is running: unplug the tablet while using Steady.")
    if any(n in CONFLICT_PROCESS_HINTS for n in names):
        notes.append("Voice Control appears to be on: turn it off while using Steady.")
    return notes


def check_permissions(
    *,
    request_listen: Optional[Callable[[], object]] = None,
    ax_trusted_prompt: Optional[Callable[[], bool]] = None,
    listen_trusted: Optional[Callable[[], bool]] = None,
    app_name: Optional[str] = None,
) -> PermissionState:
    """Real checks unless callables are injected (tests)."""
    if request_listen is None or ax_trusted_prompt is None or listen_trusted is None:
        real = _real_checks()
        request_listen = request_listen or real[0]
        ax_trusted_prompt = ax_trusted_prompt or real[1]
        listen_trusted = listen_trusted or real[2]
    try:
        request_listen()  # once, so the launcher appears in the Input Monitoring list
    except Exception:
        log.exception("CGRequestListenEventAccess failed")
    try:
        ax = bool(ax_trusted_prompt())
    except Exception:
        log.exception("AXIsProcessTrustedWithOptions failed")
        ax = False
    try:
        im = bool(listen_trusted())
    except Exception:
        log.exception("listen-event preflight failed")
        im = False
    return PermissionState(ax, im, app_name or launching_app_name())


def _real_checks() -> Tuple[Callable[[], object], Callable[[], bool], Callable[[], bool]]:
    def request_listen():
        import Quartz

        return Quartz.CGRequestListenEventAccess()

    def ax_prompt():
        from ApplicationServices import AXIsProcessTrustedWithOptions, kAXTrustedCheckOptionPrompt

        return AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: True})

    def listen_trusted():
        # Input Monitoring proper. pynput's Listener.IS_TRUSTED is AXIsProcessTrusted() (the
        # Accessibility bit) on macOS, so it cannot tell the two grants apart; the
        # CoreGraphics preflight can.
        import Quartz

        return Quartz.CGPreflightListenEventAccess()

    return request_listen, ax_prompt, listen_trusted
