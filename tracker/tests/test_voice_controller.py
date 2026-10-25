"""Agent E: VoiceController end to end with fakes (fake mic, fake Cartesia socket, fake brain parse, fake Claude).

Never opens the real microphone, never plays audio, never calls Cartesia or Anthropic: sounddevice is replaced by
a module that fails loudly, and every device/service is injected.
"""

import math
import sys
from array import array
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from steadytracker.voice.cartesia import TokenSource
from steadytracker.voice.claude import ClaudeLog
from steadytracker.voice.controller import VoiceController
from steadytracker.voice.fakes import FakeConnect, FakeHttp, FakeInterpreter, FakeMic, FakePlayer, FakeWs, NoSoundDevice, Recorder, finals
from steadytracker.voice.tts import TtsClient

pytestmark = pytest.mark.P2a


@pytest.fixture(autouse=True)
def no_sounddevice(monkeypatch):
    monkeypatch.setitem(sys.modules, "sounddevice", NoSoundDevice())


def voiced(seconds=0.2, rate=48000, amp=0.3):
    return array("f", [amp * math.sin(2 * math.pi * 300 * i / rate) for i in range(int(rate * seconds))]).tobytes()


def silent(seconds=0.2, rate=48000):
    return array("f", [0.0] * int(rate * seconds)).tobytes()


class Parse:
    def __init__(self, table=None):
        self.table = table or {}
        self.calls = []

    def __call__(self, text, opts):
        self.calls.append((text, dict(opts)))
        return self.table.get(text, {"kind": "nomatch", "closest": ["bigger", "brush"]})


def match(*cmds):
    return {"kind": "match", "commands": list(cmds), "fuzzy": False}


class Rig:
    def __init__(self, tmp_path, transcript=("blue",), parse=None, response=None, keys=None, settings=None, dialog=True):
        self.clock = [0.0]
        self.settings = {"micSilenceMs": 2000, "micCapMs": 15000, "quiet": False, "tts": True, "steadiness": 50, **(settings or {})}
        self.connect = FakeConnect(transcript_msgs=finals(*transcript))
        self.parse = parse or Parse({"blue": match({"action": "colour_blue"})})
        self.dispatch, self.status, self.heard, self.mic_events, self.dialogs, self.sleeps, self.listening = (Recorder() for _ in range(7))
        self.interp = FakeInterpreter(response)
        self.tts_sockets = []
        self.player = FakePlayer()

        def tts_socket(url):
            ws = FakeWs()
            self.tts_sockets.append(ws)
            return ws

        http = FakeHttp()
        self.keys = keys if keys is not None else {"CARTESIA_API_KEY": "k", "ANTHROPIC_API_KEY": "", "CARTESIA_VOICE_ID": "v1"}
        self.tts = TtsClient(
            TokenSource(lambda: self.keys.get("CARTESIA_API_KEY", ""), http), lambda: "v1", socket=tts_socket,
            player=lambda: self.player, threaded=False, now_ms=lambda: self.clock[0],
        )
        FakeMic.instances.clear()
        self.vc = VoiceController(
            self.parse,
            self.dispatch,
            self.status,
            self.heard,
            True,
            lambda: self.settings,
            self.keys,
            dialog=self.dialogs if dialog else None,
            on_mic=self.mic_events,
            on_listening=self.listening,
            mic_factory=FakeMic,
            stt_connect=self.connect,
            http=http,
            interpreter=self.interp,
            claude_log=ClaudeLog(tmp_path / "claude-log.jsonl"),
            tts=self.tts,
            now_ms=lambda: self.clock[0],
            threaded=False,
            sleep=self.sleeps,
        )

    @property
    def mic(self):
        return FakeMic.instances[-1]

    def feed(self, raw, advance_ms=200):
        self.mic.cb(raw)
        self.clock[0] += advance_ms
        self.vc.tick()

    def feed_frames(self, raw, frame_ms=20, rate=48000):
        """Deliver audio in 20 ms callbacks, advancing the fake clock per callback (like PortAudio)."""
        step = int(rate * frame_ms / 1000) * 4
        for i in range(0, len(raw), step):
            if not FakeMic.instances or self.mic.cb is None or self.mic.stopped:
                return
            self.mic.cb(raw[i : i + step])
            self.clock[0] += frame_ms
            self.vc.tick()

    def at(self, ms):
        self.clock[0] = ms
        self.vc.tick()

    @property
    def ws(self):
        return self.connect.sockets[-1]

    def statuses(self):
        return [s[0] for s in self.status.items]


