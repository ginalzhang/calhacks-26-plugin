"""Shared test scaffolding for helper tests (uniquely named; no conftest.py so it can't
collide with the Krita plugin's test suite in the same pytest run)."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

HELPER_DIR = Path(__file__).resolve().parents[1]
REPO = HELPER_DIR.parent
if str(HELPER_DIR) not in sys.path:
    sys.path.insert(0, str(HELPER_DIR))

from websockets.asyncio.client import connect  # noqa: E402

from steadyhelper.fakes import FakeKeyPoster, FakeMouse, FakeSystem  # noqa: E402
from steadyhelper.krita_relay import KritaRelay  # noqa: E402
from steadyhelper.permissions import PermissionState  # noqa: E402
from steadyhelper.pointer import Pointer  # noqa: E402
from steadyhelper.server import HelperServer  # noqa: E402
from steadyhelper.watchdog import Watchdog  # noqa: E402

ORIGIN = "http://localhost:3000"
EXAMPLES = json.loads((REPO / "docs" / "protocol-examples.json").read_text())


class FakePlugin:
    """Fake Krita plugin TCP server (newline JSON). Replies {id, ok:true, echo:cmd} by default."""

    def __init__(self) -> None:
        self.requests: List[Dict[str, Any]] = []
        self.replies: Dict[str, Dict[str, Any]] = {}  # cmd → extra payload
        self.server: Optional[asyncio.base_events.Server] = None
        self.port = 0
        self._writers: list = []

    async def start(self, port: int = 0) -> "FakePlugin":
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", port)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def _handle(self, reader, writer) -> None:
        self._writers.append(writer)
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                req = json.loads(line)
                self.requests.append(req)
                reply = {"id": req["id"], "ok": True, "echo": req.get("cmd")}
                reply.update(self.replies.get(req.get("cmd"), {}))
                writer.write((json.dumps(reply) + "\n").encode())
                await writer.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            writer.close()

    async def stop(self) -> None:
        if self.server:
            self.server.close()
            for w in self._writers:
                w.close()
            await self.server.wait_closed()
            self.server = None


class Rig:
    def __init__(self, server: HelperServer, mouse: FakeMouse, system: FakeSystem, keys: FakeKeyPoster) -> None:
        self.server = server
        self.mouse = mouse
        self.system = system
        self.keys = keys

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.server.port}"

    @asynccontextmanager
    async def client(self, origin: Optional[str] = ORIGIN, skip_hello: bool = True):
        kwargs = {"origin": origin} if origin else {}
        async with connect(self.url, **kwargs) as ws:
            c = Client(ws)
            if skip_hello:
                hello = await c.recv_type("hello")
                c.hello = hello
            yield c


class Client:
    def __init__(self, ws) -> None:
        self.ws = ws
        self.hello: Optional[Dict[str, Any]] = None
        self.inbox: List[Dict[str, Any]] = []

    async def send(self, msg: Dict[str, Any]) -> None:
        await self.ws.send(json.dumps(msg))

    async def recv(self, timeout: float = 2.0) -> Dict[str, Any]:
        return json.loads(await asyncio.wait_for(self.ws.recv(), timeout))

    async def recv_type(self, t: str, timeout: float = 2.0, **match) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            m = await self.recv(max(0.01, deadline - loop.time()))
            self.inbox.append(m)
            if m.get("t") == t and all(m.get(k) == v for k, v in match.items()):
                return m

    async def recv_id(self, rid: str, timeout: float = 2.0) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            m = await self.recv(max(0.01, deadline - loop.time()))
            self.inbox.append(m)
            if m.get("id") == rid:
                return m


_n = 0


def mid(prefix: str = "t") -> str:
    global _n
    _n += 1
    return f"{prefix}-{os.getpid()}-{_n}"


@asynccontextmanager
async def rig(
    *,
    system: Optional[FakeSystem] = None,
    permissions: Optional[PermissionState] = None,
    plugin_port: Optional[int] = None,
    window_rect_period: float = 1.0,
    watchdog_timeout: float = 0.3,
    pointer_enabled: bool = True,
):
    mouse = FakeMouse()
    system = system or FakeSystem()
    keys = FakeKeyPoster(system)
    pointer = Pointer(mouse, enabled=pointer_enabled)
    wd = Watchdog(pointer, timeout=watchdog_timeout, tick=0.01)
    relay = None
    if plugin_port is not None:
        relay = KritaRelay("127.0.0.1", plugin_port, reconnect_s=0.05, reply_timeout_s=1.0)
    server = HelperServer(
        pointer=pointer,
        system=system,
        key_poster=keys,
        relay=relay,
        permissions=permissions or PermissionState(True, True, "Terminal"),
        port=0,
        watchdog=wd,
        window_rect_period=window_rect_period,
        pump_period=0.01,
        reactivate_delay=0.02,
    )
    await server.start()
    try:
        yield Rig(server, mouse, system, keys)
    finally:
        await server.stop()


async def wait_until(pred, timeout: float = 2.0, step: float = 0.01) -> bool:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if pred():
            return True
        await asyncio.sleep(step)
    return pred()
