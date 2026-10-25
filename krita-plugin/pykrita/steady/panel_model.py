"""Steady panel: the pure parts (no Qt, no krita import), unit-tested in krita-plugin/tests.

* the action table (actions.json, generated from src/actions.ts) and the page layout
* newline-JSON framing and message builders for the panel <-> tracker protocol
  (tracker/PROTOCOL.md section 1, TCP 127.0.0.1:8767)
* PanelModel: what the tracker last told us (state, status, cameras, permissions, dialog, ...)
* PanelController: what a tile press / slider move / typed command sends
* view-model helpers: tile labels, checked state, disabled-by-phase, tracking word, sliders

panel.py (Qt widgets) renders these; tracker_client.py (QTcpSocket) carries the bytes.
"""
from __future__ import annotations

import base64
import json
import re
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

HERE = Path(__file__).resolve().parent
ACTIONS_JSON = HERE / "actions.json"
TRACKER_HOST = "127.0.0.1"
TRACKER_PORT = 8767
MAX_LINE = 4 << 20  # a preview JPEG is ~10 KB of base64; anything near 4 MiB is garbage

# --------------------------------------------------------------------------- privacy (§0 rule 9)
# Sentences 1-2 are the spec / website text verbatim. Adapted for the plugin build (lead decision):
# sentence 3 — no Steady server, and Claude help is OFF by default (user decision 19:10 Sat): nothing goes to
# Anthropic unless the user turns it on; sentence 4 — Steady
# Tracker (not "the helper") owns the sockets and, since it talks to Cartesia and Anthropic itself,
# sends "nothing else" off the machine.
PRIVACY_SENTENCES = (
    "Camera frames never leave this computer; the camera sees the desk, so papers on it are visible to the app, "
    "and processing is local only.",
    "Microphone audio goes to Cartesia only while the mic is open.",
    "Commands are matched on this Mac; nothing goes to Anthropic unless you turn on Claude help, and then only "
    "the text of a command the local grammar can't match (never audio) plus the current tool, preset, size, "
    "opacity, colour, Steadiness and your last three actions.",
    "Steady Tracker and the Krita plugin listen on 127.0.0.1 only and send nothing else off the machine.",
)
PRIVACY_TEXT = " ".join(PRIVACY_SENTENCES)
COACHING_TEXT = (
    "Let your fingers curl loosely. Move from the elbow and shoulder; let the forearm slide; keep the wrist straight."
)
TRACKER_APP_NAME = "Steady Tracker"
INSTALL_HINT = "Install the tracker: run scripts/install-steady.sh"
NOT_RUNNING_HINT = "Steady Tracker is not running. Press Start."

# --------------------------------------------------------------------------- action table


class ActionTable:
    """actions.json: {build_phase, phase_order, colour_hex, actions: [...]}."""

    def __init__(self, doc: Dict[str, Any]) -> None:
        self.build_phase: str = doc.get("build_phase", "P4")
        self.phase_order: List[str] = list(doc.get("phase_order") or ["P0", "P1", "P2a", "P2b", "P3", "P4"])
        self.colour_hex: Dict[str, str] = dict(doc.get("colour_hex") or {})
        self.actions: List[Dict[str, Any]] = list(doc.get("actions") or [])
        self.by_id: Dict[str, Dict[str, Any]] = {a["id"]: a for a in self.actions}

    @classmethod
    def load(cls, path: Optional[Path] = None) -> "ActionTable":
        return cls(json.loads(Path(path or ACTIONS_JSON).read_text(encoding="utf-8")))

    def phase_index(self, phase: str) -> int:
        try:
            return self.phase_order.index(phase)
        except ValueError:
            return len(self.phase_order)

    def tile_available(self, action_id: str) -> bool:
        """A tile whose tilePhase is beyond BUILD_PHASE renders disabled (with its label), never absent."""
        a = self.by_id.get(action_id)
        if a is None:
            return False
        return self.phase_index(a.get("tilePhase") or a.get("phase") or "P0") <= self.phase_index(self.build_phase)

    def colour_of(self, action_id: str) -> Optional[str]:
        if action_id.startswith("colour_"):
            return self.colour_hex.get(action_id[len("colour_"):])
        return None


