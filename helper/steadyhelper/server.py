"""WebSocket server ws://127.0.0.1:8765 (§5) wiring pointer, watchdog, hotkeys, Krita relay.

Everything system-facing is injected (mouse via Pointer, `system`, `key_poster`, `relay`)
so pytest drives the real server with fakes over a real socket.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from . import VERSION
from . import protocol as P
from .config import (
    ACTIVATE_POLL_S,
    ACTIVATE_WAIT_S,
    ALLOWED_ORIGIN,
    BAD_ORIGIN_CLOSE_CODE,
    KRITA_BUNDLE_ID,
    REACTIVATE_DELAY_S,
    RUNLOOP_PUMP_S,
    WINDOW_RECT_PERIOD_S,
    WS_HOST,
    WS_PORT,
)
from .hotkeys import HotkeyRouter
from .keys import try_parse
from .krita_relay import PluginDown
from .permissions import PermissionState, accessibility_message, input_monitoring_message
from .pointer import Pointer, Refused
from .watchdog import Watchdog

log = logging.getLogger("steady.server")


class HelperServer:
    def __init__(
        self,
        *,
        pointer: Pointer,
        system,
        key_poster,
        relay=None,
        permissions: Optional[PermissionState] = None,
        host: str = WS_HOST,
        port: int = WS_PORT,
        allowed_origins: Iterable[str] = (ALLOWED_ORIGIN,),
        watchdog: Optional[Watchdog] = None,
        window_rect_period: float = WINDOW_RECT_PERIOD_S,
        pump_period: float = RUNLOOP_PUMP_S,
        activate_wait: float = ACTIVATE_WAIT_S,
        reactivate_delay: float = REACTIVATE_DELAY_S,
        warnings: Optional[List[Tuple[str, str]]] = None,
    ) -> None:
        self.pointer = pointer
        self.system = system
        self.key_poster = key_poster
        self.relay = relay
        self.permissions = permissions or PermissionState(True, True, "Terminal")
        self.host = host
        self.port = port
        self.allowed_origins = frozenset(allowed_origins)  # validated by origins.resolve_origins
        self.watchdog = watchdog or Watchdog(pointer)
        self.window_rect_period = window_rect_period
        self.pump_period = pump_period
        self.activate_wait = activate_wait
        self.reactivate_delay = reactivate_delay
        #: Active startup warnings as (code, message); each new client gets one `warning` per entry.
        self.warnings: List[Tuple[str, str]] = list(warnings or [])

        self.clients: Set[ServerConnection] = set()
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self._server = None
        self._tasks: Set[asyncio.Task] = set()
        self._flush_handle: Optional[asyncio.TimerHandle] = None
        self._frontmost: Optional[str] = None
        self._krita_was_running = False
        self.last_krita_rect: Optional[Dict[str, float]] = None
        self.router = HotkeyRouter(
            emit=self._emit_hotkey_threadsafe,
            frontmost=lambda: self._frontmost,
            has_client=lambda: bool(self.clients),
        )
        if relay is not None:
            relay._on_state = self._on_krita_state  # set before start()

    # ------------------------------------------------------------------ lifecycle
    async def start(self) -> "HelperServer":
        self.loop = asyncio.get_running_loop()
        self._refresh_frontmost()
        self._server = await serve(self._handler, self.host, self.port, max_size=2**20, compression=None)
        if self.port == 0:
            self.port = next(iter(self._server.sockets)).getsockname()[1]
        self.watchdog.start()
        if self.relay is not None:
            self.relay.start()
        self._spawn(self._pump_loop())
        self._spawn(self._window_rect_loop())
        log.info("listening on ws://%s:%d (Origin %s only)", self.host, self.port, ", ".join(sorted(self.allowed_origins)))
        return self

    async def stop(self) -> None:
        self.pointer.release("shutdown")
        for t in list(self._tasks):
            t.cancel()
        for t in list(self._tasks):
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        if self.relay is not None:
            await self.relay.stop()
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
        self.watchdog.stop()
        self.pointer.release("shutdown")

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    # ------------------------------------------------------------------ outbound
    def broadcast(self, msg: Dict[str, Any]) -> None:
        data = json.dumps(msg)
        for ws in list(self.clients):
            self._spawn(self._safe_send(ws, data))

    async def _safe_send(self, ws: ServerConnection, data: str) -> None:
        try:
            await ws.send(data)
        except ConnectionClosed:
            pass
        except Exception:
            log.exception("send failed")

    async def _send(self, ws: ServerConnection, msg: Dict[str, Any]) -> None:
        await self._safe_send(ws, json.dumps(msg))

    def _emit_hotkey_threadsafe(self, name: str) -> None:
        # Called on the pynput listener thread. Lifting is always safe, so the helper lifts
        # at once for pen (if down), pause and push-to-talk start, before the Worker reacts.
        if name in ("pen", "pause", "ptt_down"):
            self.pointer.release(f"hotkey {name}")
        loop = self.loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(self.broadcast, P.hotkey(name))

    def _on_krita_state(self, connected: bool) -> None:
        self.broadcast(P.krita_state(connected))

    # ------------------------------------------------------------------ periodic
    def _refresh_frontmost(self) -> None:
        try:
            self.system.pump()
            self._frontmost = self.system.frontmost_bundle_id()
        except Exception:
            log.exception("frontmost refresh failed")

    async def _pump_loop(self) -> None:
        while True:
            self._refresh_frontmost()
            await asyncio.sleep(self.pump_period)

    def window_rect_tick(self) -> Optional[Dict[str, Any]]:
        """One krita_window_rect step; returns the message broadcast (or None)."""
        running = self.system.krita_pid() is not None
        msg = None
        if running:
            rect = self.system.krita_window_rect()
            self.last_krita_rect = rect
            msg = P.krita_window_rect(rect, self._frontmost == KRITA_BUNDLE_ID)
        elif self._krita_was_running:
            self.last_krita_rect = None
            msg = P.krita_window_rect(None, False)
        self._krita_was_running = running
        if msg is not None and self.clients:
            self.broadcast(msg)
        return msg

    async def _window_rect_loop(self) -> None:
        while True:
            try:
                self.window_rect_tick()
            except Exception:
                log.exception("window rect tick failed")
            await asyncio.sleep(self.window_rect_period)

    # ------------------------------------------------------------------ connection
    def hello_msg(self) -> Dict[str, Any]:
        running = False
        rect = None
        try:
            running = self.system.krita_pid() is not None
            rect = self.system.krita_window_rect() if running else None
        except Exception:
            log.exception("krita lookup failed")
        return P.hello(
            version=VERSION,
            screen=self.system.screen(),
            accessibility=self.permissions.accessibility,
            input_monitoring=self.permissions.input_monitoring,
            krita=bool(self.relay and self.relay.connected),
            krita_running=running,
            krita_window_rect=rect,
            paused=self.pointer.paused,
        )

    def permission_errors(self) -> list:
        out = []
        app = self.permissions.app_name
        if not self.permissions.accessibility:
            out.append(P.error(None, "permission", accessibility_message(app), which="accessibility"))
        if not self.permissions.input_monitoring:
            out.append(P.error(None, "permission", input_monitoring_message(app), which="input_monitoring"))
        return out

    async def _handler(self, ws: ServerConnection) -> None:
        origin = ws.request.headers.get("Origin") if ws.request is not None else None
        if origin is None or origin not in self.allowed_origins:
            log.warning("refused connection with Origin %r", origin)
            await ws.close(BAD_ORIGIN_CLOSE_CODE, "origin not allowed")
            return
        self.clients.add(ws)
        try:
            await self._send(ws, self.hello_msg())
            for err in self.permission_errors():
                await self._send(ws, err)
            for code, message in self.warnings:
                await self._send(ws, P.warning(code, message))
            async for raw in ws:
                await self.handle_raw(ws, raw)
        except ConnectionClosed:
            pass
        finally:
            self.clients.discard(ws)
            self.pointer.release("socket closed")

    # ------------------------------------------------------------------ inbound
    async def handle_raw(self, ws: ServerConnection, raw) -> None:
        try:
            msg = json.loads(raw)
        except (TypeError, ValueError):
            await self._send(ws, P.error(None, "bad_message", "not JSON"))
            return
        err = P.validate_worker_msg(msg)
        if err:
            rid = msg.get("id") if isinstance(msg, dict) and isinstance(msg.get("id"), str) else None
            await self._send(ws, P.error(rid, "bad_message", err))
            return
        self.watchdog.feed()
        try:
            await self.dispatch(ws, msg)
        except Exception as exc:  # top-level guard: the button is never left held
            self.pointer.release("exception")
            log.exception("handler failed for %s", msg.get("t"))
            await self._send(ws, P.error(msg["id"], "internal", f"{type(exc).__name__}: {exc}"))

    async def dispatch(self, ws: ServerConnection, msg: Dict[str, Any]) -> None:
        t = msg["t"]
        rid = msg["id"]
        p = self.pointer
        if t == "move":
            delay = p.move(float(msg["x"]), float(msg["y"]))
            if delay > 0 and self._flush_handle is None:
                self._flush_handle = asyncio.get_running_loop().call_later(delay, self._flush)
        elif t == "ping":
            await self._send(ws, P.pong(rid))
        elif t == "down":
            if not p.enabled:
                await self._send(ws, self._permission_error(rid))
                return
            try:
                p.down()
            except Refused as r:
                await self._send(ws, P.error(rid, r.code, str(r)))
        elif t == "up":
            p.up()
        elif t == "click":
            if not p.enabled:
                await self._send(ws, self._permission_error(rid))
                return
            try:
                p.click(float(msg["x"]), float(msg["y"]))
            except Refused as r:
                await self._send(ws, P.error(rid, r.code, str(r)))
                return
            await self._send(ws, P.ack(rid))
            if msg.get("reactivate_krita"):
                asyncio.get_running_loop().call_later(self.reactivate_delay, self._reactivate_krita)
        elif t == "pause":
            p.pause()
            await self._send(ws, P.ack(rid))
        elif t == "resume":
            p.resume()
            await self._send(ws, P.ack(rid))
        elif t == "chrome_rect":
            p.set_chrome_rect(msg["rect"])
        elif t == "keys":
            self._spawn(self._handle_keys(ws, msg))
        elif t == "krita":
            self._spawn(self._handle_krita(ws, msg))
        elif t in ("middle_down", "middle_up", "ring"):
            pass  # † P3
        else:  # pragma: no cover - validate_worker_msg already filtered
            await self._send(ws, P.error(rid, "bad_message", f"unhandled {t}"))

    def _permission_error(self, rid: str) -> Dict[str, Any]:
        return P.error(rid, "permission", accessibility_message(self.permissions.app_name), which="accessibility")

    def _flush(self) -> None:
        self._flush_handle = None
        try:
            self.pointer.flush()
        except Exception:
            log.exception("move flush failed")
            self.pointer.release("exception in flush")

    def _reactivate_krita(self) -> None:
        try:
            if self.system.krita_pid() is not None:
                self.system.activate_krita()
        except Exception:
            log.exception("reactivate Krita failed")

    # ------------------------------------------------------------------ keys / krita
    async def post_keys(self, combo: str):
        """Activate Krita (≤ activate_wait), then post the combo. Returns (ok, error)."""
        stroke = try_parse(combo)
        if stroke is None:
            return False, "bad_combo"
        if not self.permissions.accessibility:
            return False, "permission"
        if self.system.krita_pid() is None:
            return False, "krita_not_running"
        self._refresh_frontmost()
        if self._frontmost != KRITA_BUNDLE_ID:
            self.system.activate_krita()
            loop = asyncio.get_running_loop()
            deadline = loop.time() + self.activate_wait
            while True:
                self._refresh_frontmost()
                if self._frontmost == KRITA_BUNDLE_ID or loop.time() >= deadline:
                    break
                await asyncio.sleep(ACTIVATE_POLL_S)
            if self._frontmost != KRITA_BUNDLE_ID:
                return False, "krita_not_frontmost"
        self.key_poster.post(stroke)
        return True, None

    async def _handle_keys(self, ws: ServerConnection, msg: Dict[str, Any]) -> None:
        try:
            ok, err = await self.post_keys(msg["combo"])
        except Exception as exc:
            log.exception("keys failed")
            ok, err = False, f"internal: {exc}"
        await self._send(ws, P.ack(msg["id"], ok, err))

    async def _handle_krita(self, ws: ServerConnection, msg: Dict[str, Any]) -> None:
        rid = msg["id"]
        req = P.plugin_request_from_krita_msg(msg)
        try:
            if self.relay is None:
                raise PluginDown()
            reply = await self.relay.request(req)
        except PluginDown:
            fb = msg.get("fallback_keys")
            if fb:
                ok, err = await self.post_keys(fb)
                await self._send(ws, P.krita_reply(rid, ok, via="keys", error=err))
            else:
                await self._send(ws, P.krita_reply(rid, False, error="plugin_down"))
            return
        except asyncio.TimeoutError:
            await self._send(ws, P.krita_reply(rid, False, via="plugin", error="timeout"))
            return
        except Exception as exc:
            log.exception("krita relay failed")
            await self._send(ws, P.krita_reply(rid, False, via="plugin", error=f"internal: {exc}"))
            return
        payload = {k: v for k, v in reply.items() if k not in ("id", "ok", "error")}
        await self._send(
            ws,
            P.krita_reply(rid, bool(reply.get("ok")), via="plugin", error=reply.get("error"), **payload),
        )