def test_tap_closes_utterance_end_after_speech_and_dispatches_grammar_match(tmp_path):
    r = Rig(tmp_path, settings={"utteranceEndMs": 450})
    r.vc.open("tile")
    assert r.vc.is_open and r.mic.started and r.mic_events.items == [(True, "tile")]
    assert "Listening…" in r.statuses()
    r.at(1000)
    r.feed_frames(voiced(0.4))  # VAD hears speech
    end = r.clock[0]
    r.feed_frames(silent(0.42))
    assert r.vc.is_open  # 420 ms of silence
    r.feed_frames(silent(0.1))
    assert not r.vc.is_open and r.mic.stopped
    assert r.clock[0] - end <= 450 + 20  # end of speech -> close within utteranceEndMs (+ one frame)
    assert r.mic_events.items[-1] == (False, "closed")
    assert r.ws.texts == ["finalize"]
    assert r.ws.audio and all(len(a) == 3200 for a in r.ws.audio)  # 100 ms pcm_s16le @ 16 kHz
    assert r.heard.items == [("blue", "grammar")]
    assert r.dispatch.items == [("colour_blue", None, None, "voice")]
    assert r.interp.calls == []  # grammar matched: Claude never asked


def test_tap_falls_back_to_mic_silence_when_vad_heard_no_speech(tmp_path):
    r = Rig(tmp_path, settings={"micSilenceMs": 2000})
    r.vc.open("tile")
    r.at(1000)
    r.feed(voiced(0.1))  # a short sound: activity, but < 200 ms so the VAD never starts
    r.at(2900)
    assert r.vc.is_open
    r.at(3100)
    assert not r.vc.is_open  # micSilenceMs after the last activity


def test_no_onset_timeout_in_tap_mode(tmp_path):
    r = Rig(tmp_path)
    r.vc.open("tile")
    r.feed(silent())
    r.at(10 * 60_000)
    assert r.vc.is_open  # nothing closes before speech starts


def test_tap_closes_at_cap_counted_from_onset(tmp_path):
    r = Rig(tmp_path, settings={"micCapMs": 15000})
    r.vc.open("tile")
    r.at(5000)
    while r.vc.is_open and r.clock[0] < 30000:
        r.feed(voiced(0.1), advance_ms=100)
    assert not r.vc.is_open
    assert 19900 <= r.clock[0] <= 20300  # onset ~5100 + 15 s


def test_ptt_closes_only_on_release(tmp_path):
    r = Rig(tmp_path)
    r.vc.on_brain_mic(True, "ptt")
    assert r.mic_events.items == [(True, "ptt")]
    r.feed(voiced())
    r.at(120_000)  # long silence, past the cap
    assert r.vc.is_open
    r.vc.on_brain_mic(False, "ptt")
    assert not r.vc.is_open and r.dispatch.items == [("colour_blue", None, None, "voice")]


def test_tap_toggle_closes_on_next_tap(tmp_path):
    r = Rig(tmp_path)
    r.vc.toggle()
    assert r.vc.is_open
    r.feed(voiced())
    r.vc.toggle()
    assert not r.vc.is_open and r.ws.texts == ["finalize"]


def test_quiet_mode_cancels_without_transcript_and_blocks_open(tmp_path):
    r = Rig(tmp_path)
    r.vc.open("tile")
    r.feed(voiced())
    r.vc.set_quiet(True)
    assert not r.vc.is_open and r.mic.stopped
    assert r.ws.closed and "finalize" not in r.ws.texts  # audio never leaks into a later utterance
    assert r.dispatch.items == [] and r.statuses()[-1] == "Quiet mode: mic off."
    n = len(FakeMic.instances)
    r.vc.open("ptt")
    assert not r.vc.is_open and len(FakeMic.instances) == n  # mic never opened in quiet mode
    assert r.vc.speak("Saved") is False and r.tts_sockets == []


