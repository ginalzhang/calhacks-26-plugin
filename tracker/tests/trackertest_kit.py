"""Shared scaffolding for tracker tests (no conftest.py: avoids colliding with other suites)."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

TESTS = Path(__file__).resolve().parent
TRACKER = TESTS.parent
REPO = TRACKER.parent
for p in (str(TRACKER), str(REPO / "helper")):
    if p not in sys.path:
        sys.path.insert(0, p)

from steadyhelper.config import KRITA_BUNDLE_ID  # noqa: E402
from steadyhelper.fakes import FakeKeyPoster, FakeMouse, FakeSystem  # noqa: E402
from steadyhelper.pointer import Pointer  # noqa: E402

from steadytracker.app import TrackerApp  # noqa: E402
from steadytracker.camera import FrameSource  # noqa: E402
from steadytracker.persistence import Store  # noqa: E402
from steadytracker.replay import expand_compact_point  # noqa: E402

FAKE_BRAIN = str(TESTS / "fake_brain.py")
REPLAY_DIR = REPO / "tests" / "fixtures" / "replay"


class ManualSource(FrameSource):
    """Frames pushed by the test (no thread)."""

    kind = "manual"

    def __init__(self, cameras=None) -> None:
        super().__init__()
        self._cams = cameras if cameras is not None else [{"index": 0, "name": "FaceTime HD Camera"}, {"index": 1, "name": "iPhone Desk View Camera"}]
        self.t = 0.0
        self.selections: List[int] = []

    def cameras(self):
        return list(self._cams)

    def start(self, on_frame) -> None:
        self._on_frame = on_frame

    def stop(self) -> None:
        pass

    def select(self, index: int) -> None:
        self.selected = int(index)
        self.selections.append(int(index))

    def push(self, x: float = 320, y: float = 240, score: float = 0.95, image: Any = None, hand: bool = True) -> Dict[str, Any]:
        self.t += 33.0
        hands = [{"landmarks": expand_compact_point(x, y, 5, "Right", 640, 480), "score": score, "handedness": "Right"}] if hand else []
        frame = {"t": self.t, "width": 640, "height": 480, "hands": hands}
        self._emit(frame, image)
        return frame


class FakePlugin:
    """Fake Krita bridge (TCP server, newline JSON). Replies {id, ok:true, ...replies[cmd]}."""

    def __init__(self) -> None:
        self.requests: List[Dict[str, Any]] = []
        self.replies: Dict[str, Dict[str, Any]] = {"canvas_rect": {"rect": {"x": 100.0, "y": 120.0, "w": 800.0, "h": 600.0}}}
        self.server = None
        self.port = 0

    async def start(self) -> "FakePlugin":
        self.server = await asyncio.start_server(self._client, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def _client(self, reader, writer) -> None:
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                req = json.loads(line)
                self.requests.append(req)
                reply = {"id": req["id"], "ok": True, **self.replies.get(req.get("cmd"), {})}
                writer.write((json.dumps(reply) + "\n").encode())
                await writer.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            writer.close()

    async def stop(self) -> None:
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()


class PanelClient:
    """Test panel: TCP client on the tracker's panel port."""

    def __init__(self, port: int) -> None:
        self.port = port
        self.messages: List[Dict[str, Any]] = []
        self.closed = False
        self._task = None

    async def connect(self, hello: bool = True) -> "PanelClient":
        self.reader, self.writer = await asyncio.open_connection("127.0.0.1", self.port)
        self._task = asyncio.get_running_loop().create_task(self._read())
        if hello:
            await self.send({"t": "hello", "plugin_version": "test", "krita_version": "5.3.2"})
        return self

    async def _read(self) -> None:
        try:
            while True:
                line = await self.reader.readline()
                if not line:
                    break
                self.messages.append(json.loads(line))
        except (ConnectionError, OSError):
            pass
        self.closed = True

    async def send(self, msg: Dict[str, Any]) -> None:
        self.writer.write((json.dumps(msg) + "\n").encode())
        await self.writer.drain()

    async def send_raw(self, data: bytes) -> None:
        self.writer.write(data)
        await self.writer.drain()

    def of(self, t: str) -> List[Dict[str, Any]]:
        return [m for m in self.messages if m.get("t") == t]

    def ack_for(self, rid: str) -> Optional[Dict[str, Any]]:
        for m in self.messages:
            if m.get("t") == "ack" and m.get("id") == rid:
                return m
        return None

    async def close(self) -> None:
        try:
            self.writer.close()
        except Exception:
            pass
        if self._task:
            self._task.cancel()


async def wait_until(cond, timeout: float = 3.0, step: float = 0.01) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        await asyncio.sleep(step)
    return bool(cond())


def read_log(path: Path) -> List[Dict[str, Any]]:
    try:
        return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    except FileNotFoundError:
        return []


class Rig:
    def __init__(self, app: TrackerApp, mouse: FakeMouse, keys: FakeKeyPoster, system: FakeSystem, log: Path, source):
        self.app = app
        self.mouse = mouse
        self.keys = keys
        self.system = system
        self.log = log
        self.source = source

    def brain_msgs(self, t: Optional[str] = None) -> List[Dict[str, Any]]:
        msgs = read_log(self.log)
        return [m for m in msgs if t is None or m.get("t") == t]

    def helper_events(self, event: Optional[str] = None) -> List[Dict[str, Any]]:
        return [m for m in self.brain_msgs("helper_event") if event is None or m.get("event") == event]

    async def panel(self, hello: bool = True) -> PanelClient:
        return await PanelClient(self.app.panel.port).connect(hello)


@asynccontextmanager
async def rig(
    tmp_path: Path,
    *,
    mode: str = "normal",
    source=None,
    frontmost: Optional[str] = KRITA_BUNDLE_ID,
    relay=None,
    permissions: Optional[Dict[str, bool]] = None,
    encoder=None,
    voice=None,
    data_dir: Optional[Path] = None,
    env_extra: Optional[Dict[str, str]] = None,
    **kw,
):
    log = tmp_path / f"brain-{time.monotonic_ns()}.jsonl"
    env = dict(os.environ)
    env.update({"FAKE_BRAIN_LOG": str(log), "FAKE_BRAIN_MODE": mode, "FAKE_BRAIN_FLAG": str(tmp_path / "crashed.flag")})
    env.update(env_extra or {})
    mouse = FakeMouse()
    system = FakeSystem(frontmost=frontmost)
    keys = FakeKeyPoster(system)
    src = source if source is not None else ManualSource()
    perms = permissions if permissions is not None else {"camera": True, "microphone": False, "accessibility": True, "input_monitoring": True}
    app = TrackerApp(
        source=src,
        brain_cmd=[sys.executable, FAKE_BRAIN],
        pointer=Pointer(mouse, enabled=True),
        system=system,
        key_poster=keys,
        store=Store(str(data_dir or (tmp_path / "data"))),
        relay=relay,
        panel_port=0,
        permissions_probe=lambda: dict(perms),
        voice_factory=(lambda a: voice) if voice is not None else None,
        preview_encoder=encoder,
        brain_cwd=str(TESTS),
        brain_env=env,
        **kw,
    )
    await app.start()
    r = Rig(app, mouse, keys, system, log, src)
    try:
        assert await wait_until(lambda: app.brain_ready, 5.0), "fake brain never sent ready"
        yield r
    finally:
        await app.stop()
