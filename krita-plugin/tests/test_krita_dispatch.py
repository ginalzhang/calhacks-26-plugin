"""Steady Krita plugin: dispatcher tests with a fake adapter (no Qt, no Krita). Spec §7, §10."""
from __future__ import annotations

import ast
import re

import pytest

from krita_fakes import DEFAULT_PRESETS, PYKRITA, ExplodingAdapter, FakeAdapter, load_examples
from steady.dispatch import (
    HANDLERS,
    PRESET_FAMILIES,
    adjust_value,
    dispatch,
    key_to_portable,
    match_preset,
    strip_mnemonic,
)

pytestmark = pytest.mark.P2a

STEADY_KEYS = ["f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10"]


def run(cmd: str, fake=None, **fields):
    fake = fake or FakeAdapter()
    return dispatch({"id": "req-1", "cmd": cmd, **fields}, fake), fake


# --- every command ---------------------------------------------------------------------


def test_action_triggers_and_reports_checked_state():
    r, f = run("action", action="edit_undo")
    assert r == {"id": "req-1", "ok": True}
    assert f.actions["edit_undo"].triggers == 1
    r, f = run("action", f, action="erase_action")
    assert r["ok"] and r["checked"] is True


def test_action_unknown_and_disabled():
    f = FakeAdapter()
    del f.actions["edit_redo"]  # allowed id, but missing from this Krita
    r, _ = run("action", f, action="edit_redo")
    assert r["ok"] is False and r["error"] == "unknown_action"
    f.actions["file_save"].enabled = False
    r, _ = run("action", f, action="file_save")
    assert r["error"] == "action_disabled"
    r, _ = run("action", f)  # missing field (field is `action`, not `id`)
    assert r["error"] == "bad_args"


def test_color_sets_foreground():
    r, f = run("color", hex="#1D4ED8")
    assert r == {"id": "req-1", "ok": True, "color": "#1d4ed8"}
    assert f.color == "#1d4ed8"


@pytest.mark.parametrize("bad", ["blue", "#12345", "#1234567", "1d4ed8", "#gggggg", None, 123, ""])
def test_bad_hex(bad):
    f = FakeAdapter()
    r, _ = run("color", f, hex=bad)
    assert r == {"id": "req-1", "ok": False, "error": "bad_hex"}
    assert f.color == "#000000"


def test_color_adjust_lighter_and_darker():
    f = FakeAdapter()
    f.color = "#808080"
    r, _ = run("color_adjust", f, dv=0.1)
    assert r["ok"] and r["color"] == adjust_value("#808080", 0.1) == f.color
    assert int(f.color[1:3], 16) > 0x80
    r, _ = run("color_adjust", f, dv=-1)
    assert f.color == "#000000"
    r, _ = run("color_adjust", f, dv=2)
    assert r["error"] == "bad_args"


def test_adjust_value_clamps_and_keeps_hue():
    assert adjust_value("#ffffff", 0.5) == "#ffffff"
    assert adjust_value("#ff0000", -0.5) == "#800000"


def test_size_value_delta_and_clamp():
    r, f = run("size", value=20)
    assert r == {"id": "req-1", "ok": True, "size": 20}
    r, _ = run("size", f, delta=-5)
    assert r["size"] == 15
    r, _ = run("size", f, delta=-100)
    assert r["size"] == 1
    r, _ = run("size", f, value=99999)
    assert r["size"] == 1000
    for bad in ({}, {"value": 1, "delta": 1}, {"value": "big"}, {"delta": True}):
        r, _ = run("size", f, **bad)
        assert r["error"] == "bad_args", bad


def test_opacity_percent():
    r, f = run("opacity", value=50)
    assert r == {"id": "req-1", "ok": True, "opacity": 50}
    assert f.opacity == pytest.approx(0.5)
    r, _ = run("opacity", f, value=150)
    assert r["opacity"] == 100
    r, _ = run("opacity", f, value="half")
    assert r["error"] == "bad_args"