def test_brain_quiet_close_and_settings_quiet(tmp_path):
    r = Rig(tmp_path)
    r.vc.open("tile")
    r.vc.on_brain_mic(False, "quiet")
    assert not r.vc.is_open and r.dispatch.items == []
    r.vc.set_quiet(False)
    r.vc.on_settings({"quiet": True})
    assert r.vc.quiet is True and r.tts.quiet is True


def test_voice_input_switched_off(tmp_path):
    r = Rig(tmp_path, settings={"inputs": {"camera": True, "voice": False, "dwell": True, "keys": True}})
    r.vc.open("tile")
    assert not r.vc.is_open and FakeMic.instances == []


def test_missing_cartesia_key_never_opens_mic(tmp_path):
    r = Rig(tmp_path, keys={"CARTESIA_API_KEY": "", "ANTHROPIC_API_KEY": ""})
    r.vc.open("tile")
    assert not r.vc.is_open and FakeMic.instances == []
    assert "Cartesia key" in r.statuses()[-1]
    assert r.mic_events.items == [(False, "refused")]  # the brain learns the mic did not open


def test_mic_open_cancels_tts_and_blocks_speaking(tmp_path):
    r = Rig(tmp_path)
    assert r.vc.speak("Saved") is True
    assert len(r.tts_sockets) == 1
    r.vc.open("tile")
    assert r.tts.mic_open is True
    assert '"cancel": true' in r.tts_sockets[0].texts[-1]
    assert r.vc.speak("New layer") is False
    r.vc.close()
    assert r.tts.mic_open is False


def test_tts_setting_off(tmp_path):
    r = Rig(tmp_path, settings={"tts": False})
    assert r.vc.speak("Saved") is False
    r.settings["tts"] = True
    r.vc.on_settings({"tts": True})
    assert r.vc.speak("Saved") is True


def test_nomatch_goes_to_claude_two_commands_50ms_apart(tmp_path):
    resp = {"kind": "actions", "first": "smaller", "second": "airbrush", "arg": None, "latencyMs": 500, "mock": False}
    r = Rig(tmp_path, transcript=("make it thinner", " and a bit softer"), response=resp)
    r.vc.open("ptt")
    r.feed(voiced())
    r.vc.close()
    assert r.heard.items == [("make it thinner and a bit softer", "claude")]
    assert r.dispatch.items == [("smaller", None, None, "claude"), ("airbrush", None, None, "claude")]
    assert r.sleeps.items == [0.05]
    assert set(r.interp.calls[0][1]) >= {"steadiness"}


def test_coalesced_undo_is_sent_once_with_its_count(tmp_path):
    r = Rig(tmp_path, transcript=("undo that undo that",), parse=Parse({"undo that undo that": match({"action": "undo", "arg": 2})}))
    r.vc.open("ptt")
    r.feed(voiced())
    r.vc.close()
    assert r.dispatch.items == [("undo", None, 2, "voice")]


def test_clarify_dialog_answered_by_voice_then_by_panel(tmp_path):
    resp = {"kind": "clarify", "options": ["lighter", "fade"], "latencyMs": 400, "mock": False}
    parse = Parse({"two": match({"action": "choice_two"}), "make it lighter": {"kind": "nomatch", "closest": []}})
    r = Rig(tmp_path, transcript=("make it lighter",), parse=parse, response=resp)
    r.vc.submit_text("make it lighter")
    d = r.dialogs.items[-1]
    assert d["t"] == "dialog" and d["kind"] == "clarify" and d["dialog_id"].startswith("v-dlg-")
    assert not d["dialog_id"].startswith("b-dlg-")
    assert [o["id"] for o in d["options"]] == ["lighter", "fade"]
    assert r.vc.clarify_open
    r.vc.submit_text("two")
    assert parse.calls[-1][1]["dialogOpen"] is True  # exact grammar only while our prompt is open
    assert r.dispatch.items == [("fade", None, None, "claude")]
    assert r.dialogs.items[-1] == {"t": "dialog_close", "dialog_id": d["dialog_id"]}
    assert len(r.interp.calls) == 1  # "two" never went to Claude
    rows = r.vc.resolver.log.read()
    assert rows[-1]["outcome"] == "accepted"

    r.vc.submit_text("make it lighter")
    d2 = r.dialogs.items[-1]
    assert r.vc.dialog_answer("b-dlg-7", "confirm") is False  # the brain's dialog: not ours
    assert r.vc.dialog_answer(d2["dialog_id"], "cancel") is True
    assert not r.vc.clarify_open and r.vc.resolver.log.read()[-1]["outcome"] == "rejected"
    assert r.dispatch.items == [("fade", None, None, "claude")]


