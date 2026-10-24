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
import socket
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
    """One connection; requests handled in order.

    Safety (review R10): the first line that is not a JSON object (e.g. the request line of an
    HTTP POST a web page sends to 127.0.0.1:8766) or a line over 1 MiB gets one error reply and
    the connection is closed, so nothing after it (an HTTP body) is ever executed.
    """

    def handle(self) -> None:
        bridge: Bridge = self.server.bridge  # type: ignore[attr-defined]
        bridge._track(self.request, True)
        try:
            while True:
                raw = self.rfile.readline(MAX_LINE + 1)
                if not raw:
                    return
                if len(raw) > MAX_LINE:
                    self.wfile.write(_encode({"id": "", "ok": False, "error": "bad_args",
                                              "message": "line over 1 MiB; closing"}))
                    return
                line = raw.strip()
                if not line:
                    continue
                cmd = parse_line(line)
                if cmd is None:
                    self.wfile.write(_encode({"id": "", "ok": False, "error": "bad_args",
                                              "message": "not a JSON object; closing"}))
                    return
                self.wfile.write(_encode(bridge.process(cmd)))
        except (ConnectionError, OSError, ValueError):
            return
        finally:
            bridge._track(self.request, False)


def parse_line(line: bytes) -> Optional[dict]:
    """A JSON object, or None for anything else (invalid JSON, arrays, strings, numbers)."""
    try:
        cmd = json.loads(line.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    return cmd if isinstance(cmd, dict) else None


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
        self._socks: "set[socket.socket]" = set()
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
        """Stop accepting and close every open client connection (review H4)."""
        srv, self.server = self.server, None
        if srv is not None:
            try:
                srv.shutdown()
                srv.server_close()
            except Exception:
                pass
        with self._lock:
            socks = list(self._socks)
        for sock in socks:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass

    def submit(self, cmd: dict) -> Future:
        fut: Future = Future()
        self.queue.put((cmd, fut))
        return fut

    def process_line(self, line: bytes) -> dict:
        cmd = parse_line(line)
        if cmd is None:
            return {"id": "", "ok": False, "error": "bad_args", "message": "not a JSON object"}
        return self.process(cmd)

    def process(self, cmd: dict) -> dict:
        rid = cmd.get("id", "")
        fut = self.submit(cmd)
        try:
            return fut.result(timeout=self.reply_timeout)
        except FutureTimeout:
            fut.cancel()  # drain() skips it if it has not started
            return {"id": rid, "ok": False, "error": "timeout", "message": "Krita GUI thread busy"}
        except Exception as e:
            return {"id": rid, "ok": False, "error": "internal", "message": str(e)}

    def _track(self, sock: socket.socket, add: bool) -> None:
        with self._lock:
            if add:
                self._socks.add(sock)
            else:
                self._socks.discard(sock)
            self.connections = len(self._socks)


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