# Pages, in selector order. The action table's `page` field is the default; like the website
# (Pages.tsx PAGE_LAYOUT) a few tiles move to Presets / Modes / Input / Krita so no page needs a
# smaller tile or gap (§0 rule 6: add pages, never shrink).
PAGES: List[Tuple[str, str]] = [
    ("steady", "Steady"),
    ("presets", "Presets"),
    ("modes", "Modes"),
    ("setup", "Setup"),
    ("input", "Input"),
    ("timing", "Timing"),
    ("krita", "Krita"),
    ("paint", "Paint"),
    ("colour", "Colour"),
    ("view", "View"),
    ("layers", "Layers"),
    ("demo", "Demo"),
]
PAGE_IDS = [p for p, _ in PAGES]
PAGE_OVERRIDES: Dict[str, str] = {
    "preset_sore_joints": "presets",
    "preset_shakes_reaching": "presets",
    "preset_slow_rest": "presets",
    "preset_hard_still": "presets",
    "smoothing_sketch": "modes",
    "smoothing_ink": "modes",
    "smoothing_shade": "modes",
    "hatch_lr": "modes",
    "hatch_down": "modes",
    "hatch_alternate": "modes",
    "stop_hatching": "modes",
    "dash": "modes",
    "repeat": "modes",
    "pick_sticker_colour": "input",
    "lock_exposure": "input",
    "head_mode": "input",
    "eyebrow_lift": "input",
    "app_profile": "krita",
}
# Tiles per row. Presets have long names: one per row, full width.
PAGE_COLUMNS: Dict[str, int] = {"presets": 1, "setup": 2, "input": 2, "krita": 2, "demo": 2}
DEFAULT_COLUMNS = 3
HEADER_COLUMNS = 4
SELECTOR_COLUMNS = 4


def page_of(action: Dict[str, Any]) -> str:
    return PAGE_OVERRIDES.get(action["id"], action.get("page", "dialog"))


def header_actions(table: ActionTable) -> List[Dict[str, Any]]:
    return [a for a in table.actions if a.get("page") == "header"]


def page_actions(table: ActionTable, page: str) -> List[Dict[str, Any]]:
    """Action tiles on `page`, in action-table order. Header and dialog-only rows are never on a page."""
    return [a for a in table.actions if a.get("page") not in ("header", "dialog") and page_of(a) == page]


def columns_for(page: str) -> int:
    return PAGE_COLUMNS.get(page, DEFAULT_COLUMNS)


def longest_word(label: str) -> str:
    words = label.split()
    return max(words, key=len) if words else ""


def wrap_on_spaces(label: str, max_chars: int) -> List[str]:
    """Greedy line breaking that never splits a word (a word longer than max_chars gets its own line)."""
    lines: List[str] = []
    cur = ""
    for w in label.split():
        if not cur:
            cur = w
        elif len(cur) + 1 + len(w) <= max_chars:
            cur += " " + w
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


# --------------------------------------------------------------------------- sliders (§0 rule 6)
class SliderSpec:
    def __init__(self, key: str, label: str, lo: float, hi: float, step: float, tile_step: float,
                 unit: str, page: str, default: float) -> None:
        self.key, self.label, self.lo, self.hi = key, label, lo, hi
        self.step, self.tile_step, self.unit, self.page, self.default = step, tile_step, unit, page, default

    @property
    def scale(self) -> int:
        """QSlider is integer-only: Gain (0.5 steps) is stored ×2."""
        return 2 if self.step < 1 else 1

    def clamp(self, v: float) -> float:
        v = min(self.hi, max(self.lo, v))
        q = round(round(v / self.step) * self.step, 3)
        return int(q) if float(q).is_integer() and self.step >= 1 else q

    def fmt(self, v: Optional[float]) -> str:
        if v is None:
            return "–"
        if self.unit == "ms":
            return f"{int(v)} ms"
        if self.unit == "s":
            return f"{v / 1000:.1f} s"
        if self.unit == "x":
            return f"{float(v):.1f} times"
        return str(int(v))


# Steps: ± tiles move 5 (Steadiness), 50 ms for the dwell holds and Dash pause, 10 ms for Hatch lag
# (its range is only 80–250) and 0.5 s / 5 s for the mic timers (website values: at 50 ms the
# 15–60 s mic limit would need 900 presses). Ranges are the website's (Pages.tsx).
SLIDERS: List[SliderSpec] = [
    SliderSpec("steadiness", "Steadiness", 0, 100, 1, 5, "", "steady", 50),
    SliderSpec("gainOverride", "Gain", 2, 10, 0.5, 0.5, "x", "krita", 3),
    SliderSpec("dwellDownMs", "Pen-down hold", 500, 1500, 50, 50, "ms", "timing", 800),
    SliderSpec("dwellUpMs", "Pen-up hold", 800, 3000, 50, 50, "ms", "timing", 1200),
    SliderSpec("micSilenceMs", "Mic silence", 1000, 8000, 50, 500, "s", "timing", 2000),
    SliderSpec("utteranceEndMs", "Speech end", 250, 1500, 50, 50, "ms", "timing", 450),
    SliderSpec("micCapMs", "Mic limit", 15000, 60000, 50, 5000, "s", "timing", 15000),
    SliderSpec("hatchLagMs", "Hatch lag", 80, 250, 10, 10, "ms", "modes", 120),
    SliderSpec("dashPauseMs", "Dash pause", 100, 600, 50, 50, "ms", "modes", 200),
]
SLIDERS_BY_KEY = {s.key: s for s in SLIDERS}


