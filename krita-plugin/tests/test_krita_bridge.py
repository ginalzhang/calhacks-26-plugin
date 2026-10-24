"""Steady Krita plugin: TCP bridge round-trips with a fake GUI-thread drain (no Qt). Spec §7."""
from __future__ import annotations

import json
import socket
import threading
import time

import pytest

from krita_fakes import FakeAdapter, load_examples
from steady.bridge import Bridge
from steady.dispatch import dispatch

pytestmark = pytest.mark.P2a


class FakeGui:
    """Stands in for Krita's 20 ms QTimer: drains the bridge queue on its own thread."""

    def __init__(self, bridge: Bridge, period: float = 0.02):
        self.bridge, self.period = bridge, period
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.ident = None

    def _run(self):
        self.ident = threading.get_ident()
        while not self.stop.is_set():
            self.bridge.drain()
            time.sleep(self.period)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *a):
        self.stop.set()
        self.thread.join(1)


@pytest.fixture
def served():
    fake = FakeAdapter()
    handled_on = []

    def handle(cmd):
        handled_on.append(threading.get_ident())
        return dispatch(cmd, fake)

    bridge = Bridge(handle, host="127.0.0.1", port=0, reply_timeout=2.0, log=lambda m: None)
    host, port = bridge.start()
    yield bridge, fake, host, port, handled_on
    bridge.stop()


def connect(host, port):
    s = socket.create_connection((host, port), timeout=3)
    return s, s.makefile("rb")


def roundtrip(sock, rfile, obj):
    sock.sendall((json.dumps(obj) + "\n").encode())
    return json.loads(rfile.readline())


def test_round_trip_runs_on_gui_thread(served):
    bridge, fake, host, port, handled_on = served
    assert host == "127.0.0.1" and port > 0
    with FakeGui(bridge) as gui:
        s, rf = connect(host, port)
        r = roundtrip(s, rf, {"id": "a1", "cmd": "color", "hex": "#1d4ed8"})
        assert r == {"id": "a1", "ok": True, "color": "#1d4ed8"}
        assert fake.color == "#1d4ed8"
        assert handled_on == [gui.ident]  # Krita API only on the "GUI" thread
        s.close()


def test_pipelined_lines_reply_in_order(served):
    bridge, fake, host, port, _ = served
    with FakeGui(bridge):
        s, rf = connect(host, port)
        lines = [{"id": f"p{i}", "cmd": "action", "action": "edit_undo"} for i in range(5)]
        s.sendall("".join(json.dumps(x) + "\n" for x in lines).encode())
        got = [json.loads(rf.readline()) for _ in lines]
        assert [g["id"] for g in got] == [x["id"] for x in lines]
        assert all(g["ok"] for g in got)
        assert fake.actions["edit_undo"].triggers == 5
        s.close()


def test_every_plugin_request_example_over_tcp(served):
    bridge, _, host, port, _ = served
    with FakeGui(bridge):
        s, rf = connect(host, port)
        for name, req in load_examples()["plugin_request"].items():
            r = roundtrip(s, rf, req)
            assert r["id"] == req["id"] and r["ok"] is True, (name, r)
        s.close()


def _closed(rf) -> bool:
    try:
        return rf.readline() == b""
    except (ConnectionError, OSError):
        return True


def test_unknown_cmd_keeps_connection_open(served):
    bridge, _, host, port, _ = served
    with FakeGui(bridge):
        s, rf = connect(host, port)
        r = roundtrip(s, rf, {"id": "u1", "cmd": "nope"})
        assert r == {"id": "u1", "ok": False, "error": "unknown_cmd", "cmd": "nope"}
        assert roundtrip(s, rf, {"id": "p1", "cmd": "ping"}) == {"id": "p1", "ok": True}
        s.close()


@pytest.mark.parametrize("first", [b"this is not json", b"[1, 2]", b'"str"', b"42", b"{bad json"])
def test_first_non_object_line_closes_connection(served, first):
    bridge, fake, host, port, _ = served
    with FakeGui(bridge):
        s, rf = connect(host, port)
        s.sendall(first + b'\n{"id":"x","cmd":"action","action":"edit_undo"}\n')
        r = json.loads(rf.readline())
        assert r["ok"] is False and r["error"] == "bad_args" and "closing" in r["message"]
        assert _closed(rf)
        assert fake.actions["edit_undo"].triggers == 0
        s.close()


