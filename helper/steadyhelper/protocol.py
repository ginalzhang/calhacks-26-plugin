"""Python-side validation of the Steady wire protocol.

Hand-written mirror of the zod schemas in src/desktop/protocol.ts (the contract).
pytest loads docs/protocol-examples.json and checks every example validates here,
so the TypeScript and Python sides cannot drift silently.

Each validator returns None when the message is valid, else a short error string.
"""

from __future__ import annotations

import uuid
from typing import Any, Callable, Dict, Optional

Msg = Dict[str, Any]
Check = Callable[[Any], bool]


def new_id() -> str:
    return str(uuid.uuid4())


# --- primitive checks ---------------------------------------------------------

def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _str(v: Any) -> bool:
    return isinstance(v, str)


def _bool(v: Any) -> bool:
    return isinstance(v, bool)


def _rect(v: Any) -> bool:
    return isinstance(v, dict) and all(_num(v.get(k)) for k in ("x", "y", "w", "h"))


def _rect_or_null(v: Any) -> bool:
    return v is None or _rect(v)


def _enum(*values: str) -> Check:
    return lambda v: v in values


def _str_list(v: Any) -> bool:
    return isinstance(v, list) and all(_str(x) for x in v)


def _screen(v: Any) -> bool:
    return isinstance(v, dict) and all(_num(v.get(k)) for k in ("w", "h", "scale"))


# (required fields, optional fields)
Spec = tuple


def _check(msg: Msg, required: Dict[str, Check], optional: Optional[Dict[str, Check]] = None) -> Optional[str]:
    for k, fn in required.items():
        if k not in msg:
            return f"missing field {k!r}"
        if not fn(msg[k]):
            return f"bad field {k!r}"
    for k, fn in (optional or {}).items():
        if k in msg and msg[k] is not None and not fn(msg[k]):
            return f"bad field {k!r}"
        if k in msg and msg[k] is None:
            # zod .optional() rejects null
            return f"bad field {k!r} (null)"
    return None


# --- Krita commands (KritaCommandSchema) --------------------------------------

KRITA_COMMANDS: Dict[str, Spec] = {
    "action": ({"action": _str}, {}),
    "color": ({"hex": _str}, {}),
    "color_adjust": ({"dv": _num}, {}),
    "size": ({}, {"value": _num, "delta": _num}),
    "opacity": ({"value": _num}, {}),
    "preset": ({"name": _str}, {}),
    "new_layer": ({}, {"name": _str}),
    "layer_nav": ({"dir": _enum("up", "down")}, {}),
    "layer_visible": ({"visible": _bool}, {}),
    "canvas_rect": ({}, {}),
    "window_rect": ({}, {}),
    "list_actions": ({}, {}),
    "list_presets": ({}, {}),
    "smoothing": ({"mode": _enum("none", "simple", "weighted", "stabilizer")}, {}),
    "clear_shortcuts": ({"keys": _str_list}, {}),
    "session_init": ({"keys": _str_list}, {}),
    "get_state": ({}, {}),
    "ping": ({}, {}),
}


def validate_krita_command(msg: Msg) -> Optional[str]:
    cmd = msg.get("cmd")
    if cmd not in KRITA_COMMANDS:
        return f"unknown cmd {cmd!r}"
    req, opt = KRITA_COMMANDS[cmd]
    return _check(msg, req, opt)


# --- Worker → helper -----------------------------------------------------------

WORKER_TO_HELPER: Dict[str, Spec] = {
    "move": ({"x": _num, "y": _num}, {}),
    "down": ({}, {}),
    "up": ({}, {"reason": _str}),
    "click": ({"x": _num, "y": _num}, {"reactivate_krita": _bool}),
    "middle_down": ({}, {}),
    "middle_up": ({}, {}),
    "keys": ({"combo": _str}, {}),
    "krita": ({}, {"fallback_keys": _str}),
    "ring": (
        {
            "state": _enum("hover", "drawing", "outside", "lost", "hidden"),
            "progress": _num,
            "x": _num,
            "y": _num,
        },
        {},
    ),
    "ping": ({}, {}),
    "pause": ({}, {}),
    "resume": ({}, {}),
    "chrome_rect": ({"rect": _rect}, {}),
}


def validate_worker_msg(msg: Any) -> Optional[str]:
    if not isinstance(msg, dict):
        return "not an object"
    t = msg.get("t")
    if t not in WORKER_TO_HELPER:
        return f"unknown t {t!r}"
    if not _str(msg.get("id")):
        return "missing id"
    req, opt = WORKER_TO_HELPER[t]
    err = _check(msg, req, opt)
    if err:
        return err
    if t == "krita":
        return validate_krita_command(msg)
    return None