def test_brain_dialog_open_keeps_claude_out(tmp_path):
    r = Rig(tmp_path)
    r.vc._dialog_open = lambda: True
    r.vc.submit_text("make it thinner")
    assert r.interp.calls == [] and r.dispatch.items == []
    assert r.parse.calls[-1][1]["dialogOpen"] is True


def test_none_shows_didnt_catch_with_closest(tmp_path):
    r = Rig(tmp_path, response={"kind": "error", "reason": "timeout", "latencyMs": 2500, "mock": False})
    r.vc.submit_text("paint the room")
    assert r.heard.items == [("paint the room", "grammar")]
    assert r.statuses()[-1].startswith("Didn't catch that. Heard: “paint the room”. Closest: Bigger, Brush")
    assert r.dispatch.items == []


def test_typed_grammar_source_is_typed(tmp_path):
    r = Rig(tmp_path)
    r.vc.submit_text("blue")
    assert r.dispatch.items == [("colour_blue", None, None, "typed")]


def test_empty_transcript_reports_nothing_heard(tmp_path):
    r = Rig(tmp_path, transcript=())
    r.vc.open("tile")
    r.feed(voiced())
    r.vc.close()
    assert r.statuses()[-1] == "Didn't hear anything." and r.dispatch.items == []


def test_unreachable_cartesia_is_reported(tmp_path):
    r = Rig(tmp_path)
    r.connect.fail = True
    r.vc.open("tile")
    r.feed(voiced())
    r.vc.close()
    assert "Couldn't reach the voice service" in r.statuses()[-1]


def test_socket_reused_between_utterances(tmp_path):
    r = Rig(tmp_path)
    for _ in range(2):
        r.vc.open("ptt")
        r.feed(voiced())
        r.vc.close()
    assert len(r.connect.sockets) == 1 and r.ws.texts == ["finalize", "finalize"]
    assert len(r.dispatch.items) == 2


def test_threaded_smoke(tmp_path):
    """The real thread layout (voice thread + finisher) with fakes; shutdown joins cleanly."""
    import time

    parse = Parse({"blue": match({"action": "colour_blue"})})
    dispatch = Recorder()
    FakeMic.instances.clear()
    vc = VoiceController(
        parse, dispatch, Recorder(), Recorder(), True, lambda: {"micSilenceMs": 2000, "micCapMs": 15000}, {"CARTESIA_API_KEY": "k"},
        mic_factory=FakeMic, stt_connect=FakeConnect(transcript_msgs=finals("blue")), http=FakeHttp(),
        interpreter=FakeInterpreter(), claude_log=ClaudeLog(tmp_path / "l.jsonl"),
        tts=TtsClient(TokenSource(lambda: "k", FakeHttp()), lambda: "v", socket=lambda u: FakeWs(), player=FakePlayer, threaded=False),
        prewarm=False,
    )
    vc.open("ptt")
    end = time.time() + 2
    while not FakeMic.instances or not FakeMic.instances[-1].started:
        assert time.time() < end
        time.sleep(0.01)
    FakeMic.instances[-1].cb(voiced())
    vc.close()
    while not dispatch.items:
        assert time.time() < end
        time.sleep(0.01)
    assert dispatch.items == [("colour_blue", None, None, "voice")]
    vc.shutdown()
