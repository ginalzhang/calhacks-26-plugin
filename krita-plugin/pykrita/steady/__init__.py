"""Steady Krita plugin.

Two parts:
  * the bridge: listens on tcp 127.0.0.1:8766 for newline-delimited JSON commands from Steady
    Tracker / the helper (docs/PROTOCOL.md) and runs them on Krita's GUI thread;
  * the Steady panel (panel.py): a docker that is Steady's whole user interface. It launches
    Steady Tracker.app and talks to it on 127.0.0.1:8767 (tracker/PROTOCOL.md §1).
Both use localhost only. Tested on Krita 5.3.x (Qt5/PyQt5); loads on Krita 6 (PyQt6) but that is
untested. The bridge never depends on the panel: if the panel fails to load, the bridge still runs.

Importing this package outside Krita (pytest) registers nothing.
"""
from __future__ import annotations

PLUGIN_VERSION = "0.1.0"
TESTED = "Krita 5.3.x"


def _log(msg: str) -> None:
    try:
        print(msg, flush=True)
    except Exception:
        pass


try:
    from krita import Extension, Krita  # type: ignore[import-not-found]
except ImportError:  # not running inside Krita
    Krita = None  # type: ignore[assignment]

if Krita is not None and Krita.instance() is not None:
    from .adapter import QT_BINDING, QTimer, KritaAdapter
    from .bridge import HOST, PORT, Bridge
    from .dispatch import dispatch

    try:
        from PyQt5.QtWidgets import QMenu, QMessageBox
    except ImportError:  # Krita 6
        from PyQt6.QtWidgets import QMenu, QMessageBox

    PANEL_ERROR = ""
    try:  # the panel (docker) is optional: a failure here must not take the bridge down
        from krita import DockWidgetFactory, DockWidgetFactoryBase

        from .panel import DOCKER_ID, Hub, SteadyDocker

        Krita.instance().addDockWidgetFactory(
            DockWidgetFactory(DOCKER_ID, DockWidgetFactoryBase.DockRight, SteadyDocker)
        )
    except Exception as e:  # never raise into Krita
        Hub = None  # type: ignore[assignment]
        PANEL_ERROR = f"{type(e).__name__}: {e}"
        _log(f"Steady panel failed to load: {PANEL_ERROR}")

    class SteadyExtension(Extension):
        def __init__(self, parent):
            super().__init__(parent)
            self.bridge = None
            self.adapter = None
            self.timer = None
            self.listen_status = "not started"

        def setup(self):
            app = Krita.instance()
            version = str(app.version())
            tested = version.startswith("5.3")
            self.version_status = (
                f"Krita {version}, {QT_BINDING}"
                + ("" if tested else f" (untested: Steady is tested on {TESTED})")
            )
            try:
                self.adapter = KritaAdapter(app)
                self.bridge = Bridge(lambda cmd: dispatch(cmd, self.adapter), HOST, PORT, log=_log)
                # Every Krita API call happens here, on the GUI thread (20 ms drain).
                self.timer = QTimer(self)
                self.timer.setInterval(20)
                self.timer.timeout.connect(self._drain)
                self.timer.start()
                self.bridge.start()
                self.listen_status = f"listening on {HOST}:{PORT}"
            except OSError as e:
                self.listen_status = f"could not listen on {HOST}:{PORT} ({e}); is another Krita open?"
            except Exception as e:  # never raise into Krita
                self.listen_status = f"failed to start: {type(e).__name__}: {e}"
            _log(f"Steady plugin {PLUGIN_VERSION}: {self.listen_status}; {self.version_status}")
            try:
                app.notifier().applicationClosing.connect(self._shutdown)
            except Exception:
                pass

        def createActions(self, window):
            try:
                a = window.createAction("steady_status", "Steady: connection status", "tools/scripts")
                a.triggered.connect(self._show_status)
            except Exception:
                pass
            # Tools > Steady > Start tracker / Stop tracker / Show panel
            try:
                menu_action = window.createAction("steady_menu", "Steady", "tools")
                menu_action.setMenu(QMenu("Steady", window.qwindow()))
                for aid, text, fn in (
                    ("steady_start_tracker", "Start tracker", self._start_tracker),
                    ("steady_stop_tracker", "Stop tracker", self._stop_tracker),
                    ("steady_show_panel", "Show panel", self._show_panel),
                    ("steady_status_menu", "Connection status", self._show_status),
                ):
                    act = window.createAction(aid, text, "tools/steady_menu")
                    act.triggered.connect(fn)
            except Exception as e:
                _log(f"Steady menu failed: {e}")

        def _hub(self):
            return Hub.get() if Hub is not None else None

        def _start_tracker(self):
            try:
                hub = self._hub()
                if hub is not None:
                    hub.start_tracker()
                    hub.show_panel()
            except Exception as e:
                _log(f"Start tracker: {e}")

        def _stop_tracker(self):
            try:
                hub = self._hub()
                if hub is not None:
                    hub.stop_tracker()
            except Exception as e:
                _log(f"Stop tracker: {e}")

        def _show_panel(self):
            try:
                hub = self._hub()
                if hub is not None:
                    hub.show_panel()
            except Exception as e:
                _log(f"Show panel: {e}")

        def _drain(self):
            try:
                if self.bridge is not None:
                    self.bridge.drain()
            except Exception:
                pass

        def status_text(self) -> str:
            b = self.bridge
            conns = b.connections if b else 0
            handled = b.handled if b else 0
            helper = "helper connected" if conns else "helper not connected (run: npm run helper)"
            if Hub is None:
                panel = f"panel: failed to load ({PANEL_ERROR})"
            else:
                try:
                    panel = f"panel: {Hub.get().status_line()}"
                except Exception as e:
                    panel = f"panel: {e}"
            return (
                f"Steady plugin {PLUGIN_VERSION}\n{self.listen_status}\n{helper}\n"
                f"commands handled: {handled}\n{panel}\n{self.version_status}\nTested on {TESTED}."
            )

        def _show_status(self):
            try:
                QMessageBox.information(None, "Steady", self.status_text())
            except Exception:
                pass

        def _shutdown(self):
            try:
                if self.timer is not None:
                    self.timer.stop()
                if self.bridge is not None:
                    self.bridge.stop()
            except Exception:
                pass

    Krita.instance().addExtension(SteadyExtension(Krita.instance()))
