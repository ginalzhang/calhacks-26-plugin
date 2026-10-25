"""A small functional stand-in for PyQt5 + krita, enough to build the Steady panel's widget tree and
click its buttons without Qt (the test venv has no PyQt5; real Krita is checked by hand, NEEDS-HUMAN.md).

Unknown methods follow Qt naming: setFoo(v) stores, foo()/isFoo() reads; anything else returns an
inert `_Any`. Unknown class names in a stub module become QWidget subclasses.
"""
from __future__ import annotations

import sys
import types
from contextlib import contextmanager
from typing import Any, Dict, List


class _Any:
    def __call__(self, *a, **k): return _Any()
    def __getattr__(self, name): return _Any()
    def __bool__(self): return False
    def __int__(self): return 0
    def __float__(self): return 0.0
    def __iter__(self): return iter(())
    def __or__(self, o): return self
    __ror__ = __or__
    def __mul__(self, o): return 0
    __rmul__ = __mul__


class _Meta(type):
    def __getattr__(cls, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return name  # enum members: Qt.AlignCenter -> "AlignCenter"


class Signal:
    def __init__(self):
        self.slots: List[Any] = []

    def connect(self, fn):
        self.slots.append(fn)

    def disconnect(self, *a):
        self.slots.clear()

    def emit(self, *args):
        for fn in list(self.slots):
            fn(*args)


_DEFAULT_TRUE = {"enabled", "activewindow"}


class QObject(metaclass=_Meta):
    _signals: tuple = ("destroyed",)

    def __init__(self, *args, **kwargs):
        object.__setattr__(self, "_p", {})
        object.__setattr__(self, "_blocked", False)
        for cls in type(self).__mro__:
            for s in getattr(cls, "_signals", ()):
                if s not in self.__dict__:
                    object.__setattr__(self, s, Signal())

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        p = self.__dict__.setdefault("_p", {})
        if name.startswith("set") and len(name) > 3 and name[3].isupper():
            key = name[3:].lower()

            def setter(*a, **k):
                p[key] = a[0] if len(a) == 1 else a
            return setter
        if name.startswith("is") and len(name) > 2 and name[2].isupper():
            key = name[2:].lower()
            return lambda *a: bool(p.get(key, key in _DEFAULT_TRUE))
        if name.lower() in p:
            return lambda *a: p[name.lower()]
        return _Any()

    def blockSignals(self, b):
        self._blocked = b

    def property(self, name):
        return self._p.get(("prop", name))

    def setProperty(self, name, value):
        self._p[("prop", name)] = value


class QWidget(QObject):
    def __init__(self, *args, **kwargs):
        super().__init__()
        self._p["visible"] = False
        self.children_: List[Any] = []
        self._layout = None
        self._w, self._h = 380, 900

    def setLayout(self, lay):
        self._layout = lay

    def layout(self):
        return self._layout

    def show(self): self._p["visible"] = True
    def hide(self): self._p["visible"] = False
    def setVisible(self, v): self._p["visible"] = bool(v)
    def isVisible(self): return self._p.get("visible", False)
    def isHidden(self): return not self._p.get("visible", False)
    def width(self): return self._w
    def height(self): return self._h
    def resize(self, w, h): self._w, self._h = w, h
    def window(self): return self
    def raise_(self): pass
    def deleteLater(self): self._p["deleted"] = True
    def mapToGlobal(self, p): return QPoint(100 + p.x(), 50 + p.y())
    def style(self): return _Any()
    def update(self): pass
    def fontMetrics(self): return _Any()


class QLayout(QObject):
    def __init__(self, parent=None):
        super().__init__()
        self.items: List[Any] = []
        if isinstance(parent, QWidget):
            parent.setLayout(self)

    def addWidget(self, w, *a): self.items.append(w)
    def addLayout(self, lay, *a): self.items.append(lay)
    def addStretch(self, *a): pass
    def removeWidget(self, w):
        if w in self.items:
            self.items.remove(w)
    def count(self): return len(self.items)

    def takeAt(self, i):
        it = self.items.pop(i)
        return types.SimpleNamespace(widget=lambda: it if isinstance(it, QWidget) else None)

    def widgets(self) -> List[Any]:
        out = []
        for it in self.items:
            if isinstance(it, QWidget):
                out.append(it)
                if it.layout() is not None:
                    out += it.layout().widgets()
            elif isinstance(it, QLayout):
                out += it.widgets()
        return out


class QVBoxLayout(QLayout): pass
class QHBoxLayout(QLayout): pass
class QGridLayout(QLayout): pass


class QLabel(QWidget):
    def __init__(self, text="", *a):
        super().__init__()
        self._p["text"] = text

    def text(self): return self._p.get("text", "")
    def setText(self, t): self._p["text"] = t
    def pixmap(self): return self._p.get("pixmap")


class QPushButton(QWidget):
    _signals = ("clicked", "toggled")

    def text(self): return self._p.get("text", "")
    def setText(self, t): self._p["text"] = t

    def setChecked(self, v):
        v = bool(v)
        changed = v != self._p.get("checked", False)
        self._p["checked"] = v
        if changed and not self._blocked:
            self.toggled.emit(v)

    def isChecked(self): return self._p.get("checked", False)

    def click(self):
        if not self.isEnabled():
            return
        if self.isCheckable():
            self.setChecked(not self.isChecked())
        self.clicked.emit(False)


class QLineEdit(QWidget):
    _signals = ("returnPressed",)

    def text(self): return self._p.get("text", "")
    def setText(self, t): self._p["text"] = t
    def clear(self): self._p["text"] = ""


class QSlider(QWidget):
    _signals = ("valueChanged", "sliderReleased")

    def setRange(self, lo, hi): self._p["range"] = (lo, hi)
    def value(self): return self._p.get("value", 0)

    def setValue(self, v):
        lo, hi = self._p.get("range", (0, 99))
        v = max(lo, min(hi, int(v)))
        changed = v != self.value()
        self._p["value"] = v
        if changed and not self._blocked:
            self.valueChanged.emit(v)


class QDialog(QWidget):
    _signals = ("finished",)

    def open(self): self._p["visible"] = True
    def accept(self):
        self._p["visible"] = False
        self.finished.emit(1)
    def reject(self):
        was = self._p.get("visible")
        self._p["visible"] = False
        if was:
            self.finished.emit(0)


class QDockWidget(QWidget):
    _signals = ("visibilityChanged", "topLevelChanged")

    def setWidget(self, w): self._p["widget"] = w
    def widget(self): return self._p.get("widget")


class QScrollArea(QWidget):
    def setWidget(self, w): self._p["widget"] = w
    def widget(self): return self._p.get("widget")


class QTimer(QObject):
    _signals = ("timeout",)
    shots: List[Any] = []

    @staticmethod
    def singleShot(ms, fn):
        QTimer.shots.append((ms, fn))


class QAbstractSocket(QObject):
    UnconnectedState, ConnectingState, ConnectedState = 0, 1, 2


class QTcpSocket(QAbstractSocket):
    _signals = ("connected", "disconnected", "readyRead", "errorOccurred")

    def __init__(self, *a):
        super().__init__()
        self._state = 0
        self.written: List[bytes] = []
        self.connects: List[Any] = []

    def state(self): return self._state
    def connectToHost(self, host, port):
        self.connects.append((host, port))
        self._state = 1
    def write(self, data):
        self.written.append(bytes(data))
        return len(data)
    def abort(self): self._state = 0
    def disconnectFromHost(self): self._state = 0


class QPoint:
    def __init__(self, x=0, y=0): self._x, self._y = x, y
    def x(self): return self._x
    def y(self): return self._y


class QPointF(QPoint): pass


class QUrl:
    def __init__(self, s=""): self.s = s
    def toString(self): return self.s


class QDesktopServices:
    opened: List[str] = []

    @staticmethod
    def openUrl(url):
        QDesktopServices.opened.append(url.toString())
        return True


class QPixmap(QObject):
    def loadFromData(self, data, fmt=None): return bool(data)
    def scaled(self, *a): return self


class QApplication(QObject):
    @staticmethod
    def focusWidget(): return None


class _StubModule(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        cls = type(name, (QWidget,), {})
        setattr(self, name, cls)
        return cls


def build_pyqt5() -> Dict[str, types.ModuleType]:
    pkg = _StubModule("PyQt5")
    core, gui, widgets, net = (_StubModule(f"PyQt5.{n}") for n in ("QtCore", "QtGui", "QtWidgets", "QtNetwork"))
    core.QObject, core.QTimer, core.QPoint, core.QPointF, core.QUrl = QObject, QTimer, QPoint, QPointF, QUrl
    core.Qt = type("Qt", (QObject,), {})
    gui.QDesktopServices, gui.QPixmap = QDesktopServices, QPixmap
    gui.QColor = type("QColor", (QObject,), {})
    gui.QPen = type("QPen", (QObject,), {})
    gui.QPainter = type("QPainter", (QObject,), {})
    for c in (QWidget, QLabel, QPushButton, QLineEdit, QSlider, QDialog, QDockWidget, QScrollArea,
              QVBoxLayout, QHBoxLayout, QGridLayout, QApplication):
        setattr(widgets, c.__name__, c)
    widgets.QFrame = type("QFrame", (QWidget,), {})
    widgets.QProgressBar = type("QProgressBar", (QWidget,), {})
    widgets.QSizePolicy = type("QSizePolicy", (QObject,), {})
    widgets.QMenu = type("QMenu", (QWidget,), {})
    widgets.QMessageBox = type("QMessageBox", (QWidget,), {})
    net.QAbstractSocket, net.QTcpSocket = QAbstractSocket, QTcpSocket
    pkg.QtCore, pkg.QtGui, pkg.QtWidgets, pkg.QtNetwork = core, gui, widgets, net
    return {"PyQt5": pkg, "PyQt5.QtCore": core, "PyQt5.QtGui": gui, "PyQt5.QtWidgets": widgets,
            "PyQt5.QtNetwork": net}


class FakeKritaApp:
    def __init__(self):
        self.settings: Dict[Any, str] = {}
        self.extensions: List[Any] = []
        self.factories: List[Any] = []

    def version(self): return "5.3.4"
    def readSetting(self, g, k, d): return self.settings.get((g, k), d)
    def writeSetting(self, g, k, v): self.settings[(g, k)] = v
    def addExtension(self, e): self.extensions.append(e)
    def addDockWidgetFactory(self, f): self.factories.append(f)
    def activeWindow(self): return None
    def notifier(self): return _Any()


def build_krita(app: FakeKritaApp) -> types.ModuleType:
    k = types.ModuleType("krita")

    class Krita:
        @staticmethod
        def instance(): return app

    class Extension(QObject):
        def __init__(self, parent=None): super().__init__()

    class DockWidgetFactory:
        def __init__(self, id_, area, cls): self.id, self.area, self.cls = id_, area, cls

    class DockWidgetFactoryBase:
        DockRight = "DockRight"

    k.Krita, k.Extension, k.DockWidget = Krita, Extension, QDockWidget
    k.DockWidgetFactory, k.DockWidgetFactoryBase = DockWidgetFactory, DockWidgetFactoryBase
    k.ManagedColor = type("ManagedColor", (QObject,), {})
    return k


_PREFIXES = ("PyQt5", "PyQt6", "krita", "steady")


@contextmanager
def stubbed(app: FakeKritaApp = None):
    """Install stub PyQt5 + krita for the duration; restore sys.modules (and steady) afterwards."""
    app = app or FakeKritaApp()
    saved = {k: v for k, v in sys.modules.items() if k.split(".")[0] in _PREFIXES}
    for k in list(saved):
        del sys.modules[k]
    sys.modules.update(build_pyqt5())
    sys.modules["krita"] = build_krita(app)
    QTimer.shots.clear()
    QDesktopServices.opened.clear()
    try:
        yield app
    finally:
        for k in [k for k in sys.modules if k.split(".")[0] in _PREFIXES]:
            del sys.modules[k]
        sys.modules.update(saved)
