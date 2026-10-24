"""Integration (agent H): the REAL helper process <-> the REAL plugin bridge server.

* Plugin side: `krita-plugin/pykrita/steady/bridge.py` Bridge (real TCP server) in-process, its GUI
  queue drained by a plain thread (stands in for Krita's 20 ms QTimer), dispatching into the real
  `dispatch()` with krita-plugin/tests' FakeAdapter.
* Helper side: `tests/integration/safe_helper.py` (the real `steadyhelper.main.main`, real CLI, server,
  relay, watchdog) as a SUBPROCESS with --no-pointer --no-hotkeys --no-overlay, on private ports, every
  real-input path sealed (CGEventPost, key poster, Krita activation, key tap, permission prompts).
* Client: a websockets client with `Origin: http://localhost:<STEADY_INTEG_APP_PORT>`.

Run: .venv/bin/python -m pytest tests/integration -m "P1 or P2a"
"""
from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import pytest
from websockets.exceptions import ConnectionClosed, InvalidStatus
from websockets.sync.client import connect

ROOT = Path(__file__).resolve().parents[2]
for p in (ROOT / "krita-plugin" / "pykrita", ROOT / "krita-plugin" / "tests"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from krita_fakes import FakeAdapter  # noqa: E402
from steady.bridge import Bridge  # noqa: E402
from steady.dispatch import dispatch  # noqa: E402

SHIM = ROOT / "tests" / "integration" / "safe_helper.py"
PY = sys.executable
APP_PORT = int(os.environ.get("STEADY_INTEG_APP_PORT", "3200"))
ORIGIN = f"http://localhost:{APP_PORT}"
LOG_DIR = Path(os.environ.get("STEADY_INTEG_OUT", "/tmp/steady-integration"))
BLOCKED = "INTEGRATION-BLOCKED"


def free_port(preferred: Optional[int] = None) -> int:
    if preferred:
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", preferred))
                return preferred
            except OSError:
                pass
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_until(pred: Callable[[], Any], timeout: float, what: str, step: float = 0.02):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        v = pred()
        if v:
            return v
        time.sleep(step)
    raise AssertionError(f"timed out after {timeout}s waiting for {what}")


# --------------------------------------------------------------------------- plugin side
class PluginHarness:
    """Real Bridge TCP server + a fake GUI thread draining its queue into dispatch(FakeAdapter)."""

    def __init__(self, port: int) -> None:
        self.port = port
        self.adapter = FakeAdapter()
        self.handled_on: List[int] = []
        self.gui_ident: Optional[int] = None
        self.bridge: Optional[Bridge] = None
        self._stop = threading.Event()
        self._gui: Optional[threading.Thread] = None
        self._socks: List[socket.socket] = []

    def _handle(self, cmd: dict) -> dict:
        self.handled_on.append(threading.get_ident())
        return dispatch(cmd, self.adapter)

    def _gui_loop(self) -> None:
        self.gui_ident = threading.get_ident()
        while not self._stop.is_set():
            if self.bridge is not None:
                self.bridge.drain()
            time.sleep(0.02)

    def start(self) -> "PluginHarness":
        b = Bridge(self._handle, host="127.0.0.1", port=self.port, reply_timeout=2.0, log=lambda m: None)
        b.start()
        srv = b.server
        orig_get = srv.get_request

        def get_request():  # remember accepted sockets so stop() can drop them like a Krita exit
            sock, addr = orig_get()
            self._socks.append(sock)
            return sock, addr

        srv.get_request = get_request  # type: ignore[method-assign]
        self.bridge = b
        self._stop.clear()
        self._gui = threading.Thread(target=self._gui_loop, name="fake-krita-gui", daemon=True)
        self._gui.start()
        return self

    def stop(self) -> None:
        """Stop like Krita quitting: close the listener AND every live connection.

        (Bridge.stop() alone only closes the listener; established connections stay open.)
        """
        if self.bridge is not None:
            self.bridge.stop()
            self.bridge = None
        for s in self._socks:
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                s.close()
            except OSError:
                pass
        self._socks.clear()
        self._stop.set()
        if self._gui is not None:
            self._gui.join(1)
            self._gui = None

    @property
    def connections(self) -> int:
        return self.bridge.connections if self.bridge else 0


# --------------------------------------------------------------------------- helper side
class HelperProc:
    def __init__(self, ws_port: int, plugin_port: int, *, fake_pointer: bool = False, name: str = "helper") -> None:
        self.ws_port, self.plugin_port = ws_port, plugin_port
        self.fake_pointer = fake_pointer
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        self.log_path = LOG_DIR / f"{name}-{ws_port}.log"
        self.proc: Optional[subprocess.Popen] = None

    def start(self) -> "HelperProc":
        args = [
            PY, "-u", str(SHIM),
            "--host", "127.0.0.1", "--port", str(self.ws_port),
            "--plugin-port", str(self.plugin_port),
            "--origin", ORIGIN,
            "--no-hotkeys", "--no-overlay", "-v",
        ]
        if not self.fake_pointer:
            args.append("--no-pointer")
        env = dict(os.environ)
        env.pop("STEADY_ORIGIN", None)
        if self.fake_pointer:
            env["STEADY_SHIM_FAKE_POINTER"] = "1"
        else:
            env.pop("STEADY_SHIM_FAKE_POINTER", None)
        self._fh = open(self.log_path, "w")
        self.proc = subprocess.Popen(args, cwd=str(ROOT), stdout=self._fh, stderr=subprocess.STDOUT, env=env)
        wait_until(lambda: "ready on ws://" in self.log() or self.proc.poll() is not None, 20, "helper ready")
        assert self.proc.poll() is None, f"helper exited early:\n{self.log()}"
        return self

    def log(self) -> str:
        try:
            return self.log_path.read_text()
        except FileNotFoundError:
            return ""

    def stop(self, sig: int = signal.SIGTERM) -> int:
        if self.proc is None:
            return 0
        if self.proc.poll() is None:
            self.proc.send_signal(sig)  # by PID only
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(5)
        self._fh.close()
        rc = self.proc.returncode
        self.proc = None
        return rc

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.ws_port}"


