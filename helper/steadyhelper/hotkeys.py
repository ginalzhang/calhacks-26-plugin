"""Global hotkeys (§4): F3–F10 → `hotkey` messages, consumed only while Krita or Chrome is frontmost.

`HotkeyRouter.handle()` is pure decision logic (tested). `start_listener()` wires it to a
pynput keyboard Listener with `darwin_intercept` (a CGEventTap with kCGEventTapOptionDefault):
returning None from the intercept swallows the event so Krita never also sees the key.

Rules:
- Consumed (and emitted) only when a Worker is connected AND the frontmost app is Krita or
  Chrome. Otherwise the key passes through untouched and nothing is emitted (other apps are
  untouched; with no Worker connected the page's own keydown handler owns the keys).
- Key-up of a key whose key-down was consumed is always consumed (no orphan key-ups).
- Auto-repeat key-downs are consumed but emit nothing. F10 emits ptt_down on press and
  ptt_up on release; the other keys emit on press only.
- Events posted by this process are ignored (passed through).
"""

from __future__ import annotations

import logging
from typing import Callable, Dict, List, Optional, Set, Tuple

from .config import CHROME_BUNDLE_IDS, DEFAULT_HOTKEYS, FKEY_KEYCODES, KRITA_BUNDLE_ID

log = logging.getLogger("steady.hotkeys")


def default_keycode_map() -> Dict[int, str]:
    """keycode → action name ("pen", "pause", "ptt", ...)."""
    return {FKEY_KEYCODES[k]: name for k, name in DEFAULT_HOTKEYS.items()}


def is_target_app(bundle_id: Optional[str]) -> bool:
    return bundle_id == KRITA_BUNDLE_ID or bundle_id in CHROME_BUNDLE_IDS


class HotkeyRouter:
    def __init__(
        self,
        emit: Callable[[str], None],
        frontmost: Callable[[], Optional[str]],
        has_client: Callable[[], bool],
        keymap: Optional[Dict[int, str]] = None,
    ) -> None:
        self._emit = emit
        self._frontmost = frontmost
        self._has_client = has_client
        self.keymap = keymap if keymap is not None else default_keycode_map()
        self._held: Set[int] = set()  # keycodes whose key-down we consumed

    def handle(self, keycode: int, is_down: bool, is_repeat: bool = False) -> Tuple[bool, List[str]]:
        """Returns (consume, emitted hotkey names)."""
        name = self.keymap.get(keycode)
        if name is None:
            return False, []
        if not is_down:
            if keycode not in self._held:
                return False, []
            self._held.discard(keycode)
            emitted = ["ptt_up"] if name == "ptt" else []
            for e in emitted:
                self._emit(e)
            return True, emitted
        # key down
        if keycode in self._held:
            return True, []  # auto-repeat of a consumed key
        if not self._has_client():
            return False, []
        try:
            front = self._frontmost()
        except Exception:
            log.exception("frontmost lookup failed")
            front = None
        if not is_target_app(front):
            return False, []
        self._held.add(keycode)
        if is_repeat:
            return True, []
        emitted = ["ptt_down"] if name == "ptt" else [name]
        for e in emitted:
            self._emit(e)
        return True, emitted


def start_listener(router: HotkeyRouter, own_pid: int):
    """Start the real pynput listener. Returns the listener, or None if unavailable."""
    try:
        import Quartz
        from pynput import keyboard
    except Exception:
        log.exception("pynput/Quartz unavailable; global hotkeys disabled")
        return None

    def intercept(event_type, event):
        try:
            if event_type not in (Quartz.kCGEventKeyDown, Quartz.kCGEventKeyUp):
                return event
            if Quartz.CGEventGetIntegerValueField(event, Quartz.kCGEventSourceUnixProcessID) == own_pid:
                return event
            keycode = int(Quartz.CGEventGetIntegerValueField(event, Quartz.kCGKeyboardEventKeycode))
            repeat = bool(Quartz.CGEventGetIntegerValueField(event, Quartz.kCGKeyboardEventAutorepeat))
            consume, _ = router.handle(keycode, event_type == Quartz.kCGEventKeyDown, repeat)
            return None if consume else event
        except Exception:
            log.exception("hotkey intercept failed; passing key through")
            return event

    listener = keyboard.Listener(darwin_intercept=intercept)
    listener.daemon = True
    listener.start()
    return listener
