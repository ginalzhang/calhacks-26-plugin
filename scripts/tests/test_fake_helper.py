"""Fake helper (scripts/fake_helper.py) behaves as docs/PROTOCOL.md › "Fake helper" says."""

import asyncio
import importlib.util
import json
import sys
import urllib.request
from pathlib import Path

import pytest
import pytest_asyncio
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("steady_fake_helper", REPO / "scripts" / "fake_helper.py")
fake_helper = importlib.util.module_from_spec(_spec)
sys.modules["steady_fake_helper"] = fake_helper
_spec.loader.exec_module(fake_helper)

sys.path.insert(0, str(REPO / "helper"))
from steadyhelper.protocol import validate_helper_msg  # noqa: E402

EXAMPLES = json.loads((REPO / "docs" / "protocol-examples.json").read_text())
pytestmark = pytest.mark.P1


def http(fake, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{fake.http_port}{path}", data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


async def ahttp(fake, method, path, body=None):
    return await asyncio.to_thread(http, fake, method, path, body)


async def recv(ws, timeout=2.0):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout))


@pytest_asyncio.fixture
async def fake():
    f = await fake_helper.FakeHelper(ws_port=0, http_port=0, quiet=True).start()
    try:
        yield f
    finally:
        await f.stop()


def url(f):
    return f"ws://127.0.0.1:{f.ws_port}"


@pytest.mark.asyncio
@pytest.mark.parametrize("origin", ["http://localhost:3000", None])
async def test_accepts_localhost_origin_and_no_origin_and_sends_hello(fake, origin):
    kw = {"origin": origin} if origin else {}
    async with connect(url(fake), **kw) as ws:
        hello = await recv(ws)
        assert hello["t"] == "hello"
        assert validate_helper_msg(hello) is None


@pytest.mark.asyncio
async def test_rejects_other_origins(fake):
    with pytest.raises(ConnectionClosed) as ei:
        async with connect(url(fake), origin="http://evil.example") as ws:
            await recv(ws)
    assert ei.value.rcvd.code == 4003


@pytest.mark.asyncio
async def test_replies_and_records_every_example(fake):
    async with connect(url(fake), origin="http://localhost:3000") as ws:
        await recv(ws)  # hello
        sent = list(EXAMPLES["worker_to_helper"].values())
        for m in sent:
            await ws.send(json.dumps(m))
        replies = {}
        expect = {m["id"] for m in sent if m["t"] in ("ping", "keys", "click", "pause", "resume", "krita")}
        while expect - set(replies):
            r = await recv(ws)
            assert validate_helper_msg(r) is None, r
            replies[r["id"]] = r
        ex = EXAMPLES["worker_to_helper"]
        assert replies[ex["ping"]["id"]] == {"t": "pong", "id": ex["ping"]["id"]}
        assert replies[ex["keys"]["id"]] == {"t": "ack", "id": ex["keys"]["id"], "ok": True}
        kr = replies[ex["krita"]["id"]]
        assert kr["t"] == "krita_reply" and kr["ok"] is True and kr["via"] == "plugin"
        recorded = await ahttp(fake, "GET", "/messages")
        assert recorded == sent
        moves = await ahttp(fake, "GET", "/messages?t=move")
        assert moves == [ex["move"]]
        assert (await ahttp(fake, "POST", "/reset"))["ok"] is True
        assert await ahttp(fake, "GET", "/messages") == []


@pytest.mark.asyncio
async def test_send_pushes_to_every_client(fake):
    async with connect(url(fake), origin="http://localhost:3000") as a, connect(url(fake)) as b:
        await recv(a)
        await recv(b)
        res = await ahttp(fake, "POST", "/send", {"t": "hotkey", "key": "pause"})
        assert res["sent_to"] == 2
        for ws in (a, b):
            m = await recv(ws)
            assert m["t"] == "hotkey" and m["key"] == "pause" and isinstance(m["id"], str)
        await ahttp(fake, "POST", "/send", EXAMPLES["helper_to_worker"]["krita_state"])
        assert (await recv(a)) == EXAMPLES["helper_to_worker"]["krita_state"]


@pytest.mark.asyncio
async def test_config_krita_false_replies_plugin_down(fake):
    await ahttp(fake, "POST", "/config", {"krita": False})
    async with connect(url(fake), origin="http://localhost:3000") as ws:
        hello = await recv(ws)
        assert hello["krita"] is False
        await ws.send(json.dumps({"t": "krita", "id": "k1", "cmd": "color", "hex": "#000000"}))
        r = await recv(ws)
        assert r == {"t": "krita_reply", "id": "k1", "ok": False, "error": "plugin_down"}


@pytest.mark.asyncio
async def test_canned_krita_payloads(fake):
    async with connect(url(fake)) as ws:
        await recv(ws)
        await ws.send(json.dumps({"t": "krita", "id": "la", "cmd": "list_actions"}))
        r = await recv(ws)
        assert {"id": "merge_layer", "text": "Merge with Layer Below"} in r["actions"]
        assert r["id"] == "la"


@pytest.mark.asyncio
async def test_health(fake):
    h = await ahttp(fake, "GET", "/health")
    assert h == {"ok": True, "clients": 0}
