#!/usr/bin/env python3
"""Fake Steady helper for tests (docs/PROTOCOL.md › "Fake helper").

Speaks the helper side of the protocol WITHOUT touching the pointer or keyboard:
- WebSocket on 127.0.0.1:18765 (--ws-port). Accepts Origin http://localhost:3000 or no Origin;
  any other Origin is closed with code 4003 (like the real helper).
- Sends `hello` on connect; replies `pong` to ping, `ack ok:true` to keys/click/pause/resume,
  `krita_reply ok:true via:"plugin"` (with a canned payload per cmd) to krita; records every
  received message.
- HTTP control on 127.0.0.1:18767 (--http-port):
    GET  /messages            → [msg, ...] received so far (optional ?t=move filter)
    POST /reset               → clears the record
    POST /send   body = msg   → pushed to every client (id added if missing)
    POST /config body         → {"krita": false} makes later `krita` messages reply
                                 ok:false error:"plugin_down"; {"hello": {...}} overrides hello fields;
                                 {"canvas_rect": {x,y,w,h}} / {"window_rect": ...} sets the rect those
                                 cmds reply (null → ok:false no_canvas_rect / no_window);
                                 {"payloads": {"<cmd>": {...}}} merges extra reply fields per cmd
    GET  /health              → {"ok": true, "clients": n}

Only needs `websockets` (stdlib otherwise). Run: scripts/run-fake-helper.sh or
`python scripts/fake_helper.py --ws-port 18765 --http-port 18767`.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

ALLOWED_ORIGIN = "http://localhost:3000"

KRITA_PAYLOADS: Dict[str, Dict[str, Any]] = {
    "canvas_rect": {"rect": {"x": 64, "y": 120, "w": 1180, "h": 860}},
    "window_rect": {"rect": {"x": 0, "y": 25, "w": 1400, "h": 1060}},
    "list_actions": {
        "actions": [
            {"id": "merge_layer", "text": "Merge with Layer Below"},
            {"id": "remove_layer", "text": "Delete Layer"},
            {"id": "clear", "text": "Clear"},
        ]
    },
    "list_presets": {"presets": ["b) Basic-5 Size", "c) Pencil-2", "d) Ink-2 Fineliner", "f) Airbrush Soft", "a) Eraser Circle"]},
    "session_init": {"smoothing_changed": True, "cleared": [{"key": "f5", "action": "show_brush_editor"}], "krita_version": "5.3.4"},
    "get_state": {"preset": "b) Basic-5 Size", "size": 40, "opacity": 100, "color": "#1d4ed8", "eraser": False, "layer": "Paint Layer 1"},
    "clear_shortcuts": {"cleared": []},
    "preset": {"preset": "b) Basic-5 Size"},
    "new_layer": {"layer": "Steady 1"},
    "layer_nav": {"layer": "Paint Layer 1"},
    "layer_visible": {"layer": "Paint Layer 1"},
}


def new_id() -> str:
    return str(uuid.uuid4())


class FakeHelper:
    def __init__(self, host: str = "127.0.0.1", ws_port: int = 18765, http_port: int = 18767, quiet: bool = False):
        self.host = host
        self.ws_port = ws_port
        self.http_port = http_port
        self.quiet = quiet
        self.lock = threading.Lock()
        self.messages: List[Any] = []
        self.config: Dict[str, Any] = {"krita": True, "hello": {}}
        self.paused = False
        self.clients: set = set()
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self._ws_server = None
        self._http: Optional[ThreadingHTTPServer] = None
        self._http_thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------- protocol
    def hello(self) -> Dict[str, Any]:
        with self.lock:
            krita = bool(self.config.get("krita", True))
            overrides = dict(self.config.get("hello") or {})
            paused = self.paused
        msg = {
            "t": "hello",
            "id": new_id(),
            "version": "0.1.0-fake",
            "screen": {"w": 1728, "h": 1117, "scale": 2},
            "accessibility": True,
            "input_monitoring": True,
            "krita": krita,
            "krita_running": True,
            "krita_window_rect": {"x": 0, "y": 25, "w": 1400, "h": 1060},
            "paused": paused,
        }
        msg.update(overrides)
        return msg

    def reply_for(self, msg: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(msg, dict):
            return {"t": "error", "id": new_id(), "code": "bad_message", "message": "not an object"}
        t = msg.get("t")
        rid = msg.get("id") if isinstance(msg.get("id"), str) else new_id()
        if t == "ping":
            return {"t": "pong", "id": rid}
        if t in ("keys", "click", "pause", "resume"):
            if t in ("pause", "resume"):
                with self.lock:
                    self.paused = t == "pause"
            return {"t": "ack", "id": rid, "ok": True}
        if t == "krita":
            with self.lock:
                krita_up = bool(self.config.get("krita", True))
            if not krita_up:
                return {"t": "krita_reply", "id": rid, "ok": False, "error": "plugin_down"}
            cmd = str(msg.get("cmd"))
            with self.lock:
                overrides = dict(self.config.get("payloads") or {})
                rect_override = self.config.get(cmd, "unset") if cmd in ("canvas_rect", "window_rect") else "unset"
            if rect_override is None:
                return {"t": "krita_reply", "id": rid, "ok": False, "via": "plugin", "error": "no_canvas_rect" if cmd == "canvas_rect" else "no_window"}
            payload = dict(KRITA_PAYLOADS.get(cmd, {}))
            if isinstance(rect_override, dict):
                payload["rect"] = rect_override
            payload.update(overrides.get(cmd) or {})
            return {"t": "krita_reply", **payload, "id": rid, "ok": True, "via": "plugin"}
        return None  # move/down/up/chrome_rect/ring/middle_*: no reply

    # ------------------------------------------------------------- websocket
    async def _handler(self, ws) -> None:
        origin = ws.request.headers.get("Origin") if ws.request is not None else None
        if origin not in (None, ALLOWED_ORIGIN):
            await ws.close(4003, "origin not allowed")
            return
        self.clients.add(ws)
        try:
            await ws.send(json.dumps(self.hello()))
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except (TypeError, ValueError):
                    msg = {"_raw": raw if isinstance(raw, str) else repr(raw)}
                    with self.lock:
                        self.messages.append(msg)
                    continue
                with self.lock:
                    self.messages.append(msg)
                reply = self.reply_for(msg)
                if reply is not None:
                    await ws.send(json.dumps(reply))
        except ConnectionClosed:
            pass
        finally:
            self.clients.discard(ws)

    async def broadcast(self, msg: Dict[str, Any]) -> int:
        data = json.dumps(msg)
        n = 0
        for ws in list(self.clients):
            try:
                await ws.send(data)
                n += 1
            except ConnectionClosed:
                pass
        return n

    # ------------------------------------------------------------- http
    def _make_http_handler(self):
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):  # noqa: N802
                if not fake.quiet:
                    sys.stderr.write("fake-helper http: " + (fmt % args) + "\n")

            def _json(self, code: int, body: Any) -> None:
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data)

            def _body(self) -> Any:
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                return json.loads(raw) if raw.strip() else None

            def do_OPTIONS(self):  # noqa: N802
                self.send_response(204)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.end_headers()

            def do_GET(self):  # noqa: N802
                u = urlparse(self.path)
                if u.path == "/messages":
                    with fake.lock:
                        msgs = list(fake.messages)
                    t = parse_qs(u.query).get("t")
                    if t:
                        msgs = [m for m in msgs if isinstance(m, dict) and m.get("t") in t]
                    self._json(200, msgs)
                elif u.path == "/health":
                    self._json(200, {"ok": True, "clients": len(fake.clients)})
                else:
                    self._json(404, {"error": "not found"})

            def do_POST(self):  # noqa: N802
                u = urlparse(self.path)
                try:
                    body = self._body()
                except ValueError:
                    self._json(400, {"error": "bad json"})
                    return
                if u.path == "/reset":
                    with fake.lock:
                        fake.messages.clear()
                    self._json(200, {"ok": True})
                elif u.path == "/send":
                    if not isinstance(body, dict) or "t" not in body:
                        self._json(400, {"error": "body must be a helper→Worker message"})
                        return
                    body.setdefault("id", new_id())
                    if fake.loop is None:
                        self._json(503, {"error": "not running"})
                        return
                    fut = asyncio.run_coroutine_threadsafe(fake.broadcast(body), fake.loop)
                    n = fut.result(timeout=5)
                    self._json(200, {"ok": True, "sent_to": n, "msg": body})
                elif u.path == "/config":
                    if not isinstance(body, dict):
                        self._json(400, {"error": "body must be an object"})
                        return
                    with fake.lock:
                        for k, v in body.items():
                            fake.config[k] = v
                        cfg = dict(fake.config)
                    self._json(200, {"ok": True, "config": cfg})
                else:
                    self._json(404, {"error": "not found"})

        return Handler

    # ------------------------------------------------------------- lifecycle
    async def start(self) -> "FakeHelper":
        self.loop = asyncio.get_running_loop()
        self._ws_server = await serve(self._handler, self.host, self.ws_port, compression=None)
        if self.ws_port == 0:
            self.ws_port = next(iter(self._ws_server.sockets)).getsockname()[1]
        self._http = ThreadingHTTPServer((self.host, self.http_port), self._make_http_handler())
        self._http.daemon_threads = True
        self.http_port = self._http.server_address[1]
        self._http_thread = threading.Thread(target=self._http.serve_forever, name="fake-helper-http", daemon=True)
        self._http_thread.start()
        return self

    async def stop(self) -> None:
        if self._http is not None:
            self._http.shutdown()
            self._http.server_close()
            self._http = None
        if self._ws_server is not None:
            self._ws_server.close()
            await self._ws_server.wait_closed()
            self._ws_server = None


async def amain(args) -> None:
    fake = await FakeHelper(args.host, args.ws_port, args.http_port, quiet=args.quiet).start()
    print(
        f"fake helper ready: ws://{args.host}:{fake.ws_port}  http://{args.host}:{fake.http_port}",
        flush=True,
    )
    try:
        await asyncio.Event().wait()
    finally:
        await fake.stop()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--ws-port", type=int, default=18765)
    ap.add_argument("--http-port", type=int, default=18767)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
