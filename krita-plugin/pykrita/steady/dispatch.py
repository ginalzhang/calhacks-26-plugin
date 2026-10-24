"""Steady Krita plugin: the pure command dispatcher.

`dispatch(cmd, krita)` turns one helper request `{id, cmd, ...}` into one reply
`{id, ok: true, ...}` / `{id, ok: false, error}` (docs/PROTOCOL.md, "helper <-> Krita plugin").

No PyQt and no `krita` import here: everything that touches Krita goes through the
`Adapter` interface below (real implementation: adapter.py; tests: a fake). The function
never raises; an adapter exception becomes `error: "internal"`.
"""
from __future__ import annotations

import colorsys
import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

# Families the browser may ask for (`preset {name}`); matched against whatever presets the
# user's Krita actually has. Never a hard-coded preset name.
PRESET_FAMILIES = ("basic", "pencil", "ink", "airbrush", "eraser")

# Verified in Krita 5.3.4's bundled share/krita/actions/krita.action (see DECISIONS.md, Agent D).
SMOOTHING_ACTIONS = {
    "none": "set_no_brush_smoothing",
    "simple": "set_simple_brush_smoothing",
    "weighted": "set_weighted_brush_smoothing",
    "stabilizer": "set_stabilizer_brush_smoothing",
}
ERASE_ACTION = "erase_action"
BRUSH_TOOL_ACTION = "KritaShape/KisToolBrush"

SIZE_MIN, SIZE_MAX = 1.0, 1000.0
TESTED_KRITA = "5.3"

_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


# ---------------------------------------------------------------------------
# Session state (once per Krita process; lives on the adapter, which is created once)
# ---------------------------------------------------------------------------


@dataclass
class Session:
    # "untouched" -> "pending" (session_init seen, no view yet) -> "done" (applied once, never again)
    smoothing: str = "untouched"
    inits: int = 0


class Adapter:
    """Everything dispatch needs from Krita. adapter.KritaAdapter implements it for real."""

    session: Session

    def version(self) -> str: raise NotImplementedError
    def has_view(self) -> bool: raise NotImplementedError
    # actions
    def trigger_action(self, name: str) -> str: raise NotImplementedError  # "ok" | "unknown" | "disabled"
    def action_checked(self, name: str) -> Optional[bool]: raise NotImplementedError  # None if not checkable/absent
    def list_actions(self) -> List[Dict[str, str]]: raise NotImplementedError
    def clear_shortcuts(self, keys: List[str]) -> List[Dict[str, str]]: raise NotImplementedError
    def apply_smoothing(self, mode: str) -> bool: raise NotImplementedError
    # brush state (need a view)
    def get_color_hex(self) -> str: raise NotImplementedError
    def set_color_hex(self, hex_: str) -> None: raise NotImplementedError
    def get_size(self) -> float: raise NotImplementedError
    def set_size(self, px: float) -> None: raise NotImplementedError
    def get_opacity(self) -> float: raise NotImplementedError  # 0..1
    def set_opacity(self, value01: float) -> None: raise NotImplementedError
    def list_presets(self) -> List[str]: raise NotImplementedError
    def current_preset(self) -> Optional[str]: raise NotImplementedError
    def set_preset(self, name: str) -> bool: raise NotImplementedError
    def eraser_on(self) -> bool: raise NotImplementedError
    def set_eraser(self, on: bool) -> None: raise NotImplementedError
    # layers (need a document)
    def current_layer(self) -> Optional[str]: raise NotImplementedError
    def new_layer(self, name: Optional[str]) -> Optional[str]: raise NotImplementedError
    def layer_nav(self, direction: str) -> Optional[str]: raise NotImplementedError
    def set_layer_visible(self, visible: bool) -> Optional[str]: raise NotImplementedError
    # geometry (global screen points)
    def canvas_rect(self) -> Optional[Dict[str, Any]]: raise NotImplementedError
    def window_rect(self) -> Optional[Dict[str, Any]]: raise NotImplementedError


class CmdError(Exception):
    def __init__(self, code: str, **extra: Any):
        super().__init__(code)
        self.code = code
        self.extra = extra


# ---------------------------------------------------------------------------
# Pure helpers (tested directly)
# ---------------------------------------------------------------------------


def valid_hex(value: Any) -> bool:
    return isinstance(value, str) and bool(_HEX_RE.match(value))


def adjust_value(hex_: str, dv: float) -> str:
    """Shift the HSV value of `#rrggbb` by dv (fraction of full scale), clamped."""
    r, g, b = (int(hex_[i : i + 2], 16) / 255.0 for i in (1, 3, 5))
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    v = min(1.0, max(0.0, v + dv))
    r, g, b = colorsys.hsv_to_rgb(h, s, v)
    return "#{:02x}{:02x}{:02x}".format(*(int(round(c * 255)) for c in (r, g, b)))


