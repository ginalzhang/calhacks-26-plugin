"""Steady panel <-> Steady Tracker client: QTcpSocket to 127.0.0.1:8767 on Krita's GUI thread.

Newline-delimited JSON (tracker/PROTOCOL.md §1). Non-blocking: no waitFor* calls. While started,
it reconnects every 1 s; on connect it sends `hello`. Acks are matched by id (AckTracker).
Framing, builders and ack bookkeeping live in panel_model (pure, unit-tested).
"""
from __future__ import annotations

import time
from typing import Any, Callable, Dict, Optional

try:  # Krita 5.x (Qt5) is the tested target
    from PyQt5.QtCore import QObject, QTimer
    from PyQt5.QtNetwork import QAbstractSocket, QTcpSocket

    _UNCONNECTED = QAbstractSocket.UnconnectedState
    _CONNECTING = QAbstractSocket.ConnectingState
    _CONNECTED = QAbstractSocket.ConnectedState
except ImportError:  # Krita 6.x (Qt6): loads, untested
    from PyQt6.QtCore import QObject, QTimer
    from PyQt6.QtNetwork import QAbstractSocket, QTcpSocket

    _UNCONNECTED = QAbstractSocket.SocketState.UnconnectedState
    _CONNECTING = QAbstractSocket.SocketState.ConnectingState
    _CONNECTED = QAbstractSocket.SocketState.ConnectedState

from .panel_model import TRACKER_HOST, TRACKER_PORT, AckTracker, LineFramer, encode

RECONNECT_MS = 1000
CONNECT_TIMEOUT_S = 2.0


def _log(msg: str) -> None:
    try:
        print(f"Steady panel: {msg}", flush=True)
    except Exception:
        pass


class TrackerClient(QObject):
    def __init__(self, parent=None, host: str = TRACKER_HOST, port: int = TRACKER_PORT,
                 hello: Optional[Callable[[], Dict[str, Any]]] = None) -> None:
        super().__init__(parent)
        self.host, self.port = host, port
        self.hello = hello
        self.framer = LineFramer()
        self.acks = AckTracker()
        self.started = False
        self.connected = False
        self._connect_t = 0.0
        # callbacks (set by the controller)
        self.on_message: Callable[[Dict[str, Any]], None] = lambda m: None
        self.on_ack: Callable[[Optional[Dict[str, Any]], Dict[str, Any]], None] = lambda req, ack: None
        self.on_connected: Callable[[], None] = lambda: None
        self.on_disconnected: Callable[[], None] = lambda: None
        self.on_tick: Callable[[], None] = lambda: None

        self.sock = QTcpSocket(self)
        self.sock.connected.connect(self._connected)
        self.sock.disconnected.connect(self._disconnected)
        self.sock.readyRead.connect(self._ready_read)
        err = getattr(self.sock, "errorOccurred", None)  # Qt >= 5.15
        if err is None:
            err = getattr(self.sock, "error", None)
        try:
            err.connect(self._error)
        except Exception:
            pass
        self.timer = QTimer(self)
        self.timer.setInterval(RECONNECT_MS)
        self.timer.timeout.connect(self._tick)
        self.timer.start()

    # -- control ------------------------------------------------------------------
    def start(self) -> None:
        self.started = True
        self._try_connect()

    def probe(self) -> None:
        """One connection attempt without 'started' (a tracker left running from before shows up)."""
        self._try_connect()

    def stop(self) -> None:
        self.started = False
        try:
            self.sock.disconnectFromHost()
        except Exception:
            pass

    def abort(self) -> None:
        self.started = False
        try:
            self.sock.abort()
        except Exception:
            pass
        if self.connected:
            self._disconnected()

    def send(self, msg: Dict[str, Any]) -> bool:
        if not self.connected or self.sock.state() != _CONNECTED:
            return False
        data = encode(msg)
        try:
            n = self.sock.write(data)
        except Exception as e:
            _log(f"write failed: {e}")
            return False
        if n != len(data) and n < 0:
            return False
        self.acks.sent(msg)
        return True

    # -- socket events --------------------------------------------------------------
    def _try_connect(self) -> None:
        try:
            st = self.sock.state()
            if st == _UNCONNECTED:
                self.framer.reset()
                self._connect_t = time.monotonic()
                self.sock.connectToHost(self.host, self.port)
            elif st == _CONNECTING and time.monotonic() - self._connect_t > CONNECT_TIMEOUT_S:
                self.sock.abort()
        except Exception as e:
            _log(f"connect failed: {e}")

    def _tick(self) -> None:
        try:
            if self.started and not self.connected:
                self._try_connect()
            for req in self.acks.expire():
                self.on_ack(req, {"t": "ack", "id": req.get("id"), "ok": False, "error": "no reply"})
            self.on_tick()
        except Exception as e:
            _log(f"tick: {e}")

    def _connected(self) -> None:
        self.connected = True
        self.framer.reset()
        self.acks.clear()
        if self.hello is not None:
            try:
                self.send(self.hello())
            except Exception as e:
                _log(f"hello: {e}")
        _log(f"connected to {self.host}:{self.port}")
        try:
            self.on_connected()
        except Exception as e:
            _log(f"on_connected: {e}")

    def _disconnected(self) -> None:
        was = self.connected
        self.connected = False
        self.acks.clear()
        if was:
            _log("disconnected")
            try:
                self.on_disconnected()
            except Exception as e:
                _log(f"on_disconnected: {e}")

    def _error(self, *_args: Any) -> None:
        # refused / closed: the 1 s timer retries while started
        if self.sock.state() == _UNCONNECTED and self.connected:
            self._disconnected()

    def _ready_read(self) -> None:
        try:
            raw = self.sock.readAll()
            data = bytes(raw.data()) if hasattr(raw, "data") else bytes(raw)
        except Exception:
            return
        for msg in self.framer.feed(data):
            try:
                if msg.get("t") == "ack":
                    self.on_ack(self.acks.acked(msg), msg)
                else:
                    self.on_message(msg)
            except Exception as e:  # a bad message never kills the panel
                _log(f"message {msg.get('t')}: {type(e).__name__}: {e}")

