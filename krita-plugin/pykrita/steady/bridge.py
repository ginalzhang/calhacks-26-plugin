"""Steady Krita plugin: TCP server on 127.0.0.1:8766 + GUI-thread hand-off.

Threads:
  * server threads (stdlib socketserver.ThreadingTCPServer, daemon): read one JSON
    command per line, push (cmd, Future) on a queue.Queue, wait for the Future, write
    one JSON reply line. They never touch Krita.
  * the GUI thread: `Bridge.drain()` is called by a 20 ms QTimer (set up in __init__.py),
    pops commands and runs `handle(cmd)` (= dispatch(cmd, adapter)) on the GUI thread.

No Qt import here, so tests drive `drain()` from a plain thread.
"""
from __future__ import annotations

import json
import queue
import socketserver
import threading
from concurrent.futures import Future, TimeoutError as FutureTimeout
from typing import Any, Callable, Optional, Tuple

HOST = "127.0.0.1"
PORT = 8766
REPLY_TIMEOUT_S = 4.0  # below the helper relay's 5 s, so our explicit timeout reply arrives first
MAX_LINE = 1 << 20


def _encode(reply: Any) -> bytes:
    try:
        return (json.dumps(reply, separators=(",", ":"), ensure_ascii=False, default=str) + "\n").encode("utf-8")
    except Exception:  # pragma: no cover - default=str makes this near impossible
        rid = reply.get("id", "") if isinstance(reply, dict) else ""
        return (json.dumps({"id": rid, "ok": False, "error": "internal"}) + "\n").encode("utf-8")


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    bridge: "Bridge"


class _Handler(socketserver.StreamRequestHandler):
    def handle(self) -> None:  # one connection; requests handled in order
        bridge: Bridge = self.server.bridge  # type: ignore[attr-defined]
        bridge._conn_delta(+1)
        try:
            while True:
                raw = self.rfile.readline(MAX_LINE)
                if not raw:
                    return
                line = raw.strip()
                if not line:
                    continue
                reply = bridge.process_line(line)
                self.wfile.write(_encode(reply))
        except (ConnectionError, OSError):
            return
        finally:
            bridge._conn_delta(-1)


class Bridge:
    def __init__(
        self,
        handle: Callable[[dict], dict],
        host: str = HOST,
        port: int = PORT,
        reply_timeout: float = REPLY_TIMEOUT_S,
        log: Callable[[str], None] = print,
    ) -> None:
        self.handle = handle
        self.host, self.port = host, port
        self.reply_timeout = reply_timeout
        self.log = log
        self.queue: "queue.Queue[Tuple[dict, Future]]" = queue.Queue()
        self.server: Optional[_Server] = None
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self.connections = 0
        self.handled = 0

    # -- server side (any thread) -------------------------------------------------
    def start(self) -> Tuple[str, int]:
        """Bind and serve in a daemon thread. Returns the bound (host, port). Raises OSError."""
        srv = _Server((self.host, self.port), _Handler)
        srv.bridge = self
        self.server = srv
        self.port = srv.server_address[1]
        self._thread = threading.Thread(target=srv.serve_forever, name="steady-bridge", daemon=True)
        self._thread.start()
        self.log(f"Steady: listening on {self.host}:{self.port}")
        return self.host, self.port

    def stop(self) -> None:
        srv, self.server = self.server, None
        if srv is not None:
            try:
                srv.shutdown()
                srv.server_close()
            except Exception:
                pass

    def submit(self, cmd: dict) -> Future:
        fut: Future = Future()
        self.queue.put((cmd, fut))
        return fut

    def process_line(self, line: bytes) -> dict:
        try:
            cmd = json.loads(line.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {"id": "", "ok": False, "error": "bad_args", "message": "invalid JSON line"}
        rid = cmd.get("id", "") if isinstance(cmd, dict) else ""
        fut = self.submit(cmd)
        try:
            return fut.result(timeout=self.reply_timeout)
        except FutureTimeout:
            fut.cancel()  # drain() skips it if it has not started
            return {"id": rid, "ok": False, "error": "timeout", "message": "Krita GUI thread busy"}
        except Exception as e:
            return {"id": rid, "ok": False, "error": "internal", "message": str(e)}

    def _conn_delta(self, d: int) -> None:
        with self._lock:
            self.connections += d

    # -- GUI thread ---------------------------------------------------------------
    def drain(self, max_items: int = 64) -> int:
        """Run queued commands on the calling (GUI) thread. Never raises."""
        n = 0
        while n < max_items:
            try:
                cmd, fut = self.queue.get_nowait()
            except queue.Empty:
                break
            n += 1
            if not fut.set_running_or_notify_cancel():
                continue
            try:
                reply = self.handle(cmd)
            except Exception as e:  # dispatch never raises; belt and braces
                rid = cmd.get("id", "") if isinstance(cmd, dict) else ""
                reply = {"id": rid, "ok": False, "error": "internal", "message": str(e)}
            self.handled += 1
            fut.set_result(reply)
        return n
