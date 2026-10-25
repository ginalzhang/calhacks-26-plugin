"""Agent E: always-listening mode (local VAD -> one warm Cartesia socket) and fast end of utterance. Fakes only:
no real microphone, no audio output, no network."""

import base64
import json
import math
import random
import struct
import sys
from array import array
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from steadytracker.voice.fakes import FakeMic, NoSoundDevice, finals
from steadytracker.voice.vad import DEFAULT_END_MS, FRAME_MS, PREROLL_MS, START_MS, Vad, clamp_end_ms
from test_voice_controller import Parse, Rig, match, silent

pytestmark = pytest.mark.P2a

RATE = 48000


@pytest.fixture(autouse=True)
def no_sounddevice(monkeypatch):
    monkeypatch.setitem(sys.modules, "sounddevice", NoSoundDevice())


# ------------------------------------------------------------------------------------------- synthetic audio
def speech(seconds, amp=0.15, syllable_ms=140, gap_ms=40):
    """Speech-like bursts: harmonic 'syllables' with short near-silent gaps."""
    out = array("f")
    n = int(RATE * seconds)
    period = int(RATE * (syllable_ms + gap_ms) / 1000)
    on = int(RATE * syllable_ms / 1000)
    for i in range(n):
        k = i % period
        if k < on:
            env = math.sin(math.pi * k / on)
            v = env * amp * (math.sin(2 * math.pi * 180 * i / RATE) + 0.5 * math.sin(2 * math.pi * 360 * i / RATE))
        else:
            v = 0.0
        out.append(v)
    return out.tobytes()


def noise(seconds, rms=0.004, seed=1):
    rnd = random.Random(seed)
    return array("f", [rnd.gauss(0.0, rms) for _ in range(int(RATE * seconds))]).tobytes()


def tts_chunk(ctx, seconds):
    pcm = b"\x00\x00" * int(24000 * seconds)
    return json.dumps({"type": "chunk", "context_id": ctx, "data": base64.b64encode(pcm).decode()})


