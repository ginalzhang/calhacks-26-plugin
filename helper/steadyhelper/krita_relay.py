"""TCP client to the Krita plugin (127.0.0.1:8766, newline-delimited JSON).

The PLUGIN is the server; this client reconnects every 2 s. Requests carry the Worker's
`id`; replies are matched by `id`. `on_state(connected)` fires on every transition.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable, Dict, Optional

from .config import PLUGIN_HOST, PLUGIN_PORT, PLUGIN_RECONNECT_S, PLUGIN_REPLY_TIMEOUT_S

log = logging.getLogger("steady.krita")


class PluginDown(Exception):
    pass


class KritaRelay:
    def __init__(
        self,
        host: str = PLUGIN_HOST,
        port: int = PLUGIN_PORT,
        *,
        reconnect_s: float = PLUGIN_RECONNECT_S,
        reply_timeout_s: float = PLUGIN_REPLY_TIMEOUT_S,
        on_state: Optional[Callable[[bool], None]] = None,
    ) -> None:
        self.host = host
        self.port = port
        self.reconnect_s = reconnect_s
        self.reply_timeout_s = reply_timeout_s
        self._on_state = on_state
        self.connected = False
        self._writer: Optional[asyncio.StreamWriter] = None
        self._pending: Dict[str, asyncio.Future] = {}
        self._task: Optional[asyncio.Task] = None
        self._stopping = False

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._run(), name="krita-relay")

    async def stop(self) -> None:
        self._stopping = True
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        self._close_writer()
        self._set_connected(False)

    def _set_connected(self, value: bool) -> None:
        if value != self.connected:
            self.connected = value
            log.info("Krita plugin %s", "connected" if value else "disconnected")
            if self._on_state:
                try:
                    self._on_state(value)
                except Exception:
                    log.exception("on_state failed")

    def _close_writer(self) -> None:
        if self._writer is not None:
            try:
                self._writer.close()
            except Exception:
                pass
            self._writer = None

    def _fail_pending(self) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(PluginDown())
        self._pending.clear()

    async def _run(self) -> None:
        while not self._stopping:
            try:
                reader, writer = await asyncio.open_connection(self.host, self.port)
            except (OSError, asyncio.TimeoutError):
                await asyncio.sleep(self.reconnect_s)
                continue
            self._writer = writer
            self._set_connected(True)
            try:
                while True:
                    line = await reader.readline()
                    if not line:
                        break
                    self._on_line(line)
            except (OSError, asyncio.IncompleteReadError, ValueError):
                log.info("plugin socket error", exc_info=True)
            finally:
                self._close_writer()
                self._fail_pending()
                self._set_connected(False)
            if not self._stopping:
                await asyncio.sleep(self.reconnect_s)

    def _on_line(self, line: bytes) -> None:
        try:
            reply = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            log.warning("bad line from plugin: %r", line[:200])
            return
        if not isinstance(reply, dict):
            return
        fut = self._pending.pop(str(reply.get("id")), None)
        if fut is not None and not fut.done():
            fut.set_result(reply)

    async def request(self, req: Dict[str, Any]) -> Dict[str, Any]:
        """Send `{id, cmd, ...}`; return the plugin's reply dict. Raises PluginDown / asyncio.TimeoutError."""
        if not self.connected or self._writer is None:
            raise PluginDown()
        rid = str(req["id"])
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        try:
            self._writer.write((json.dumps(req) + "\n").encode("utf-8"))
            await self._writer.drain()
        except (OSError, RuntimeError):
            self._pending.pop(rid, None)
            raise PluginDown()
        try:
            return await asyncio.wait_for(fut, self.reply_timeout_s)
        finally:
            self._pending.pop(rid, None)