def strip_mnemonic(text: str) -> str:
    """Qt action text "&Merge with Layer Below" -> "Merge with Layer Below" ("&&" -> "&")."""
    return re.sub(r"&(.)", r"\1", text or "").strip()


_PREFIX_RE = re.compile(r"^\s*[a-z0-9]{1,2}\)\s*")


def _tokens(name: str) -> List[str]:
    return re.findall(r"[a-z]+|\d+", _PREFIX_RE.sub("", name.lower()))


def match_preset(query: str, presets: List[str]) -> Optional[str]:
    """Pick a preset for a family keyword (or an alias's stored name) from the installed list.

    1. exact name (case-insensitive) wins (aliases store a real preset name);
    2. every query word must prefix-match a word of the preset name; eraser presets are
       excluded unless the query itself asks for an eraser; best = keyword earliest in the
       name, then shortest name, then alphabetical (deterministic);
    3. no match -> None.
    """
    q = (query or "").strip().lower()
    if not q:
        return None
    for p in presets:
        if p.strip().lower() == q:
            return p
    qtoks = re.findall(r"[a-z]+|\d+", q)
    if not qtoks:
        return None
    wants_eraser = any(t.startswith("eras") for t in qtoks)
    scored = []
    for p in presets:
        toks = _tokens(p)
        if not wants_eraser and any(t.startswith("eras") for t in toks):
            continue
        positions = []
        for qt in qtoks:
            pos = next((i for i, t in enumerate(toks) if t.startswith(qt)), None)
            if pos is None:
                break
            positions.append(pos)
        else:
            scored.append((min(positions), len(p), p.lower(), p))
    if not scored:
        return None
    scored.sort()
    return scored[0][3]


_MOD_MAP = {"cmd": "Ctrl", "command": "Ctrl", "ctrl": "Meta", "control": "Meta", "alt": "Alt",
            "option": "Alt", "opt": "Alt", "shift": "Shift"}
_KEY_MAP = {"delete": "Del", "del": "Del", "backspace": "Backspace", "insert": "Ins", "esc": "Esc",
            "escape": "Esc", "space": "Space", "tab": "Tab", "enter": "Return", "return": "Return",
            "home": "Home", "end": "End", "pageup": "PgUp", "pagedown": "PgDown", "plus": "+",
            "minus": "-", "left": "Left", "right": "Right", "up": "Up", "down": "Down"}
_MOD_ORDER = ["Ctrl", "Shift", "Alt", "Meta"]


def key_to_portable(key: str) -> str:
    """Steady key combo ("f5", "cmd+shift+z") -> Qt PortableText ("F5", "Ctrl+Shift+Z").

    On macOS Qt's "Ctrl" is the Command key and "Meta" is Control.
    """
    k = (key or "").strip().lower()
    if k == "+":
        parts = ["+"]
    elif k.endswith("++"):
        parts = [p for p in k[:-2].split("+") if p] + ["+"]
    else:
        parts = [p for p in k.split("+") if p]
    if not parts:
        return ""
    mods, base = parts[:-1], parts[-1]
    qmods = sorted({_MOD_MAP.get(m, m.capitalize()) for m in mods}, key=lambda m: _MOD_ORDER.index(m) if m in _MOD_ORDER else 9)
    if re.fullmatch(r"f\d{1,2}", base):
        qbase = base.upper()
    elif base in _KEY_MAP:
        qbase = _KEY_MAP[base]
    elif len(base) == 1:
        qbase = base.upper()
    else:
        qbase = base.capitalize()
    return "+".join(qmods + [qbase])


def shortcut_targets(keys: List[str]) -> Dict[str, str]:
    """{lowercased Qt PortableText: Steady key} for the keys Steady owns."""
    out: Dict[str, str] = {}
    for k in keys:
        p = key_to_portable(k)
        if p:
            out[p.lower()] = k
    return out


def split_shortcuts(portables: List[str], targets: Dict[str, str]) -> "tuple[List[int], List[str]]":
    """Given an action's shortcuts (PortableText), return (indexes to keep, Steady keys hit)."""
    keep, hit = [], []
    for i, p in enumerate(portables):
        k = targets.get((p or "").lower())
        if k is None:
            keep.append(i)
        else:
            hit.append(k)
    return keep, hit


