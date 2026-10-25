"""Agent E: resolution order (grammar first, Claude only on nomatch, refused alias never Claude, dialogs exact only)."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from steadytracker.voice.claude import ClaudeInterpreter, ClaudeLog
from steadytracker.voice.fakes import FakeInterpreter
from steadytracker.voice.resolve import Resolver

pytestmark = pytest.mark.P2a


class FakeParse:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def __call__(self, text, opts):
        self.calls.append((text, dict(opts)))
        return self.result


NOMATCH = {"kind": "nomatch", "closest": ["bigger", "brush"]}


def resolver(parse_result, response=None, tmp_path=None):
    parse = FakeParse(parse_result)
    it = FakeInterpreter(response)
    log = ClaudeLog(tmp_path / "claude-log.jsonl")
    return Resolver(parse, it, log), parse, it, log


def test_grammar_match_never_calls_claude(tmp_path):
    r, parse, it, log = resolver({"kind": "match", "commands": [{"action": "undo", "arg": 2}], "fuzzy": False}, tmp_path=tmp_path)
    out = r.resolve("undo that undo that", mode="voice")
    assert out == {"kind": "commands", "commands": [{"action": "undo", "arg": 2}], "heard": "undo that undo that", "via": "grammar"}
    assert it.calls == [] and log.read() == []
    assert parse.calls == [("undo that undo that", {"mode": "voice"})]  # dialogOpen left to the brain when unknown


def test_nomatch_goes_to_claude_with_rule9_context(tmp_path):
    resp = {"kind": "actions", "first": "smaller", "second": "airbrush", "arg": None, "latencyMs": 600, "mock": False}
    r, parse, it, log = resolver(NOMATCH, resp, tmp_path)
    out = r.resolve("make it thinner and a bit softer", context={"steadiness": 40, "tool": "brush"})
    assert out == {"kind": "commands", "commands": [{"action": "smaller"}, {"action": "airbrush"}], "heard": "make it thinner and a bit softer", "via": "claude"}
    assert it.calls[0][0] == "make it thinner and a bit softer"
    rows = log.read()
    assert rows[0]["outcome"] == "accepted" and rows[0]["latencyMs"] == 600 and "smaller + airbrush" in rows[0]["summary"]


def test_refused_alias_never_reaches_claude(tmp_path):
    statuses = []
    r, _, it, log = resolver({"kind": "nomatch", "closest": [], "refused": {"reason": "alias_taken", "word": "blue"}}, tmp_path=tmp_path)
    out = r.resolve("call this brush blue", on_status=lambda t, l: statuses.append(t))
    assert out["kind"] == "none" and out["refused"] == {"reason": "alias_taken", "word": "blue"} and out["closest"] == []
    assert it.calls == [] and log.read() == []
    assert statuses == ['That word is taken: "blue".']


def test_dialog_open_is_exact_grammar_only(tmp_path):
    r, parse, it, _ = resolver(NOMATCH, tmp_path=tmp_path)
    out = r.resolve("yeah sure", dialog_open=True)
    assert out == {"kind": "none", "heard": "yeah sure", "closest": [], "reason": "nomatch"}
    assert it.calls == []
    assert parse.calls[0][1]["dialogOpen"] is True


def test_mock_mode_end_to_end_without_key(tmp_path):
    statuses = []
    parse = FakeParse(NOMATCH)
    r = Resolver(parse, ClaudeInterpreter(lambda: ""), ClaudeLog(tmp_path / "l.jsonl"))
    out = r.resolve("make it thinner and a bit softer", on_status=lambda t, l: statuses.append(t))
    assert out["kind"] == "commands" and out["via"] == "claude"
    assert [c["action"] for c in out["commands"]] == ["smaller", "airbrush"]
    assert any("Claude key missing" in s for s in statuses)
    assert r.log.read()[0]["mock"] is True
    out = r.resolve("paint the room", on_status=lambda t, l: statuses.append(t))
    assert out["kind"] == "none" and out["reason"] == "key_missing" and out["closest"] == ["bigger", "brush"]
    assert statuses[-1] == "Claude key missing: only exact commands work."


@pytest.mark.parametrize(
    "resp,expected",
    [
        ({"kind": "actions", "first": "size", "second": None, "arg": 40}, [{"action": "size", "arg": 40}]),
        ({"kind": "actions", "first": "size", "second": None, "arg": None}, None),  # size without a number
        ({"kind": "actions", "first": "colour_blue", "second": "size", "arg": 20}, [{"action": "colour_blue"}, {"action": "size", "arg": 20}]),
        ({"kind": "actions", "first": "Bigger", "second": None, "arg": 7}, [{"action": "bigger"}]),
        ({"kind": "actions", "first": "nope", "second": None, "arg": None}, None),
    ],
)
def test_claude_actions_arg_rules(tmp_path, resp, expected):
    r, _, _, _ = resolver(NOMATCH, {**resp, "latencyMs": 1, "mock": False}, tmp_path)
    out = r.resolve("whatever")
    if expected is None:
        assert out["kind"] == "none" and out["reason"] == "invalid" and out["closest"] == ["bigger", "brush"]
    else:
        assert out["kind"] == "commands" and out["commands"] == expected


def test_clarify_noop_and_errors(tmp_path):
    r, _, _, log = resolver(NOMATCH, {"kind": "clarify", "options": ["lighter", "FADE"], "latencyMs": 1, "mock": False}, tmp_path)
    assert r.resolve("make it lighter") == {"kind": "clarify", "options": ["lighter", "fade"], "heard": "make it lighter"}
    assert log.read()[-1]["outcome"] == "pending"
    r.resolve_clarify(True)
    assert log.read()[-1]["outcome"] == "accepted"

    r.interpreter.response = {"kind": "noop", "latencyMs": 1, "mock": False}
    assert r.resolve("*cough*") == {"kind": "noop", "heard": "*cough*"}
    for reason, expect in (("timeout", "timeout"), ("invalid", "invalid"), ("upstream", "offline"), ("offline", "offline")):
        r.interpreter.response = {"kind": "error", "reason": reason, "latencyMs": 2500, "mock": False}
        out = r.resolve("hmm what")
        assert out["kind"] == "none" and out["reason"] == expect and out["heard"] == "hmm what"


def test_empty_text_is_noop_and_brain_failure_still_tries_claude(tmp_path):
    r, parse, it, _ = resolver(NOMATCH, tmp_path=tmp_path)
    assert r.resolve("   ") == {"kind": "noop", "heard": ""}
    assert parse.calls == []

    def boom(text, opts):
        raise TimeoutError("brain")

    r.parse = boom
    out = r.resolve("something")
    assert out["kind"] == "noop" and len(it.calls) == 1
