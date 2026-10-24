"""`keymap` (P2b): the Worker remaps the global keys (pedals, keypads, no F-keys)."""

import pytest

from steadyhelper_testkit import EXAMPLES, mid, rig, wait_until  # noqa: I001

from steadyhelper.config import KRITA_BUNDLE_ID
from steadyhelper.hotkeys import BadKeymap, HotkeyRouter, build_keymap
from steadyhelper.keys import FLAG_CMD, FLAG_SHIFT, KEYCODES
from steadyhelper.protocol import validate_worker_msg

pytestmark = pytest.mark.P2b

K = KEYCODES


def router(keymap):
    emitted = []
    r = HotkeyRouter(emit=emitted.append, frontmost=lambda: KRITA_BUNDLE_ID, has_client=lambda: True)
    r.set_keymap(build_keymap(keymap))
    return r, emitted


def test_example_keymap_validates_and_equals_the_default_map():
    ex = EXAMPLES["worker_to_helper"]["keymap"]
    assert validate_worker_msg(ex) is None
    from steadyhelper.hotkeys import default_keycode_map

    assert build_keymap(ex["map"]) == default_keycode_map()


def test_remapped_keys_replace_the_defaults():
    r, emitted = router({"pageup": "pen", "pagedown": "ptt_down", "shift+f8": "undo"})
    assert r.handle(K["pageup"], True) == (True, ["pen"])
    assert r.handle(K["pageup"], False) == (True, [])
    # F8 alone is no longer mapped: untouched
    assert r.handle(K["f8"], True) == (False, [])
    assert r.handle(K["f8"], False) == (False, [])
    # modifiers must match
    assert r.handle(K["f8"], True, flags=FLAG_SHIFT) == (True, ["undo"])
    assert r.handle(K["f8"], False) == (True, [])  # key-up matched by keycode only
    assert r.handle(K["f8"], True, flags=FLAG_SHIFT | FLAG_CMD) == (False, [])
    # ptt_down names the push-to-talk key; its release sends ptt_up
    assert r.handle(K["pagedown"], True) == (True, ["ptt_down"])
    assert r.handle(K["pagedown"], True, is_repeat=True) == (True, [])
    assert r.handle(K["pagedown"], False) == (True, ["ptt_up"])
    assert emitted == ["pen", "undo", "ptt_down", "ptt_up"]


def test_fn_flag_is_ignored_when_matching():
    r, _ = router({"f8": "pen"})
    FN = 0x00800000
    assert r.handle(K["f8"], True, flags=FN) == (True, ["pen"])


def test_consumption_rules_unchanged_with_a_keymap():
    emitted = []
    state = {"front": "com.apple.finder", "client": True}
    r = HotkeyRouter(emit=emitted.append, frontmost=lambda: state["front"], has_client=lambda: state["client"])
    r.set_keymap(build_keymap({"b": "pen"}))
    assert r.handle(K["b"], True) == (False, [])  # Finder: untouched
    r.handle(K["b"], False)
    state["front"] = "com.google.Chrome"
    state["client"] = False
    assert r.handle(K["b"], True) == (False, [])  # no Worker connected
    r.handle(K["b"], False)
    state["client"] = True
    assert r.handle(K["b"], True) == (True, ["pen"])


def test_key_held_across_a_keymap_change_still_gets_its_key_up_consumed():
    r, emitted = router({"f10": "ptt_down"})
    assert r.handle(K["f10"], True) == (True, ["ptt_down"])
    r.set_keymap(build_keymap({"f9": "pause"}))
    assert r.handle(K["f10"], False) == (True, ["ptt_up"])  # mic never left open


@pytest.mark.parametrize(
    "bad",
    [
        {"hyper+q": "pen"},  # unknown modifier
        {"nokey": "pen"},  # unknown key
        {"F8": "pen", "f8": "undo"},  # duplicate after normalisation
        {"command+z": "undo", "cmd+z": "redo"},  # duplicate after normalisation
        {"f8": "ptt_up"},  # not a key of its own
    ],
)
def test_bad_keymaps_refused(bad):
    with pytest.raises(BadKeymap):
        build_keymap(bad)


@pytest.mark.asyncio
async def test_keymap_over_the_wire_ack_and_effect():
    async with rig() as r:
        r.system.frontmost = KRITA_BUNDLE_ID
        async with r.client() as c:
            assert await wait_until(lambda: r.server._frontmost == KRITA_BUNDLE_ID)
            rid = mid()
            await c.send({"t": "keymap", "id": rid, "map": {"pageup": "pen", "f10": "ptt_down"}})
            assert (await c.recv_id(rid)) == {"t": "ack", "id": rid, "ok": True}
            assert r.server.router.handle(K["pageup"], True) == (True, ["pen"])
            assert (await c.recv_type("hotkey"))["key"] == "pen"
            assert r.server.router.handle(K["f8"], True) == (False, [])
            # a bad map is refused and leaves the current map in place
            rid = mid()
            await c.send({"t": "keymap", "id": rid, "map": {"F5": "recenter", "f5": "undo"}})
            assert (await c.recv_id(rid)) == {"t": "ack", "id": rid, "ok": False, "error": "bad_combo"}
            rid = mid()
            await c.send({"t": "keymap", "id": rid, "map": {"nokey": "pen"}})
            assert (await c.recv_id(rid))["error"] == "bad_combo"
            r.server.router.handle(K["pageup"], False)
            assert r.server.router.handle(K["pageup"], True) == (True, ["pen"])
            # an unknown hotkey name is a malformed message (schema)
            rid = mid()
            await c.send({"t": "keymap", "id": rid, "map": {"f8": "explode"}})
            m = await c.recv_id(rid)
            assert m["t"] == "error" and m["code"] == "bad_message"
