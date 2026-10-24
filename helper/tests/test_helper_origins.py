"""Allowed Origins: default exactly http://localhost:3000; --origin / STEADY_ORIGIN for other
local ports; '*' and non-local origins refused at startup."""

import pytest
from websockets.exceptions import ConnectionClosed

from steadyhelper_testkit import rig  # noqa: I001

from steadyhelper.main import parse_args
from steadyhelper.origins import BadOrigin, resolve_origins

pytestmark = pytest.mark.P1


def test_default_is_exactly_localhost_3000():
    assert resolve_origins(None, {}) == ["http://localhost:3000"]
    assert parse_args([], env={}).origins == ["http://localhost:3000"]


def test_flags_repeatable_and_env_comma_separated():
    a = parse_args(["--origin", "http://localhost:3100", "--origin", "http://127.0.0.1:3100"], env={})
    assert a.origins == ["http://localhost:3100", "http://127.0.0.1:3100"]
    env = {"STEADY_ORIGIN": "http://localhost:3100, http://localhost:3000"}
    assert parse_args([], env=env).origins == ["http://localhost:3100", "http://localhost:3000"]
    # flags win over the env var
    assert parse_args(["--origin", "http://localhost:4000"], env=env).origins == ["http://localhost:4000"]


@pytest.mark.parametrize(
    "bad",
    [
        "*",
        "http://evil.example",
        "http://localhost.evil.example:3000",
        "http://192.168.1.5:3000",
        "http://localhost:3000/path",
        "http://user@localhost:3000",
        "file://",
        "null",
        "http://localhost:99999",
    ],
)
def test_non_local_origin_flag_refused(bad, capsys):
    with pytest.raises(BadOrigin):
        resolve_origins([bad], {})
    with pytest.raises(SystemExit) as e:
        parse_args(["--origin", bad], env={})
    assert e.value.code == 2
    assert "only http://localhost" in capsys.readouterr().err
    with pytest.raises(SystemExit):
        parse_args([], env={"STEADY_ORIGIN": f"http://localhost:3100,{bad}"})


@pytest.mark.asyncio
async def test_default_rejects_localhost_3100():
    async with rig() as r:
        with pytest.raises(ConnectionClosed) as ei:
            async with r.client(origin="http://localhost:3100", skip_hello=False) as c:
                await c.recv(timeout=1.0)
        assert ei.value.rcvd.code == 4003


@pytest.mark.asyncio
async def test_origin_flag_accepts_localhost_3100():
    origins = parse_args(["--origin", "http://localhost:3100"], env={}).origins
    async with rig(allowed_origins=origins) as r:
        async with r.client(origin="http://localhost:3100") as c:
            assert c.hello["t"] == "hello"
        # the default origin is no longer accepted unless also listed
        with pytest.raises(ConnectionClosed):
            async with r.client(origin="http://localhost:3000", skip_hello=False) as c:
                await c.recv(timeout=1.0)
