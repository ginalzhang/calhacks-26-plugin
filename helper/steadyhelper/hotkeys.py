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
from .keys import FLAG_ALT, FLAG_CMD, FLAG_CTRL, FLAG_SHIFT, try_parse

log = logging.getLogger("steady.hotkeys")


#: Modifier bits compared when matching a key (cmd/ctrl/alt/shift). Fn and numeric-pad bits
#: are ignored (macOS sets Fn on every F-key event).
MODIFIER_MASK = FLAG_CMD | FLAG_CTRL | FLAG_ALT | FLAG_SHIFT

Keymap = Dict[Tuple[int, int], str]


def default_keycode_map() -> Keymap:
    """(keycode, modifier flags) → action name ("pen", "pause", "ptt", ...)."""
    return {(FKEY_KEYCODES[k], 0): name for k, name in DEFAULT_HOTKEYS.items()}


class BadKeymap(ValueError):
    pass


#: `keymap` values allowed from the Worker (`ptt_down` names the push-to-talk key; `ptt_up`
#: is not a key of its own: it is sent when the PTT key is released).
KEYMAP_NAMES = ("pen", "pause", "ptt_down", "undo", "redo", "recenter", "other_hand", "latch")


def build_keymap(mapping: Dict[str, str]) -> Keymap:
    """Worker `keymap.map` ({combo: hotkeyName}) → router keymap. Raises BadKeymap on an
    unparseable combo, a combo that duplicates another after normalisation ("F8" vs "f8",
    "command+z" vs "cmd+z"), a modifier-only combo or a name that is not a key action."""
    if not isinstance(mapping, dict):
        raise BadKeymap("map must be an object")
    out: Keymap = {}
    for combo, name in mapping.items():
        if name not in KEYMAP_NAMES:
            raise BadKeymap(f"{name!r} cannot be bound to a key")
        stroke = try_parse(str(combo))
        if stroke is None:
            raise BadKeymap(f"unknown combo {combo!r}")
        key = (stroke.keycode, stroke.flags & MODIFIER_MASK)
        if key in out:
            raise BadKeymap(f"duplicate combo {combo!r}")
        out[key] = "ptt" if name == "ptt_down" else name
    return out


def is_target_app(bundle_id: Optional[str], app_bundle: str = KRITA_BUNDLE_ID) -> bool:
    """Keys are consumed only while the drawing app (Krita by default) or Chrome is frontmost."""
    return bundle_id == app_bundle or bundle_id in CHROME_BUNDLE_IDS


class HotkeyRouter:
    def __init__(
        self,
        emit: Callable[[str], None],
        frontmost: Callable[[], Optional[str]],
        has_client: Callable[[], bool],
        keymap: Optional[Keymap] = None,
        app_bundle: str = KRITA_BUNDLE_ID,
    ) -> None:
        self.app_bundle = app_bundle
        self._emit = emit
        self._frontmost = frontmost
        self._has_client = has_client
        self.keymap = keymap if keymap is not None else default_keycode_map()
        #: keycode → the action name its consumed key-down was matched to. A key-up is matched
        #: by keycode only (modifiers may already be released; the map may have changed).
        self._held: Dict[int, str] = {}

    def set_keymap(self, keymap: Keymap) -> None:
        self.keymap = dict(keymap)  # atomic swap; held keys still get their key-up consumed

    def handle(
        self, keycode: int, is_down: bool, is_repeat: bool = False, flags: int = 0
    ) -> Tuple[bool, List[str]]:
        """Returns (consume, emitted hotkey names)."""
        if not is_down:
            name = self._held.pop(keycode, None)
            if name is None:
                return False, []
            emitted = ["ptt_up"] if name == "ptt" else []
            for e in emitted:
                self._emit(e)
            return True, emitted
        # key down
        if keycode in self._held:
            return True, []  # auto-repeat of a consumed key
        name = self.keymap.get((keycode, flags & MODIFIER_MASK))
        if name is None:
            return False, []
        if not self._has_client():
            return False, []
        try:
            front = self._frontmost()
        except Exception:
            log.exception("frontmost lookup failed")
            front = None
        if not is_target_app(front, self.app_bundle):
            return False, []
        self._held[keycode] = name
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
            flags = int(Quartz.CGEventGetFlags(event))
            consume, _ = router.handle(keycode, event_type == Quartz.kCGEventKeyDown, repeat, flags)
            return None if consume else event
        except Exception:
            log.exception("hotkey intercept failed; passing key through")
            return event

    listener = keyboard.Listener(darwin_intercept=intercept)
    listener.daemon = True
    listener.start()
    return listener
