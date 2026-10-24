"""Key combo parsing ("cmd+shift+z", "]", "shift+delete", "f5") → macOS virtual keycodes.

Combos are lowercase, "+"-joined, modifiers first (protocol.ts KeyComboSchema). A bare "+"
is the plus key itself (posted as shift+'=' on an ANSI layout), as is a trailing "+" after
modifiers ("cmd++").
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

# kCGEventFlagMask* values (CoreGraphics CGEventTypes.h)
FLAG_SHIFT = 0x00020000
FLAG_CTRL = 0x00040000
FLAG_ALT = 0x00080000
FLAG_CMD = 0x00100000

MODIFIERS = {
    "cmd": FLAG_CMD,
    "command": FLAG_CMD,
    "meta": FLAG_CMD,
    "ctrl": FLAG_CTRL,
    "control": FLAG_CTRL,
    "alt": FLAG_ALT,
    "opt": FLAG_ALT,
    "option": FLAG_ALT,
    "shift": FLAG_SHIFT,
}

# ANSI US layout virtual keycodes (HIToolbox/Events.h kVK_*)
KEYCODES = {
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "return": 36, "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
    ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50,
    # "delete" = Qt Key_Delete = forward delete (fn+delete on a Mac keyboard). Krita's
    # "Clear" is bound to Del; "backspace" is the key labelled delete on Mac keyboards.
    "backspace": 51, "delete": 117, "forwarddelete": 117, "del": 117,
    "escape": 53, "esc": 53,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "home": 115, "pageup": 116, "end": 119, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "insert": 114,  # kVK_Help; Macs have no Insert key
}

# Characters that need shift on ANSI US.
SHIFTED = {"+": "=", "_": "-", "{": "[", "}": "]", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "|": "\\", "~": "`"}


@dataclass(frozen=True)
class KeyStroke:
    keycode: int
    flags: int
    combo: str


class BadCombo(ValueError):
    pass


def _split(combo: str) -> Tuple[list, str]:
    c = combo.strip().lower()
    if not c:
        raise BadCombo("empty combo")
    if c == "+":
        return [], "+"
    if c.endswith("++"):
        mods = c[:-2].split("+") if len(c) > 2 else []
        return [m for m in mods if m], "+"
    parts = c.split("+")
    return parts[:-1], parts[-1]


def parse_combo(combo: str) -> KeyStroke:
    mods, key = _split(combo)
    flags = 0
    for m in mods:
        if m not in MODIFIERS:
            raise BadCombo(f"unknown modifier {m!r} in {combo!r}")
        flags |= MODIFIERS[m]
    if key in SHIFTED:
        flags |= FLAG_SHIFT
        key = SHIFTED[key]
    if key not in KEYCODES:
        raise BadCombo(f"unknown key {key!r} in {combo!r}")
    return KeyStroke(KEYCODES[key], flags, combo)


def try_parse(combo: str) -> Optional[KeyStroke]:
    try:
        return parse_combo(combo)
    except BadCombo:
        return None
