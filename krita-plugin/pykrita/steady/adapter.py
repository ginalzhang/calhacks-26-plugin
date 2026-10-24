"""Steady Krita plugin: the real Krita adapter (runs only inside Krita, on the GUI thread).

API names verified against Krita 5.3.4's bundled libkis stub
(Contents/Frameworks/krita-python-libs/PyKrita/krita.pyi): Krita.instance/action/actions/
resources/activeWindow/version, Window.activeView/qwindow, View.foregroundColor/
setForeGroundColor/brushSize/setBrushSize/paintingOpacity/setPaintingOpacity/
currentBrushPreset/setCurrentBrushPreset/eraserMode/setEraserMode/canvas/document,
ManagedColor.fromQColor/colorForCanvas, Document.createNode/rootNode/activeNode/
setActiveNode/refreshProjection, Node.addChildNode/parentNode/childNodes/setVisible.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

try:  # Krita 5.x (Qt5) is the tested target
    from PyQt5.QtCore import QPoint, Qt, QTimer
    from PyQt5.QtGui import QColor, QGuiApplication, QKeySequence
    from PyQt5.QtWidgets import QAbstractButton, QAbstractItemView, QOpenGLWidget, QTabBar, QWidget

    QT_BINDING = "PyQt5"
except ImportError:  # Krita 6.x (Qt6): loads, untested
    from PyQt6.QtCore import QPoint, Qt, QTimer
    from PyQt6.QtGui import QColor, QGuiApplication, QKeySequence
    from PyQt6.QtWidgets import QAbstractButton, QAbstractItemView, QTabBar, QWidget

    try:
        from PyQt6.QtOpenGLWidgets import QOpenGLWidget
    except ImportError:  # pragma: no cover
        QOpenGLWidget = None  # type: ignore[assignment]
    QT_BINDING = "PyQt6"

from krita import ManagedColor  # noqa: E402  (only importable inside Krita)

from .dispatch import (  # noqa: E402
    BRUSH_TOOL_ACTION,
    ERASE_ACTION,
    SMOOTHING_ACTIONS,
    Adapter,
    Session,
    shortcut_targets,
    split_shortcuts,
    strip_mnemonic,
)

try:
    _PORTABLE = QKeySequence.PortableText  # Qt5
except AttributeError:  # Qt6
    _PORTABLE = QKeySequence.SequenceFormat.PortableText

try:
    _TOOLTIP_ROLE, _DISPLAY_ROLE = Qt.ToolTipRole, Qt.DisplayRole  # Qt5
except AttributeError:  # Qt6
    _TOOLTIP_ROLE, _DISPLAY_ROLE = Qt.ItemDataRole.ToolTipRole, Qt.ItemDataRole.DisplayRole

# Item views whose cells are worth numbering (P4 list_widgets). Class names verified as strings in
# Krita 5.3.4's bundled libkritawidgets / libkritaresourcewidgets dylibs (DECISIONS.md, Agent D).
ITEM_VIEW_CLASSES = {"KisPaletteView": "Swatch", "KisResourceItemListView": "Preset"}
_MAX_CELLS_PER_VIEW = 64
_MAX_CELL_SCAN = 4000

# Krita's canvas widget classes (Krita 5.x source: KisOpenGLCanvas2 is a QOpenGLWidget,
# KisQPainterCanvas the software fallback). Verified at runtime: the reply carries
# `widget_class` so a human can confirm it (NEEDS-HUMAN.md).
CANVAS_CLASSES = ("KisOpenGLCanvas2", "KisQPainterCanvas")
_MIN_CANVAS_PX = 100


def _rect_of(widget: Any) -> Dict[str, Any]:
    tl = widget.mapToGlobal(QPoint(0, 0))
    return {"x": tl.x(), "y": tl.y(), "w": widget.width(), "h": widget.height()}


class KritaAdapter(Adapter):
    def __init__(self, app: Any) -> None:
        self.app = app
        self.session = Session()

    # -- plumbing -----------------------------------------------------------------
    def _window(self):
        return self.app.activeWindow()

    def _view(self):
        w = self._window()
        return w.activeView() if w is not None else None

    def _doc(self):
        v = self._view()
        d = v.document() if v is not None else None
        return d if d is not None else self.app.activeDocument()

    def version(self) -> str:
        return str(self.app.version())

    def has_view(self) -> bool:
        v = self._view()
        return v is not None and v.document() is not None

    # -- actions ------------------------------------------------------------------
    def trigger_action(self, name: str) -> str:
        a = self.app.action(name)
        if a is None:
            return "unknown"
        if not a.isEnabled():
            return "disabled"
        a.trigger()
        return "ok"

    def action_checked(self, name: str) -> Optional[bool]:
        a = self.app.action(name)
        if a is None or not a.isCheckable():
            return None
        return bool(a.isChecked())

    def list_actions(self) -> List[Dict[str, str]]:
        out, seen = [], set()
        for a in self.app.actions():
            oid = a.objectName()
            if not oid or oid in seen:
                continue
            seen.add(oid)
            out.append({"id": oid, "text": strip_mnemonic(a.text())})
        return out

    def clear_shortcuts(self, keys: List[str]) -> List[Dict[str, str]]:
        targets = shortcut_targets(keys)
        cleared: List[Dict[str, str]] = []
        for a in self.app.actions():
            seqs = list(a.shortcuts())
            keep, hit = split_shortcuts([s.toString(_PORTABLE) for s in seqs], targets)
            if not hit:
                continue
            if keep:
                a.setShortcuts([seqs[i] for i in keep])
            else:
                a.setShortcut(QKeySequence())
            for k in hit:
                cleared.append({"key": k, "action": a.objectName() or strip_mnemonic(a.text())})
        return cleared

    def apply_smoothing(self, mode: str) -> bool:
        # The set_*_brush_smoothing actions are wired to the Freehand Brush tool's options,
        # so make that tool current first (verified id KritaShape/KisToolBrush, tools.action).
        brush = self.app.action(BRUSH_TOOL_ACTION)
        if brush is not None and brush.isEnabled():
            brush.trigger()
        a = self.app.action(SMOOTHING_ACTIONS[mode])
        if a is None or not a.isEnabled():
            return False
        a.trigger()
        # Tool option widgets can be created a tick after the tool switch: trigger once more.
        QTimer.singleShot(150, a.trigger)
        return True

    # -- brush state ----------------------------------------------------------------
    def get_color_hex(self) -> str:
        v = self._view()
        return v.foregroundColor().colorForCanvas(v.canvas()).name()

    def set_color_hex(self, hex_: str) -> None:
        v = self._view()
        v.setForeGroundColor(ManagedColor.fromQColor(QColor(hex_), v.canvas()))

    def get_size(self) -> float:
        return float(self._view().brushSize())

    def set_size(self, px: float) -> None:
        self._view().setBrushSize(float(px))

    def get_opacity(self) -> float:
        return float(self._view().paintingOpacity())

    def set_opacity(self, value01: float) -> None:
        self._view().setPaintingOpacity(float(value01))

    def _presets(self) -> Dict[str, Any]:
        res = self.app.resources("preset")
        return dict(res) if res else {}

    def list_presets(self) -> List[str]:
        return list(self._presets().keys())

    def current_preset(self) -> Optional[str]:
        p = self._view().currentBrushPreset()
        return p.name() if p is not None else None

    def set_preset(self, name: str) -> bool:
        res = self._presets().get(name)
        if res is None:
            return False
        self._view().setCurrentBrushPreset(res)
        return True

    def eraser_on(self) -> bool:
        checked = self.action_checked(ERASE_ACTION)
        if checked is not None:
            return checked
        v = self._view()
        return bool(v.eraserMode()) if v is not None and hasattr(v, "eraserMode") else False

    def set_eraser(self, on: bool) -> None:
        a = self.app.action(ERASE_ACTION)
        if a is not None and a.isCheckable() and a.isChecked() != on:
            a.trigger()
        v = self._view()
        if v is not None and hasattr(v, "setEraserMode") and bool(v.eraserMode()) != on:
            v.setEraserMode(on)

    # -- layers -----------------------------------------------------------------------
    def current_layer(self) -> Optional[str]:
        d = self._doc()
        n = d.activeNode() if d is not None else None
        return n.name() if n is not None else None

    @staticmethod
    def _same(a: Any, b: Any) -> bool:
        if hasattr(a, "uniqueId") and hasattr(b, "uniqueId"):
            return a.uniqueId() == b.uniqueId()
        return a == b

    def new_layer(self, name: Optional[str]) -> Optional[str]:
        d = self._doc()
        if d is None:
            return None
        root = d.rootNode()
        if not name:
            taken = {n.name() for n in root.childNodes()}
            i = 1
            while f"Steady {i}" in taken:
                i += 1
            name = f"Steady {i}"
        node = d.createNode(name, "paintlayer")
        active = d.activeNode()
        parent = active.parentNode() if active is not None else None
        if active is not None and parent is not None:
            parent.addChildNode(node, active)  # directly above the active layer, like Krita's own
        else:
            root.addChildNode(node, None)
        d.setActiveNode(node)
        return node.name()

    def layer_nav(self, direction: str) -> Optional[str]:
        d = self._doc()
        n = d.activeNode() if d is not None else None
        if n is None:
            return None
        parent = n.parentNode()
        if parent is None:
            return n.name()
        sibs = parent.childNodes()  # bottom -> top
        idx = next((i for i, s in enumerate(sibs) if self._same(s, n)), None)
        if idx is None:
            return n.name()
        j = idx + 1 if direction == "up" else idx - 1
        if 0 <= j < len(sibs):
            d.setActiveNode(sibs[j])
            return sibs[j].name()
        return n.name()  # already at the top/bottom: stay

    def set_layer_visible(self, visible: bool) -> Optional[str]:
        d = self._doc()
        n = d.activeNode() if d is not None else None
        if n is None:
            return None
        n.setVisible(bool(visible))
        d.refreshProjection()
        return n.name()

    # -- geometry ---------------------------------------------------------------------
    def _qwindow(self):
        w = self._window()
        return w.qwindow() if w is not None else None

    def canvas_rect(self) -> Optional[Dict[str, Any]]:
        qw = self._qwindow()
        if qw is None:
            return None
        known, named, gl = [], [], []
        for wid in qw.findChildren(QWidget):
            if not wid.isVisible() or wid.width() < _MIN_CANVAS_PX or wid.height() < _MIN_CANVAS_PX:
                continue
            cls = wid.metaObject().className()
            area = wid.width() * wid.height()
            if cls in CANVAS_CLASSES:
                known.append((area, cls, wid))
            elif "Canvas" in cls and "Controller" not in cls:
                named.append((area, cls, wid))
            elif QOpenGLWidget is not None and isinstance(wid, QOpenGLWidget):
                gl.append((area, cls, wid))
        for group in (known, named, gl):
            if group:
                group.sort(key=lambda t: t[0], reverse=True)
                _, cls, wid = group[0]
                rect = _rect_of(wid)
                rect["widget_class"] = cls
                return rect
        return None

    def widget_candidates(self) -> Optional[List[Dict[str, Any]]]:
        """Raw clickable widgets under the main window (buttons, tabs, palette/preset cells).

        Buttons cover KoToolBoxButton (toolbox), toolbar QToolButtons and
        KoDockWidgetTitleBarButton (docker title buttons); all are QAbstractButton subclasses.
        Filtering, labels, reading order and numbering happen in dispatch.order_widgets.
        """
        qw = self._qwindow()
        if qw is None:
            return None
        out: List[Dict[str, Any]] = []
        for b in qw.findChildren(QAbstractButton):
            if not b.isVisible() or b.visibleRegion().isEmpty():
                continue  # hidden, or scrolled/clipped fully out of view
            out.append({"tooltip": b.toolTip(), "text": b.text(), "object_name": b.objectName(),
                        "rect": _rect_of(b), "visible": True, "enabled": b.isEnabled(),
                        "class": b.metaObject().className()})
        for bar in qw.findChildren(QTabBar):
            if not bar.isVisible():
                continue
            visible = bar.rect()
            for i in range(bar.count()):
                r = bar.tabRect(i)
                if r.isEmpty() or not visible.contains(r.center()):
                    continue
                tl = bar.mapToGlobal(r.topLeft())
                out.append({"tooltip": bar.tabToolTip(i), "text": bar.tabText(i), "object_name": "",
                            "rect": {"x": tl.x(), "y": tl.y(), "w": r.width(), "h": r.height()},
                            "visible": True, "enabled": bar.isTabEnabled(i), "class": "QTabBar"})
        for view in qw.findChildren(QAbstractItemView):
            prefix = ITEM_VIEW_CLASSES.get(view.metaObject().className())
            if prefix is None or not view.isVisible() or view.model() is None:
                continue
            out.extend(self._cells(view, prefix))
        return out

    @staticmethod
    def _cells(view: Any, prefix: str) -> List[Dict[str, Any]]:
        model, vp = view.model(), view.viewport()
        area = vp.rect()
        cells: List[Dict[str, Any]] = []
        scanned = 0
        for row in range(model.rowCount()):
            for col in range(model.columnCount()):
                scanned += 1
                if scanned > _MAX_CELL_SCAN or len(cells) >= _MAX_CELLS_PER_VIEW:
                    return cells
                idx = model.index(row, col)
                r = view.visualRect(idx)
                if r.isEmpty() or not area.contains(r.center()):
                    continue
                tip, text = idx.data(_TOOLTIP_ROLE), idx.data(_DISPLAY_ROLE)
                tl = vp.mapToGlobal(r.topLeft())
                cells.append({"tooltip": tip if isinstance(tip, str) else "",
                              "text": text if isinstance(text, str) else "",
                              "object_name": f"{prefix} {len(cells) + 1}",
                              "rect": {"x": tl.x(), "y": tl.y(), "w": r.width(), "h": r.height()},
                              "visible": True, "enabled": bool(idx.flags() & Qt.ItemIsEnabled)
                              if hasattr(Qt, "ItemIsEnabled") else True,
                              "class": view.metaObject().className()})
        return cells

    def screen_rects(self) -> List[Dict[str, Any]]:
        out = []
        for scr in QGuiApplication.screens():
            g = scr.geometry()
            out.append({"x": g.x(), "y": g.y(), "w": g.width(), "h": g.height()})
        return out

    def window_rect(self) -> Optional[Dict[str, Any]]:
        qw = self._qwindow()
        if qw is None:
            return None
        g = qw.frameGeometry()
        return {"x": g.x(), "y": g.y(), "w": g.width(), "h": g.height()}
