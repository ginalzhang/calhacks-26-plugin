"""Startup: permissions, the message naming the launching app, pointer-less mode, key combos."""

import pytest

from steadyhelper_testkit import mid, rig  # noqa: I001

from steadyhelper.keys import FLAG_CMD, FLAG_SHIFT, BadCombo, parse_combo
from steadyhelper.main import parse_args
from steadyhelper.permissions import (
    PermissionState,
    app_name_from_chain,
    check_permissions,
    detect_conflicts,
    launching_app_name,
)

pytestmark = pytest.mark.P1


def test_launching_app_from_process_chain():
    chain = [
        "/Users/x/.venv/bin/python3.12",
        "bash",
        "/bin/zsh",
        "/Applications/iTerm.app/Contents/MacOS/iTerm2",
        "/sbin/launchd",
    ]
    assert app_name_from_chain(chain) == "iTerm"
    assert launching_app_name(env={}, chain=chain) == "iTerm"
    assert launching_app_name(env={"TERM_PROGRAM": "Apple_Terminal"}, chain=["zsh"]) == "Terminal"
    assert launching_app_name(env={}, chain=["zsh"]) == "the terminal app you launched Steady from"
    vscode = [
        "/bin/zsh",
        "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
        "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
    ]
    assert app_name_from_chain(vscode) == "Visual Studio Code"
    conductor = [
        "/bin/zsh",
        "/Users/x/Library/Application Support/com.conductor.app/agent-binaries/claude",
        "/Applications/Conductor.app/Contents/MacOS/conductor",
    ]
    assert app_name_from_chain(conductor) == "Conductor"


def test_check_permissions_requests_listen_access_once_and_reports():
    calls = []
    st = check_permissions(
        request_listen=lambda: calls.append("listen"),
        ax_trusted_prompt=lambda: False,
        listen_trusted=lambda: True,
        app_name="Terminal",
    )
    assert calls == ["listen"]
    assert st == PermissionState(False, True, "Terminal")
    assert st.pointer_enabled is False


def test_check_permissions_survives_exceptions():
    def boom():
        raise RuntimeError("x")

    st = check_permissions(request_listen=boom, ax_trusted_prompt=boom, listen_trusted=boom, app_name="T")
    assert st.accessibility is False and st.input_monitoring is False


@pytest.mark.asyncio
async def test_permission_errors_sent_and_pointer_less_mode():
    perms = PermissionState(accessibility=False, input_monitoring=False, app_name="Ghostty")
    async with rig(permissions=perms, pointer_enabled=False) as r:
        async with r.client() as c:
            assert c.hello["accessibility"] is False and c.hello["input_monitoring"] is False
            e1 = await c.recv_type("error")
            e2 = await c.recv_type("error")
            assert {e1["which"], e2["which"]} == {"accessibility", "input_monitoring"}
            for e in (e1, e2):
                assert e["code"] == "permission"
                assert "Ghostty" in e["message"]
            ax = e1 if e1["which"] == "accessibility" else e2
            assert "Privacy_Accessibility" in ax["message"]
            im = e2 if ax is e1 else e1
            assert "Privacy_ListenEvent" in im["message"]
            # pointer-less: moves are accepted but nothing is posted; down/click explain why
            await c.send({"t": "move", "id": mid(), "x": 1, "y": 1})
            rid = mid()
            await c.send({"t": "down", "id": rid})
            m = await c.recv_id(rid)
            assert m["code"] == "permission" and m["which"] == "accessibility"
            rid = mid()
            await c.send({"t": "ping", "id": rid})
            assert (await c.recv_id(rid))["t"] == "pong"  # still running
            assert r.mouse.events == []


def test_conflict_detection():
    notes = detect_conflicts(["Finder", "WacomTabletDriver", "VoiceControl"])
    assert any("tablet" in n for n in notes)
    assert any("Voice Control" in n for n in notes)
    assert detect_conflicts(["Finder", "krita"]) == []


@pytest.mark.parametrize(
    "combo,keycode,flags",
    [
        ("cmd+z", 6, FLAG_CMD),
        ("cmd+shift+z", 6, FLAG_CMD | FLAG_SHIFT),
        ("]", 30, 0),
        ("[", 33, 0),
        ("+", 24, FLAG_SHIFT),
        ("-", 27, 0),
        ("shift+delete", 117, FLAG_SHIFT),
        ("delete", 117, 0),
        ("cmd+e", 14, FLAG_CMD),
        ("cmd+s", 1, FLAG_CMD),
        ("f5", 96, 0),
        ("4", 21, 0),
        ("5", 23, 0),
        ("6", 22, 0),
        ("x", 7, 0),
        ("cmd++", 24, FLAG_CMD | FLAG_SHIFT),
    ],
)
def test_parse_combo(combo, keycode, flags):
    s = parse_combo(combo)
    assert (s.keycode, s.flags) == (keycode, flags)


@pytest.mark.parametrize("bad", ["", "hyper+z", "cmd+nokey"])
def test_parse_combo_rejects(bad):
    with pytest.raises(BadCombo):
        parse_combo(bad)


def test_every_keystroke_fallback_in_actions_ts_parses():
    """Every `keys:` fallback in src/actions.ts must be postable by the helper."""
    import re

    from steadyhelper_testkit import REPO

    src = (REPO / "src" / "actions.ts").read_text()
    combos = set(re.findall(r'keys:\s*"([^"]+)"', src))
    assert combos, "no keys found"
    for c in combos:
        parse_combo(c)


def test_cli_defaults():
    a = parse_args([])
    assert a.port == 8765 and a.origins == ["http://localhost:3000"] and a.plugin_port == 8766


def test_detect_warnings_codes():
    from steadyhelper.protocol import WARNING_CODES, validate_helper_msg, warning
    from steadyhelper.permissions import detect_warnings

    w = detect_warnings(["Finder", "VoiceControl", "WacomTabletDriver"])
    assert [c for c, _ in w] == ["voice_control", "tablet"]
    for code, message in w:
        assert code in WARNING_CODES
        assert validate_helper_msg(warning(code, message)) is None
    assert detect_warnings(["Finder", "krita"]) == []


@pytest.mark.asyncio
async def test_one_warning_per_active_startup_warning_after_hello():
    from steadyhelper.permissions import detect_warnings
    from steadyhelper.protocol import validate_helper_msg

    warnings = detect_warnings(["VoiceControl", "PenTabletDriver"])
    async with rig(warnings=warnings) as r:
        for _ in range(2):  # every new client gets them, right after hello
            async with r.client(skip_hello=False) as c:
                hello = await c.recv()
                assert hello["t"] == "hello"
                w1, w2 = await c.recv(), await c.recv()
                assert [w1["t"], w2["t"]] == ["warning", "warning"]
                assert [w1["code"], w2["code"]] == ["voice_control", "tablet"]
                assert w1["id"] != w2["id"]
                for m in (w1, w2):
                    assert validate_helper_msg(m) is None and m["message"]


@pytest.mark.asyncio
async def test_no_warning_messages_when_nothing_is_active():
    async with rig() as r:
        async with r.client() as c:
            rid = mid()
            await c.send({"t": "ping", "id": rid})
            m = await c.recv()  # first message after hello is the pong, not a warning
            assert m == {"t": "pong", "id": rid}