@pytest.mark.parametrize("family,expected", [
    ("basic", "b) Basic-5 Size"),
    ("pencil", "c) Pencil-2"),
    ("ink", "d) Ink-2 Fineliner"),
    ("airbrush", "f) Airbrush Soft"),
    ("eraser", "a) Eraser Circle"),
])
def test_preset_by_family(family, expected):
    r, f = run("preset", name=family)
    assert r["ok"] and r["preset"] == expected and f.preset == expected


def test_preset_change_clears_erase_toggle():
    f = FakeAdapter()
    run("action", f, action="erase_action")
    assert f.eraser_on() is True
    r, _ = run("preset", f, name="ink")
    assert r["ok"] and r["eraser_cleared"] is True
    assert f.eraser_on() is False
    r, _ = run("preset", f, name="pencil")  # already off: stays off, not toggled back on
    assert r["eraser_cleared"] is False and f.eraser_on() is False


def test_preset_unknown_family():
    r, f = run("preset", name="watercolour")
    assert r["ok"] is False and r["error"] == "no_preset"
    r, _ = run("preset", FakeAdapter(presets=[]), name="ink")
    assert r["error"] == "no_preset"
    r, _ = run("preset", f, name="")
    assert r["error"] == "bad_args"


def test_preset_matching_works_on_any_names():
    """Family matching never relies on Krita's default names."""
    custom = ["My Pinky Brush", "Zz Inking Pen", "studio PENCIL hb", "Soft Airbrush 2", "Big Eraser",
              "basic round", "Pencil Eraser"]
    assert match_preset("ink", custom) == "Zz Inking Pen"  # "pinky" is not ink
    assert match_preset("pencil", custom) == "studio PENCIL hb"  # never the eraser variant
    assert match_preset("airbrush", custom) == "Soft Airbrush 2"
    assert match_preset("basic", custom) == "basic round"
    assert match_preset("eraser", custom) in ("Big Eraser", "Pencil Eraser")
    # an alias stores an exact preset name; exact (case-insensitive) wins
    assert match_preset("pencil eraser", custom) == "Pencil Eraser"
    assert match_preset("STUDIO pencil HB", custom) == "studio PENCIL hb"
    assert match_preset("charcoal", custom) is None
    # deterministic among several candidates: earliest keyword, then shortest name
    assert match_preset("ink", ["d) Ink-3 Gpen", "d) Ink-2 Fineliner", "x) Ink"]) == "x) Ink"


def test_dispatch_source_hardcodes_no_preset_names():
    src = (PYKRITA / "steady" / "dispatch.py").read_text() + (PYKRITA / "steady" / "adapter.py").read_text()
    for name in DEFAULT_PRESETS + ["Fineliner", "Basic-5", "Pencil-2", "Airbrush Soft", "Eraser Circle"]:
        assert name not in src
    assert set(PRESET_FAMILIES) == {"basic", "pencil", "ink", "airbrush", "eraser"}


def test_new_layer_nav_visibility():
    f = FakeAdapter()
    r, _ = run("new_layer", f, name="Steady 1")
    assert r == {"id": "req-1", "ok": True, "layer": "Steady 1"}
    r, _ = run("new_layer", f)
    assert r["ok"] and r["layer"]
    r, _ = run("layer_nav", f, dir="down")
    assert r["layer"] == "Steady 1"
    r, _ = run("layer_nav", f, dir="up")
    r, _ = run("layer_nav", f, dir="up")  # at the top: stays
    assert r["ok"] and r["layer"] == f.layers[-1]
    r, _ = run("layer_nav", f, dir="sideways")
    assert r["error"] == "bad_args"
    r, _ = run("layer_visible", f, visible=False)
    assert r["ok"] and r["visible"] is False and f.visible[r["layer"]] is False
    r, _ = run("layer_visible", f, visible="no")
    assert r["error"] == "bad_args"


def test_canvas_and_window_rect():
    r, _ = run("canvas_rect")
    assert r["ok"] and r["rect"] == {"x": 64, "y": 120, "w": 1180, "h": 860}
    assert r["widget_class"] == "KisOpenGLCanvas2"
    r, _ = run("window_rect")
    assert r["rect"] == {"x": 0, "y": 25, "w": 1400, "h": 1060}
    r, _ = run("canvas_rect", FakeAdapter(canvas={}))
    assert r == {"id": "req-1", "ok": False, "error": "no_canvas_rect"}
    r, _ = run("canvas_rect", FakeAdapter(view=False))
    assert r["error"] == "no_canvas_rect"  # the browser falls back to corner marking
    r, _ = run("window_rect", FakeAdapter(window={}))
    assert r["error"] == "no_window"


