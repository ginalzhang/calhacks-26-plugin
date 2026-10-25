"""Steady panel, pure parts: actions.json, page layout, framing, builders, view-model, dialogs,
permissions, privacy text, launcher path resolution. No Qt."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from krita_fakes import PYKRITA, ROOT  # noqa: F401  (puts pykrita on sys.path)
from steady import launcher
from steady.panel_model import (
    PAGE_IDS,
    PAGE_OVERRIDES,
    PRIVACY_SENTENCES,
    PRIVACY_TEXT,
    SLIDERS,
    AckTracker,
    ActionTable,
    LineFramer,
    Messages,
    PanelController,
    PanelModel,
    calibration_view,
    dialog_buttons,
    encode,
    fit_trail,
    header_actions,
    heard_text,
    missing_permissions,
    next_landmark,
    page_actions,
    page_of,
    rect_dict,
    setting_patch,
    tile_view,
    tracking_text,
    tracking_view,
    wrap_on_spaces,
)

pytestmark = pytest.mark.P1

SPEC = Path("/Users/gina/conductor/workspaces/calhacks-26/montevideo/.context/steady/PROMPT-OVERLAY.md")


@pytest.fixture(scope="module")
def table():
    return ActionTable.load()


def make_ctl(table, connected=True):
    sent = []
    model = PanelModel()
    model.connected = connected
    ctl = PanelController(table, model, lambda m: (sent.append(m), True)[1])
    return ctl, sent


# --------------------------------------------------------------------------- actions.json
def test_actions_json_is_generated_from_actions_ts():
    node = shutil.which("node")
    if node is None:
        pytest.skip("node not installed")
    out = subprocess.run([node, str(ROOT / "scripts" / "gen-plugin-actions.mjs"), "--check"],
                         capture_output=True, text=True, timeout=60, cwd=ROOT)
    assert out.returncode == 0, out.stderr + out.stdout


def test_actions_json_matches_action_table_ids(table):
    src = (ROOT / "src" / "actions.ts").read_text()
    literal_ids = set(re.findall(r'^\s+id: "([a-z_]+)",', src, re.M))
    colours = {f"colour_{w}" for w in table.colour_hex}
    assert set(table.by_id) == literal_ids | colours
    assert table.build_phase in table.phase_order
    for a in table.actions:
        assert set(a) >= {"id", "label", "page", "toggle", "destructive", "phase", "tilePhase", "help", "key",
                          "voicePhrases", "typed", "fuzzyAllowed", "arg", "scope"}
    assert table.by_id["pause"]["phraseVariants"] == {"pause": "pause", "stop": "pause", "resume": "resume"}
    assert table.by_id["undo"]["krita"]["keys"] == "cmd+z"
    assert table.by_id["latch"]["modeChanging"] is True


def test_every_action_has_one_tile_on_exactly_one_page_or_the_header(table):
    seen = {}
    for a in header_actions(table):
        seen.setdefault(a["id"], []).append("header")
    for p in PAGE_IDS:
        for a in page_actions(table, p):
            seen.setdefault(a["id"], []).append(p)
    for a in table.actions:
        if a["page"] == "dialog":
            assert a["id"] not in seen  # yes/no/cancel/choices/later live only in dialogs
        else:
            assert len(seen.get(a["id"], [])) == 1, (a["id"], seen.get(a["id"]))
    assert all(p in PAGE_IDS for p in PAGE_OVERRIDES.values())
    assert [a["id"] for a in header_actions(table)] == [
        "pen_toggle", "pause", "mic", "undo", "redo", "recenter", "other_hand", "latch"]


def test_page_field_is_the_default_layout(table):
    for a in table.actions:
        if a["id"] not in PAGE_OVERRIDES:
            assert page_of(a) == a["page"]
    # long §2 preset names: their own page, one per row
    assert [a["id"] for a in page_actions(table, "presets")] == [
        "preset_sore_joints", "preset_shakes_reaching", "preset_slow_rest", "preset_hard_still"]


def test_labels_never_wrap_inside_a_word():
    assert wrap_on_spaces("Shakes when holding still or reaching", 12) == [
        "Shakes when", "holding", "still or", "reaching"]
    assert wrap_on_spaces("Supercalifragilistic tile", 5) == ["Supercalifragilistic", "tile"]
    assert wrap_on_spaces("", 5) == []


# --------------------------------------------------------------------------- framing / builders
def test_framing_partial_lines_garbage_and_non_objects():
    f = LineFramer()
    data = encode({"t": "status", "text": "hi", "level": "status"}) + b'{"t":"heard","te'
    assert f.feed(data) == [{"t": "status", "text": "hi", "level": "status"}]
    assert f.feed(b'xt":"bigger","via":"grammar"}\n\nnot json\n[1,2]\n{"no_t":1}\n') == [
        {"t": "heard", "text": "bigger", "via": "grammar"}]
    assert f.dropped == 3
    small = LineFramer(max_line=16)
    assert small.feed(b"x" * 40) == [] and small.buf == b""
    assert encode({"t": "x", "s": "é"}).endswith(b"\n") and "é".encode() in encode({"t": "x", "s": "é"})


def test_message_builders_match_protocol():
    m = Messages()
    assert m.hello("0.2.0", "5.3.4") == {"t": "hello", "plugin_version": "0.2.0", "krita_version": "5.3.4"}
    a = m.action("undo")
    assert a == {"t": "action", "id": "p1", "action": "undo", "source": "tile"}
    assert m.action("pause", variant="resume")["variant"] == "resume"
    assert m.action("size", arg=20, source="typed")["arg"] == 20
    assert m.typed("bigger")["text"] == "bigger"
    assert m.settings({"steadiness": 55}) == {"t": "settings", "id": "p5", "settings": {"steadiness": 55}}
    assert m.calibrate()["steps"] == [1, 2, 3]
    assert m.camera(2)["index"] == 2
    assert m.mic(True)["on"] is True
    assert m.panel_rect({"x": 1, "y": 2, "w": 3, "h": 4}) == {"t": "panel_rect", "rect": {"x": 1, "y": 2, "w": 3, "h": 4}}
    assert "id" not in m.panel_rect(None)
    d = m.dialog_answer("d7", "confirm")
    assert d["t"] == "dialog_answer" and d["dialog_id"] == "d7" and d["answer"] == "confirm" and d["id"]
    assert m.quit()["t"] == "quit"
    ids = [m.quit()["id"] for _ in range(3)]
    assert len(set(ids)) == 3
    for msg in (a, d):
        json.loads(encode(msg))


def test_ack_tracking_and_expiry():
    now = [0.0]
    acks = AckTracker(timeout_s=5, clock=lambda: now[0])
    m = Messages()
    a, b = m.action("undo"), m.typed("redo")
    acks.sent(a)
    acks.sent(b)
    acks.sent(m.panel_rect(None))  # no id: not tracked
    assert acks.acked({"t": "ack", "id": a["id"], "ok": True}) is a
    assert acks.acked({"t": "ack", "id": a["id"], "ok": True}) is None
    now[0] = 6
    assert acks.expire() == [b] and acks.pending == {}


def test_rect_is_passed_through_in_points():
    assert rect_dict(10.4, 20.6, 380, 900.2) == {"x": 10, "y": 21, "w": 380, "h": 900}


# --------------------------------------------------------------------------- model / view-model
def state(**kw):
    s = {"pen": "HOVER", "tracking": "Tracking", "reason": None, "paused": False, "latch": False, "mode": "normal",
         "calibrated": True, "calibrating": None, "detectionFps": 24, "kritaConnected": True, "micOpen": False,
         "quiet": False, "settings": {"steadiness": 50, "inputs": {"voice": True}}}
    s.update(kw)
    return s


def test_pause_label_flips_to_resume_and_is_never_checkable(table):
    v = tile_view(table, "pause", state())
    assert (v.label, v.checkable) == ("Pause", False)
    v = tile_view(table, "pause", state(paused=True))
    assert (v.label, v.checkable, v.checked) == ("Resume", False, False)
    ctl, sent = make_ctl(table)
    ctl.model.apply({"t": "state", "state": state(paused=True)})
    ctl.press("pause")
    assert sent[-1]["action"] == "pause" and sent[-1]["variant"] == "resume"


def test_toggles_keep_a_fixed_name_and_follow_state(table):
    for aid, st in (("pen_toggle", state(pen="DRAWING")), ("latch", state(latch=True)),
                    ("mic", state(micOpen=True)), ("hatch", state(mode="hatch_alternate")),
                    ("dots", state(mode="dots")), ("quiet", state(quiet=True))):
        on, off = tile_view(table, aid, st), tile_view(table, aid, state())
        assert on.checkable and on.checked and not off.checked, aid
        assert on.label == off.label == table.by_id[aid]["label"], aid


def test_disabled_by_phase_keeps_its_label(table):
    t = ActionTable({**{"build_phase": "P0", "phase_order": table.phase_order, "colour_hex": table.colour_hex},
                     "actions": table.actions})
    v = tile_view(t, "brush", state())
    assert v.label == "Brush" and not v.enabled and "Not in this build" in v.tooltip
    assert tile_view(t, "undo", state()).enabled  # tilePhase P0
    assert tile_view(t, "other_hand", state()).enabled is False  # P2b
    ctl, sent = make_ctl(t)
    assert ctl.press("brush") is None and sent == []
    assert tile_view(table, "brush", state()).enabled  # BUILD_PHASE P4


def test_mic_disabled_in_quiet_mode(table):
    assert tile_view(table, "mic", state(quiet=True)).enabled is False
    assert tile_view(table, "mic", state()).enabled is True
    ctl, sent = make_ctl(table)
    ctl.model.apply({"t": "state", "state": state(micOpen=True)})
    ctl.press("mic")
    assert sent[-1] == {"t": "mic", "id": sent[-1]["id"], "on": False}


def test_always_listening_mic_tile(table):
    st = state(micOpen=True, settings={"alwaysListen": True})
    v = tile_view(table, "mic", st)
    assert v.label == "Mic" and v.sub == "Listening" and v.checked  # fixed name, second line
    assert tile_view(table, "mic", state(micOpen=False, settings={"alwaysListen": True})).sub == ""
    assert tile_view(table, "mic", state(micOpen=True)).sub == ""
    ctl, sent = make_ctl(table)
    ctl.model.apply({"t": "state", "state": st})
    ctl.press("mic")  # tapping Mic while always-listening turns it off
    assert sent[-1]["t"] == "settings" and sent[-1]["settings"] == {"alwaysListen": False}
    ctl.press("mic")
    assert sent[-1]["t"] == "mic"
    ctl.toggle_setting("alwaysListen")
    assert sent[-1]["settings"] == {"alwaysListen": True}


def test_speech_end_slider(table):
    from steady.panel_model import SLIDERS_BY_KEY
    spec = SLIDERS_BY_KEY["utteranceEndMs"]
    assert (spec.label, spec.lo, spec.hi, spec.tile_step, spec.page, spec.default) == (
        "Speech end", 250, 1500, 50, "timing", 450)
    ctl, sent = make_ctl(table)
    ctl.model.apply({"t": "state", "state": state()})
    ctl.slider_step("utteranceEndMs", +1)
    assert sent[-1]["settings"] == {"utteranceEndMs": 500}


def test_tile_press_messages(table):
    ctl, sent = make_ctl(table)
    ctl.model.apply({"t": "state", "state": state()})
    ctl.press("undo")
    assert sent[-1]["t"] == "action" and sent[-1]["action"] == "undo" and sent[-1]["source"] == "tile"
    ctl.press("recalibrate")
    assert sent[-1]["t"] == "calibrate" and sent[-1]["steps"] == [1, 2, 3]
    ctl.press("eraser")  # no state field reports the eraser: optimistic local toggle
    assert tile_view(table, "eraser", ctl.model.state, ctl.local_checked).checked
    ctl.press("use_last_setup")
    assert sent[-1]["t"] == "action" and sent[-1]["action"] == "use_last_setup"
    ctl.use_profile("Shaky day")
    assert sent[-1]["action"] == "use_profile" and sent[-1]["variant"] == "Shaky day"
    assert ctl.typed("  bigger ")["text"] == "bigger" and ctl.typed("   ") is None
    ctl.choose_camera(1)
    assert sent[-1] == {"t": "camera", "id": sent[-1]["id"], "index": 1}


def test_disconnected_press_explains_instead_of_sending(table):
    ctl, sent = make_ctl(table, connected=False)
    ctl.press("undo")
    assert sent == [] and "Press Start" in ctl.status_line()


def test_sliders_steps_and_settings(table):
    ctl, sent = make_ctl(table)
    ctl.model.apply({"t": "state", "state": state(settings={"steadiness": 50, "dwellDownMs": 800})})
    ctl.slider_step("steadiness", +1)
    assert sent[-1]["settings"] == {"steadiness": 55}
    ctl.slider_step("dwellDownMs", -1)
    assert sent[-1]["settings"] == {"dwellDownMs": 750}
    ctl.slider("steadiness", 140)
    assert sent[-1]["settings"] == {"steadiness": 100}
    ctl.model.apply({"t": "state", "state": {"gain": 3.0}})
    ctl.slider_step("gainOverride", +1)
    assert sent[-1]["settings"] == {"gainOverride": 3.5}
    keys = {s.key for s in SLIDERS}
    assert keys == {"steadiness", "gainOverride", "dwellDownMs", "dwellUpMs", "micSilenceMs", "micCapMs",
                    "hatchLagMs", "dashPauseMs", "utteranceEndMs"}
    by = {s.key: s for s in SLIDERS}
    assert by["steadiness"].tile_step == 5 and by["dwellDownMs"].tile_step == 50 and by["dwellUpMs"].tile_step == 50
    assert by["dashPauseMs"].tile_step == 50


def test_nested_setting_toggle_sends_the_whole_object(table):
    ctl, sent = make_ctl(table)
    ctl.model.apply({"t": "state", "state": state(settings={"inputs": {"camera": True, "voice": True}})})
    ctl.toggle_setting("inputs.voice")
    assert sent[-1]["settings"] == {"inputs": {"camera": True, "voice": False}}
    assert setting_patch({}, "mirrorCamera", True) == {"mirrorCamera": True}
    ctl.cycle_landmark()
    assert sent[-1]["settings"] == {"landmark": 8}
    assert next_landmark(0) not in (5, 8, 9, 0) and next_landmark("x") == 5


def test_preview_only_while_setup_is_visible(table):
    ctl, sent = make_ctl(table)
    ctl.on_connected()
    assert sent[-1]["settings"] == {"preview": False}
    ctl.set_page("setup")
    assert sent[-1]["settings"] == {"preview": True}
    n = len(sent)
    ctl.set_page("setup")
    assert len(sent) == n  # only on change
    ctl.set_visible(False)
    assert sent[-1]["settings"] == {"preview": False}
    ctl.set_visible(True)
    assert sent[-1]["settings"] == {"preview": True}


def test_status_alert_heard_and_clearing():
    m = PanelModel()
    m.apply({"t": "status", "text": "Tracking lost: no hand", "level": "alert"})
    m.apply({"t": "status", "text": "Saved", "level": "status"})
    assert m.alert_text == "Tracking lost: no hand" and m.status_text == "Saved"
    m.apply({"t": "status", "text": "", "level": "alert"})  # lead: empty alert clears the alert line
    assert m.alert_text == ""
    m.apply({"t": "heard", "text": "make it blue", "via": "claude"})
    assert heard_text(m.heard) == "Heard: make it blue (Claude)"
    assert heard_text(None) == "Heard: nothing yet"


def test_tracking_word_dot_and_reason():
    assert tracking_view(state(tracking="Weak"), True) == ("Weak", "weak")
    assert tracking_view(state(), False) == ("Lost", "lost")
    assert tracking_text(state(tracking="Lost", reason="too_dark"), True) == "Lost (too dark)"
    assert tracking_text(state(), True) == "Tracking"


def test_calibration_view():
    assert calibration_view(state()) is None
    assert calibration_view(state(calibrating={"step": 2, "progress": 0.426, "prompt": "Draw a slow circle"})) == (
        "Step 2 of 3", "Draw a slow circle", 43)


def test_partial_state_merges_and_disconnect_forgets():
    m = PanelModel()
    m.connected = True
    m.apply({"t": "state", "state": state()})
    m.apply({"t": "state", "paused": True})  # flattened form (tracker panel_server)
    assert m.state["paused"] and m.state["pen"] == "HOVER"
    m.apply({"t": "preview", "jpeg_b64": "/9j/", "w": 160, "h": 120})
    assert m.preview_bytes() == b"\xff\xd8\xff"
    m.reset_connection()
    assert m.state == {} and m.preview is None and not m.connected


def test_profile_names_from_state():
    from steady.panel_model import profile_names
    assert profile_names({}) == ["Steady day", "Shaky day"]
    assert profile_names({"profiles": []}) == ["Steady day", "Shaky day"]
    assert profile_names({"profiles": ["Steady day", "Shaky day", "Morning"]})[-1] == "Morning"


def test_trail_fit_keeps_aspect():
    tf = fit_trail([[(0, 0), (100, 50)]], 200, 200, margin=0)
    assert tf((0, 0)) == (0.0, 50.0) and tf((100, 50)) == (200.0, 150.0)


# --------------------------------------------------------------------------- dialogs
def test_confirm_dialog_cancel_first_and_answers(table):
    d = {"t": "dialog", "dialog_id": "d1", "kind": "confirm", "text": "Delete this layer?", "options": []}
    assert dialog_buttons(d) == [("cancel", "Cancel"), ("confirm", "Confirm")]
    ctl, sent = make_ctl(table)
    ctl.on_message(d)
    assert ctl.model.dialog["dialog_id"] == "d1"
    msg = ctl.answer_dialog("confirm")
    assert msg == {"t": "dialog_answer", "id": msg["id"], "dialog_id": "d1", "answer": "confirm"}
    assert ctl.model.dialog is None and ctl.answer_dialog("cancel") is None


def test_clarify_dialog_numbered_options(table):
    d = {"t": "dialog", "dialog_id": "c2", "kind": "clarify", "text": "Which one?",
         "options": [{"id": "brush", "label": "Brush"}, {"id": "pencil", "label": "Pencil"}]}
    assert dialog_buttons(d) == [("brush", "1. Brush"), ("pencil", "2. Pencil"), ("cancel", "Cancel")]
    ctl, sent = make_ctl(table)
    ctl.on_message(d)
    assert ctl.answer_dialog("pencil")["answer"] == "pencil"


def test_dialog_labels_from_brain_and_voice(table):
    d = {"kind": "confirm", "dialog_id": "b-dlg-1", "text": "Delete layer?",
         "options": [{"id": "confirm", "label": "Delete layer"}, {"id": "cancel", "label": "Cancel"}]}
    assert dialog_buttons(d) == [("cancel", "Cancel"), ("confirm", "Confirm")]
    v = {"kind": "clarify", "dialog_id": "v-dlg-1", "text": "Which?",
         "options": [{"id": "lighter", "label": "One: Lighter"}, {"id": "darker", "label": "Two: Darker"}]}
    assert dialog_buttons(v) == [("lighter", "One: Lighter"), ("darker", "Two: Darker"), ("cancel", "Cancel")]
    m = PanelModel()
    m.apply({"t": "dialog", **d})
    m.apply({"t": "dialog", "dialog_id": "b-dlg-1", "kind": "confirm", "text": "", "options": []})
    assert m.dialog is None


def test_dialog_close_from_tracker():
    m = PanelModel()
    m.apply({"t": "dialog", "dialog_id": "d1", "kind": "confirm", "text": "x", "options": []})
    m.apply({"t": "dialog_close", "dialog_id": "other"})
    assert m.dialog is not None
    m.apply({"t": "dialog_close", "dialog_id": "d1"})
    assert m.dialog is None


# --------------------------------------------------------------------------- permissions
def test_permissions_name_the_tracker_and_deep_link():
    assert missing_permissions(None) == []
    assert missing_permissions({"camera": True, "microphone": True, "accessibility": True,
                                "input_monitoring": True}) == []
    miss = missing_permissions({"camera": False, "microphone": True, "accessibility": False,
                                "input_monitoring": False})
    assert [p["key"] for p in miss] == ["camera", "accessibility", "input_monitoring"]
    assert all('"Steady Tracker"' in p["text"] for p in miss)
    assert [p["url"] for p in miss] == [
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
    ]
    mic = missing_permissions({"microphone": False})[0]
    assert mic["url"].endswith("Privacy_Microphone")


# --------------------------------------------------------------------------- privacy (§0 rule 9)
def _spec_rule9() -> str:
    if SPEC.exists():
        text = SPEC.read_text()
        m = re.search(r"9\. \*\*Privacy.*?\*\* (Camera frames.*?machine\.)", text)
        if m:
            return m.group(1).replace("`", "")
    # fallback: the website's verbatim copy
    src = (ROOT / "src" / "components" / "SteadyApp.tsx").read_text()
    return re.search(r'"(Camera frames never leave.*?machine\.)"', src).group(1)


def _sentences(text):
    return [s.strip() for s in re.split(r"(?<=\.)\s+(?=[A-Z])", text) if s.strip()]


def test_privacy_text_matches_spec_sentence_by_sentence():
    spec = _sentences(_spec_rule9())
    ours = _sentences(PRIVACY_TEXT)
    assert len(spec) == len(ours) == 4
    assert ours[:2] == spec[:2]  # camera and Cartesia sentences unchanged
    assert spec[2].endswith("go to our server and on to Anthropic.")
    # plugin build: no Steady server, the tracker calls Anthropic directly (lead decision)
    assert ours[2] == spec[2].replace("go to our server and on to Anthropic.",
                                      "go from this Mac directly to Anthropic.")
    assert ours[2] == ("When the local grammar can't match a command, its text (never audio) plus the current "
                       "tool, preset, size, opacity, colour, Steadiness and your last three actions go from this "
                       "Mac directly to Anthropic.")
    assert spec[3] == "The helper and the Krita plugin listen on 127.0.0.1 only and send nothing off the machine."
    assert ours[3] == "Steady Tracker and the Krita plugin listen on 127.0.0.1 only and send nothing else off the machine."
    assert PRIVACY_TEXT == " ".join(PRIVACY_SENTENCES)


# --------------------------------------------------------------------------- launcher
def test_launcher_prefers_user_applications(tmp_path):
    home = tmp_path / "home"
    repo = tmp_path / "repo"
    plugin = tmp_path / "pykrita" / "steady"
    plugin.mkdir(parents=True)
    (repo / "build" / "Steady Tracker.app").mkdir(parents=True)
    (plugin / "steady_repo.txt").write_text(str(repo) + "\n")
    assert launcher.resolve_tracker_app(str(home), plugin) == repo / "build" / "Steady Tracker.app"
    (home / "Applications" / "Steady Tracker.app").mkdir(parents=True)
    assert launcher.resolve_tracker_app(str(home), plugin) == home / "Applications" / "Steady Tracker.app"


def test_launcher_missing_app_says_how_to_install(tmp_path):
    plugin = tmp_path / "steady"
    plugin.mkdir()
    calls = []
    ok, text = launcher.launch(str(tmp_path / "home"), plugin, runner=lambda p, a: calls.append((p, a)) or True)
    assert not ok and text == "Install the tracker: run scripts/install-steady.sh" and calls == []


def test_launcher_uses_open_with_panel_port(tmp_path):
    home = tmp_path / "home"
    app = home / "Applications" / "Steady Tracker.app"
    app.mkdir(parents=True)
    calls = []
    ok, _ = launcher.launch(str(home), tmp_path, runner=lambda p, a: calls.append((p, a)) or True)
    assert ok and calls == [("/usr/bin/open", ["-a", str(app), "--args", "--panel-port", "8767"])]


def test_launcher_repo_fallback_is_this_checkout():
    assert launcher.repo_dir(PYKRITA / "steady") == ROOT
