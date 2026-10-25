"""Agent E: Claude fallback (SYSTEM_BLOCK parity with the TS module, request shape, validation, mock). No network."""

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from steadytracker.voice import claude as C
from steadytracker.voice.actions import load_table, table
from steadytracker.voice.keyterms import stt_keyterms

pytestmark = pytest.mark.P2a

REF = json.loads((Path(C.__file__).parent / "data" / "ts_reference.json").read_text())


# ------------------------------------------------------------------------------------------- parity
def test_system_block_is_byte_identical_to_the_ts_module():
    sb = C.build_system_block()
    assert sb == REF["systemBlock"]
    assert C.build_system_block() == sb  # deterministic
    assert len(sb) / 4 > 512  # padded past the cacheable minimum


def test_claude_ids_schema_and_keyterms_match_ts():
    assert table().claude_action_ids() == REF["claudeActionIds"]
    assert C.build_output_format() == REF["outputFormat"]
    assert stt_keyterms() == REF["keyterms"]


def test_snapshot_alone_gives_the_same_table(tmp_path, monkeypatch):
    monkeypatch.setattr("steadytracker.voice.actions.PLUGIN_ACTIONS_PATH", tmp_path / "missing.json")
    monkeypatch.delenv("STEADY_ACTIONS_JSON", raising=False)
    t = load_table()
    assert t.source == "snapshot"
    assert C.build_system_block(t) == REF["systemBlock"]


def test_plugin_actions_json_rows_are_completed_from_the_snapshot(tmp_path):
    p = tmp_path / "actions.json"
    p.write_text(json.dumps({"build_phase": "P4", "actions": [{"id": "bigger", "label": "Bigger", "page": "paint", "phase": "P2a"}]}))
    t = load_table(p)
    assert t.by_id["bigger"].voice_phrases == ["bigger"]
    assert t.claude_action_ids() == ["bigger"]


def test_dialog_demo_word_and_mic_rows_never_offered_to_claude():
    ids = set(table().claude_action_ids())
    for bad in ("yes", "no", "cancel", "choice_one", "mic", "pen_toggle", "name_brush", "simulate_tremor"):
        assert bad not in ids


# ------------------------------------------------------------------------------------------- request
class FakeMessages:
    def __init__(self, reply=None, exc=None):
        self.reply, self.exc, self.calls = reply, exc, []

    def create(self, **params):
        self.calls.append(params)
        if self.exc:
            raise self.exc
        return self.reply


class FakeClient:
    def __init__(self, messages):
        self.messages = messages
        self.options = []

    def with_options(self, **kw):
        self.options.append(kw)
        return self


def reply(obj, stop="end_turn"):
    text = obj if isinstance(obj, str) else json.dumps(obj)
    return SimpleNamespace(content=[SimpleNamespace(type="text", text=text)], stop_reason=stop)


def interp(reply_obj=None, exc=None, key="sk-ant-test"):
    msgs = FakeMessages(reply_obj, exc)
    client = FakeClient(msgs)
    return C.ClaudeInterpreter(lambda: key, client_factory=lambda k: client), client, msgs


def test_request_shape_haiku_disabled_thinking_low_effort_512_cached_system():
    it, client, msgs = interp(reply({"kind": "actions", "first": "smaller", "second": "airbrush", "arg": None}))
    ctx = {"tool": "brush", "preset": "b) Basic-5 Size", "size": 40, "opacity": 100, "color": "#1d4ed8", "steadiness": 50,
           "lastActions": ["a", "blue", "bigger", "new_layer"], "camera": "secret", "path": "/Users/x"}
    out = it.interpret("make it thinner and a bit softer", ctx)
    assert out["kind"] == "actions" and out["first"] == "smaller" and out["second"] == "airbrush" and out["mock"] is False
    assert client.options == [{"timeout": 2.5, "max_retries": 0}]
    p = msgs.calls[0]
    assert p["model"] == "claude-haiku-5-5" and p["max_tokens"] == 512
    assert p["thinking"] == {"type": "disabled"}
    assert p["output_config"]["effort"] == "low" and p["output_config"]["format"]["type"] == "json_schema"
    assert p["system"] == [{"type": "text", "text": REF["systemBlock"], "cache_control": {"type": "ephemeral"}}]
    assert "tool_choice" not in p and "tools" not in p
    body = json.loads(p["messages"][0]["content"])
    assert set(body) == {"text", "context"}
    assert set(body["context"]) == {"tool", "preset", "size", "opacity", "color", "steadiness", "lastActions"}  # rule 9
    assert body["context"]["lastActions"] == ["blue", "bigger", "new_layer"]


