"""Steady Krita plugin: exercise adapter.py against stub PyQt5/krita modules.

This cannot prove Krita behaves this way (NEEDS-HUMAN.md covers real Krita); it catches
typos and logic errors in the adapter's own code paths (canvas widget search, shortcut
clearing, layer navigation, eraser clearing) using only libkis method names verified in
Krita 5.3.4's bundled krita.pyi.
"""
from __future__ import annotations

import importlib
import sys
import types

import pytest

from krita_fakes import PYKRITA  # noqa: F401  (puts pykrita on sys.path)

pytestmark = pytest.mark.P2a


# --- stub Qt -----------------------------------------------------------------------------
class QPoint:
    def __init__(self, x=0, y=0):
        self._x, self._y = x, y

    def x(self): return self._x
    def y(self): return self._y


class QTimer:
    shots = []

    @staticmethod
    def singleShot(ms, fn):
        QTimer.shots.append((ms, fn))


class QColor:
    def __init__(self, hex_="#000000"):
        self._hex = hex_.lower()

    def name(self): return self._hex


class QKeySequence:
    PortableText = "portable"

    def __init__(self, s=""):
        self.s = s

    def toString(self, fmt): return self.s
    def __eq__(self, o): return isinstance(o, QKeySequence) and o.s == self.s


class QWidget:
    def __init__(self, cls, x, y, w, h, visible=True):
        self.cls, self.x, self.y, self.w, self.h, self.vis = cls, x, y, w, h, visible

    def isVisible(self): return self.vis
    def width(self): return self.w
    def height(self): return self.h
    def mapToGlobal(self, p): return QPoint(self.x + p.x(), self.y + p.y())

    def metaObject(self):
        return types.SimpleNamespace(className=lambda: self.cls)


class QOpenGLWidget(QWidget):
    pass


class Rect:
    def __init__(self, x, y, w, h): self.v = (x, y, w, h)
    def x(self): return self.v[0]
    def y(self): return self.v[1]
    def width(self): return self.v[2]
    def height(self): return self.v[3]


class MainWindow:
    def __init__(self, children): self.children = children
    def findChildren(self, cls): return [c for c in self.children if isinstance(c, cls)]
    def frameGeometry(self): return Rect(0, 25, 1400, 1060)


# --- stub krita ----------------------------------------------------------------------------
class ManagedColor:
    def __init__(self, qc): self.qc = qc

    @staticmethod
    def fromQColor(qc, canvas=None):
        assert canvas == "canvas"
        return ManagedColor(qc)

    def colorForCanvas(self, canvas): return self.qc


class Action:
    def __init__(self, name, text="", shortcuts=(), checkable=False, enabled=True):
        self.name, self.t, self.sc = name, text, [QKeySequence(s) for s in shortcuts]
        self.checkable, self.checked, self.enabled, self.triggers = checkable, False, enabled, 0

    def objectName(self): return self.name
    def text(self): return self.t
    def isEnabled(self): return self.enabled
    def isCheckable(self): return self.checkable
    def isChecked(self): return self.checked
    def shortcuts(self): return list(self.sc)
    def setShortcuts(self, seqs): self.sc = list(seqs)
    def setShortcut(self, seq): self.sc = [seq] if seq.s else []

    def trigger(self):
        self.triggers += 1
        if self.checkable:
            self.checked = not self.checked


class Node:
    _next = 0

    def __init__(self, name, parent=None):
        Node._next += 1
        self.uid, self.n, self.parent, self.children, self.vis = Node._next, name, parent, [], True

    def name(self): return self.n
    def uniqueId(self): return self.uid
    def parentNode(self): return self.parent
    def childNodes(self): return list(self.children)
    def setVisible(self, v): self.vis = v

    def addChildNode(self, child, above):
        child.parent = self
        idx = len(self.children) if above is None else self.children.index(above) + 1
        self.children.insert(idx, child)
        return True


class Doc:
    def __init__(self):
        self.root = Node("root")
        for n in ("Background", "Paint Layer 1"):
            self.root.addChildNode(Node(n), None)
        self.active = self.root.children[-1]
        self.refreshed = 0

    def rootNode(self): return self.root
    def activeNode(self): return self.active
    def setActiveNode(self, n): self.active = n
    def createNode(self, name, kind): assert kind == "paintlayer"; return Node(name)
    def refreshProjection(self): self.refreshed += 1


class Res:
    def __init__(self, n): self.n = n
    def name(self): return self.n