def test_list_actions_strips_mnemonics():
    r, _ = run("list_actions")
    by_id = {a["id"]: a["text"] for a in r["actions"]}
    assert by_id["merge_layer"] == "Merge with Layer Below"
    assert by_id["add_new_paint_layer"] == "Add Paint Layer"
    assert strip_mnemonic("Rock && Roll") == "Rock & Roll"


def test_list_presets_sorted():
    r, _ = run("list_presets")
    assert r["presets"] == sorted(DEFAULT_PRESETS, key=str.lower)


def test_smoothing_modes():
    for mode, action in [("none", "set_no_brush_smoothing"), ("weighted", "set_weighted_brush_smoothing"),
                         ("simple", "set_simple_brush_smoothing"),
                         ("stabilizer", "set_stabilizer_brush_smoothing")]:
        r, f = run("smoothing", mode=mode)
        assert r == {"id": "req-1", "ok": True, "mode": mode}
        assert f.actions[action].triggers == 1
    r, _ = run("smoothing", mode="max")
    assert r["error"] == "bad_args"
    r, _ = run("smoothing", FakeAdapter(view=False), mode="none")
    assert r["error"] == "no_view"


def test_key_to_portable():
    assert key_to_portable("f5") == "F5"
    assert key_to_portable("F10") == "F10"
    assert key_to_portable("cmd+shift+z") == "Ctrl+Shift+Z"
    assert key_to_portable("shift+cmd+z") == "Ctrl+Shift+Z"
    assert key_to_portable("shift+delete") == "Shift+Del"
    assert key_to_portable("]") == "]"
    assert key_to_portable("+") == "+"
    assert key_to_portable("") == ""


def test_clear_shortcuts_reports_and_only_touches_exact_keys():
    r, f = run("clear_shortcuts", keys=STEADY_KEYS)
    cleared = {(c["key"], c["action"]) for c in r["cleared"]}
    assert cleared == {("f3", "layer_properties"), ("f4", "save_incremental_backup"),
                       ("f5", "show_brush_editor"), ("f6", "show_brush_presets")}
    assert f.actions["show_brush_editor"].shortcuts == []
    assert f.actions["featherselection"].shortcuts == ["Shift+F6"]  # Shift+F6 is not F6
    assert f.actions["edit_undo"].shortcuts == ["Ctrl+Z"]
    r, _ = run("clear_shortcuts", f, keys=STEADY_KEYS)
    assert r["cleared"] == []
    r, _ = run("clear_shortcuts", f, keys="f5")
    assert r["error"] == "bad_args"


def test_clear_shortcuts_keeps_other_bindings_on_same_action():
    f = FakeAdapter()
    f.actions["show_brush_presets"].shortcuts = ["F6", "Ctrl+Alt+P"]
    run("clear_shortcuts", f, keys=["f6"])
    assert f.actions["show_brush_presets"].shortcuts == ["Ctrl+Alt+P"]


def test_session_init_once_per_process():
    f = FakeAdapter()
    r1, _ = run("session_init", f, keys=STEADY_KEYS)
    assert r1["ok"] and r1["smoothing_changed"] is True and r1["krita_version"] == "5.3.4"
    assert {c["key"] for c in r1["cleared"]} == {"f3", "f4", "f5", "f6"}
    assert "warning" not in r1 and "smoothing_pending" not in r1
    # the user turns Krita's smoothing back on; a helper reconnect must not undo that
    run("smoothing", f, mode="weighted")
    r2, _ = run("session_init", f, keys=STEADY_KEYS)
    assert r2["ok"] and r2["smoothing_changed"] is False and r2["cleared"] == []
    assert f.smoothing_calls == ["none", "weighted"]
    assert f.actions["set_no_brush_smoothing"].triggers == 1


