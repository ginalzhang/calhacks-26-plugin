"""Every example in docs/protocol-examples.json parses and validates on the Python side,
and every message the helper builds validates against the same rules."""

import json

import pytest

from steadyhelper_testkit import EXAMPLES, REPO, mid, rig  # noqa: I001

from steadyhelper import protocol as P
from steadyhelper.permissions import PermissionState

pytestmark = pytest.mark.P1


def test_examples_file_parses():
    data = json.loads((REPO / "docs" / "protocol-examples.json").read_text())
    for section in ("worker_to_helper", "helper_to_worker", "plugin_request", "plugin_reply"):
        assert data[section], section


@pytest.mark.parametrize("name", sorted(EXAMPLES["worker_to_helper"]))
def test_worker_to_helper_examples_validate(name):
    msg = EXAMPLES["worker_to_helper"][name]
    assert P.validate_worker_msg(msg) is None, name


@pytest.mark.parametrize("name", sorted(EXAMPLES["helper_to_worker"]))
def test_helper_to_worker_examples_validate(name):
    msg = EXAMPLES["helper_to_worker"][name]
    assert P.validate_helper_msg(msg) is None, name


@pytest.mark.parametrize("name", sorted(EXAMPLES["plugin_request"]))
def test_plugin_request_examples_validate(name):
    assert P.validate_plugin_request(EXAMPLES["plugin_request"][name]) is None, name


@pytest.mark.parametrize("name", sorted(EXAMPLES["plugin_reply"]))
def test_plugin_reply_examples_validate(name):
    assert P.validate_plugin_reply(EXAMPLES["plugin_reply"][name]) is None, name


def test_every_worker_message_type_has_an_example():
    seen = {m["t"] for m in EXAMPLES["worker_to_helper"].values()}
    assert seen == set(P.WORKER_TO_HELPER)


def test_every_helper_message_type_has_an_example():
    seen = {m["t"] for m in EXAMPLES["helper_to_worker"].values()}
    assert seen == set(P.HELPER_TO_WORKER)


def test_every_krita_command_has_a_plugin_request_example():
    seen = {m["cmd"] for m in EXAMPLES["plugin_request"].values()}
    assert seen == set(P.KRITA_COMMANDS)


def test_krita_message_becomes_plugin_request_example_shape():
    m = EXAMPLES["worker_to_helper"]["krita_with_fallback"]
    req = P.plugin_request_from_krita_msg(m)
    assert "t" not in req and "fallback_keys" not in req
    assert req["id"] == m["id"]
    assert P.validate_plugin_request(req) is None


@pytest.mark.parametrize(
    "bad",
    [
        {"t": "move", "id": "a", "x": "1", "y": 2},
        {"t": "move", "x": 1, "y": 2},
        {"t": "click", "id": "a", "x": 1},
        {"t": "krita", "id": "a", "cmd": "nope"},
        {"t": "krita", "id": "a", "cmd": "layer_nav", "dir": "left"},
        {"t": "krita", "id": "a", "cmd": "color"},
        {"t": "chrome_rect", "id": "a", "rect": {"x": 1, "y": 2, "w": 3}},
        {"t": "up", "id": "a", "reason": None},
        {"t": "move", "id": "a", "x": True, "y": 2},
        ["move"],
    ],
)
def test_malformed_worker_messages_rejected(bad):
    assert P.validate_worker_msg(bad) is not None


def test_builders_validate():
    assert P.validate_helper_msg(P.pong("x")) is None
    assert P.validate_helper_msg(P.ack("x", False, "krita_not_running")) is None
    assert P.validate_helper_msg(P.error(None, "permission", "m", which="accessibility")) is None
    assert P.validate_helper_msg(P.hotkey("ptt_down")) is None
    assert P.validate_helper_msg(P.krita_state(True)) is None
    assert P.validate_helper_msg(P.krita_window_rect(None, False)) is None
    assert P.validate_helper_msg(P.krita_reply("x", True, via="plugin", presets=["a"])) is None


@pytest.mark.asyncio
async def test_everything_the_helper_sends_validates():
    perms = PermissionState(accessibility=False, input_monitoring=False, app_name="iTerm")
    async with rig(permissions=perms, window_rect_period=0.05, pointer_enabled=False) as r:
        async with r.client(skip_hello=False) as c:
            await c.send({"t": "ping", "id": mid()})
            await c.send({"t": "pause", "id": mid()})
            await c.send({"t": "down", "id": mid()})
            await c.send({"t": "keys", "id": mid(), "combo": "cmd+z"})
            await c.send({"t": "krita", "id": mid(), "cmd": "ping"})
            got = [await c.recv() for _ in range(9)]
            for m in got:
                assert P.validate_helper_msg(m) is None, m
