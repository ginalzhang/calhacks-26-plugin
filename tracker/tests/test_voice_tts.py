"""Agent E: Sonic TTS gating and protocol. Fake socket + fake player: nothing is ever played."""

import base64
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from steadytracker.voice.cartesia import TokenSource
from steadytracker.voice.fakes import FakeHttp, FakePlayer, FakeWs, NoSoundDevice
from steadytracker.voice.tts import TTS_MODEL, TtsClient, build_tts_request, build_tts_url, confirmation_text

pytestmark = pytest.mark.P2a


@pytest.fixture(autouse=True)
def no_sounddevice(monkeypatch):
    monkeypatch.setitem(sys.modules, "sounddevice", NoSoundDevice())


def make(voice="v-en", key="k"):
    sockets, statuses = [], []
    player = FakePlayer()

    def socket(url):
        ws = FakeWs()
        ws.url = url
        sockets.append(ws)
        return ws

    ids = iter(f"ctx-{i}" for i in range(100))
    tts = TtsClient(
        TokenSource(lambda: key, FakeHttp()),
        lambda: voice,
        socket=socket,
        player=lambda: player,
        on_status=lambda s, t: statuses.append(s),
        new_context_id=lambda: next(ids),
        threaded=False,
    )
    return tts, sockets, player, statuses


def chunk(ctx, pcm=b"\x01\x00\x02\x00"):
    return json.dumps({"type": "chunk", "context_id": ctx, "data": base64.b64encode(pcm).decode()})


def test_request_shape():
    req = build_tts_request("Saved", "v1", "c1")
    assert req == {
        "model_id": "sonic-3.6",
        "transcript": "Saved",
        "voice": {"mode": "id", "id": "v1"},
        "language": "en",
        "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": 24000},
        "context_id": "c1",
        "max_buffer_delay_ms": 300,
    }
    assert TTS_MODEL == "sonic-3.6"
    assert build_tts_url("a b").startswith("wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14&access_token=a%20b")


def test_speaks_when_allowed_and_plays_matching_chunks():
    tts, sockets, player, _ = make()
    assert tts.speak("New layer") is True
    ws = sockets[0]
    sent = json.loads(ws.texts[0])
    assert sent["transcript"] == "New layer" and sent["voice"]["id"] == "v-en"
    tts.on_message(chunk(sent["context_id"]))
    tts.on_message(chunk("stale-context"))
    assert player.played == [b"\x01\x00\x02\x00"]


@pytest.mark.parametrize("gate", ["disabled", "quiet", "mic_open"])
def test_gating(gate):
    tts, sockets, player, _ = make()
    {"disabled": lambda: tts.set_enabled(False), "quiet": lambda: tts.set_quiet(True), "mic_open": lambda: tts.set_mic_open(True)}[gate]()
    assert tts.speak("Saved") is False
    assert sockets == [] and player.played == []


def test_mic_open_cancels_speech_in_progress():
    tts, sockets, player, _ = make()
    tts.speak("Saved")
    ws = sockets[0]
    ctx = json.loads(ws.texts[0])["context_id"]
    tts.on_message(chunk(ctx))
    tts.set_mic_open(True)
    assert json.loads(ws.texts[-1]) == {"context_id": ctx, "cancel": True}
    assert player.stops >= 1  # queued audio silenced at once
    tts.on_message(chunk(ctx))  # late audio after cancel is dropped
    assert len(player.played) == 1


def test_voice_unavailable_and_key_missing():
    tts, sockets, _, statuses = make(voice=None)
    tts.speak("Saved")
    assert statuses == ["voice_unavailable"] and sockets == []
    tts, sockets, _, statuses = make(key="")
    tts.speak("Saved")
    assert statuses == ["key_missing"] and sockets == []


def test_empty_text_is_not_spoken():
    tts, sockets, _, _ = make()
    assert tts.speak("   ") is False and sockets == []


def test_confirmations():
    assert confirmation_text("saved") == "Saved"
    assert confirmation_text("didnt_catch", "paint the room") == "Didn't catch that; I heard paint the room"
    assert confirmation_text("didnt_catch", "") == "Didn't catch that"
    long = " ".join(["w"] * 30)
    assert len(confirmation_text("didnt_catch", long).split()) == 5 + 12
    assert confirmation_text("pen_toggle") is None  # never on pen toggles