def test_session_init_without_document_defers_smoothing_once():
    f = FakeAdapter(view=False)
    r, _ = run("session_init", f, keys=STEADY_KEYS)
    assert r["ok"] and r["smoothing_changed"] is False and r["smoothing_pending"] is True
    assert f.smoothing_calls == []
    r, _ = run("ping", f)  # helper keep-alive never carries the one-time notice
    assert "smoothing_changed" not in r
    f.view = True  # the user opens a document
    r, _ = run("color", f, hex="#ff0000")
    assert r["ok"] and r["smoothing_changed"] is True
    r, _ = run("color", f, hex="#00ff00")
    assert "smoothing_changed" not in r
    run("session_init", f, keys=STEADY_KEYS)
    assert f.smoothing_calls == ["none"]


def test_session_init_warns_off_tested_version():
    r, _ = run("session_init", FakeAdapter(version="6.0.1"), keys=[])
    assert r["ok"] and "5.3" in r["warning"]
    r, _ = run("session_init", FakeAdapter(), keys="f5")
    assert r["error"] == "bad_args"


def test_get_state():
    f = FakeAdapter()
    run("color", f, hex="#1d4ed8")
    run("action", f, action="erase_action")
    r, _ = run("get_state", f)
    assert r == {"id": "req-1", "ok": True, "preset": "b) Basic-5 Size", "size": 40, "opacity": 100,
                 "color": "#1d4ed8", "eraser": True, "layer": "Paint Layer 1"}


def test_ping():
    assert run("ping")[0] == {"id": "req-1", "ok": True}
    assert run("ping", FakeAdapter(view=False))[0] == {"id": "req-1", "ok": True}


# --- errors, id echo, robustness -------------------------------------------------------


def test_unknown_command():
    r, _ = run("make_coffee")
    assert r["ok"] is False and r["error"] == "unknown_cmd" and r["id"] == "req-1"
    r = dispatch({"id": "x"}, FakeAdapter())
    assert r["error"] == "unknown_cmd" and r["id"] == "x"
    assert dispatch(["not", "a", "dict"], FakeAdapter())["error"] == "bad_args"


VIEW_CMDS = [("color", {"hex": "#ffffff"}), ("color_adjust", {"dv": 0.1}), ("size", {"value": 3}),
             ("opacity", {"value": 3}), ("preset", {"name": "ink"}), ("new_layer", {}),
             ("layer_nav", {"dir": "up"}), ("layer_visible", {"visible": True}), ("get_state", {}),
             ("smoothing", {"mode": "none"})]


@pytest.mark.parametrize("cmd,fields", VIEW_CMDS)
def test_missing_view(cmd, fields):
    r, _ = run(cmd, FakeAdapter(view=False), **fields)
    assert r == {"id": "req-1", "ok": False, "error": "no_view"}


def test_commands_without_view_still_work():
    f = FakeAdapter(view=False)
    for cmd, fields in [("ping", {}), ("list_actions", {}), ("list_presets", {}), ("window_rect", {}),
                        ("clear_shortcuts", {"keys": ["f5"]}), ("action", {"action": "edit_undo"})]:
        assert run(cmd, f, **fields)[0]["ok"] is True, cmd


def test_every_handler_echoes_id_ok_or_error():
    ex = load_examples()["plugin_request"]
    for adapter in (FakeAdapter(), FakeAdapter(view=False), ExplodingAdapter()):
        for name, req in ex.items():
            req = dict(req, id=f"echo-{name}")
            r = dispatch(req, adapter)
            assert r["id"] == f"echo-{name}"
            assert isinstance(r["ok"], bool)
            assert r["ok"] or isinstance(r["error"], str)


def test_adapter_exception_becomes_internal_error():
    r, _ = run("size", ExplodingAdapter(), delta=1)
    assert r["ok"] is False and r["error"] == "internal" and "boom" in r["message"]


def test_handlers_cover_protocol_table():
    doc = (PYKRITA.parents[1] / "docs" / "PROTOCOL.md").read_text()
    section = doc.split("## helper ↔ Krita plugin", 1)[1].split("## Fake helper", 1)[0]
    table_cmds = set(re.findall(r"^\| `([a-z_]+)`[^|]*\|", section, re.M))
    assert table_cmds and table_cmds == set(HANDLERS)


