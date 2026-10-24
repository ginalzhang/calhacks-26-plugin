"""Steady Krita plugin: list_widgets (P4 numbered overlay) with a fake adapter."""
from __future__ import annotations

import pytest

from krita_fakes import FakeAdapter, load_examples
from steady.dispatch import dispatch, order_widgets, widget_label

pytestmark = pytest.mark.P4

SCREEN = [{"x": 0, "y": 0, "w": 1728, "h": 1117}]


def w(label, x, y, wd=32, h=32, **kw):
    c = {"tooltip": label, "text": "", "object_name": "", "rect": {"x": x, "y": y, "w": wd, "h": h},
         "visible": True, "enabled": True}
    c.update(kw)
    return c


def run(fake, **fields):
    return dispatch({"id": "lw", "cmd": "list_widgets", **fields}, fake)


def test_reading_order_rows_then_columns():
    fake = FakeAdapter()
    fake.widgets = [
        w("Line", 48, 141),            # same row as Brush (1 px lower), to its right
        w("Brush", 12, 140),
        w("Save", 300, 40, 28, 28),    # main toolbar: above everything
        w("Fill", 12, 176),
        w("Docker tab", 1400, 150, 90, 24),  # right of the toolbox row (centre 162 vs 156)
        w("Open", 260, 42, 28, 28),
    ]
    r = run(fake)
    assert r["ok"]
    assert [x["label"] for x in r["widgets"]] == ["Open", "Save", "Brush", "Line", "Docker tab", "Fill"]
    assert [x["n"] for x in r["widgets"]] == [1, 2, 3, 4, 5, 6]
    assert r["widgets"][2]["rect"] == {"x": 12, "y": 140, "w": 32, "h": 32}


def test_max_default_and_explicit():
    fake = FakeAdapter()
    fake.widgets = [w(f"B{i}", 10 + 40 * (i % 10), 100 + 40 * (i // 10)) for i in range(60)]
    assert len(run(fake)["widgets"]) == 40
    r = run(fake, max=5)
    assert [x["label"] for x in r["widgets"]] == ["B0", "B1", "B2", "B3", "B4"]
    assert len(run(fake, max=10000)["widgets"]) == 60
    for bad in (0, -1, 2.5, "ten", True):
        assert run(fake, max=bad)["error"] == "bad_args", bad


def test_invisible_disabled_offscreen_tiny_and_unlabelled_excluded():
    fake = FakeAdapter()
    fake.screens = SCREEN
    fake.widgets = [
        w("Visible", 10, 10),
        w("Hidden", 50, 10, visible=False),
        w("Disabled", 90, 10, enabled=False),
        w("Offscreen", 3000, 10),
        w("Tiny", 130, 10, 4, 4),
        w("", 170, 10),
        w("Visible", 10, 10),  # duplicate (nested widget with the same rect/label)
        {"tooltip": "No rect", "visible": True, "enabled": True},
    ]
    r = run(fake)
    assert [x["label"] for x in r["widgets"]] == ["Visible"]


def test_second_display_counts_as_on_screen():
    fake = FakeAdapter()
    fake.screens = SCREEN + [{"x": 1728, "y": 0, "w": 1920, "h": 1080}]
    fake.widgets = [w("Right display", 2000, 10)]
    assert run(fake)["widgets"][0]["label"] == "Right display"


def test_label_fallback_and_cleanup():
    assert widget_label({"tooltip": "Tip", "text": "Text", "object_name": "obj"}) == "Tip"
    assert widget_label({"tooltip": "", "text": "&Save", "object_name": "obj"}) == "Save"
    assert widget_label({"tooltip": None, "text": "", "object_name": "file_save"}) == "file_save"
    assert widget_label({"tooltip": "<html><b>Freehand</b>&nbsp;Brush</html>"}) == "Freehand Brush"
    assert widget_label({}) == ""
    long = widget_label({"tooltip": "x" * 200})
    assert len(long) == 60 and long.endswith("…")


def test_no_window_and_no_view_ok():
    fake = FakeAdapter(window={})
    assert run(fake)["error"] == "no_window"
    fake = FakeAdapter(view=False)  # the toolbox exists without a document
    assert run(fake)["ok"] is True


def test_pure_order_widgets_rect_rounding():
    out = order_widgets([w("A", 10.4, 20.6, 31.5, 32.2)], [], 40)
    assert out == [{"n": 1, "label": "A", "rect": {"x": 10, "y": 21, "w": 32, "h": 32}}]


def test_example_reply_shape():
    ex = load_examples()
    req, rep = ex["plugin_request"]["list_widgets"], ex["plugin_reply"]["list_widgets"]
    r = dispatch(dict(req), FakeAdapter())
    assert r["id"] == rep["id"] and r["ok"] is True
    got, want = r["widgets"][0], rep["widgets"][0]
    assert set(got) == set(want) == {"n", "label", "rect"}
    assert set(got["rect"]) == set(want["rect"])