# --- helper → Worker -----------------------------------------------------------

ERROR_CODES = ("permission", "bad_message", "krita_not_running", "plugin_down", "paused", "outside_chrome", "internal")
HOTKEYS = ("pen", "pause", "ptt_down", "ptt_up", "undo", "redo", "recenter", "other_hand", "latch")

HELPER_TO_WORKER: Dict[str, Spec] = {
    "hello": (
        {
            "version": _str,
            "screen": _screen,
            "accessibility": _bool,
            "input_monitoring": _bool,
            "krita": _bool,
            "krita_running": _bool,
            "krita_window_rect": _rect_or_null,
            "paused": _bool,
        },
        {},
    ),
    "krita_window_rect": ({"rect": _rect_or_null, "frontmost": _bool}, {}),
    "hotkey": ({"key": _enum(*HOTKEYS)}, {}),
    "krita_reply": ({"ok": _bool}, {"error": _str, "via": _enum("plugin", "keys")}),
    "error": (
        {"code": _enum(*ERROR_CODES)},
        {"which": _enum("accessibility", "input_monitoring"), "message": _str},
    ),
    "krita_state": ({"connected": _bool}, {}),
    "pong": ({}, {}),
    "ack": ({"ok": _bool}, {"error": _str}),
    "warning": ({"code": _str, "message": _str}, {}),
}

#: Known warning codes (protocol.ts types `code` as a plain string).
WARNING_CODES = ("dwell_control", "head_pointer", "voice_control", "tablet", "overlay_disabled")


def validate_helper_msg(msg: Any) -> Optional[str]:
    if not isinstance(msg, dict):
        return "not an object"
    t = msg.get("t")
    if t not in HELPER_TO_WORKER:
        return f"unknown t {t!r}"
    if not _str(msg.get("id")):
        return "missing id"
    req, opt = HELPER_TO_WORKER[t]
    return _check(msg, req, opt)


# --- helper ↔ plugin -------------------------------------------------------------

def validate_plugin_request(msg: Any) -> Optional[str]:
    if not isinstance(msg, dict):
        return "not an object"
    if not _str(msg.get("id")):
        return "missing id"
    return validate_krita_command(msg)


def validate_plugin_reply(msg: Any) -> Optional[str]:
    if not isinstance(msg, dict):
        return "not an object"
    if not _str(msg.get("id")):
        return "missing id"
    return _check(msg, {"ok": _bool}, {"error": _str})


def plugin_request_from_krita_msg(msg: Msg) -> Msg:
    """`krita` message → plugin request line: drop `t` and `fallback_keys`, keep `id`."""
    return {k: v for k, v in msg.items() if k not in ("t", "fallback_keys")}


# --- builders (helper → Worker) ------------------------------------------------------

def hello(**fields: Any) -> Msg:
    return {"t": "hello", "id": new_id(), **fields}


def pong(req_id: str) -> Msg:
    return {"t": "pong", "id": req_id}


def ack(req_id: str, ok: bool = True, error: Optional[str] = None) -> Msg:
    m: Msg = {"t": "ack", "id": req_id, "ok": ok}
    if error is not None:
        m["error"] = error
    return m


def error(req_id: Optional[str], code: str, message: Optional[str] = None, **extra: Any) -> Msg:
    m: Msg = {"t": "error", "id": req_id or new_id(), "code": code}
    if message is not None:
        m["message"] = message
    m.update({k: v for k, v in extra.items() if v is not None})
    return m


def hotkey(name: str) -> Msg:
    return {"t": "hotkey", "id": new_id(), "key": name}


def krita_state(connected: bool) -> Msg:
    return {"t": "krita_state", "id": new_id(), "connected": connected}


def krita_window_rect(rect: Optional[Msg], frontmost: bool) -> Msg:
    return {"t": "krita_window_rect", "id": new_id(), "rect": rect, "frontmost": frontmost}


def warning(code: str, message: str) -> Msg:
    return {"t": "warning", "id": new_id(), "code": code, "message": message}


def krita_reply(req_id: str, ok: bool, via: Optional[str] = None, error: Optional[str] = None, **payload: Any) -> Msg:
    m: Msg = {"t": "krita_reply"}
    m.update({k: v for k, v in payload.items() if k not in ("t", "id", "ok", "error", "via")})
    m["id"] = req_id
    m["ok"] = ok
    if via is not None:
        m["via"] = via
    if error is not None:
        m["error"] = error
    return m
