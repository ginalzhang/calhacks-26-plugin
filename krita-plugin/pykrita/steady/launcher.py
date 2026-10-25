"""Steady panel: find and launch Steady Tracker.app.

The tracker is launched with `open -a` (LaunchServices), never as Krita's child, so macOS treats
the tracker app as the responsible process for Camera, Microphone, Accessibility and Input
Monitoring (Krita has no camera usage description). Stop is the panel's `quit` message.

Path resolution is pure (tested); only start_detached() touches Qt.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Callable, List, Optional, Tuple

from .panel_model import INSTALL_HINT, TRACKER_PORT

APP_NAME = "Steady Tracker.app"
OPEN = "/usr/bin/open"
REPO_FILE = "steady_repo.txt"  # written next to the plugin's modules by scripts/krita-plugin-install.sh
HERE = Path(__file__).resolve().parent


def repo_dir(plugin_dir: Path = HERE, exists: Callable[[str], bool] = os.path.isdir) -> Optional[Path]:
    """The Steady repo: from steady_repo.txt, else the source tree this module runs from (dev checkout)."""
    f = plugin_dir / REPO_FILE
    try:
        text = f.read_text(encoding="utf-8").strip()
    except OSError:
        text = ""
    if text and exists(text):
        return Path(text)
    # krita-plugin/pykrita/steady/launcher.py -> repo root (running straight from a checkout)
    guess = plugin_dir.parent.parent.parent
    if exists(str(guess / "tracker")) and exists(str(guess / "krita-plugin")):
        return guess
    return None


def candidate_apps(home: Optional[str] = None, plugin_dir: Path = HERE,
                   isdir: Callable[[str], bool] = os.path.isdir) -> List[Path]:
    home = home if home is not None else os.path.expanduser("~")
    out = [Path(home) / "Applications" / APP_NAME]
    repo = repo_dir(plugin_dir, isdir)
    if repo is not None:
        out.append(repo / "build" / APP_NAME)
    return out


def resolve_tracker_app(home: Optional[str] = None, plugin_dir: Path = HERE,
                        isdir: Callable[[str], bool] = os.path.isdir) -> Optional[Path]:
    """~/Applications/Steady Tracker.app if it exists, else <repo>/build/Steady Tracker.app, else None."""
    for p in candidate_apps(home, plugin_dir, isdir):
        if isdir(str(p)):
            return p
    return None


def open_command(app: Path, port: int = TRACKER_PORT) -> Tuple[str, List[str]]:
    return OPEN, ["-a", str(app), "--args", "--panel-port", str(port)]


def start_detached(program: str, args: List[str]) -> bool:
    try:
        from PyQt5.QtCore import QProcess
    except ImportError:  # Krita 6
        from PyQt6.QtCore import QProcess  # type: ignore[no-redef]
    res = QProcess.startDetached(program, args)
    # PyQt5 returns bool or (bool, pid) depending on the overload; PyQt6 returns (bool, pid)
    return bool(res[0] if isinstance(res, tuple) else res)


def launch(home: Optional[str] = None, plugin_dir: Path = HERE,
           runner: Callable[[str, List[str]], bool] = start_detached) -> Tuple[bool, str]:
    """(ok, status text for the panel)."""
    app = resolve_tracker_app(home, plugin_dir)
    if app is None:
        return False, INSTALL_HINT
    prog, args = open_command(app)
    try:
        ok = runner(prog, args)
    except Exception as e:  # never raise into Krita
        return False, f"Could not start Steady Tracker: {type(e).__name__}: {e}"
    return (True, "Starting Steady Tracker…") if ok else (False, "Could not start Steady Tracker (open failed).")