class Client:
    """Sync websockets client that keeps every received message."""

    def __init__(self, url: str, origin: str = ORIGIN) -> None:
        self.ws = connect(url, origin=origin, open_timeout=5, max_size=2**22, legacy=True)
        self.inbox: List[Dict[str, Any]] = []

    def send(self, msg: Dict[str, Any]) -> str:
        msg = {"id": str(uuid.uuid4()), **msg}
        self.ws.send(json.dumps(msg))
        return msg["id"]

    def wait_for(self, pred: Callable[[Dict[str, Any]], bool], timeout: float = 5.0, what: str = "message") -> Dict[str, Any]:
        for m in self.inbox:
            if pred(m):
                return m
        end = time.monotonic() + timeout
        while True:
            left = end - time.monotonic()
            if left <= 0:
                raise AssertionError(f"no {what} within {timeout}s; got {[x.get('t') for x in self.inbox]}")
            try:
                raw = self.ws.recv(timeout=left)
            except TimeoutError:
                continue
            m = json.loads(raw)
            self.inbox.append(m)
            if pred(m):
                return m

    def reply(self, rid: str, timeout: float = 6.0) -> Dict[str, Any]:
        return self.wait_for(lambda m: m.get("id") == rid, timeout, f"reply to {rid}")

    def close(self) -> None:
        try:
            self.ws.close()
        except Exception:
            pass


@pytest.fixture
def plugin():
    h = PluginHarness(free_port(int(os.environ.get("STEADY_INTEG_PLUGIN_PORT", "0")) or None)).start()
    yield h
    h.stop()


@pytest.fixture
def helper(plugin):
    hp = HelperProc(free_port(int(os.environ.get("STEADY_INTEG_HELPER_PORT", "0")) or None), plugin.port).start()
    yield hp
    hp.stop()
    assert BLOCKED not in hp.log(), "the helper tried to emit a real input event (blocked by the shim):\n" + hp.log()


def connected_client(helper: HelperProc, plugin: PluginHarness) -> Client:
    wait_until(lambda: plugin.connections >= 1, 6, "helper relay connected to the bridge")
    c = Client(helper.url)
    hello = c.wait_for(lambda m: m.get("t") == "hello", 5, "hello")
    if not hello.get("krita"):
        c.wait_for(lambda m: m.get("t") == "krita_state" and m.get("connected") is True, 5, "krita_state connected")
    return c


# =========================================================================== tests
@pytest.mark.P1
def test_hello_reports_krita_true_once_bridge_connected(helper, plugin):
    c = connected_client(helper, plugin)
    try:
        hello = next(m for m in c.inbox if m["t"] == "hello")
        assert isinstance(hello["id"], str) and hello["id"]
        assert hello["krita"] is True, hello
        assert hello["paused"] is False
        assert set(hello["screen"]) >= {"w", "h", "scale"} and hello["screen"]["w"] > 0
        assert isinstance(hello["accessibility"], bool) and isinstance(hello["input_monitoring"], bool)
        assert "krita_running" in hello and "krita_window_rect" in hello
    finally:
        c.close()