def test_http_post_body_is_never_executed(served):
    """A web page's no-cors POST to 127.0.0.1:8766 (review R10)."""
    bridge, fake, host, port, _ = served
    body = b'\n{"id":"x","cmd":"action","action":"edit_undo"}\n{"id":"y","cmd":"color","hex":"#ff0000"}\n'
    req = (b"POST / HTTP/1.1\r\nHost: 127.0.0.1:8766\r\nContent-Type: text/plain\r\n"
           b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
    with FakeGui(bridge):
        s, rf = connect(host, port)
        s.sendall(req)
        assert json.loads(rf.readline())["error"] == "bad_args"
        assert _closed(rf)
        time.sleep(0.1)
        assert fake.actions["edit_undo"].triggers == 0 and fake.color == "#000000"
        assert bridge.handled == 0
        s.close()


def test_line_over_1_mib_closes_connection(served):
    bridge, fake, host, port, _ = served
    with FakeGui(bridge):
        s, rf = connect(host, port)
        big = b'{"id":"big","cmd":"ping","pad":"' + b"x" * (1 << 20) + b'"}\n'
        try:
            s.sendall(big + b'{"id":"after","cmd":"ping"}\n')
        except (ConnectionError, OSError):
            pass
        r = json.loads(rf.readline())
        assert r["ok"] is False and "1 MiB" in r["message"]
        assert _closed(rf)
        assert bridge.handled == 0
        s.close()


def test_stop_closes_open_client_connections():
    bridge = Bridge(lambda c: {"id": c["id"], "ok": True}, port=0, log=lambda m: None)
    host, port = bridge.start()
    with FakeGui(bridge):
        s, rf = connect(host, port)
        assert roundtrip(s, rf, {"id": "a", "cmd": "ping"})["ok"]
        deadline = time.time() + 2
        while bridge.connections != 1 and time.time() < deadline:
            time.sleep(0.01)
        assert bridge.connections == 1
        bridge.stop()
        assert _closed(rf)
        deadline = time.time() + 2
        while bridge.connections and time.time() < deadline:
            time.sleep(0.01)
        assert bridge.connections == 0
        with pytest.raises(OSError):
            socket.create_connection((host, port), timeout=1).recv(1)
        s.close()


def test_timeout_when_gui_thread_never_drains():
    bridge = Bridge(lambda c: {"id": c["id"], "ok": True}, port=0, reply_timeout=0.2, log=lambda m: None)
    host, port = bridge.start()
    try:
        s, rf = connect(host, port)
        r = roundtrip(s, rf, {"id": "t1", "cmd": "ping"})
        assert r == {"id": "t1", "ok": False, "error": "timeout", "message": "Krita GUI thread busy"}
        assert bridge.drain() == 1 and bridge.handled == 0  # cancelled request is skipped
        s.close()
    finally:
        bridge.stop()


def test_handler_exception_never_escapes():
    def boom(cmd):
        raise RuntimeError("kaboom")

    bridge = Bridge(boom, port=0, log=lambda m: None)
    fut = bridge.submit({"id": "e1", "cmd": "ping"})
    assert bridge.drain() == 1
    assert fut.result(0) == {"id": "e1", "ok": False, "error": "internal", "message": "kaboom"}


def test_two_clients_and_reconnect(served):
    bridge, _, host, port, _ = served
    with FakeGui(bridge):
        a, ra = connect(host, port)
        b, rb = connect(host, port)
        assert roundtrip(a, ra, {"id": "a", "cmd": "ping"})["id"] == "a"
        assert roundtrip(b, rb, {"id": "b", "cmd": "ping"})["id"] == "b"
        a.close()
        b.close()
        c, rc = connect(host, port)  # helper retries every 2 s; the server keeps accepting
        assert roundtrip(c, rc, {"id": "c", "cmd": "ping"})["ok"] is True
        c.close()


def test_port_in_use_raises_oserror_and_reuse_after_stop():
    b1 = Bridge(lambda c: c, port=0, log=lambda m: None)
    _, port = b1.start()
    b2 = Bridge(lambda c: c, port=port, log=lambda m: None)
    with pytest.raises(OSError):
        b2.start()
    b1.stop()
    b3 = Bridge(lambda c: c, port=port, log=lambda m: None)  # allow_reuse_address
    b3.start()
    b3.stop()


def test_large_unicode_list_actions_is_one_compact_utf8_line(served):
    bridge, fake, host, port, _ = served
    from krita_fakes import FakeAction

    for i in range(1500):  # more actions than a stock Krita 5.3 (≈700 in the bundled .action files)
        fake.actions[f"a{i}"] = FakeAction(f"a{i}", f"レイヤー {i} &Ñ")
    with FakeGui(bridge):
        s, rf = connect(host, port)
        s.sendall(b'{"id":"L","cmd":"list_actions"}\n')
        raw = rf.readline()
        assert raw.endswith(b"\n") and raw.count(b"\n") == 1
        assert "レイヤー".encode() in raw  # not \\u-escaped (6x bigger)
        r = json.loads(raw)
        assert r["ok"] and len(r["actions"]) == len(fake.actions)
        s.close()
