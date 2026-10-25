"""Steady panel: the Krita docker that is Steady's whole user interface (PyQt5; PyQt6 fallback).

Layout (§0 rule 6, adapted to a docker): a pinned header (Start/Stop, the status line, tracking
dot + word, fps, tracker/Krita connection, Heard / Undo lines, the §4 core tiles, the page
selector) above one scrolling page. Tiles are real QPushButtons, >= 64x64 px with 8 px gaps,
18 px text, labels that wrap only between words. Toggles are checkable with fixed names; Pause is
renamed to Resume and is not checkable. Pages come from actions.json (generated from
src/actions.ts); tiles whose phase is beyond BUILD_PHASE stay visible, disabled, with their label.

The panel talks to Steady Tracker (TCP 127.0.0.1:8767) through one Hub shared by every Krita
window's docker. Pure logic lives in panel_model.py (tested without Qt).
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

try:  # Krita 5.x (Qt5) is the tested target
    from PyQt5.QtCore import QPoint, QPointF, Qt, QTimer, QUrl
    from PyQt5.QtGui import QColor, QDesktopServices, QPainter, QPen, QPixmap
    from PyQt5.QtWidgets import (
        QApplication,
        QDialog,
        QFrame,
        QGridLayout,
        QHBoxLayout,
        QLabel,
        QLineEdit,
        QProgressBar,
        QPushButton,
        QScrollArea,
        QSizePolicy,
        QSlider,
        QVBoxLayout,
        QWidget,
    )

    QT_BINDING = "PyQt5"
except ImportError:  # Krita 6.x (Qt6): loads, untested
    from PyQt6.QtCore import QPoint, QPointF, Qt, QTimer, QUrl
    from PyQt6.QtGui import QColor, QDesktopServices, QPainter, QPen, QPixmap
    from PyQt6.QtWidgets import (
        QApplication,
        QDialog,
        QFrame,
        QGridLayout,
        QHBoxLayout,
        QLabel,
        QLineEdit,
        QProgressBar,
        QPushButton,
        QScrollArea,
        QSizePolicy,
        QSlider,
        QVBoxLayout,
        QWidget,
    )

    QT_BINDING = "PyQt6"

try:
    from krita import DockWidget, Krita  # type: ignore[import-not-found]
except ImportError:  # imported outside Krita (tests without a stub)
    DockWidget = None  # type: ignore[assignment]
    Krita = None  # type: ignore[assignment]

from . import launcher
from .panel_model import (
    COACHING_TEXT,
    HEADER_COLUMNS,
    INSTALL_HINT,
    PAGES,
    PERMISSIONS_FOOTER,
    PRIVACY_TEXT,
    SELECTOR_COLUMNS,
    SETTING_TOGGLES,
    TRACKER_APP_NAME,
    ActionTable,
    PanelController,
    PanelModel,
    SliderSpec,
    calibration_view,
    columns_for,
    connection_text,
    deviation_text,
    dialog_buttons,
    fit_trail,
    fps_text,
    get_setting,
    header_actions,
    heard_text,
    krita_text,
    landmark_name,
    longest_word,
    missing_permissions,
    page_actions,
    profile_names,
    rect_dict,
    slider_value,
    sliders_for,
    trail_points,
    tracking_text,
    tracking_view,
    undo_text,
)
from .tracker_client import TrackerClient

DOCKER_ID = "steady_panel"
SETTINGS_GROUP = "steady"
PRIVACY_KEY = "privacyAcknowledged"
GAP = 8
TILE_MIN = 64


def _enum(owner: Any, group: str, name: str) -> Any:
    """Qt5 flat enums (Qt.AlignCenter) vs Qt6 scoped enums (Qt.AlignmentFlag.AlignCenter)."""
    scoped = getattr(owner, group, None)
    if scoped is not None and hasattr(scoped, name):
        return getattr(scoped, name)
    return getattr(owner, name)


ALIGN_CENTER = _enum(Qt, "AlignmentFlag", "AlignCenter")
ALIGN_LEFT = _enum(Qt, "AlignmentFlag", "AlignLeft")
HORIZONTAL = _enum(Qt, "Orientation", "Horizontal")
STRONG_FOCUS = _enum(Qt, "FocusPolicy", "StrongFocus")
SCROLL_OFF = _enum(Qt, "ScrollBarPolicy", "ScrollBarAlwaysOff")
TRANSPARENT_MOUSE = _enum(Qt, "WidgetAttribute", "WA_TransparentForMouseEvents")
EXPANDING = _enum(QSizePolicy, "Policy", "Expanding")
PREFERRED = _enum(QSizePolicy, "Policy", "Preferred")
MINIMUM = _enum(QSizePolicy, "Policy", "Minimum")
FIXED = _enum(QSizePolicy, "Policy", "Fixed")
NO_PEN = _enum(Qt, "PenStyle", "NoPen")
ANTIALIAS = _enum(QPainter, "RenderHint", "Antialiasing")
KEEP_ASPECT = _enum(Qt, "AspectRatioMode", "KeepAspectRatio")
SMOOTH = _enum(Qt, "TransformationMode", "SmoothTransformation")

# Dark theme matching the website (src/app/globals.css). Contrast: #f3f4f6 on #262b36 ≈ 12:1,
# #111 on #ffd166 ≈ 13:1, disabled #a3a9b4 on #1c2029 ≈ 7:1.
STYLE = """
#steadyRoot { background: #0f1115; }
#steadyRoot QWidget { color: #f3f4f6; font-size: 18px; }
#steadyRoot QFrame#header { background: #171a21; border-bottom: 2px solid #2c313c; }
#steadyRoot QFrame#box { background: #171a21; border: 2px solid #7d8696; border-radius: 10px; }
#steadyRoot QFrame#alertBox { background: #2a1416; border: 2px solid #ff6b6b; border-radius: 10px; }
#steadyRoot QLabel { background: transparent; }
#steadyRoot QLabel#status { font-size: 20px; font-weight: 600; }
#steadyRoot QLabel#alert { font-size: 20px; font-weight: 700; color: #ffd0d0; }
#steadyRoot QLabel#muted { color: #c4c8d0; }
#steadyRoot QLabel#title { font-size: 20px; font-weight: 700; }
#steadyRoot QLabel#caption { color: #ffd166; font-weight: 700; }
#steadyRoot QPushButton#tile {
  background: #262b36; border: 2px solid #7d8696; border-radius: 10px;
  min-width: 64px; min-height: 64px; padding: 4px;
}
#steadyRoot QPushButton#tile:hover { border-color: #c9cfda; }
#steadyRoot QPushButton#tile:checked, #steadyRoot QPushButton#tile[current="true"] {
  background: #ffd166; border-color: #fff3c4;
}
#steadyRoot QPushButton#tile[current="true"] { border-bottom: 6px solid #111111; }
#steadyRoot QPushButton#tile[danger="true"] { border-color: #ff6b6b; }
#steadyRoot QPushButton#tile[primary="true"] { background: #1e3a8a; border-color: #93b4ff; }
#steadyRoot QPushButton#tile:focus { border: 3px solid #ffd166; }
#steadyRoot QPushButton#tile:checked:focus, #steadyRoot QPushButton#tile[current="true"]:focus {
  border: 3px solid #ffffff;
}
#steadyRoot QPushButton#tile:disabled { background: #1c2029; border-color: #4b5160; }
#steadyRoot QLabel#tileLabel { font-size: 18px; font-weight: 600; }
#steadyRoot QLineEdit {
  background: #0f1115; border: 2px solid #7d8696; border-radius: 8px;
  min-height: 52px; padding: 4px 8px; font-size: 18px;
}
#steadyRoot QLineEdit:focus { border: 3px solid #ffd166; }
#steadyRoot QSlider { min-height: 40px; }
#steadyRoot QSlider::groove:horizontal { height: 10px; background: #3a404d; border-radius: 5px; }
#steadyRoot QSlider::handle:horizontal {
  background: #ffd166; border: 2px solid #fff3c4; width: 28px; margin: -11px 0; border-radius: 15px;
}
#steadyRoot QSlider:focus::handle:horizontal { border: 3px solid #ffffff; }
#steadyRoot QProgressBar {
  background: #262b36; border: 2px solid #7d8696; border-radius: 8px; min-height: 22px; text-align: center;
}
#steadyRoot QProgressBar::chunk { background: #ffd166; border-radius: 6px; }
#steadyRoot QScrollArea { background: #0f1115; border: none; }
#steadyRoot QWidget#page { background: #0f1115; }
"""

DOT_STYLE = {
    "tracking": "background: #7ee0a1; border: 3px solid #7ee0a1; border-radius: 10px;",
    "weak": "background: #ffd166; border: 3px solid #ffd166; border-radius: 10px;",
    "lost": "background: transparent; border: 3px solid #ff6b6b; border-radius: 10px;",
}


def _repolish(w: QWidget) -> None:
    try:
        st = w.style()
        st.unpolish(w)
        st.polish(w)
    except Exception:
        pass


def _label(text: str = "", name: str = "", wrap: bool = True) -> QLabel:
    lab = QLabel(text)
    if name:
        lab.setObjectName(name)
    lab.setWordWrap(wrap)
    return lab


# --------------------------------------------------------------------------- tiles
class Tile(QPushButton):
    """A >= 64x64 button whose label wraps only between words (QLabel word wrap never splits a
    word; the minimum width is the longest word, so a word is never clipped either)."""

    def __init__(self, label: str, on_press: Optional[Callable[[], None]] = None, checkable: bool = False,
                 colour: Optional[str] = None, parent: Optional[QWidget] = None, accessible: Optional[str] = None):
        super().__init__(parent)
        self.setObjectName("tile")
        self.setFocusPolicy(STRONG_FOCUS)
        self.setCheckable(checkable)
        self.setSizePolicy(EXPANDING, MINIMUM)
        self._text = ""
        self._accessible = accessible
        self._lay = QVBoxLayout(self)
        self._lay.setContentsMargins(6, 4, 6, 4)
        self._lay.setSpacing(2)
        self.swatch: Optional[QLabel] = None
        if colour:
            self.swatch = QLabel()
            self.swatch.setFixedSize(28, 14)
            self.swatch.setStyleSheet(f"background: {colour}; border: 1px solid #f3f4f6; border-radius: 3px;")
            self.swatch.setAttribute(TRANSPARENT_MOUSE)
            self._lay.addWidget(self.swatch, 0, ALIGN_CENTER)
        self.label = QLabel()
        self.label.setObjectName("tileLabel")
        self.label.setWordWrap(True)
        self.label.setAlignment(ALIGN_CENTER)
        self.label.setAttribute(TRANSPARENT_MOUSE)
        self._lay.addWidget(self.label)
        self.set_label(label)
        if on_press is not None:
            self.clicked.connect(lambda *_: on_press())
        try:
            self.toggled.connect(lambda *_: self._sync_colour())
        except Exception:
            pass

    def set_label(self, text: str) -> None:
        if text == self._text:
            return
        self._text = text
        self.label.setText(text)
        self.setAccessibleName(self._accessible or text)
        try:
            fm = self.label.fontMetrics()
            word = longest_word(text) or text
            w = fm.horizontalAdvance(word) if hasattr(fm, "horizontalAdvance") else fm.width(word)
            self.setMinimumWidth(max(TILE_MIN, int(w * 1.15) + 20))  # bold 18 px is wider than the metrics' font
        except Exception:
            self.setMinimumWidth(TILE_MIN)
        self._fit_height()

    def text_label(self) -> str:
        return self._text

    def _fit_height(self) -> None:
        try:
            h = self.label.heightForWidth(max(10, self.width() - 12))
            if h <= 0:
                h = self.label.sizeHint().height()
            extra = self.swatch.height() + 2 if self.swatch is not None else 0
            self.setMinimumHeight(max(TILE_MIN, h + extra + 12))
        except Exception:
            self.setMinimumHeight(TILE_MIN)

    def resizeEvent(self, ev):  # noqa: N802 (Qt API)
        super().resizeEvent(ev)
        self._fit_height()

    def _sync_colour(self) -> None:
        dark = self.isChecked() or self.property("current") is True
        self.label.setStyleSheet("color: #111111;" if dark else "")

    def set_flag(self, name: str, on: bool) -> None:
        if bool(self.property(name)) == on:
            return
        self.setProperty(name, on)
        _repolish(self)
        self._sync_colour()

    def apply(self, view) -> None:
        """Render a panel_model.TileView without emitting clicked/toggled."""
        self.set_label(view.label)
        if self.isCheckable() != view.checkable:
            self.setCheckable(view.checkable)
        if view.checkable and self.isChecked() != view.checked:
            self.blockSignals(True)
            self.setChecked(view.checked)
            self.blockSignals(False)
            self._sync_colour()
        if self.isEnabled() != view.enabled:
            self.setEnabled(view.enabled)
        if self.toolTip() != view.tooltip:
            self.setToolTip(view.tooltip)
        self.set_flag("danger", bool(view.danger))


def _grid(tiles: List[QWidget], cols: int) -> QGridLayout:
    g = QGridLayout()
    g.setContentsMargins(0, 0, 0, 0)
    g.setHorizontalSpacing(GAP)
    g.setVerticalSpacing(GAP)
    for i, t in enumerate(tiles):
        g.addWidget(t, i // cols, i % cols)
    for c in range(cols):
        g.setColumnStretch(c, 1)
    return g


class SliderRow(QWidget):
    """[−] label value / QSlider [+]. The ± tiles are the dwell path; the slider is the keyboard path."""

    def __init__(self, spec: SliderSpec, hub: "Hub", parent: Optional[QWidget] = None):
        super().__init__(parent)
        self.spec, self.hub = spec, hub
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(GAP)
        self.down = Tile("−", lambda: hub.ctl.slider_step(spec.key, -1), accessible=f"{spec.label} down")
        self.up = Tile("+", lambda: hub.ctl.slider_step(spec.key, +1), accessible=f"{spec.label} up")
        for t in (self.down, self.up):
            t.setSizePolicy(FIXED, MINIMUM)
            t.setFixedWidth(TILE_MIN)
        mid = QVBoxLayout()
        mid.setSpacing(2)
        head = QHBoxLayout()
        self.name = _label(spec.label, wrap=False)
        self.value = _label("", "muted", wrap=False)
        head.addWidget(self.name)
        head.addStretch(1)
        head.addWidget(self.value)
        self.slider = QSlider(HORIZONTAL)
        self.slider.setFocusPolicy(STRONG_FOCUS)
        self.slider.setAccessibleName(spec.label)
        k = spec.scale
        self.slider.setRange(int(spec.lo * k), int(spec.hi * k))
        self.slider.setSingleStep(max(1, int(spec.step * k)))
        self.slider.setPageStep(max(1, int(spec.tile_step * k)))
        self.slider.valueChanged.connect(self._changed)
        self.slider.sliderReleased.connect(lambda: self._send(self.slider.value()))
        mid.addLayout(head)
        mid.addWidget(self.slider)
        lay.addWidget(self.down)
        lay.addLayout(mid, 1)
        lay.addWidget(self.up)
        self.render()

    def _changed(self, v: int) -> None:
        self.value.setText(self.spec.fmt(v / self.spec.scale))
        if not self.slider.isSliderDown():  # keyboard / click; a drag sends on release
            self._send(v)

    def _send(self, v: int) -> None:
        self.hub.ctl.slider(self.spec.key, v / self.spec.scale)

    def render(self) -> None:
        if self.slider.isSliderDown():
            return
        v = slider_value(self.spec, self.hub.model.state)
        iv = int(round(v * self.spec.scale))
        if self.slider.value() != iv:
            self.slider.blockSignals(True)
            self.slider.setValue(iv)
            self.slider.blockSignals(False)
        text = self.spec.fmt(v)
        self.value.setText(text)
        self.slider.setAccessibleDescription(text)
        self.down.setEnabled(v > self.spec.lo)
        self.up.setEnabled(v < self.spec.hi)


class TraceWidget(QWidget):
    """Demo page live trace: last ~3 s of the raw path, faded, plus the deviation in px."""

    def __init__(self, hub: "Hub", parent: Optional[QWidget] = None):
        super().__init__(parent)
        self.hub = hub
        self.setMinimumHeight(200)
        self.setSizePolicy(EXPANDING, FIXED)
        self.setAccessibleName("Live trace: raw path, faded")

    def paintEvent(self, ev):  # noqa: N802 (Qt API)
        p = QPainter(self)
        try:
            p.setRenderHint(ANTIALIAS)
            w, h = self.width(), self.height()
            p.fillRect(0, 0, w, h, QColor("#171a21"))
            st = self.hub.model.state
            raw = trail_points(st, "rawTrail")
            drawn = trail_points(st, "drawnTrail") or trail_points(st, "trail")
            tf = fit_trail([raw, drawn], w, h)
            for pts, colour, width in ((raw, QColor(255, 107, 107, 115), 2.0), (drawn, QColor("#ffd166"), 3.0)):
                if len(pts) < 2:
                    continue
                pen = QPen(colour)
                pen.setWidthF(width)
                p.setPen(pen)
                prev = tf(pts[0])
                for q in pts[1:]:
                    cur = tf(q)
                    p.drawLine(QPointF(*prev), QPointF(*cur))
                    prev = cur
            p.setPen(QColor("#f3f4f6"))
            p.drawText(10, h - 10, deviation_text(st))
        finally:
            p.end()


# --------------------------------------------------------------------------- dialogs
class SteadyDialog(QDialog):
    """Destructive confirm (Cancel focused, Confirm button, Esc cancels) or clarify (numbered options)."""

    def __init__(self, spec: Dict[str, Any], on_answer: Callable[[str], None], parent: Optional[QWidget] = None):
        super().__init__(parent)
        self.setObjectName("steadyRoot")
        self.setStyleSheet(STYLE)
        self.setWindowTitle("Steady")
        self.setModal(True)
        self.spec = spec
        self._on_answer = on_answer
        self._done = False
        self.setAccessibleName("Steady: confirm" if spec.get("kind") == "confirm" else "Steady: which one?")
        lay = QVBoxLayout(self)
        lay.setContentsMargins(16, 16, 16, 16)
        lay.setSpacing(12)
        self.text = _label(str(spec.get("text") or ""), "title")
        lay.addWidget(self.text)
        self.buttons: Dict[str, Tile] = {}
        row = QHBoxLayout() if spec.get("kind") == "confirm" else QVBoxLayout()
        row.setSpacing(GAP)
        for answer, label in dialog_buttons(spec):
            t = Tile(label, (lambda a=answer: self.answer(a)))
            t.setAutoDefault(True)
            if answer == "confirm":
                t.set_flag("danger", True)
            self.buttons[answer] = t
            row.addWidget(t)
        lay.addLayout(row)
        self.setMinimumWidth(360)
        self.cancel = self.buttons.get("cancel")
        if self.cancel is not None:
            self.cancel.setDefault(True)

    def showEvent(self, ev):  # noqa: N802 (Qt API)
        super().showEvent(ev)
        if self.cancel is not None:
            QTimer.singleShot(0, self.cancel.setFocus)

    def answer(self, a: str) -> None:
        if self._done:
            return
        self._done = True
        try:
            self._on_answer(a)
        finally:
            self.accept()

    def reject(self) -> None:  # Esc / window close = Cancel
        if not self._done:
            self._done = True
            try:
                self._on_answer("cancel")
            except Exception:
                pass
        super().reject()

    def close_silently(self) -> None:
        self._done = True
        super().reject()


# --------------------------------------------------------------------------- the panel widget
class SteadyPanel(QWidget):
    def __init__(self, hub: "Hub", parent: Optional[QWidget] = None):
        super().__init__(parent)
        self.hub = hub
        self.ctl = hub.ctl
        self.setObjectName("steadyRoot")
        self.setStyleSheet(STYLE)
        self.setMinimumWidth(4 * TILE_MIN + 3 * GAP + 24)
        self.action_tiles: Dict[str, List[Tile]] = {}
        self.sliders: List[SliderRow] = []
        self.setting_tiles: Dict[str, Tile] = {}
        self.page_buttons: Dict[str, Tile] = {}
        self.pages: Dict[str, QWidget] = {}
        self.dialog: Optional[SteadyDialog] = None
        self._dialog_return_focus: Optional[QWidget] = None

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        root.addWidget(self._build_header())
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setHorizontalScrollBarPolicy(SCROLL_OFF)
        holder = QWidget()
        holder.setObjectName("page")
        hl = QVBoxLayout(holder)
        hl.setContentsMargins(12, 12, 12, 12)
        hl.setSpacing(GAP)
        # privacy / permissions / calibration sit at the top of the scrolling area, so the docker can
        # stay short while the header (Start/Stop, status, core tiles, pages) stays pinned
        hl.addWidget(self._build_banners())
        for pid, label in PAGES:
            page = self._build_page(pid)
            page.setObjectName("page")
            page.setAccessibleName(f"{label} page")
            self.pages[pid] = page
            hl.addWidget(page)
        hl.addStretch(1)
        self.scroll.setWidget(holder)
        root.addWidget(self.scroll, 1)

        self.ctl.listeners.append(self._on_change)
        self.set_page(self.ctl.page if self.ctl.page in self.pages else "steady")
        self.render_all()

    # -- builders -------------------------------------------------------------------
    def _action_tile(self, action_id: str) -> Tile:
        view = self.ctl.tile(action_id)
        t = Tile(view.label, (lambda a=action_id: self.ctl.press(a)), checkable=view.checkable, colour=view.colour)
        t.setProperty("action", action_id)
        t.apply(view)
        self.action_tiles.setdefault(action_id, []).append(t)
        return t

    def _setting_tile(self, label: str, path: str) -> Tile:
        t = Tile(label, (lambda p=path: self.ctl.toggle_setting(p)), checkable=True)
        self.setting_tiles[path] = t
        return t

    def _build_header(self) -> QWidget:
        h = QFrame()
        h.setObjectName("header")
        lay = QVBoxLayout(h)
        lay.setContentsMargins(12, 12, 12, 12)
        lay.setSpacing(GAP)

        top = QHBoxLayout()
        top.setSpacing(GAP)
        self.start_tile = Tile("Start", self.hub.toggle_tracker)
        self.start_tile.set_flag("primary", True)
        self.start_tile.setSizePolicy(FIXED, MINIMUM)
        self.start_tile.setFixedWidth(96)
        top.addWidget(self.start_tile)
        info = QVBoxLayout()
        info.setSpacing(2)
        line1 = QHBoxLayout()
        line1.setSpacing(6)
        self.dot = QLabel()
        self.dot.setFixedSize(20, 20)
        self.tracking = _label("Lost", "title", wrap=False)
        self.fps = _label("– fps", "muted", wrap=False)
        self.fps.setAccessibleName("Detection frames per second")
        line1.addWidget(self.dot)
        line1.addWidget(self.tracking)
        line1.addStretch(1)
        line1.addWidget(self.fps)
        info.addLayout(line1)
        self.conn = _label("", "muted")
        self.krita = _label("", "muted")
        info.addWidget(self.conn)
        info.addWidget(self.krita)
        top.addLayout(info, 1)
        lay.addLayout(top)

        self.alert_box = QFrame()
        self.alert_box.setObjectName("alertBox")
        al = QVBoxLayout(self.alert_box)
        al.setContentsMargins(10, 6, 10, 6)
        self.alert = _label("", "alert")
        self.alert.setAccessibleName("Alert")
        al.addWidget(self.alert)
        lay.addWidget(self.alert_box)
        self.status = _label("", "status")
        self.status.setAccessibleName("Status")
        lay.addWidget(self.status)
        self.heard = _label("Heard: nothing yet", "muted")
        self.undo = _label("Undo: nothing yet", "muted")
        lay.addWidget(self.heard)
        lay.addWidget(self.undo)

        core = [self._action_tile(a["id"]) for a in header_actions(self.hub.table)]
        lay.addLayout(_grid(core, HEADER_COLUMNS))

        sel = []
        for pid, label in PAGES:
            t = Tile(label, (lambda p=pid: self.set_page(p)), accessible=f"{label} page")
            self.page_buttons[pid] = t
            sel.append(t)
        lay.addLayout(_grid(sel, SELECTOR_COLUMNS))
        return h

    def _build_banners(self) -> QWidget:
        w = QWidget()
        w.setObjectName("page")
        lay = QVBoxLayout(w)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(GAP)

        # first-run privacy (§0 rule 9), shown once
        self.privacy = QFrame()
        self.privacy.setObjectName("box")
        pl = QVBoxLayout(self.privacy)
        pl.setContentsMargins(10, 10, 10, 10)
        pl.addWidget(_label("Privacy", "title"))
        self.privacy_text = _label(PRIVACY_TEXT)
        pl.addWidget(self.privacy_text)
        self.privacy_ok = Tile("Got it", self._ack_privacy)
        pl.addWidget(self.privacy_ok)
        lay.addWidget(self.privacy)
        self.privacy.setVisible(not self.hub.privacy_acknowledged())

        # permissions: exactly what to grant to Steady Tracker
        self.perm_box = QFrame()
        self.perm_box.setObjectName("alertBox")
        self.perm_lay = QVBoxLayout(self.perm_box)
        self.perm_lay.setContentsMargins(10, 10, 10, 10)
        self.perm_lay.setSpacing(GAP)
        lay.addWidget(self.perm_box)
        self.perm_box.setVisible(False)

        # calibration progress (visible on every page while calibrating)
        self.calib_box = QFrame()
        self.calib_box.setObjectName("box")
        cl = QVBoxLayout(self.calib_box)
        cl.setContentsMargins(10, 10, 10, 10)
        self.calib_step = _label("", "title")
        self.calib_prompt = _label("")
        self.calib_bar = QProgressBar()
        self.calib_bar.setRange(0, 100)
        self.calib_bar.setAccessibleName("Calibration progress")
        cl.addWidget(self.calib_step)
        cl.addWidget(self.calib_prompt)
        cl.addWidget(self.calib_bar)
        lay.addWidget(self.calib_box)
        self.calib_box.setVisible(False)
        return w

    def _build_page(self, pid: str) -> QWidget:
        page = QWidget()
        lay = QVBoxLayout(page)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(GAP)
        table = self.hub.table
        ids = [a["id"] for a in page_actions(table, pid)]

        def sliders() -> None:
            for spec in sliders_for(pid):
                row = SliderRow(spec, self.hub)
                self.sliders.append(row)
                lay.addWidget(row)

        if pid == "paint":
            lay.addLayout(self._typed_box())
        if pid in ("steady", "krita"):
            sliders()
        if pid == "setup":
            self._build_setup(lay, ids)
        elif pid == "input":
            tiles: List[QWidget] = [self._action_tile(i) for i in ids]
            self.colorcap = Tile("Colour cap", self._toggle_colorcap, checkable=True)
            self.colorcap.setToolTip("Track a bright sticker on a glove, brace or fingertip instead of the hand.")
            tiles.insert(0, self.colorcap)
            tiles += [self._setting_tile(lbl, path) for lbl, path in SETTING_TOGGLES["input"]]
            lay.addLayout(_grid(tiles, columns_for(pid)))
        elif pid == "demo":
            lay.addLayout(_grid([self._action_tile(i) for i in ids], columns_for(pid)))
            self.tremor_caption = _label("Simulated tremor", "caption")
            lay.addWidget(self.tremor_caption)
            self.trace = TraceWidget(self.hub)
            lay.addWidget(self.trace)
            self.metrics = _label("", "muted")
            self.metrics.setAccessibleName("Metrics")
            lay.addWidget(self.metrics)
        else:
            if ids:
                lay.addLayout(_grid([self._action_tile(i) for i in ids], columns_for(pid)))
        if pid in ("modes", "timing"):
            sliders()
        if pid == "presets":
            lay.addWidget(_label("Each preset sets Steadiness, gain, hold times and Latch for how your hand is "
                                 "today. Change any slider afterwards.", "muted"))
        if pid == "steady":
            lay.addWidget(_label(COACHING_TEXT, "muted"))
        return page

    def _build_setup(self, lay: QVBoxLayout, ids: List[str]) -> None:
        prev_row = QHBoxLayout()
        self.preview = QLabel("No preview")
        self.preview.setFixedSize(160, 120)
        self.preview.setAlignment(ALIGN_CENTER)
        self.preview.setStyleSheet("background: #171a21; border: 2px solid #7d8696; border-radius: 6px;")
        self.preview.setAccessibleName("Camera preview")
        prev_row.addWidget(self.preview)
        prev_row.addStretch(1)
        lay.addLayout(prev_row)
        lay.addWidget(_label("Camera", "title"))
        self.camera_holder = QWidget()
        self.camera_lay = QVBoxLayout(self.camera_holder)
        self.camera_lay.setContentsMargins(0, 0, 0, 0)
        self.camera_lay.setSpacing(GAP)
        self.camera_tiles: List[Tile] = []
        self.no_camera = _label("No camera yet (press Start).", "muted")
        self.camera_lay.addWidget(self.no_camera)
        lay.addWidget(self.camera_holder)

        tiles: List[QWidget] = [self._setting_tile(lbl, path) for lbl, path in SETTING_TOGGLES["setup"]]
        rest = [i for i in ids if i not in ("use_profile",)]
        tiles += [self._action_tile(i) for i in rest]
        self.pointer_tile = Tile("Pointer point", self.ctl.cycle_landmark)
        self.pointer_tile.setToolTip("Which part of the hand moves the pointer. Index knuckle is the default.")
        tiles.append(self.pointer_tile)
        lay.addLayout(_grid(tiles, columns_for("setup")))

        lay.addWidget(_label("Profiles", "title"))
        prof: List[QWidget] = []
        if "use_profile" in ids:
            prof.append(self._action_tile("use_profile"))
        lay.addLayout(_grid(prof, columns_for("setup")))
        # one tile per saved profile (PanelState.profiles; Steady day / Shaky day when absent)
        self.profile_holder = QWidget()
        self.profile_lay = QGridLayout(self.profile_holder)
        self.profile_lay.setContentsMargins(0, 0, 0, 0)
        self.profile_lay.setHorizontalSpacing(GAP)
        self.profile_lay.setVerticalSpacing(GAP)
        self.profile_tiles: Dict[str, Tile] = {}
        lay.addWidget(self.profile_holder)
        self.render_profiles()

    def _typed_box(self) -> QHBoxLayout:
        row = QHBoxLayout()
        row.setSpacing(GAP)
        self.typed = QLineEdit()
        self.typed.setPlaceholderText("Type a command, e.g. steadier")
        self.typed.setAccessibleName("Command")
        self.typed.returnPressed.connect(self._run_typed)
        run = Tile("Run", self._run_typed)
        run.set_flag("primary", True)
        run.setSizePolicy(FIXED, MINIMUM)
        run.setFixedWidth(80)
        row.addWidget(self.typed, 1)
        row.addWidget(run)
        return row

    # -- user events ------------------------------------------------------------------
    def _run_typed(self) -> None:
        text = self.typed.text()
        if self.ctl.typed(text) is not None:
            self.typed.clear()

    def _toggle_colorcap(self) -> None:
        cur = self.hub.model.settings.get("trackingSource", "hand")
        self.ctl.set_setting("trackingSource", "hand" if cur == "colorcap" else "colorcap")

    def _ack_privacy(self) -> None:
        self.hub.acknowledge_privacy()

    def set_page(self, pid: str) -> None:
        for p, w in self.pages.items():
            w.setVisible(p == pid)
        for p, t in self.page_buttons.items():
            t.set_flag("current", p == pid)
            t.setAccessibleDescription("current page" if p == pid else "")
        self.ctl.set_page(pid)
        try:
            self.scroll.verticalScrollBar().setValue(0)
        except Exception:
            pass

    # -- rendering --------------------------------------------------------------------
    def _on_change(self, topics: set) -> None:
        try:
            if "dialog" in topics:
                self.render_dialog()
            if topics & {"state", "connection"}:
                self.render_all()
            else:
                if topics & {"status", "local_status", "heard"}:
                    self.render_header()
                if "cameras" in topics:
                    self.render_cameras()
                if "permissions" in topics:
                    self.render_permissions()
                if "preview" in topics:
                    self.render_preview()
                if "privacy" in topics:
                    self.privacy.setVisible(not self.hub.privacy_acknowledged())
        except RuntimeError:  # this docker's C++ side is gone (window closed)
            try:
                self.ctl.listeners.remove(self._on_change)
            except ValueError:
                pass

    def render_all(self) -> None:
        self.render_header()
        for aid, tiles in self.action_tiles.items():
            view = self.ctl.tile(aid)
            for t in tiles:
                t.apply(view)
        for row in self.sliders:
            row.render()
        s = self.hub.model.settings
        for path, t in self.setting_tiles.items():
            default = path.startswith("inputs.") or path in ("tts", "earcons", "dwellClickEnabled")
            on = bool(get_setting(s, path, default))
            if t.isChecked() != on:
                t.blockSignals(True)
                t.setChecked(on)
                t.blockSignals(False)
                t._sync_colour()
        on = s.get("trackingSource") == "colorcap"
        if self.colorcap.isChecked() != on:
            self.colorcap.blockSignals(True)
            self.colorcap.setChecked(on)
            self.colorcap.blockSignals(False)
            self.colorcap._sync_colour()
        self.pointer_tile.set_label(f"Pointer point: {landmark_name(s.get('landmark', 5))}")
        self.pointer_tile.setEnabled(not s.get("headMode"))
        st = self.hub.model.state
        cal = calibration_view(st)
        self.calib_box.setVisible(cal is not None)
        if cal is not None:
            self.calib_step.setText(f"Calibrating: {cal[0]}")
            self.calib_prompt.setText(cal[1])
            self.calib_bar.setValue(cal[2])
        self.tremor_caption.setVisible(bool(s.get("simulateTremor")))
        connected = self.hub.model.connected
        self.metrics.setText(
            f"{deviation_text(st)}\nCamera {st.get('cameraFps', '–') if connected else '–'} fps · "
            f"Detection {st.get('detectionFps', '–') if connected else '–'} fps")
        self.trace.update()
        self.render_cameras()
        self.render_profiles()
        self.render_permissions()
        self.render_preview()

    def render_header(self) -> None:
        m = self.hub.model
        connected = m.connected
        started = self.hub.client.started
        self.start_tile.set_label("Stop" if (connected or started) else "Start")
        self.start_tile.setToolTip("Stop Steady Tracker" if (connected or started) else
                                   f"Start {TRACKER_APP_NAME} (camera, voice, pointer)")
        word, kind = tracking_view(m.state, connected)
        self.dot.setStyleSheet(DOT_STYLE[kind])
        self.tracking.setText(tracking_text(m.state, connected))
        self.fps.setText(fps_text(m.state, connected))
        self.conn.setText(connection_text(connected, started))
        self.krita.setText(krita_text(m.state, connected))
        self.alert.setText(m.alert_text)
        self.alert_box.setVisible(bool(m.alert_text))
        self.status.setText(self.ctl.status_line())
        self.heard.setText(heard_text(m.heard))
        self.undo.setText(undo_text(m.state))

    def render_cameras(self) -> None:
        m = self.hub.model
        names = [(c.get("index"), str(c.get("name") or f"Camera {c.get('index')}")) for c in m.cameras]
        if [t.text_label() for t in self.camera_tiles] != [n for _, n in names]:
            for t in self.camera_tiles:
                self.camera_lay.removeWidget(t)
                t.deleteLater()
            self.camera_tiles = []
            for idx, name in names:
                t = Tile(name, (lambda i=idx: self.ctl.choose_camera(i)), checkable=True)
                self.camera_tiles.append(t)
                self.camera_lay.addWidget(t)
        self.no_camera.setVisible(not names)
        for t, (idx, _) in zip(self.camera_tiles, names):
            on = idx == m.camera_selected
            if t.isChecked() != on:
                t.blockSignals(True)
                t.setChecked(on)
                t.blockSignals(False)
                t._sync_colour()

    def render_profiles(self) -> None:
        names = profile_names(self.hub.model.state)
        if list(self.profile_tiles) == names:
            return
        for t in self.profile_tiles.values():
            self.profile_lay.removeWidget(t)
            t.deleteLater()
        self.profile_tiles = {}
        cols = columns_for("setup")
        for i, name in enumerate(names):
            t = Tile(name, (lambda n=name: self.ctl.use_profile(n)))
            t.setToolTip(f"Use the {name} profile")
            self.profile_tiles[name] = t
            self.profile_lay.addWidget(t, i // cols, i % cols)

    def render_permissions(self) -> None:
        missing = missing_permissions(self.hub.model.permissions) if self.hub.model.connected else []
        key = [p["key"] for p in missing]
        if getattr(self, "_perm_key", None) != key:
            self._perm_key = key
            while self.perm_lay.count():
                item = self.perm_lay.takeAt(0)
                w = item.widget()
                if w is not None:
                    w.deleteLater()
            if missing:
                self.perm_lay.addWidget(_label(f"{TRACKER_APP_NAME} needs permission", "alert"))
                for p in missing:
                    self.perm_lay.addWidget(_label(p["text"]))
                    self.perm_lay.addWidget(Tile(p["button"], (lambda u=p["url"]: self.hub.open_url(u))))
                self.perm_lay.addWidget(_label(PERMISSIONS_FOOTER, "muted"))
        self.perm_box.setVisible(bool(missing))

    def render_preview(self) -> None:
        data = self.hub.model.preview_bytes()
        if not data:
            if self.preview.pixmap() is None or not self.hub.model.connected:
                self.preview.setText("No preview")
            return
        pm = QPixmap()
        if pm.loadFromData(data, "JPG"):
            self.preview.setPixmap(pm.scaled(self.preview.width(), self.preview.height(), KEEP_ASPECT, SMOOTH))

    def render_dialog(self) -> None:
        spec = self.hub.model.dialog
        if self.dialog is not None:
            if spec is not None and spec.get("dialog_id") == self.dialog.spec.get("dialog_id"):
                return
            self.dialog.close_silently()
            self.dialog = None
            self._restore_focus()
        if spec is None or not self.hub.is_dialog_owner(self):
            return
        self._dialog_return_focus = QApplication.focusWidget()
        self.dialog = SteadyDialog(spec, self.ctl.answer_dialog, self)
        self.dialog.finished.connect(lambda *_: self._dialog_closed())
        self.dialog.open()

    def _dialog_closed(self) -> None:
        self.dialog = None
        self._restore_focus()

    def _restore_focus(self) -> None:
        w, self._dialog_return_focus = self._dialog_return_focus, None
        try:
            if w is not None:
                w.setFocus()
        except RuntimeError:
            pass


# --------------------------------------------------------------------------- the hub (one per Krita)
class Hub:
    """One tracker connection shared by every Krita window's Steady docker."""

    _instance: Optional["Hub"] = None

    @classmethod
    def get(cls) -> "Hub":
        if cls._instance is None:
            cls._instance = Hub()
        return cls._instance

    def __init__(self, table: Optional[ActionTable] = None, client: Optional[TrackerClient] = None,
                 app: Any = None, plugin_version: str = "", probe: bool = True) -> None:
        self.app = app if app is not None else (Krita.instance() if Krita is not None else None)
        self.plugin_version = plugin_version or _plugin_version()
        self.table = table or ActionTable.load()
        self.model = PanelModel()
        self.client = client or TrackerClient(hello=self._hello)
        self.ctl = PanelController(self.table, self.model, self.client.send)
        self.client.on_message = self.ctl.on_message
        self.client.on_ack = self.ctl.on_ack
        self.client.on_connected = self.ctl.on_connected
        self.client.on_disconnected = self.ctl.on_disconnected
        self.client.on_tick = self.tick
        self.dockers: List[Any] = []
        self.panels: List[SteadyPanel] = []
        self._last_rect: Any = "unset"
        if probe:
            try:
                QTimer.singleShot(1500, self.client.probe)  # a tracker left running shows up without Start
            except Exception:
                pass

    def _hello(self) -> Dict[str, Any]:
        kv = ""
        try:
            kv = str(self.app.version()) if self.app is not None else ""
        except Exception:
            pass
        return self.ctl.msgs.hello(self.plugin_version, kv)

    # -- start / stop
    def toggle_tracker(self) -> None:
        if self.model.connected or self.client.started:
            self.stop_tracker()
        else:
            self.start_tracker()

    def start_tracker(self) -> None:
        ok, text = launcher.launch()
        # Connect even when the app is missing: a tracker started by hand (scripts/run-tracker.sh) is used.
        self.client.start()
        self.ctl.say(text if not ok or not self.model.connected else "")
        self.ctl.notify({"connection"})

    def stop_tracker(self) -> None:
        if self.model.connected:
            self.client.send(self.ctl.msgs.quit())
            self.ctl.say("Stopping Steady Tracker…")
        self.client.stop()  # graceful: the quit line is flushed before the socket closes
        self.ctl.notify({"connection"})

    # -- privacy (persisted in Krita's settings: shown once)
    def privacy_acknowledged(self) -> bool:
        try:
            return str(self.app.readSetting(SETTINGS_GROUP, PRIVACY_KEY, "")) == "1"
        except Exception:
            return False

    def acknowledge_privacy(self) -> None:
        try:
            self.app.writeSetting(SETTINGS_GROUP, PRIVACY_KEY, "1")
        except Exception:
            pass
        self.ctl.notify({"privacy"})

    def open_url(self, url: str) -> None:
        try:
            QDesktopServices.openUrl(QUrl(url))
        except Exception:
            pass

    # -- dockers and the panel rect
    def register(self, docker: Any, panel: SteadyPanel) -> None:
        self.dockers.append(docker)
        self.panels.append(panel)

    def unregister(self, docker: Any) -> None:
        if docker in self.dockers:
            i = self.dockers.index(docker)
            self.dockers.pop(i)
            panel = self.panels.pop(i)
            try:
                self.ctl.listeners.remove(panel._on_change)
            except ValueError:
                pass

    def active_docker(self) -> Any:
        """The visible docker, preferring one in the active window."""
        visible = []
        for d in list(self.dockers):
            try:
                if d.isVisible():
                    visible.append(d)
            except RuntimeError:
                self.unregister(d)
        for d in visible:
            try:
                if d.window().isActiveWindow():
                    return d
            except Exception:
                pass
        return visible[0] if visible else None

    def is_dialog_owner(self, panel: SteadyPanel) -> bool:
        d = self.active_docker()
        if d is None:
            return bool(self.panels) and panel is self.panels[0]
        try:
            return self.panels[self.dockers.index(d)] is panel
        except (ValueError, IndexError):
            return True

    def docker_rect(self) -> Optional[Dict[str, int]]:
        d = self.active_docker()
        if d is None:
            return None
        tl = d.mapToGlobal(QPoint(0, 0))
        return rect_dict(tl.x(), tl.y(), d.width(), d.height())

    def report_rect(self, force: bool = False) -> None:
        try:
            rect = self.docker_rect()
        except RuntimeError:
            rect = None
        self.ctl.set_visible(rect is not None)
        if not self.model.connected:
            self._last_rect = "unset"
            return
        # rect null = panel hidden (lead decision; the tracker must not clamp Pause to a stale rect)
        if force or rect != self._last_rect:
            self._last_rect = rect
            self.client.send(self.ctl.msgs.panel_rect(rect))

    def tick(self) -> None:
        """Every 1 s (client timer): the panel rect, even unchanged (the tracker may have restarted)."""
        self.report_rect(force=True)

    def show_panel(self) -> None:
        for d in list(self.dockers):
            try:
                if d.window().isActiveWindow() or len(self.dockers) == 1:
                    d.show()
                    d.raise_()
            except RuntimeError:
                self.unregister(d)
        self.report_rect(force=True)

    def status_line(self) -> str:
        return connection_text(self.model.connected, self.client.started)