@pytest.mark.P1
def test_ping_pong_echoes_id(helper, plugin):
    c = connected_client(helper, plugin)
    try:
        rtts = []
        for _ in range(5):
            t0 = time.monotonic()
            rid = c.send({"t": "ping"})
            r = c.reply(rid, 2)
            rtts.append((time.monotonic() - t0) * 1000)
            assert r["t"] == "pong" and r["id"] == rid
        assert max(rtts) < 200, rtts
    finally:
        c.close()


@pytest.mark.P2a
def test_krita_color_round_trip_through_real_bridge(helper, plugin):
    c = connected_client(helper, plugin)
    try:
        before = len(plugin.handled_on)
        rid = c.send({"t": "krita", "cmd": "color", "hex": "#1d4ed8", "fallback_keys": "cmd+z"})
        r = c.reply(rid)
        assert r["t"] == "krita_reply" and r["id"] == rid
        assert r["ok"] is True and r["via"] == "plugin", r
        assert r.get("color") == "#1d4ed8"
        assert plugin.adapter.color == "#1d4ed8"
        assert plugin.handled_on[before:] and set(plugin.handled_on[before:]) == {plugin.gui_ident}
        # a plugin-side error passes through with via:"plugin"
        rid = c.send({"t": "krita", "cmd": "color", "hex": "blue"})
        r = c.reply(rid)
        assert r["ok"] is False and r["error"] == "bad_hex" and r["via"] == "plugin", r
        # a big reply (list_actions, ~38 KB on real Krita) and get_state pass through intact
        rid = c.send({"t": "krita", "cmd": "list_actions"})
        r = c.reply(rid)
        assert r["ok"] is True and len(r["actions"]) == len(plugin.adapter.actions)
        rid = c.send({"t": "krita", "cmd": "get_state"})
        r = c.reply(rid)
        assert r["ok"] is True and r["color"] == "#1d4ed8" and "layer" in r, r
    finally:
        c.close()


@pytest.mark.P2a
def test_krita_state_toggles_and_fallback_keys_when_bridge_down(helper, plugin):
    c = connected_client(helper, plugin)
    try:
        plugin.stop()  # Krita quits: listener and live connection close
        c.wait_for(lambda m: m.get("t") == "krita_state" and m.get("connected") is False, 5, "krita_state false")

        rid = c.send({"t": "krita", "cmd": "color", "hex": "#ff0000"})
        r = c.reply(rid)
        assert r == {"t": "krita_reply", "id": rid, "ok": False, "error": "plugin_down"} or (
            r["ok"] is False and r["error"] == "plugin_down"
        ), r

        # fallback_keys path with an unparseable combo: proves the route (via:"keys") and returns
        # before ANY system call (bad_combo is checked first in post_keys).
        rid = c.send({"t": "krita", "cmd": "action", "action": "edit_undo", "fallback_keys": "notakey"})
        r = c.reply(rid)
        assert r["via"] == "keys" and r["ok"] is False and r["error"] == "bad_combo", r

        # a real combo: the shim seals the key poster/activation; the helper refuses earlier
        # (no Accessibility for the test runner -> "permission"; Krita not running -> "krita_not_running").
        rid = c.send({"t": "krita", "cmd": "action", "action": "edit_undo", "fallback_keys": "cmd+z"})
        r = c.reply(rid)
        assert r["via"] == "keys" and r["ok"] is False, r
        assert r["error"] in ("permission", "krita_not_running", "krita_not_frontmost"), r

        # Krita comes back on the same port: the relay reconnects (every 2 s) and says so.
        plugin.start()
        c.wait_for(lambda m: m.get("t") == "krita_state" and m.get("connected") is True, 6, "krita_state true again")
        rid = c.send({"t": "krita", "cmd": "color", "hex": "#00ff00"})
        r = c.reply(rid)
        assert r["ok"] is True and r["via"] == "plugin" and plugin.adapter.color == "#00ff00", r
    finally:
        c.close()


@pytest.mark.P1
@pytest.mark.parametrize(
    "origin",
    ["http://localhost:3000", "http://localhost:3999", "http://evil.example", "null", None],
)
def test_bad_origin_is_refused_with_4003(helper, plugin, origin):
    if origin == f"http://localhost:{APP_PORT}":
        pytest.skip("this origin is the allowed one")
    try:
        ws = connect(helper.url, origin=origin, open_timeout=5, legacy=True) if origin else connect(helper.url, open_timeout=5, legacy=True)
    except InvalidStatus as e:  # refusal during the handshake also counts
        assert e.response.status_code >= 400
        return
    try:
        with pytest.raises(ConnectionClosed) as ei:
            ws.recv(timeout=3)
        assert ei.value.rcvd is not None and ei.value.rcvd.code == 4003, ei.value
    finally:
        ws.close()
    assert "refused connection with Origin" in helper.log()