def sliders_for(page: str) -> List[SliderSpec]:
    return [s for s in SLIDERS if s.page == page]


# Pointer point (Setup/Input): named landmarks first, then every other hand landmark (Advanced).
LANDMARK_NAMES: List[Tuple[int, str]] = [(5, "Index knuckle"), (8, "Fingertip (Precise)"), (9, "Middle knuckle"),
                                         (0, "Wrist")]
LANDMARK_ORDER: List[int] = [n for n, _ in LANDMARK_NAMES] + [i for i in range(21) if i not in (5, 8, 9, 0)]


def landmark_name(i: Any) -> str:
    for n, name in LANDMARK_NAMES:
        if n == i:
            return name
    return f"Point {i}"


def next_landmark(i: Any) -> int:
    try:
        k = LANDMARK_ORDER.index(int(i))
    except (ValueError, TypeError):
        return 5
    return LANDMARK_ORDER[(k + 1) % len(LANDMARK_ORDER)]


# Settings toggles that are not action-table rows (website Setup / Input pages).
# (label, settings path). A dotted path means a nested key: inputs.dwell.
SETTING_TOGGLES: Dict[str, List[Tuple[str, str]]] = {
    "setup": [("Mirror camera", "mirrorCamera"), ("Rotate camera", "rotateCamera")],
    "input": [("Dwell click", "dwellClickEnabled"), ("Click anywhere", "clickAnywhere"), ("Claude help", "claudeFallback"), ("All dwell", "inputs.dwell"), ("Keys", "inputs.keys"),
              ("Camera", "inputs.camera"), ("Voice", "inputs.voice"), ("Always listening", "alwaysListen"), ("Speech replies", "tts"),
              ("Sounds", "earcons")],
}

BUILTIN_PROFILES = ["Steady day", "Shaky day"]
ALWAYS_LISTEN_NOTE = ("Always listening is on: the mic stays open on this Mac, and only when you speak is that audio "
                      "sent to Cartesia.")


def profile_names(state: Dict[str, Any]) -> List[str]:
    """PanelState.profiles (saved profile names, built-ins included), else the two built-ins."""
    names = state.get("profiles")
    if isinstance(names, list):
        out = [str(n) for n in names if isinstance(n, str) and n.strip()]
        if out:
            return out
    return list(BUILTIN_PROFILES)


def get_setting(settings: Dict[str, Any], path: str, default: Any = None) -> Any:
    cur: Any = settings
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return cur


def setting_patch(settings: Dict[str, Any], path: str, value: Any) -> Dict[str, Any]:
    """Partial<SteadySettings> for one (possibly nested) key; nested objects are sent whole."""
    parts = path.split(".")
    if len(parts) == 1:
        return {path: value}
    top = dict(settings.get(parts[0]) or {})
    top[parts[1]] = value
    return {parts[0]: top}


# --------------------------------------------------------------------------- framing


