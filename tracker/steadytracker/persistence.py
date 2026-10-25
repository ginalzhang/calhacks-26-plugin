"""~/Library/Application Support/Steady/: settings.json, calibration.json, profiles.json, aliases.json,
tracker.json (tracker-only prefs: chosen camera name).

Writes are atomic (tmp + rename). A corrupt or missing file reads as empty; nothing here raises.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from typing import Any, Dict, Optional

log = logging.getLogger("steady.tracker.store")

FILES = ("settings", "calibration", "profiles", "aliases", "tracker")


def deep_merge(base: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    """Partial<SteadySettings> merge: nested objects (inputs, keymap, stickerRange) merge key by key."""
    out = dict(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


class Store:
    def __init__(self, directory: str) -> None:
        self.dir = directory
        self._lock = threading.Lock()

    def path(self, name: str) -> str:
        return os.path.join(self.dir, f"{name}.json")

    def load(self, name: str) -> Dict[str, Any]:
        try:
            with open(self.path(name), "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except FileNotFoundError:
            return {}
        except (OSError, ValueError):
            log.warning("could not read %s; starting empty", self.path(name))
            return {}

    def save(self, name: str, data: Dict[str, Any]) -> bool:
        with self._lock:
            try:
                os.makedirs(self.dir, exist_ok=True)
                fd, tmp = tempfile.mkstemp(prefix=f".{name}.", dir=self.dir)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2, sort_keys=True)
                os.replace(tmp, self.path(name))
                return True
            except OSError:
                log.exception("could not write %s", self.path(name))
                return False

    # -- typed helpers ------------------------------------------------------------------------
    def settings(self) -> Dict[str, Any]:
        return self.load("settings")

    def merge_settings(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        merged = deep_merge(self.settings(), patch or {})
        self.save("settings", merged)
        return merged

    def calibrations(self) -> Dict[str, Any]:
        """Record<"Left"|"Right", Calibration>."""
        return self.load("calibration")

    def save_calibration(self, cal: Dict[str, Any]) -> None:
        hand = cal.get("handedness") if cal.get("handedness") in ("Left", "Right") else "Right"
        data = self.calibrations()
        data[hand] = cal
        self.save("calibration", data)

    def latest_calibration(self) -> Optional[Dict[str, Any]]:
        """The most recently created calibration (either hand), for brain `init`."""
        cals = [c for k, c in self.calibrations().items() if k in ("Left", "Right") and isinstance(c, dict)]
        if not cals:
            return None
        return max(cals, key=lambda c: c.get("createdAt") or 0)

    def aliases(self) -> Dict[str, str]:
        return {str(k): str(v) for k, v in self.load("aliases").items()}

    def profiles(self) -> Dict[str, Any]:
        return self.load("profiles")

    def tracker_prefs(self) -> Dict[str, Any]:
        return self.load("tracker")

    def set_tracker_pref(self, key: str, value: Any) -> None:
        data = self.tracker_prefs()
        data[key] = value
        self.save("tracker", data)