@pytest.mark.P1
def test_no_pointer_mode_refuses_down_and_click(helper, plugin):
    """--no-pointer: `down`/`click`/`middle_down` answer a permission error; nothing is pressed,
    so the watchdog has nothing to release (see the fake-pointer test below for the watchdog)."""
    c = connected_client(helper, plugin)
    try:
        c.send({"t": "move", "x": 100, "y": 100})
        for t, extra in (("down", {}), ("click", {"x": 100, "y": 100}), ("middle_down", {})):
            rid = c.send({"t": t, **extra})
            r = c.reply(rid, 2)
            assert r["t"] == "error" and r["code"] == "permission" and r.get("which") == "accessibility", r
        time.sleep(0.5)
        assert "released button" not in helper.log()
    finally:
        c.close()


@pytest.fixture
def fake_pointer_helper(plugin):
    hp = HelperProc(free_port(), plugin.port, fake_pointer=True, name="helper-fakeptr").start()
    yield hp
    hp.stop()
    assert BLOCKED not in hp.log(), hp.log()


@pytest.mark.P1
def test_watchdog_releases_after_silence_fake_pointer(fake_pointer_helper, plugin):
    """Watchdog in the real process, observed through the shim's logging fake mouse (stderr) and
    the helper's own `released button (watchdog: ...)` log line."""
    hp = fake_pointer_helper
    c = connected_client(hp, plugin)
    try:
        c.send({"t": "move", "x": 200, "y": 200})
        rid = c.send({"t": "down"})
        # keep the pen down with pings for 0.5 s: no release while messages flow
        end = time.monotonic() + 0.5
        while time.monotonic() < end:
            c.send({"t": "ping"})
            time.sleep(0.08)
        log = hp.log()
        assert "FAKE-MOUSE down 200.0 200.0" in log, log
        assert "released button" not in log
        assert not any(m.get("id") == rid and m.get("t") == "error" for m in c.inbox)
        t0 = time.monotonic()
        wait_until(lambda: "released button (watchdog: no message for 300 ms)" in hp.log(), 2, "watchdog release")
        assert time.monotonic() - t0 < 1.0
        assert "FAKE-MOUSE up" in hp.log()
    finally:
        c.close()


def _helper_sends_released() -> bool:
    """True once agent C's `released {reason, button}` message exists in the helper sources."""
    src = "".join(p.read_text() for p in (ROOT / "helper" / "steadyhelper").glob("*.py"))
    return '"released"' in src or "'released'" in src


@pytest.mark.P1
def test_watchdog_release_is_reported_to_the_client_fake_pointer(fake_pointer_helper, plugin):
    """Watchdog release → the helper tells the (single) client `released {reason, button}`."""
    hp = fake_pointer_helper
    c = connected_client(hp, plugin)
    try:
        c.send({"t": "move", "x": 50, "y": 60})
        c.send({"t": "down"})
        wait_until(lambda: "FAKE-MOUSE down" in hp.log(), 2, "down")
        wait_until(lambda: "released button (watchdog" in hp.log(), 2, "watchdog release")
        try:
            m = c.wait_for(lambda m: m.get("t") == "released", 2.0, "released message")
        except AssertionError:
            if not _helper_sends_released():
                pytest.skip("agent C's `released {reason, button}` message has not landed in helper/steadyhelper yet")
            raise
        assert m["button"] in ("left", "both", "all"), m
        assert "watchdog" in str(m.get("reason", "")), m
    finally:
        c.close()


@pytest.mark.P1
def test_socket_close_and_sigterm_release_fake_pointer(fake_pointer_helper, plugin):
    hp = fake_pointer_helper
    c = connected_client(hp, plugin)
    c.send({"t": "move", "x": 10, "y": 10})
    c.send({"t": "down"})
    wait_until(lambda: "FAKE-MOUSE down" in hp.log(), 2, "down")
    c.close()
    wait_until(lambda: "released button (socket closed)" in hp.log(), 2, "release on socket close")

    c2 = connected_client(hp, plugin)
    c2.send({"t": "down"})
    wait_until(lambda: hp.log().count("FAKE-MOUSE down") >= 2, 2, "second down")
    c2.send({"t": "ping"})
    rc = hp.stop(signal.SIGTERM)  # by PID
    log = hp.log()
    assert rc == 0, log
    assert "released button (signal" in log or "released button (shutdown)" in log, log
    assert log.count("FAKE-MOUSE up") >= 2, log
    c2.close()