@pytest.mark.parametrize(
    "raw,expected",
    [
        ({"kind": "actions", "first": "SMALLER", "second": None, "arg": None}, {"kind": "actions", "first": "smaller", "second": None, "arg": None}),
        ({"kind": "actions", "first": "bigger", "second": "bigger", "arg": None}, {"kind": "actions", "first": "bigger", "second": None, "arg": None}),
        ({"kind": "actions", "first": "launch_rockets", "second": None, "arg": None}, None),
        ({"kind": "actions", "first": "yes", "second": None, "arg": None}, None),  # dialog vocabulary is never Claude's
        ({"kind": "actions", "first": "size", "second": None, "arg": "big"}, None),
        ({"kind": "clarify", "options": ["lighter", "fade", "fade", "darker", "bigger"]}, {"kind": "clarify", "options": ["lighter", "fade", "darker"]}),
        ({"kind": "clarify", "options": []}, None),
        ({"kind": "noop"}, {"kind": "noop"}),
        ({"kind": "explain"}, None),
        ("not json", None),
    ],
)
def test_normalise_output(raw, expected):
    assert C.normalise_output(raw) == expected


def test_invalid_json_or_refusal_is_invalid():
    it, _, _ = interp(reply("{not json"))
    assert it.interpret("x", {})["reason"] == "invalid"
    it, _, _ = interp(reply({"kind": "noop"}, stop="refusal"))
    assert it.interpret("x", {})["reason"] == "invalid"


def test_errors_are_classified():
    import anthropic
    import httpx2

    req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    cases = [
        (anthropic.APITimeoutError(request=req), "timeout"),
        (anthropic.AuthenticationError("bad", response=httpx2.Response(401, request=req), body=None), "key_missing"),
        (anthropic.APIConnectionError(request=req), "offline"),
        (anthropic.InternalServerError("boom", response=httpx2.Response(500, request=req), body=None), "upstream"),
    ]
    for exc, reason in cases:
        it, _, _ = interp(exc=exc)
        out = it.interpret("x", {})
        assert out["kind"] == "error" and out["reason"] == reason


def test_prewarm_uses_same_system_block_and_30s_timeout():
    it, client, msgs = interp(reply({"kind": "noop"}))
    assert it.prewarm()["ok"] is True
    assert client.options == [{"timeout": 30.0, "max_retries": 0}]
    assert msgs.calls[0]["system"][0]["text"] == REF["systemBlock"]
    assert json.loads(msgs.calls[0]["messages"][0]["content"])["text"] == "um"


# ------------------------------------------------------------------------------------------- mock
def test_no_key_uses_the_keyword_mock():
    it, _, msgs = interp(key="")
    out = it.interpret("make it thinner and a bit softer", {})
    assert out["kind"] == "actions" and out["first"] == "smaller" and out["second"] == "airbrush" and out["mock"] is True
    assert msgs.calls == []  # never calls Anthropic without a key


@pytest.mark.parametrize(
    "text,expected",
    [
        ("make it thinner and a bit softer", {"kind": "actions", "first": "smaller", "second": "airbrush", "arg": None}),
        ("set the brush to forty", {"kind": "actions", "first": "size", "second": None, "arg": 40}),
        ("half see-through opacity", {"kind": "actions", "first": "opacity", "second": None, "arg": 50}),
        ("navy and fatter", {"kind": "actions", "first": "colour_blue", "second": "bigger", "arg": None}),
        ("make it lighter", {"kind": "clarify", "options": ["lighter", "fade"]}),
        ("um", {"kind": "noop"}),
        ("*cough*", {"kind": "noop"}),
        ("paint the room", None),
    ],
)
def test_mock_interpret(text, expected):
    assert C.mock_interpret(text) == expected


def test_no_key_and_no_mock_match_is_key_missing():
    it, _, _ = interp(key="")
    out = it.interpret("paint the room", {})
    assert out == {"kind": "error", "reason": "key_missing", "latencyMs": out["latencyMs"], "mock": True}


def test_claude_log_jsonl(tmp_path):
    log = C.ClaudeLog(tmp_path / "Steady" / "claude-log.jsonl")
    e = log.log('"x" → clarify a / b', 640.4, "pending", False)
    log.log('"y" → noop', 300, "noop", True)
    log.mark(e["id"], "accepted")
    rows = log.read()
    assert [r["outcome"] for r in rows] == ["accepted", "noop"]
    assert rows[0]["latencyMs"] == 640 and rows[1]["mock"] is True
    assert set(rows[1]) == {"id", "t", "summary", "latencyMs", "outcome", "mock"}
