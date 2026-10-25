"""Panel ↔ tracker: TCP 127.0.0.1:8767, newline-delimited JSON (tracker/PROTOCOL.md §1).

- Binds 127.0.0.1 only. One client at a time, newest wins — but a new connection only replaces the
  current panel once it sends a valid `hello` (so a stray connection can't kick the real panel).
- The first line that is not a JSON object (e.g. an HTTP request a web page aimed at this port), or a
  line over 1 MiB, closes that connection.
- Requests with `id` get `{t:"ack", id, ok, error?}` after the handler ran (handlers run in order).
- `send_state()` coalesces to ≤ 15 Hz and only sends on change, nested: `{t:"state", state: PanelState}`.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable, Dict, Optional, Tuple

from .config import PANEL_HOST, PANEL_PORT, STATE_MIN_INTERVAL_S

log = logging.getLogger("steady.tracker.panel")

MAX_LINE = 1 << 20
Handler = Callable[[Dict[str, Any]], Awaitable[Optional[Tuple[bool, Optional[str]]]]]


def ack(rid: Any, ok: bool = True, error: Optional[str] = None) -> Dict[str, Any]:
    m: Dict[str, Any] = {"t": "ack", "id": rid, "ok": bool(ok)}
    if error:
        m["error"] = error
    return m


class PanelServer:
    def __init__(
        self,
        handler: Handler,
        *,
        on_connect: Optional[Callable[[], None]] = None,
        on_disconnect: Optional[Callable[[], None]] = None,
        host: str = PANEL_HOST,
        port: int = PANEL_PORT,
        state_interval: float = STATE_MIN_INTERVAL_S,
    ) -> None:
        self._handler = handler
        self._on_connect = on_connect
        self._on_disconnect = on_disconnect
        self.host = host
        self.port = port
        self.state_interval = state_interval
        self._server: Optional[asyncio.base_events.Server] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.hello: Optional[Dict[str, Any]] = None
        self.connections = 0
        # state throttle
        self._last_state_json: Optional[str] = None
        self._pending_state: Optional[Dict[str, Any]] = None
        self._last_state_at = float("-inf")
        self._state_handle: Optional[asyncio.TimerHandle] = None
        self.sent_states = 0

    @property
    def connected(self) -> bool:
        return self._writer is not None

    async def start(self) -> "PanelServer":
        self.loop = asyncio.get_running_loop()
        self._server = await asyncio.start_server(self._client, self.host, self.port, limit=MAX_LINE)
        if self.port == 0:
            self.port = self._server.sockets[0].getsockname()[1]
        log.info("panel server on %s:%d", self.host, self.port)
        return self

    async def stop(self) -> None:
        if self._state_handle:
            self._state_handle.cancel()
        w = self._writer
        self._writer = None
        if w is not None:
            try:
                w.close()
            except Exception:
                pass
        if self._server is not None:
            self._server.close()
            try:
                await asyncio.wait_for(self._server.wait_closed(), 1.0)
            except (asyncio.TimeoutError, Exception):
                pass

    # ------------------------------------------------------------------ outbound (loop thread)
    def send(self, msg: Dict[str, Any]) -> bool:
        w = self._writer
        if w is None:
            return False
        try:
            w.write((json.dumps(msg, separators=(",", ":")) + "\n").encode("utf-8"))
            return True
        except Exception:
            log.debug("panel send failed", exc_info=True)
            return False

    def send_threadsafe(self, msg: Dict[str, Any]) -> None:
        loop = self.loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(self.send, msg)

    def send_state(self, state: Dict[str, Any]) -> None:
        """≤ 15 Hz, only on change; the newest state wins."""
        self._pending_state = state
        if self._state_handle is not None:
            return
        loop = asyncio.get_running_loop()
        wait = self.state_interval - (loop.time() - self._last_state_at)
        if wait <= 0:
            self._flush_state()
        else:
            self._state_handle = loop.call_later(wait, self._flush_state)

    def _flush_state(self) -> None:
        self._state_handle = None
        st = self._pending_state
        self._pending_state = None
        if st is None:
            return
        data = json.dumps(st, sort_keys=True, separators=(",", ":"))
        if data == self._last_state_json:
            return
        if self.send({"t": "state", "state": st}):
            self._last_state_json = data
            self._last_state_at = asyncio.get_running_loop().time()
            self.sent_states += 1

    def resend_state(self) -> None:
        """After a new hello: send the last known state at once."""
        if self._last_state_json is not None:
            self.send({"t": "state", "state": json.loads(self._last_state_json)})

    def last_state(self) -> Optional[Dict[str, Any]]:
        return json.loads(self._last_state_json) if self._last_state_json else None

    # ------------------------------------------------------------------ inbound
    async def _client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        active = False
        try:
            while True:
                try:
                    raw = await reader.readline()
                except (ValueError, asyncio.LimitOverrunError):
                    log.warning("panel line too long; closing that connection")
                    break
                if not raw:
                    break
                line = raw.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, ValueError):
                    msg = None
                if not isinstance(msg, dict) or not isinstance(msg.get("t"), str):
                    log.warning("panel sent a non-JSON-object line; closing that connection")
                    break
                if not active:
                    if msg["t"] != "hello":
                        if "id" in msg:
                            self._write(writer, ack(msg["id"], False, "hello_first"))
                        continue
                    active = True
                    self._activate(writer, msg)
                    continue
                if writer is not self._writer:
                    break  # replaced by a newer panel
                if msg["t"] == "hello":
                    self.hello = msg
                    self._connected_cb()
                    continue
                try:
                    res = await self._handler(msg)
                except Exception as exc:
                    log.exception("panel handler failed for %s", msg.get("t"))
                    res = (False, f"internal: {type(exc).__name__}")
                if "id" in msg and writer is self._writer:
                    ok, err = res if res is not None else (True, None)
                    self.send(ack(msg["id"], ok, err))
        except (ConnectionError, OSError):
            pass
        finally:
            if writer is self._writer:
                self._writer = None
                if self._on_disconnect:
                    try:
                        self._on_disconnect()
                    except Exception:
                        log.exception("on_disconnect failed")
            try:
                writer.close()
            except Exception:
                pass

    @staticmethod
    def _write(writer: asyncio.StreamWriter, msg: Dict[str, Any]) -> None:
        try:
            writer.write((json.dumps(msg) + "\n").encode("utf-8"))
        except Exception:
            pass

    def _activate(self, writer: asyncio.StreamWriter, hello: Dict[str, Any]) -> None:
        old = self._writer
        self._writer = writer
        self.hello = hello
        self.connections += 1
        if old is not None:
            log.info("a newer Steady panel connected; closing the old connection")
            try:
                old.close()
            except Exception:
                pass
        log.info("panel connected (plugin %s, Krita %s)", hello.get("plugin_version"), hello.get("krita_version"))
        self._connected_cb()

    def _connected_cb(self) -> None:
        if self._on_connect:
            try:
                self._on_connect()
            except Exception:
                log.exception("on_connect failed")
