"""Test doubles for the Steady Krita plugin (no Qt, no Krita)."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

ROOT = Path(__file__).resolve().parents[2]
PYKRITA = ROOT / "krita-plugin" / "pykrita"
EXAMPLES = ROOT / "docs" / "protocol-examples.json"
if str(PYKRITA) not in sys.path:
    sys.path.insert(0, str(PYKRITA))

from steady.dispatch import (  # noqa: E402
    SMOOTHING_ACTIONS,
    Adapter,
    Session,
    shortcut_targets,
    split_shortcuts,
)


def load_examples() -> Dict[str, Any]:
    return json.loads(EXAMPLES.read_text())


class FakeAction:
    def __init__(self, name: str, text: str = "", enabled: bool = True, checkable: bool = False,
                 checked: bool = False, shortcuts: Optional[List[str]] = None):
        self.name, self.text = name, text or name
        self.enabled, self.checkable, self.checked = enabled, checkable, checked
        self.shortcuts = list(shortcuts or [])  # Qt PortableText strings
        self.triggers = 0

    def trigger(self) -> None:
        if not self.enabled:
            return
        self.triggers += 1
        if self.checkable:
            self.checked = not self.checked


# Shaped like a fresh Krita 5.3 (ids and default F-keys verified in the bundled .action files).
def default_actions() -> Dict[str, FakeAction]:
    acts = [
        FakeAction("edit_undo", "Undo", shortcuts=["Ctrl+Z"]),
        FakeAction("edit_redo", "Redo", shortcuts=["Ctrl+Shift+Z"]),
        FakeAction("file_save", "&Save", shortcuts=["Ctrl+S"]),
        FakeAction("erase_action", "Set eraser mode", checkable=True, shortcuts=["E"]),
        FakeAction("increase_brush_size", "Increase Brush Size", shortcuts=["]"]),
        FakeAction("decrease_opacity", "Decrease Opacity", shortcuts=["I"]),
        FakeAction("add_new_paint_layer", "Add &Paint Layer", shortcuts=["Ins"]),
        FakeAction("merge_layer", "&Merge with Layer Below", shortcuts=["Ctrl+E"]),
        FakeAction("show_brush_editor", "Show Brush Editor", checkable=True, shortcuts=["F5"]),
        FakeAction("show_brush_presets", "Show Brush Presets", shortcuts=["F6"]),
        FakeAction("layer_properties", "&Properties...", shortcuts=["F3"]),
        FakeAction("save_incremental_backup", "Save Incremental &Backup", shortcuts=["F4"]),
        FakeAction("featherselection", "Feather Selection...", shortcuts=["Shift+F6"]),
        FakeAction("KritaShape/KisToolBrush", "Freehand Brush Tool", shortcuts=["B"]),
    ]
    acts += [FakeAction(a, a) for a in SMOOTHING_ACTIONS.values()]
    return {a.name: a for a in acts}


DEFAULT_PRESETS = ["b) Basic-5 Size", "c) Pencil-2", "d) Ink-2 Fineliner", "f) Airbrush Soft",
                   "a) Eraser Circle"]


class FakeAdapter(Adapter):
    def __init__(self, *, view: bool = True, presets: Optional[List[str]] = None,
                 canvas: Optional[Dict[str, Any]] = None, window: Optional[Dict[str, Any]] = None,
                 version: str = "5.3.4"):
        self.session = Session()
        self.view = view
        self.actions = default_actions()
        self.presets = list(DEFAULT_PRESETS if presets is None else presets)
        self.preset: Optional[str] = self.presets[0] if self.presets else None
        self.color = "#000000"
        self.size = 40.0
        self.opacity = 1.0
        self.layers = ["Background", "Paint Layer 1"]  # bottom -> top
        self.active = 1
        self.visible = {n: True for n in self.layers}
        self.canvas = canvas if canvas is not None else {"x": 64, "y": 120, "w": 1180, "h": 860,
                                                         "widget_class": "KisOpenGLCanvas2"}
        self.window = window if window is not None else {"x": 0, "y": 25, "w": 1400, "h": 1060}
        self._version = version
        self.smoothing_calls: List[str] = []
        self.calls: List[str] = []

    def _v(self) -> None:
        if not self.view:
            raise AssertionError("adapter view method called without a view")

    def version(self) -> str: return self._version
    def has_view(self) -> bool: return self.view

    def trigger_action(self, name: str) -> str:
        a = self.actions.get(name)
        if a is None:
            return "unknown"
        if not a.enabled:
            return "disabled"
        a.trigger()
        self.calls.append(f"action:{name}")
        return "ok"

    def action_checked(self, name: str) -> Optional[bool]:
        a = self.actions.get(name)
        return a.checked if a is not None and a.checkable else None

    def list_actions(self) -> List[Dict[str, str]]:
        from steady.dispatch import strip_mnemonic
        return [{"id": a.name, "text": strip_mnemonic(a.text)} for a in self.actions.values()]

    def clear_shortcuts(self, keys: List[str]) -> List[Dict[str, str]]:
        targets = shortcut_targets(keys)
        out = []
        for a in self.actions.values():
            keep, hit = split_shortcuts(a.shortcuts, targets)
            if hit:
                a.shortcuts = [a.shortcuts[i] for i in keep]
                out += [{"key": k, "action": a.name} for k in hit]
        return out

    def apply_smoothing(self, mode: str) -> bool:
        if not self.view:
            return False
        self.smoothing_calls.append(mode)
        return self.trigger_action(SMOOTHING_ACTIONS[mode]) == "ok"

    def get_color_hex(self) -> str: self._v(); return self.color
    def set_color_hex(self, hex_: str) -> None: self._v(); self.color = hex_
    def get_size(self) -> float: self._v(); return self.size
    def set_size(self, px: float) -> None: self._v(); self.size = px
    def get_opacity(self) -> float: self._v(); return self.opacity
    def set_opacity(self, value01: float) -> None: self._v(); self.opacity = value01
    def list_presets(self) -> List[str]: return list(self.presets)
    def current_preset(self) -> Optional[str]: self._v(); return self.preset

    def set_preset(self, name: str) -> bool:
        self._v()
        if name not in self.presets:
            return False
        self.preset = name  # like Krita: eraser mode survives a preset change
        self.calls.append(f"preset:{name}")
        return True

    def eraser_on(self) -> bool: return self.actions["erase_action"].checked

    def set_eraser(self, on: bool) -> None:
        a = self.actions["erase_action"]
        if a.checked != on:
            a.trigger()

    def current_layer(self) -> Optional[str]: self._v(); return self.layers[self.active]

    def new_layer(self, name: Optional[str]) -> Optional[str]:
        self._v()
        name = name or f"Steady {len(self.layers)}"
        self.layers.insert(self.active + 1, name)
        self.visible[name] = True
        self.active += 1
        return name

    def layer_nav(self, direction: str) -> Optional[str]:
        self._v()
        j = self.active + (1 if direction == "up" else -1)
        if 0 <= j < len(self.layers):
            self.active = j
        return self.layers[self.active]

    def set_layer_visible(self, visible: bool) -> Optional[str]:
        self._v()
        name = self.layers[self.active]
        self.visible[name] = visible
        return name

    def canvas_rect(self) -> Optional[Dict[str, Any]]: return self.canvas or None
    def window_rect(self) -> Optional[Dict[str, Any]]: return self.window or None


class ExplodingAdapter(FakeAdapter):
    def get_size(self) -> float:
        raise RuntimeError("boom")