def encode(msg: Dict[str, Any]) -> bytes:
    return (json.dumps(msg, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


class LineFramer:
    """Newline-delimited JSON. feed(bytes) -> complete JSON objects; partial lines are kept."""

    def __init__(self, max_line: int = MAX_LINE) -> None:
        self.buf = b""
        self.max_line = max_line
        self.dropped = 0

    def feed(self, data: bytes) -> List[Dict[str, Any]]:
        self.buf += data
        out: List[Dict[str, Any]] = []
        while True:
            nl = self.buf.find(b"\n")
            if nl < 0:
                if len(self.buf) > self.max_line:  # never grow without bound on a garbage stream
                    self.buf = b""
                    self.dropped += 1
                break
            line, self.buf = self.buf[:nl].strip(), self.buf[nl + 1:]
            if not line:
                continue
            try:
                obj = json.loads(line.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                self.dropped += 1
                continue
            if isinstance(obj, dict) and isinstance(obj.get("t"), str):
                out.append(obj)
            else:
                self.dropped += 1
        return out

    def reset(self) -> None:
        self.buf = b""


class Messages:
    """Builders for every panel -> tracker message (tracker/PROTOCOL.md §1). Requests carry an id."""

    def __init__(self, prefix: str = "p") -> None:
        self.prefix = prefix
        self.n = 0

    def _id(self) -> str:
        self.n += 1
        return f"{self.prefix}{self.n}"

    def hello(self, plugin_version: str, krita_version: str) -> Dict[str, Any]:
        return {"t": "hello", "plugin_version": plugin_version, "krita_version": krita_version}

    def action(self, action: str, variant: Optional[str] = None, arg: Any = None,
               source: str = "tile") -> Dict[str, Any]:
        m: Dict[str, Any] = {"t": "action", "id": self._id(), "action": action, "source": source}
        if variant is not None:
            m["variant"] = variant
        if arg is not None:
            m["arg"] = arg
        return m

    def typed(self, text: str) -> Dict[str, Any]:
        return {"t": "typed", "id": self._id(), "text": text}

    def settings(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        return {"t": "settings", "id": self._id(), "settings": dict(patch)}

    def calibrate(self, steps: Sequence[int] = (1, 2, 3)) -> Dict[str, Any]:
        return {"t": "calibrate", "id": self._id(), "steps": list(steps)}

    def camera(self, index: int) -> Dict[str, Any]:
        return {"t": "camera", "id": self._id(), "index": int(index)}

    def mic(self, on: bool) -> Dict[str, Any]:
        return {"t": "mic", "id": self._id(), "on": bool(on)}

    def panel_rect(self, rect: Optional[Dict[str, int]]) -> Dict[str, Any]:
        return {"t": "panel_rect", "rect": rect}

    def dialog_answer(self, dialog_id: str, answer: str) -> Dict[str, Any]:
        return {"t": "dialog_answer", "id": self._id(), "dialog_id": dialog_id, "answer": answer}

    def quit(self) -> Dict[str, Any]:
        return {"t": "quit", "id": self._id()}


class AckTracker:
    """Remembers sent requests by id until their ack (or a timeout) arrives."""

    def __init__(self, timeout_s: float = 5.0, clock: Callable[[], float] = time.monotonic) -> None:
        self.timeout_s = timeout_s
        self.clock = clock
        self.pending: Dict[str, Tuple[Dict[str, Any], float]] = {}

    def sent(self, msg: Dict[str, Any]) -> None:
        if "id" in msg:
            self.pending[msg["id"]] = (msg, self.clock())

    def acked(self, ack: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """The request this ack answers (None if unknown or already timed out)."""
        item = self.pending.pop(str(ack.get("id", "")), None)
        return item[0] if item else None

    def expire(self) -> List[Dict[str, Any]]:
        now = self.clock()
        late = [k for k, (_, t) in self.pending.items() if now - t > self.timeout_s]
        return [self.pending.pop(k)[0] for k in late]

    def clear(self) -> None:
        self.pending.clear()


def rect_dict(x: float, y: float, w: float, h: float) -> Dict[str, int]:
    """Qt logical pixels == macOS points, so the global rect goes as is (no scaling)."""
    return {"x": int(round(x)), "y": int(round(y)), "w": int(round(w)), "h": int(round(h))}


# --------------------------------------------------------------------------- permissions
SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?"
PERMISSIONS: List[Tuple[str, str, str]] = [
    ("camera", "Camera", "Privacy_Camera"),
    ("microphone", "Microphone", "Privacy_Microphone"),
    ("accessibility", "Accessibility", "Privacy_Accessibility"),
    ("input_monitoring", "Input Monitoring", "Privacy_ListenEvent"),
]
PERMISSION_WHY = {
    "camera": "to see your hand",
    "microphone": "to hear commands while the mic is open",
    "accessibility": "to move the pointer and click",
    "input_monitoring": "to hear the F-keys while Krita is in front",
}


def missing_permissions(perms: Optional[Dict[str, Any]]) -> List[Dict[str, str]]:
    """Exactly what to grant, to which app, with the System Settings deep link. Only keys reported false."""
    if not perms:
        return []
    out = []
    for key, title, anchor in PERMISSIONS:
        if perms.get(key) is False:
            out.append({
                "key": key,
                "title": title,
                "text": (f"{title}: in System Settings › Privacy & Security › {title}, turn on "
                         f"\"{TRACKER_APP_NAME}\" ({PERMISSION_WHY[key]})."),
                "button": f"Open {title} settings",
                "url": SETTINGS_URL + anchor,
            })
    return out


PERMISSIONS_FOOTER = "After turning a switch on, press Stop, then Start, so Steady Tracker picks it up."

# --------------------------------------------------------------------------- dialogs


NUMBERED = re.compile(r"^\s*(\d+[.:)]|one|two|three)\b", re.I)


def dialog_buttons(dialog: Dict[str, Any]) -> List[Tuple[str, str]]:
    """(answer, label) in display order. Confirm: Cancel first (it gets focus), then Confirm.
    Clarify: numbered options, then Cancel."""
    kind = dialog.get("kind")
    opts = [o for o in (dialog.get("options") or []) if isinstance(o, dict) and "id" in o]
    if kind == "confirm":
        return [("cancel", "Cancel"), ("confirm", "Confirm")]  # always "Confirm" (§0 rule 6)
    out = []
    for i, o in enumerate((o for o in opts if o.get("id") != "cancel"), 1):
        label = str(o.get("label") or o["id"])
        if not NUMBERED.match(label):  # the voice side already labels "One: Lighter"
            label = f"{i}. {label}"
        out.append((str(o["id"]), label))
    return out + [("cancel", "Cancel")]


def dialog_focus_answer(dialog: Dict[str, Any]) -> str:
    """Focus moves to Cancel on open (§0 rule 6), for confirm and clarify alike."""
    return "cancel"


# --------------------------------------------------------------------------- model


class PanelModel:
    """Everything the tracker told us. apply(msg) -> set of changed topics."""

    def __init__(self) -> None:
        self.state: Dict[str, Any] = {}
        self.status_text = ""
        self.alert_text = ""
        self.heard: Optional[Dict[str, str]] = None
        self.cameras: List[Dict[str, Any]] = []
        self.camera_selected: Optional[int] = None
        self.permissions: Optional[Dict[str, Any]] = None
        self.dialog: Optional[Dict[str, Any]] = None
        self.preview: Optional[Dict[str, Any]] = None
        self.connected = False

    @property
    def settings(self) -> Dict[str, Any]:
        s = self.state.get("settings")
        return s if isinstance(s, dict) else {}

    def apply(self, msg: Dict[str, Any]) -> set:
        t = msg.get("t")
        if t == "state":
            # PanelState flattened next to "t" (Steady Tracker's panel_server) or nested under "state"
            st = msg.get("state")
            if not isinstance(st, dict):
                st = {k: v for k, v in msg.items() if k != "t"}
            self.state.update(st)  # full or partial PanelState
            return {"state"}
        elif t == "status":
            text = str(msg.get("text") or "")
            if msg.get("level") == "alert":
                self.alert_text = text  # persists until the tracker clears it (empty alert)
            else:
                self.status_text = text
            return {"status"}
        elif t == "heard":
            self.heard = {"text": str(msg.get("text") or ""), "via": str(msg.get("via") or "grammar")}
            return {"heard"}
        elif t == "cameras":
            lst = msg.get("list")
            self.cameras = [c for c in lst if isinstance(c, dict)] if isinstance(lst, list) else []
            self.camera_selected = msg.get("selected")
            return {"cameras"}
        elif t == "permissions":
            self.permissions = {k: msg.get(k) for k, _, _ in PERMISSIONS if k in msg}
            return {"permissions"}
        elif t == "dialog":
            same = self.dialog is not None and msg.get("dialog_id") == self.dialog.get("dialog_id")
            if same and not msg.get("options"):  # brain's pre-dialog_close convention: empty options = closed
                self.dialog = None
            elif msg.get("kind") in ("confirm", "clarify"):
                self.dialog = dict(msg)
            else:  # forward-compatible: {kind:"close"} closes the open dialog (answered by voice/typed)
                self.dialog = None
            return {"dialog"}
        elif t == "dialog_close":
            if self.dialog is None or msg.get("dialog_id") in (None, self.dialog.get("dialog_id")):
                self.dialog = None
            return {"dialog"}
        elif t == "preview":
            self.preview = {"jpeg_b64": msg.get("jpeg_b64") or "", "w": msg.get("w"), "h": msg.get("h")}
            return {"preview"}
        return set()

    def preview_bytes(self) -> Optional[bytes]:
        if not self.preview or not self.preview.get("jpeg_b64"):
            return None
        try:
            return base64.b64decode(self.preview["jpeg_b64"], validate=False)
        except (ValueError, TypeError):
            return None

    def reset_connection(self) -> None:
        """Socket closed: forget live state so nothing stale reads as live."""
        self.connected = False
        self.state = {}
        self.dialog = None
        self.preview = None
        self.alert_text = ""


# --------------------------------------------------------------------------- view-model


class TileView:
    def __init__(self, label: str, checkable: bool, checked: bool, enabled: bool, tooltip: str = "",
                 colour: Optional[str] = None, danger: bool = False, sub: str = "") -> None:
        self.label, self.checkable, self.checked, self.enabled = label, checkable, checked, enabled
        self.tooltip, self.colour, self.danger = tooltip, colour, danger
        self.sub = sub  # second line under the (fixed) label, e.g. Mic › "Listening"

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"TileView({self.label!r}, checkable={self.checkable}, checked={self.checked}, enabled={self.enabled})"


def checked_from_state(action_id: str, state: Dict[str, Any]) -> Optional[bool]:
    """Pressed state of a toggle tile from the tracker's state; None = the state does not report it."""
    if not state:
        return None
    s = state.get("settings") if isinstance(state.get("settings"), dict) else {}
    mode = state.get("mode")
    if action_id == "pen_toggle":
        return state.get("pen") == "DRAWING"
    if action_id == "latch":
        return bool(state.get("latch"))
    if action_id == "mic":
        return bool(state.get("micOpen"))
    if action_id == "quiet":
        return bool(state.get("quiet", s.get("quiet")))
    if action_id == "dots":
        return mode == "dots"
    if action_id == "hatch":
        return mode in ("hatch", "hatch_alternate")
    if action_id == "dash":
        return mode == "dash"
    if action_id == "simulate_tremor":
        return bool(s.get("simulateTremor"))
    if action_id == "head_mode":
        return bool(s.get("headMode"))
    if action_id == "eyebrow_lift":
        return bool(s.get("eyebrowLift"))
    return None


def tile_view(table: ActionTable, action_id: str, state: Dict[str, Any],
              local_checked: Optional[Dict[str, bool]] = None) -> TileView:
    a = table.by_id[action_id]
    s = state.get("settings") if isinstance(state.get("settings"), dict) else {}
    label = a["label"]
    available = table.tile_available(action_id)
    enabled = available
    checkable = bool(a.get("toggle"))
    if action_id == "pause":
        # Renamed toggle: reads Resume while paused and exposes no checked state (§0 rule 10).
        checkable = False
        label = "Resume" if state.get("paused") else "Pause"
    elif action_id == "app_profile":
        label = "App: Photoshop" if s.get("appProfile") == "photoshop" else "App: Krita"
    elif action_id == "recalibrate":
        label = "Recalibrate" if state.get("calibrated") else "Calibrate"
    if action_id == "mic":
        inputs = s.get("inputs") if isinstance(s.get("inputs"), dict) else {}
        if state.get("quiet") or s.get("quiet") or inputs.get("voice") is False:
            enabled = False
    if action_id == "pick_sticker_colour" and s and s.get("trackingSource") != "colorcap":
        enabled = False
    checked = False
    if checkable:
        c = checked_from_state(action_id, state)
        if c is None:
            c = bool((local_checked or {}).get(action_id, False))
        checked = c
    tip = a.get("help") or ""
    if not available:
        tip = "Not in this build yet."
    elif a.get("key"):
        tip = (tip + " " if tip else "") + f"Key: {a['key']}."
    sub = ""
    if action_id == "mic" and s.get("alwaysListen"):
        if state.get("listening") or state.get("micOpen"):
            sub = "Listening"
        tip = "Always listening is on. Tap Mic to turn it off."
    return TileView(label, checkable, checked, enabled, tip, table.colour_of(action_id), bool(a.get("destructive")),
                    sub)


def tracking_view(state: Dict[str, Any], connected: bool) -> Tuple[str, str]:
    """(word, dot kind). The word is always shown next to the dot: state is never colour-only."""
    if not connected or not state:
        return "Lost", "lost"
    word = state.get("tracking") if state.get("tracking") in ("Tracking", "Weak", "Lost") else "Lost"
    return word, word.lower()


LOST_REASONS = {"no_hand": "no hand", "too_dark": "too dark", "low_fps": "low fps",
                "outside_area": "hand outside the tracked area"}


def tracking_text(state: Dict[str, Any], connected: bool) -> str:
    word, _ = tracking_view(state, connected)
    reason = LOST_REASONS.get(state.get("reason") or "") if connected and word != "Tracking" else None
    return f"{word} ({reason})" if reason else word


def fps_text(state: Dict[str, Any], connected: bool) -> str:
    if not connected or not state:
        return "– fps"
    try:
        return f"{int(round(float(state.get('detectionFps') or 0)))} fps"
    except (TypeError, ValueError):
        return "– fps"


def krita_text(state: Dict[str, Any], connected: bool) -> str:
    if not connected:
        return "Krita: waiting for tracker"
    return "Krita connected" if state.get("kritaConnected") else "Krita not connected"


def connection_text(connected: bool, started: bool) -> str:
    if connected:
        return "Tracker connected"
    return "Tracker connecting…" if started else "Tracker stopped"


def undo_text(state: Dict[str, Any]) -> str:
    return f"Undo: {state.get('undoLabel') or 'nothing yet'}"


def heard_text(heard: Optional[Dict[str, str]]) -> str:
    if not heard or not heard.get("text"):
        return "Heard: nothing yet"
    via = " (Claude)" if heard.get("via") == "claude" else ""
    return f"Heard: {heard['text']}{via}"


def calibration_view(state: Dict[str, Any]) -> Optional[Tuple[str, str, int]]:
    """(step line, prompt, progress 0-100) while calibrating, else None."""
    c = state.get("calibrating")
    if not isinstance(c, dict):
        return None
    try:
        p = int(round(max(0.0, min(1.0, float(c.get("progress") or 0))) * 100))
    except (TypeError, ValueError):
        p = 0
    return f"Step {c.get('step', 1)} of 3", str(c.get("prompt") or ""), p


def deviation_text(state: Dict[str, Any]) -> str:
    d = state.get("deviationPx")
    try:
        return f"Deviation {float(d):.1f} px" if d is not None else "Deviation –"
    except (TypeError, ValueError):
        return "Deviation –"


def trail_points(state: Dict[str, Any], key: str = "rawTrail") -> List[Tuple[float, float]]:
    pts = state.get(key)
    out: List[Tuple[float, float]] = []
    if isinstance(pts, list):
        for p in pts:
            if isinstance(p, dict) and isinstance(p.get("x"), (int, float)) and isinstance(p.get("y"), (int, float)):
                out.append((float(p["x"]), float(p["y"])))
    return out


def fit_trail(trails: Iterable[List[Tuple[float, float]]], w: float, h: float, margin: float = 8.0,
              min_span: float = 60.0) -> Callable[[Tuple[float, float]], Tuple[float, float]]:
    """A transform that fits every trail point into a w×h box (same scale on both axes), like the website."""
    allp = [p for t in trails for p in t]
    if not allp:
        return lambda p: p
    xs, ys = [p[0] for p in allp], [p[1] for p in allp]
    mnx, mxx, mny, mxy = min(xs), max(xs), min(ys), max(ys)
    span = max(mxx - mnx, mxy - mny, min_span)
    k = (min(w, h) - 2 * margin) / span
    ox = (w - (mxx - mnx) * k) / 2
    oy = (h - (mxy - mny) * k) / 2
    return lambda p: (ox + (p[0] - mnx) * k, oy + (p[1] - mny) * k)


def slider_value(spec: SliderSpec, state: Dict[str, Any]) -> float:
    s = state.get("settings") if isinstance(state.get("settings"), dict) else {}
    v = s.get(spec.key)
    if spec.key == "gainOverride" and v is None:
        v = state.get("gain")
    if spec.key == "steadiness" and v is None:
        v = state.get("steadiness")
    if not isinstance(v, (int, float)) or isinstance(v, bool):
        v = spec.default
    return spec.clamp(v)


# --------------------------------------------------------------------------- controller


class PanelController:
    """What the panel sends. Qt-free: `send(msg) -> bool` is the tracker client's send."""

    def __init__(self, table: ActionTable, model: PanelModel, send: Callable[[Dict[str, Any]], bool],
                 messages: Optional[Messages] = None) -> None:
        self.table = table
        self.model = model
        self._send = send
        self.msgs = messages or Messages()
        self.local_checked: Dict[str, bool] = {}
        self.local_status: str = ""
        self.listeners: List[Callable[[set], None]] = []
        self.page = "steady"
        self.visible = True
        self.preview_on: Optional[bool] = None

    # -- plumbing
    def notify(self, topics: set) -> None:
        for fn in list(self.listeners):
            try:
                fn(topics)
            except Exception:
                pass

    def say(self, text: str) -> None:
        self.local_status = text
        self.notify({"local_status"})

    def send(self, msg: Dict[str, Any]) -> bool:
        if not self.model.connected:
            self.say(NOT_RUNNING_HINT)
            return False
        ok = self._send(msg)
        if not ok:
            self.say(NOT_RUNNING_HINT)
        return ok

    def on_message(self, msg: Dict[str, Any]) -> None:
        topics = self.model.apply(msg)
        if "status" in topics:
            self.local_status = ""
        if topics:
            self.notify(topics)

    def on_ack(self, request: Optional[Dict[str, Any]], ack: Dict[str, Any]) -> None:
        if not ack.get("ok", True):
            what = request.get("action") or request.get("t") if request else "request"
            self.say(f"Steady Tracker could not do {what}: {ack.get('error') or 'error'}")

    def on_connected(self) -> None:
        self.model.connected = True
        self.local_status = ""
        self.preview_on = None
        self.notify({"connection"})
        self.sync_preview()

    def on_disconnected(self) -> None:
        self.model.reset_connection()
        self.notify({"connection", "state", "dialog", "preview", "status"})

    # -- tiles
    def press(self, action_id: str) -> Optional[Dict[str, Any]]:
        a = self.table.by_id.get(action_id)
        if a is None or not self.table.tile_available(action_id):
            return None
        st = self.model.state
        if action_id == "mic" and self.model.settings.get("alwaysListen"):
            return self.set_setting("alwaysListen", False)  # tapping Mic ends always-listening
        if action_id == "mic":
            msg = self.msgs.mic(not bool(st.get("micOpen")))
        elif action_id == "recalibrate":
            msg = self.msgs.calibrate([1, 2, 3])
        elif action_id == "pause":
            msg = self.msgs.action("pause", variant="resume" if st.get("paused") else "pause")
        else:
            msg = self.msgs.action(action_id)
        if a.get("toggle") and checked_from_state(action_id, st) is None and self.model.connected:
            self.local_checked[action_id] = not self.local_checked.get(action_id, False)
        self.send(msg)
        return msg

    def use_profile(self, name: str) -> Dict[str, Any]:
        msg = self.msgs.action("use_profile", variant=name)
        self.send(msg)
        return msg

    def set_setting(self, path: str, value: Any) -> Dict[str, Any]:
        patch = setting_patch(self.model.settings, path, value)
        # optimistic: show the new value until the tracker's next state confirms it
        s = dict(self.model.settings)
        s.update(patch)
        self.model.state["settings"] = s
        msg = self.msgs.settings(patch)
        self.send(msg)
        self.notify({"state"})
        return msg

    def toggle_setting(self, path: str) -> Dict[str, Any]:
        default = True if path.startswith("inputs.") or path in ("tts", "earcons", "dwellClickEnabled") else False
        return self.set_setting(path, not bool(get_setting(self.model.settings, path, default)))

    def slider(self, key: str, value: float) -> Dict[str, Any]:
        spec = SLIDERS_BY_KEY[key]
        return self.set_setting(key, spec.clamp(value))

    def slider_step(self, key: str, direction: int) -> Dict[str, Any]:
        spec = SLIDERS_BY_KEY[key]
        cur = slider_value(spec, self.model.state)
        return self.slider(key, cur + direction * spec.tile_step)

    def cycle_landmark(self) -> Dict[str, Any]:
        return self.set_setting("landmark", next_landmark(self.model.settings.get("landmark", 5)))

    def choose_camera(self, index: int) -> Dict[str, Any]:
        msg = self.msgs.camera(index)
        self.send(msg)
        return msg

    def typed(self, text: str) -> Optional[Dict[str, Any]]:
        text = (text or "").strip()
        if not text:
            return None
        msg = self.msgs.typed(text)
        self.send(msg)
        return msg

    def answer_dialog(self, answer: str) -> Optional[Dict[str, Any]]:
        d = self.model.dialog
        if d is None:
            return None
        msg = self.msgs.dialog_answer(str(d.get("dialog_id", "")), answer)
        self.model.dialog = None
        self.send(msg)
        self.notify({"dialog"})
        return msg

    # -- preview only while Setup is visible
    def set_page(self, page: str) -> None:
        self.page = page
        self.sync_preview()

    def set_visible(self, visible: bool) -> None:
        self.visible = visible
        self.sync_preview()

    def sync_preview(self) -> Optional[Dict[str, Any]]:
        want = self.visible and self.page == "setup"
        if not self.model.connected or want == self.preview_on:
            return None
        self.preview_on = want
        msg = self.msgs.settings({"preview": want})
        self._send(msg)
        return msg

    # -- views
    def tile(self, action_id: str) -> TileView:
        return tile_view(self.table, action_id, self.model.state, self.local_checked)

    def status_line(self) -> str:
        return self.local_status or self.model.status_text or ("" if self.model.connected else NOT_RUNNING_HINT)
