"""§4/§5 global hotkeys: relay to the Worker, consumed only while Krita or Chrome is frontmost."""

import pytest

from steadyhelper_testkit import mid, rig, wait_until  # noqa: I001

from steadyhelper.config import FKEY_KEYCODES, KRITA_BUNDLE_ID
from steadyhelper.hotkeys import HotkeyRouter

pytestmark = pytest.mark.P1

F = FKEY_KEYCODES


def make(front="org.kde.krita", client=True):
    emitted = []
    state = {"front": front, "client": client}
    r = HotkeyRouter(emit=emitted.append, frontmost=lambda: state["front"], has_client=lambda: state["client"])
    return r, emitted, state


@pytest.mark.parametrize(
    "key,name",
    [("f8", "pen"), ("f9", "pause"), ("f7", "undo"), ("f6", "redo"), ("f5", "recenter"), ("f4", "other_hand"), ("f3", "latch")],
)
@pytest.mark.parametrize("front", [KRITA_BUNDLE_ID, "com.google.Chrome"])
def test_mapped_key_consumed_and_emitted_when_krita_or_chrome_front(key, name, front):
    r, emitted, _ = make(front)
    assert r.handle(F[key], True) == (True, [name])
    assert r.handle(F[key], False) == (True, [])  # key-up consumed too, emits nothing
    assert emitted == [name]


@pytest.mark.parametrize("front", ["com.apple.finder", "com.apple.Safari", None])
def test_other_apps_untouched(front):
    r, emitted, _ = make(front)
    for k in F.values():
        assert r.handle(k, True) == (False, [])
        assert r.handle(k, False) == (False, [])
    assert emitted == []


def test_not_consumed_without_a_connected_worker():
    r, emitted, _ = make(KRITA_BUNDLE_ID, client=False)
    assert r.handle(F["f8"], True) == (False, [])
    assert emitted == []


def test_unmapped_keys_pass_through():
    r, emitted, _ = make()
    assert r.handle(0, True) == (False, [])  # "a"
    assert r.handle(F["f9"] + 1000, True) == (False, [])
    assert emitted == []


def test_f10_push_to_talk_down_and_up():
    r, emitted, _ = make()
    assert r.handle(F["f10"], True) == (True, ["ptt_down"])
    assert r.handle(F["f10"], True, is_repeat=True) == (True, [])  # auto-repeat while held
    assert r.handle(F["f10"], True) == (True, [])  # still held
    assert r.handle(F["f10"], False) == (True, ["ptt_up"])
    assert emitted == ["ptt_down", "ptt_up"]


def test_key_up_consumed_even_if_frontmost_changed_meanwhile():
    r, emitted, state = make()
    assert r.handle(F["f10"], True)[0] is True
    state["front"] = "com.apple.finder"
    assert r.handle(F["f10"], False) == (True, ["ptt_up"])  # never leave the mic open
    # a fresh press in Finder is untouched
    assert r.handle(F["f10"], True) == (False, [])
    assert r.handle(F["f10"], False) == (False, [])


def test_key_up_not_consumed_if_down_was_not():
    r, _, state = make("com.apple.finder")
    assert r.handle(F["f8"], True) == (False, [])
    state["front"] = KRITA_BUNDLE_ID
    assert r.handle(F["f8"], False) == (False, [])


@pytest.mark.asyncio
async def test_hotkey_relayed_to_worker_and_lifts_pen():
    async with rig() as r:
        r.system.frontmost = KRITA_BUNDLE_ID
        async with r.client() as c:
            await c.send({"t": "move", "id": mid(), "x": 5, "y": 5})
            await c.send({"t": "down", "id": mid()})
            assert await wait_until(lambda: r.server.pointer.is_down)
            assert await wait_until(lambda: r.server._frontmost == KRITA_BUNDLE_ID)
            # simulate the key tap thread
            consume, names = r.server.router.handle(F["f9"], True)
            assert consume and names == ["pause"]
            m = await c.recv_type("hotkey")
            assert m["key"] == "pause" and isinstance(m["id"], str)
            assert not r.server.pointer.is_down  # pause key lifts at once
            r.server.router.handle(F["f9"], False)
            consume, _ = r.server.router.handle(F["f10"], True)
            assert (await c.recv_type("hotkey"))["key"] == "ptt_down"
            r.server.router.handle(F["f10"], False)
            assert (await c.recv_type("hotkey"))["key"] == "ptt_up"


@pytest.mark.asyncio
async def test_hotkey_not_consumed_when_other_app_front_over_the_wire():
    async with rig() as r:
        r.system.frontmost = "com.apple.finder"
        async with r.client():
            assert await wait_until(lambda: r.server._frontmost == "com.apple.finder")
            assert r.server.router.handle(F["f8"], True) == (False, [])