def _plugin_version() -> str:
    try:
        from . import PLUGIN_VERSION

        return PLUGIN_VERSION
    except Exception:
        return ""


if DockWidget is not None:

    class SteadyDocker(DockWidget):  # type: ignore[misc, valid-type]
        def __init__(self):
            super().__init__()
            self.setWindowTitle("Steady")
            self.hub = Hub.get()
            self.panel = SteadyPanel(self.hub, self)
            self.setWidget(self.panel)
            self.hub.register(self, self.panel)
            try:
                self.visibilityChanged.connect(lambda *_: self.hub.report_rect(force=True))
                self.topLevelChanged.connect(lambda *_: self.hub.report_rect(force=True))
                self.destroyed.connect(lambda *_: self.hub.unregister(self))
            except Exception:
                pass

        def canvasChanged(self, canvas):  # noqa: N802 (Krita API; required)
            pass

        def moveEvent(self, ev):  # noqa: N802 (Qt API)
            super().moveEvent(ev)
            self.hub.report_rect()

        def resizeEvent(self, ev):  # noqa: N802 (Qt API)
            super().resizeEvent(ev)
            self.hub.report_rect()

        def showEvent(self, ev):  # noqa: N802 (Qt API)
            super().showEvent(ev)
            self.hub.report_rect(force=True)

        def hideEvent(self, ev):  # noqa: N802 (Qt API)
            super().hideEvent(ev)
            self.hub.report_rect(force=True)
else:  # pragma: no cover - outside Krita
    SteadyDocker = None  # type: ignore[assignment, misc]

__all__ = ["DOCKER_ID", "Hub", "SteadyDocker", "SteadyPanel", "SteadyDialog", "Tile", "INSTALL_HINT"]