def _num(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _need_view(krita: Adapter) -> None:
    if not krita.has_view():
        raise CmdError("no_view")


def _clear_eraser(krita: Adapter) -> bool:
    if krita.eraser_on():
        krita.set_eraser(False)
        return True
    return False


def _try_pending_smoothing(krita: Adapter) -> bool:
    s = krita.session
    if s.smoothing == "pending" and krita.has_view() and krita.apply_smoothing("none"):
        s.smoothing = "done"
        return True
    return False


def _version_warning(version: str) -> Optional[str]:
    if version and not version.startswith(TESTED_KRITA):
        return f"Krita {version} detected; Steady is tested on Krita {TESTED_KRITA}.x"
    return None


# ---------------------------------------------------------------------------
# Command handlers: (cmd, krita) -> payload dict (ok:true implied) or raise CmdError
# ---------------------------------------------------------------------------


def _h_action(c: dict, k: Adapter) -> dict:
    name = c.get("action")
    if not isinstance(name, str) or not name:
        raise CmdError("bad_args", message="action must be a Krita action id")
    status = k.trigger_action(name)
    if status == "unknown":
        raise CmdError("unknown_action", action=name)
    if status == "disabled":
        raise CmdError("action_disabled", action=name)
    out: dict = {}
    checked = k.action_checked(name)
    if checked is not None:
        out["checked"] = checked
    return out


def _h_color(c: dict, k: Adapter) -> dict:
    hex_ = c.get("hex")
    if not valid_hex(hex_):
        raise CmdError("bad_hex")
    _need_view(k)
    k.set_color_hex(hex_.lower())
    return {"color": hex_.lower()}


def _h_color_adjust(c: dict, k: Adapter) -> dict:
    dv = c.get("dv")
    if not _num(dv) or not -1.0 <= dv <= 1.0:
        raise CmdError("bad_args", message="dv must be a number in -1..1")
    _need_view(k)
    new = adjust_value(k.get_color_hex(), float(dv))
    k.set_color_hex(new)
    return {"color": new}


def _h_size(c: dict, k: Adapter) -> dict:
    value, delta = c.get("value"), c.get("delta")
    has_v, has_d = value is not None, delta is not None
    if has_v == has_d or (has_v and not _num(value)) or (has_d and not _num(delta)):
        raise CmdError("bad_args", message="exactly one of value/delta (number)")
    _need_view(k)
    target = float(value) if has_v else k.get_size() + float(delta)
    k.set_size(min(SIZE_MAX, max(SIZE_MIN, target)))
    return {"size": round(k.get_size(), 1)}


def _h_opacity(c: dict, k: Adapter) -> dict:
    value = c.get("value")
    if not _num(value):
        raise CmdError("bad_args", message="value must be a number 0..100")
    _need_view(k)
    k.set_opacity(min(100.0, max(0.0, float(value))) / 100.0)
    return {"opacity": round(k.get_opacity() * 100)}


def _h_preset(c: dict, k: Adapter) -> dict:
    name = c.get("name")
    if not isinstance(name, str) or not name.strip():
        raise CmdError("bad_args", message="name must be a family keyword or preset name")
    _need_view(k)
    match = match_preset(name, k.list_presets())
    if match is None:
        raise CmdError("no_preset", name=name)
    if not k.set_preset(match):
        raise CmdError("no_preset", name=name)
    # Krita keeps eraser mode across preset changes; choosing a brush always paints.
    cleared = _clear_eraser(k)
    return {"preset": match, "eraser_cleared": cleared}


def _h_new_layer(c: dict, k: Adapter) -> dict:
    name = c.get("name")
    if name is not None and not isinstance(name, str):
        raise CmdError("bad_args", message="name must be a string")
    _need_view(k)
    layer = k.new_layer(name or None)
    if layer is None:
        raise CmdError("no_view")
    return {"layer": layer}


def _h_layer_nav(c: dict, k: Adapter) -> dict:
    d = c.get("dir")
    if d not in ("up", "down"):
        raise CmdError("bad_args", message="dir must be up|down")
    _need_view(k)
    layer = k.layer_nav(d)
    if layer is None:
        raise CmdError("no_layer")
    return {"layer": layer}


def _h_layer_visible(c: dict, k: Adapter) -> dict:
    v = c.get("visible")
    if not isinstance(v, bool):
        raise CmdError("bad_args", message="visible must be a boolean")
    _need_view(k)
    layer = k.set_layer_visible(v)
    if layer is None:
        raise CmdError("no_layer")
    return {"layer": layer, "visible": v}


def _h_canvas_rect(c: dict, k: Adapter) -> dict:
    if not k.has_view():
        # The browser treats no_canvas_rect as "fall back to corner marking".
        raise CmdError("no_canvas_rect", reason="no_view")
    rect = k.canvas_rect()
    if not rect:
        raise CmdError("no_canvas_rect")
    rect = dict(rect)
    out = {"rect": {key: rect[key] for key in ("x", "y", "w", "h")}}
    if rect.get("widget_class"):
        out["widget_class"] = rect["widget_class"]
    return out


def _h_window_rect(c: dict, k: Adapter) -> dict:
    rect = k.window_rect()
    if not rect:
        raise CmdError("no_window")
    return {"rect": {key: rect[key] for key in ("x", "y", "w", "h")}}


def _h_list_actions(c: dict, k: Adapter) -> dict:
    return {"actions": k.list_actions()}


def _h_list_presets(c: dict, k: Adapter) -> dict:
    return {"presets": sorted(k.list_presets(), key=str.lower)}


def _h_smoothing(c: dict, k: Adapter) -> dict:
    mode = c.get("mode")
    if mode not in SMOOTHING_ACTIONS:
        raise CmdError("bad_args", message="mode must be none|simple|weighted|stabilizer")
    _need_view(k)
    if not k.apply_smoothing(mode):
        raise CmdError("action_disabled", action=SMOOTHING_ACTIONS[mode])
    if mode != "none" or k.session.smoothing == "pending":
        # An explicit user choice ends any pending one-time switch to None.
        k.session.smoothing = "done"
    return {"mode": mode}


def _keys_arg(c: dict) -> List[str]:
    keys = c.get("keys")
    if not isinstance(keys, list) or not all(isinstance(x, str) and x for x in keys):
        raise CmdError("bad_args", message="keys must be a list of key combos")
    return keys


def _h_clear_shortcuts(c: dict, k: Adapter) -> dict:
    return {"cleared": k.clear_shortcuts(_keys_arg(c))}


def _h_session_init(c: dict, k: Adapter) -> dict:
    keys = _keys_arg(c)
    s = k.session
    s.inits += 1
    changed = False
    if s.smoothing == "untouched":
        s.smoothing = "pending"  # once per Krita process; never re-armed
    if s.smoothing == "pending":
        changed = _try_pending_smoothing(k)
    out = {
        "smoothing_changed": changed,
        "cleared": k.clear_shortcuts(keys),  # idempotent: a second call clears nothing new
        "krita_version": k.version(),
    }
    if s.smoothing == "pending":
        out["smoothing_pending"] = True  # no document yet; applied with the first command that has one
    warn = _version_warning(out["krita_version"])
    if warn:
        out["warning"] = warn
    return out


def _h_get_state(c: dict, k: Adapter) -> dict:
    _need_view(k)
    return {
        "preset": k.current_preset(),
        "size": round(k.get_size(), 1),
        "opacity": round(k.get_opacity() * 100),
        "color": k.get_color_hex(),
        "eraser": bool(k.eraser_on()),
        "layer": k.current_layer(),
    }


def _h_ping(c: dict, k: Adapter) -> dict:
    return {}


HANDLERS: Dict[str, Callable[[dict, Adapter], dict]] = {
    "action": _h_action,
    "color": _h_color,
    "color_adjust": _h_color_adjust,
    "size": _h_size,
    "opacity": _h_opacity,
    "preset": _h_preset,
    "new_layer": _h_new_layer,
    "layer_nav": _h_layer_nav,
    "layer_visible": _h_layer_visible,
    "canvas_rect": _h_canvas_rect,
    "window_rect": _h_window_rect,
    "list_actions": _h_list_actions,
    "list_presets": _h_list_presets,
    "smoothing": _h_smoothing,
    "clear_shortcuts": _h_clear_shortcuts,
    "session_init": _h_session_init,
    "get_state": _h_get_state,
    "ping": _h_ping,
}


def dispatch(cmd: Any, krita: Adapter) -> dict:
    """One request -> one reply. Never raises."""
    if not isinstance(cmd, dict):
        return {"id": "", "ok": False, "error": "bad_args", "message": "request must be a JSON object"}
    rid = cmd.get("id", "")
    name = cmd.get("cmd")
    handler = HANDLERS.get(name) if isinstance(name, str) else None
    if handler is None:
        return {"id": rid, "ok": False, "error": "unknown_cmd", "cmd": name if isinstance(name, str) else None}
    try:
        payload = handler(cmd, krita)
        reply = {"id": rid, "ok": True}
        reply.update(payload)
        if name not in ("session_init", "smoothing", "ping") and _try_pending_smoothing(krita):
            reply["smoothing_changed"] = True  # deferred one-time switch to None happened now
        return reply
    except CmdError as e:
        reply = {"id": rid, "ok": False, "error": e.code}
        reply.update(e.extra)
        return reply
    except Exception as e:  # never raise into Krita
        return {"id": rid, "ok": False, "error": "internal", "message": f"{type(e).__name__}: {e}"}