# --- protocol-examples.json --------------------------------------------------------------


def _shape(value):
    if isinstance(value, bool):
        return bool
    if isinstance(value, (int, float)):
        return float
    if isinstance(value, dict):
        return {k: _shape(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_shape(value[0])] if value else []
    return type(value)


def _assert_has_shape(reply, example):
    for key, val in example.items():
        assert key in reply, f"missing {key!r} in {reply}"
        if key == "id":
            continue
        want, got = _shape(val), _shape(reply[key])
        if isinstance(want, dict):
            assert isinstance(got, dict) and set(want) <= set(got), (key, reply[key])
        elif isinstance(want, list):
            assert isinstance(got, list), (key, reply[key])
            if want and got:
                if isinstance(want[0], dict):
                    assert set(want[0]) <= set(got[0]), (key, reply[key])
                else:
                    assert got[0] == want[0], (key, reply[key])
        else:
            assert got == want or reply[key] is None and key in ("preset", "layer"), (key, reply[key])


def test_every_plugin_request_example_dispatches_with_reply_shape():
    ex = load_examples()
    replies_by_id = {}
    for rname, rep in ex["plugin_reply"].items():
        if rep["ok"]:
            replies_by_id.setdefault(rep["id"], []).append(rep)
    for name, req in ex["plugin_request"].items():
        r = dispatch(dict(req), FakeAdapter())
        assert r["ok"] is True, (name, r)
        assert r["id"] == req["id"]
        _assert_has_shape(r, ex["plugin_reply"]["ok"])
        for rep in replies_by_id.get(req["id"], []):
            _assert_has_shape(r, rep)


def test_error_reply_examples():
    ex = load_examples()
    err = ex["plugin_reply"]["error"]
    req = dict(ex["plugin_request"]["color"], hex="not-a-colour")
    assert req["id"] == err["id"]
    assert dispatch(req, FakeAdapter()) == err
    missing = ex["plugin_reply"]["canvas_rect_missing"]
    assert dispatch(dict(ex["plugin_request"]["canvas_rect"]), FakeAdapter(canvas={})) == missing


def test_dispatch_is_pure_no_qt_import():
    tree = ast.parse((PYKRITA / "steady" / "dispatch.py").read_text())
    mods = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            mods |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            mods.add(node.module.split(".")[0])
    assert not mods & {"PyQt5", "PyQt6", "krita", "sip"}
    tree = ast.parse((PYKRITA / "steady" / "bridge.py").read_text())
    assert not any(isinstance(n, (ast.Import, ast.ImportFrom)) and "PyQt" in ast.dump(n) for n in ast.walk(tree))


@pytest.mark.parametrize("name", ["definitely_not_an_action", "file_close", "flatten_image", "file_quit",
                                  "KritaShape/KisToolBrush", "show_brush_editor", "options_configure"])
def test_action_not_on_allowlist_is_refused(name):
    f = FakeAdapter()
    for a in ("file_close", "flatten_image", "file_quit", "options_configure"):
        from krita_fakes import FakeAction
        f.actions[a] = FakeAction(a)
    r, _ = run("action", f, action=name)
    assert r == {"id": "req-1", "ok": False, "error": "action_not_allowed", "action": name}
    assert all(a.triggers == 0 for a in f.actions.values())


def test_allowlist_covers_action_table_and_lookups():
    """Every plugin `action` id in src/actions.ts plus the runtime lookups is allowed."""
    from steady.dispatch import ALLOWED_ACTIONS, SMOOTHING_ACTIONS

    src = (PYKRITA.parents[1] / "src" / "actions.ts").read_text()
    used = set(re.findall(r'cmd: "action", action: "([^"]+)"', src))
    assert used and used <= ALLOWED_ACTIONS
    assert {"merge_layer", "remove_layer", "clear", "toggle_layer_visibility"} <= ALLOWED_ACTIONS
    assert set(SMOOTHING_ACTIONS.values()) <= ALLOWED_ACTIONS