# ------------------------------------------------------------------------------------------- VAD unit
def run(vad, level, ms):
    evs = []
    for _ in range(ms // FRAME_MS):
        e = vad.update(level)
        if e:
            evs.append(e)
    return evs


def test_vad_silence_and_low_noise_never_start():
    v = Vad()
    assert run(v, 0.0, 5000) == [] and run(v, 0.004, 5000) == []
    assert not v.speech_seen


def test_vad_needs_200ms_of_speech_and_ends_after_end_ms():
    v = Vad(end_ms=450)
    assert run(v, 0.1, START_MS - FRAME_MS) == []
    assert run(v, 0.1, FRAME_MS) == ["start"]
    assert run(v, 0.0, 440) == []
    assert run(v, 0.0, 20) == ["end"]


def test_vad_short_click_is_not_speech():
    v = Vad()
    assert run(v, 0.3, 100) == [] and run(v, 0.0, 200) == [] and run(v, 0.3, 100) == []


def test_vad_hysteresis_keeps_quieter_speech_inside_an_utterance():
    v = Vad(end_ms=450)
    run(v, 0.1, 300)
    level = (v.stay_threshold + v.start_threshold) / 2  # below start, above stay
    assert run(v, level, 2000) == []
    assert v.in_speech


def test_vad_warmup_learns_room_noise():
    v = Vad(warmup_ms=200)
    run(v, 0.02, 200)
    assert v.floor == pytest.approx(0.02, rel=0.05)
    assert run(v, 0.02, 5000) == []  # a fan at -34 dBFS is not speech
    assert run(v, 0.2, 300) == ["start"]  # a voice over it is


def test_vad_learns_steady_noise_after_a_capped_utterance():
    v = Vad()
    run(v, 0.05, 300)
    assert v.in_speech
    v.force_end(capped=True)
    assert run(v, 0.05, 5000) == []


def test_clamp_end_ms():
    assert clamp_end_ms(None) == DEFAULT_END_MS == 450
    assert clamp_end_ms(100) == 250 and clamp_end_ms(9000) == 1500 and clamp_end_ms("600") == 600


# ------------------------------------------------------------------------------------------- always mode
def always_rig(tmp_path, transcript=("undo",), parse=None, **settings):
    parse = parse or Parse({"undo": match({"action": "undo"}), "blue": match({"action": "colour_blue"})})
    return Rig(tmp_path, transcript=transcript, parse=parse, settings={"alwaysListen": True, "utteranceEndMs": 450, **settings})


def test_stream_opens_with_a_warm_socket_and_does_not_touch_the_pen(tmp_path):
    r = always_rig(tmp_path)
    assert r.vc.listening and r.mic.started
    assert r.listening.items == [True]
    assert len(r.connect.sockets) == 1  # handshake done before anyone speaks
    assert r.mic_events.items == []  # never a brain mic event: the pen is not lifted
    assert "Listening for commands (always on)." in r.statuses()


def test_nothing_is_sent_while_nobody_speaks(tmp_path):
    r = always_rig(tmp_path)
    r.feed_frames(silent(1.0))
    r.feed_frames(noise(2.0))
    r.feed_frames(speech(0.1))  # a cough-length burst
    r.feed_frames(silent(1.0))
    assert r.ws.sent == [] and r.vc.utterances == 0 and r.dispatch.items == []


def test_one_utterance_one_dispatch_with_preroll_and_fast_end(tmp_path):
    r = always_rig(tmp_path)
    stamps = []
    inner = r.vc._dispatch
    r.vc._dispatch = lambda *a: (stamps.append(r.clock[0]), inner(*a))
    r.feed_frames(silent(0.6))
    r.feed_frames(speech(0.4))
    speech_end = r.clock[0]
    r.feed_frames(silent(1.0))
    assert r.dispatch.items == [("undo", None, None, "voice")]
    assert r.heard.items == [("undo", "grammar")]
    assert stamps[0] - speech_end <= 450 + FRAME_MS  # speech end -> dispatch: utteranceEndMs + one frame (+ fake STT 0 ms)
    ws = r.ws
    assert ws.texts == ["finalize"]
    audio = b"".join(ws.audio)
    assert all(len(a) == 3200 for a in ws.audio)
    first = struct.unpack("<1600h", ws.audio[0])
    assert max(abs(x) for x in first[:1600]) < 50  # pre-roll: the chunk before the word is the room, not speech
    sent_ms = len(audio) / 32  # 32 bytes per ms at 16 kHz int16
    assert sent_ms >= PREROLL_MS + 400 - 100  # pre-roll + the whole word (+ trailing silence)
    assert r.mic_events.items == []


def test_socket_kept_warm_across_utterances(tmp_path):
    r = always_rig(tmp_path)
    for _ in range(3):
        r.feed_frames(silent(0.5))
        r.feed_frames(speech(0.4))
        r.feed_frames(silent(0.8))
    assert len(r.connect.sockets) == 1
    assert r.ws.texts == ["finalize"] * 3
    assert r.dispatch.items == [("undo", None, None, "voice")] * 3


def test_capture_is_muted_while_tts_speaks(tmp_path):
    r = always_rig(tmp_path)
    assert r.vc.speak("Saved") is True
    ctx = json.loads(r.tts_sockets[0].texts[0])["context_id"]
    r.tts.on_message(tts_chunk(ctx, 1.0))  # 1 s of our own voice
    r.feed_frames(speech(0.6))  # what the mic hears while we speak
    r.feed_frames(silent(0.6))  # inside the 300 ms tail
    assert r.vc.utterances == 0 and r.ws.audio == []
    r.feed_frames(silent(0.3))
    r.feed_frames(speech(0.4))
    r.feed_frames(silent(0.6))
    assert r.vc.utterances == 1 and r.dispatch.items == [("undo", None, None, "voice")]


def test_tts_does_not_talk_over_the_user(tmp_path):
    r = always_rig(tmp_path)
    r.feed_frames(silent(0.3))
    r.feed_frames(speech(0.3))
    assert r.vc._utt is not None
    assert r.vc.speak("Saved") is False


def test_quiet_mode_and_setting_off_close_the_stream(tmp_path):
    r = always_rig(tmp_path)
    mic = r.mic
    r.vc.set_quiet(True)
    assert not r.vc.listening and mic.stopped and r.listening.items == [True, False]
    r.vc.set_quiet(False)
    assert r.vc.listening and r.mic is not mic
    mic2 = r.mic
    r.settings["alwaysListen"] = False
    r.vc.on_settings(dict(r.settings))
    assert not r.vc.listening and mic2.stopped
    r.settings["alwaysListen"] = True
    r.vc.on_settings(dict(r.settings))
    assert r.vc.listening
    r.settings["inputs"] = {"voice": False}
    r.vc.on_settings(dict(r.settings))
    assert not r.vc.listening


def test_quiet_mid_utterance_drops_it(tmp_path):
    r = always_rig(tmp_path)
    r.feed_frames(silent(0.3))
    r.feed_frames(speech(0.4))
    ws = r.ws
    assert ws.audio
    r.vc.set_quiet(True)
    assert ws.closed and "finalize" not in ws.texts and r.dispatch.items == []


def test_ambient_speech_never_goes_to_claude(tmp_path):
    r = always_rig(tmp_path, transcript=("so I said to her",))
    r.feed_frames(speech(0.6))
    r.feed_frames(silent(0.6))
    assert r.interp.calls == [] and r.dispatch.items == []
    assert r.statuses()[-1] == "Heard: “so I said to her” (not a command)."


def test_utterance_capped_at_mic_cap(tmp_path):
    r = always_rig(tmp_path, micCapMs=15000)
    r.feed_frames(speech(16.0, gap_ms=20))
    assert r.ws.texts == ["finalize"]


def test_ptt_takes_over_and_hands_back(tmp_path):
    r = always_rig(tmp_path, transcript=("blue",))
    always_mic = r.mic
    r.vc.on_brain_mic(True, "ptt")
    assert always_mic.stopped and not r.vc.listening and r.vc.is_open
    assert r.mic_events.items == [(True, "ptt")]
    r.feed_frames(speech(0.4))
    r.feed_frames(silent(2.0))
    assert r.vc.is_open  # PTT ignores the VAD: release only
    r.vc.on_brain_mic(False, "ptt")
    assert r.dispatch.items == [("colour_blue", None, None, "voice")]
    assert r.vc.listening and r.mic is not always_mic and r.mic.started


def test_idle_socket_replaced_after_five_minutes_and_reconnect_on_close(tmp_path):
    r = always_rig(tmp_path)
    first = r.ws
    r.at(r.clock[0] + 5 * 60 * 1000 + 100)
    assert first.closed and len(r.connect.sockets) == 2
    r.ws.close()  # server dropped it
    r.at(r.clock[0] + 100)  # reader thread notices; backoff
    import time

    time.sleep(0.05)
    r.at(r.clock[0] + 2100)
    assert len(r.connect.sockets) == 3 and not r.ws.closed


def test_tap_mode_end_of_utterance_timing_with_custom_setting(tmp_path):
    r = Rig(tmp_path, settings={"utteranceEndMs": 300})
    stamps = []
    inner = r.vc._dispatch
    r.vc._dispatch = lambda *a: (stamps.append(r.clock[0]), inner(*a))
    r.vc.open("tile")
    r.feed_frames(speech(0.4))
    t_end = r.clock[0]
    r.feed_frames(silent(1.0))
    assert not r.vc.is_open and r.mic.stopped and r.dispatch.items == [("colour_blue", None, None, "voice")]
    assert stamps[0] - t_end <= 300 + FRAME_MS  # speech end -> dispatch


def test_threaded_back_to_back_utterances_share_one_socket_in_order(tmp_path):
    """Real thread layout: the second command starts while the first is still finalising (slow flush_done)."""
    import threading
    import time

    from steadytracker.voice.cartesia import TokenSource
    from steadytracker.voice.claude import ClaudeLog
    from steadytracker.voice.controller import VoiceController
    from steadytracker.voice.fakes import FakeHttp, FakeInterpreter, FakePlayer, FakeWs, Recorder
    from steadytracker.voice.tts import TtsClient

    class SlowWs(FakeWs):
        def send(self, data):
            self.sent.append(data)
            if data == "finalize":
                threading.Timer(0.3, lambda: [self.push(m) for m in finals("undo")]).start()

    sockets = []

    def connect(url):
        ws = SlowWs()
        sockets.append(ws)
        return ws

    dispatch = Recorder()
    FakeMic.instances.clear()
    vc = VoiceController(
        Parse({"undo": match({"action": "undo"})}), dispatch, Recorder(), Recorder(), True,
        lambda: {"alwaysListen": True, "utteranceEndMs": 450, "micCapMs": 15000}, {"CARTESIA_API_KEY": "k"},
        mic_factory=FakeMic, stt_connect=connect, http=FakeHttp(), interpreter=FakeInterpreter(),
        claude_log=ClaudeLog(tmp_path / "l.jsonl"),
        tts=TtsClient(TokenSource(lambda: "k", FakeHttp()), lambda: "v", socket=lambda u: FakeWs(), player=FakePlayer, threaded=False),
        prewarm=False,
    )
    end = time.time() + 5
    while not (FakeMic.instances and FakeMic.instances[-1].started and sockets):
        assert time.time() < end
        time.sleep(0.01)
    cb = FakeMic.instances[-1].cb
    step = 960 * 4
    for raw in (silent(0.3), speech(0.4), silent(0.5), speech(0.4), silent(0.5)):
        for i in range(0, len(raw), step):
            cb(raw[i : i + step])
    while len(dispatch.items) < 2:
        assert time.time() < end, dispatch.items
        time.sleep(0.01)
    vc.shutdown()
    assert dispatch.items == [("undo", None, None, "voice")] * 2
    assert len(sockets) == 1
    sent = sockets[0].sent
    f1 = sent.index("finalize")
    assert sent.count("finalize") == 2 and isinstance(sent[f1 + 1], bytes)  # 2nd utterance's audio after the 1st finalize