class View:
    def __init__(self, doc):
        self.doc, self.fg, self.size, self.op, self.preset, self.eraser = doc, None, 40.0, 1.0, None, False

    def document(self): return self.doc
    def canvas(self): return "canvas"
    def foregroundColor(self): return self.fg or ManagedColor(QColor("#000000"))
    def setForeGroundColor(self, c): self.fg = c
    def brushSize(self): return self.size
    def setBrushSize(self, s): self.size = s
    def paintingOpacity(self): return self.op
    def setPaintingOpacity(self, o): self.op = o
    def currentBrushPreset(self): return self.preset
    def setCurrentBrushPreset(self, r): self.preset = r
    def eraserMode(self): return self.eraser
    def setEraserMode(self, v): self.eraser = v


class App:
    def __init__(self, widgets, with_doc=True):
        self.doc = Doc() if with_doc else None
        self.view = View(self.doc) if with_doc else None
        self.qw = MainWindow(widgets)
        win = types.SimpleNamespace(activeView=lambda: self.view, qwindow=lambda: self.qw)
        self.win = win
        acts = [Action("erase_action", "Set eraser mode", ["E"], checkable=True),
                Action("show_brush_editor", "Show Brush Editor", ["F5"], checkable=True),
                Action("show_brush_presets", "Show Brush Presets", ["F6", "Ctrl+Alt+P"]),
                Action("featherselection", "Feather Selection...", ["Shift+F6"]),
                Action("merge_layer", "&Merge with Layer Below", ["Ctrl+E"]),
                Action("KritaShape/KisToolBrush", "Freehand Brush Tool", ["B"]),
                Action("set_no_brush_smoothing", "Brush Smoothing: Disabled"),
                Action("", "unnamed")]
        self.acts = {a.name: a for a in acts}
        self.presets = {n: Res(n) for n in ["b) Basic-5 Size", "d) Ink-2 Fineliner"]}

    def action(self, name): return self.acts.get(name)
    def actions(self): return list(self.acts.values())
    def resources(self, kind): assert kind == "preset"; return self.presets
    def activeWindow(self): return self.win
    def activeDocument(self): return self.doc
    def version(self): return "5.3.4"


@pytest.fixture
def adapter_mod(monkeypatch):
    pyqt = types.ModuleType("PyQt5")
    core = types.ModuleType("PyQt5.QtCore")
    core.QPoint, core.QTimer = QPoint, QTimer
    gui = types.ModuleType("PyQt5.QtGui")
    gui.QColor, gui.QKeySequence = QColor, QKeySequence
    wid = types.ModuleType("PyQt5.QtWidgets")
    wid.QWidget, wid.QOpenGLWidget = QWidget, QOpenGLWidget
    kr = types.ModuleType("krita")
    kr.ManagedColor = ManagedColor
    for name, mod in {"PyQt5": pyqt, "PyQt5.QtCore": core, "PyQt5.QtGui": gui, "PyQt5.QtWidgets": wid,
                      "krita": kr}.items():
        monkeypatch.setitem(sys.modules, name, mod)
    monkeypatch.delitem(sys.modules, "steady.adapter", raising=False)
    mod = importlib.import_module("steady.adapter")
    yield mod
    sys.modules.pop("steady.adapter", None)


WIDGETS = [
    QWidget("KisCanvasController", 60, 100, 1200, 900),
    QOpenGLWidget("KisOpenGLCanvas2", 64, 120, 1180, 860),
    QOpenGLWidget("KisOpenGLCanvas2", 0, 0, 1180, 860, visible=False),  # another tab
    QOpenGLWidget("KisColorSelector", 1300, 100, 200, 200),
]


def test_adapter_imports_with_pyqt5(adapter_mod):
    assert adapter_mod.QT_BINDING == "PyQt5"


def test_canvas_rect_prefers_visible_known_canvas(adapter_mod):
    a = adapter_mod.KritaAdapter(App(WIDGETS))
    assert a.canvas_rect() == {"x": 64, "y": 120, "w": 1180, "h": 860, "widget_class": "KisOpenGLCanvas2"}
    a = adapter_mod.KritaAdapter(App([QWidget("KisCanvasController", 0, 0, 900, 900),
                                      QWidget("KisSomethingCanvas", 5, 6, 700, 500)]))
    assert a.canvas_rect()["widget_class"] == "KisSomethingCanvas"
    a = adapter_mod.KritaAdapter(App([QWidget("QLabel", 0, 0, 900, 900)]))
    assert a.canvas_rect() is None
    assert a.window_rect() == {"x": 0, "y": 25, "w": 1400, "h": 1060}


