"""Brain `keys` / fallback keys → Krita (same rules as the helper's HelperServer.post_keys):
activate Krita (≤ 150 ms), refuse when Krita is not frontmost, never post with --no-input."""

from __future__ import annotations

import asyncio
import logging
from typing import Callable, Optional, Tuple

from steadyhelper.config import ACTIVATE_POLL_S, ACTIVATE_WAIT_S, KRITA_BUNDLE_ID
from steadyhelper.keys import try_parse

log = logging.getLogger("steady.tracker.keys")


class KeyOutput:
    def __init__(
        self,
        system,
        key_poster,
        *,
        allow: bool = True,
        accessibility: Callable[[], bool] = lambda: True,
        activate_wait: float = ACTIVATE_WAIT_S,
        app_bundle: str = KRITA_BUNDLE_ID,
    ) -> None:
        self.system = system
        self.key_poster = key_poster
        self.allow = allow
        self._accessibility = accessibility
        self.activate_wait = activate_wait
        self.app_bundle = app_bundle

    def _front(self) -> Optional[str]:
        try:
            self.system.pump()
            return self.system.frontmost_bundle_id()
        except Exception:
            log.exception("frontmost lookup failed")
            return None

    async def post(self, combo: str) -> Tuple[bool, Optional[str]]:
        if not self.allow:
            return False, "input_disabled"
        stroke = try_parse(combo)
        if stroke is None:
            return False, "bad_combo"
        if not self._accessibility():
            return False, "permission"
        if self.system.krita_pid() is None:
            return False, "krita_not_running"
        if self._front() != self.app_bundle:
            self.system.activate_krita()
            loop = asyncio.get_running_loop()
            deadline = loop.time() + self.activate_wait
            while self._front() != self.app_bundle and loop.time() < deadline:
                await asyncio.sleep(ACTIVATE_POLL_S)
            if self._front() != self.app_bundle:
                return False, "krita_not_frontmost"
        self.key_poster.post(stroke)
        return True, None