def test_clear_shortcuts_real_adapter(adapter_mod):
    app = App(WIDGETS)
    a = adapter_mod.KritaAdapter(app)
    cleared = a.clear_shortcuts(["f5", "f6", "f9"])
    assert {(c["key"], c["action"]) for c in cleared} == {("f5", "show_brush_editor"), ("f6", "show_brush_presets")}
    assert app.acts["show_brush_editor"].sc == []
    assert [s.s for s in app.acts["show_brush_presets"].sc] == ["Ctrl+Alt+P"]
    assert [s.s for s in app.acts["featherselection"].sc] == ["Shift+F6"]
    assert a.clear_shortcuts(["f5", "f6"]) == []


def test_list_actions_skips_unnamed(adapter_mod):
    acts = adapter_mod.KritaAdapter(App(WIDGETS)).list_actions()
    assert {"id": "merge_layer", "text": "Merge with Layer Below"} in acts
    assert all(x["id"] for x in acts)


def test_brush_state_and_preset_clears_eraser(adapter_mod):
    from steady.dispatch import dispatch

    app = App(WIDGETS)
    a = adapter_mod.KritaAdapter(app)
    assert dispatch({"id": "1", "cmd": "color", "hex": "#1d4ed8"}, a)["ok"]
    assert a.get_color_hex() == "#1d4ed8"
    assert dispatch({"id": "2", "cmd": "size", "delta": 5}, a)["size"] == 45
    assert dispatch({"id": "3", "cmd": "opacity", "value": 30}, a)["opacity"] == 30
    dispatch({"id": "4", "cmd": "action", "action": "erase_action"}, a)
    app.view.eraser = True
    r = dispatch({"id": "5", "cmd": "preset", "name": "ink"}, a)
    assert r["ok"] and r["preset"] == "d) Ink-2 Fineliner" and r["eraser_cleared"] is True
    assert app.acts["erase_action"].checked is False and app.view.eraser is False
    st = dispatch({"id": "6", "cmd": "get_state"}, a)
    assert st["preset"] == "d) Ink-2 Fineliner" and st["eraser"] is False and st["layer"] == "Paint Layer 1"


def test_layers(adapter_mod):
    from steady.dispatch import dispatch

    app = App(WIDGETS)
    a = adapter_mod.KritaAdapter(app)
    r = dispatch({"id": "1", "cmd": "new_layer"}, a)
    assert r["layer"] == "Steady 1"
    assert [n.name() for n in app.doc.root.children] == ["Background", "Paint Layer 1", "Steady 1"]
    r = dispatch({"id": "2", "cmd": "new_layer", "name": "Ink"}, a)
    assert [n.name() for n in app.doc.root.children][-1] == "Ink"
    assert dispatch({"id": "3", "cmd": "layer_nav", "dir": "down"}, a)["layer"] == "Steady 1"
    assert dispatch({"id": "4", "cmd": "layer_nav", "dir": "down"}, a)["layer"] == "Paint Layer 1"
    assert dispatch({"id": "5", "cmd": "layer_nav", "dir": "up"}, a)["layer"] == "Steady 1"
    r = dispatch({"id": "6", "cmd": "layer_visible", "visible": False}, a)
    assert r["layer"] == "Steady 1" and app.doc.active.vis is False and app.doc.refreshed == 1


def test_session_init_real_adapter(adapter_mod):
    from steady.dispatch import dispatch

    QTimer.shots.clear()
    app = App(WIDGETS)
    a = adapter_mod.KritaAdapter(app)
    r = dispatch({"id": "1", "cmd": "session_init", "keys": ["f5", "f6"]}, a)
    assert r["ok"] and r["smoothing_changed"] is True and r["krita_version"] == "5.3.4"
    assert app.acts["KritaShape/KisToolBrush"].triggers == 1
    assert app.acts["set_no_brush_smoothing"].triggers == 1 and len(QTimer.shots) == 1
    r = dispatch({"id": "2", "cmd": "session_init", "keys": ["f5", "f6"]}, a)
    assert r["smoothing_changed"] is False and app.acts["set_no_brush_smoothing"].triggers == 1


def test_no_document(adapter_mod):
    from steady.dispatch import dispatch

    a = adapter_mod.KritaAdapter(App(WIDGETS, with_doc=False))
    assert dispatch({"id": "1", "cmd": "color", "hex": "#ffffff"}, a)["error"] == "no_view"
    r = dispatch({"id": "2", "cmd": "session_init", "keys": ["f5"]}, a)
    assert r["ok"] and r["smoothing_pending"] is True
