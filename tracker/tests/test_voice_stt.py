"""Agent E: Cartesia Ink 2 manual-finalize STT (message handling, URL/keyterms, token minting). Fakes only."""

import json
import sys
import threading
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from steadytracker.voice.cartesia import REMINT_AFTER_S, TokenError, TokenSource, first_english_voice, mint_token, needs_remint
from steadytracker.voice.fakes import FakeConnect, FakeHttp, FakeWs, finals
from steadytracker.voice.keyterms import KEYTERM_MAX_CHARS, KEYTERM_MAX_COUNT, limit_keyterms, stt_keyterms
from steadytracker.voice.stt import STT_BASE, SttConnection, SttHandlers, build_stt_url, redact_url

pytestmark = pytest.mark.P2a


def wait_for(pred, timeout=2.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.005)
    return False


# ------------------------------------------------------------------------------------------- URL
def test_url_is_the_documented_manual_finalize_url():
    url = build_stt_url("tok/+=", ["zoom in", "layer", "undo that"])
    base, _, query = url.partition("?")
    assert base == STT_BASE == "wss://api.cartesia.ai/stt/websocket"
    assert query.startswith("model=ink-2&encoding=pcm_s16le&sample_rate=16000&cartesia_version=2026-08-14&access_token=")
    assert "keyterm=zoom%20in" in query and "keyterm=undo%20that" in query  # spaces as %20, not +
    assert "access_token=tok%2F%2B%3D" in query
    pairs = parse_qsl(urlsplit(url).query)
    assert [v for k, v in pairs if k == "keyterm"] == ["zoom in", "layer", "undo that"]
    assert "/stt/turns" not in url
    assert "tok" not in redact_url(url).split("access_token=")[1].split("&")[0]


def test_keyterms_from_action_table_within_limits():
    kt = stt_keyterms()
    assert 0 < len(kt) <= KEYTERM_MAX_COUNT
    assert len("".join(kt)) <= KEYTERM_MAX_CHARS
    assert len(set(kt)) == len(kt)
    assert "layer" in kt and "undo that" in kt and "bigger" in kt


def test_keyterm_limits_are_enforced():
    many = [f"phrase {i}" for i in range(300)]
    out = limit_keyterms(many)
    assert len(out) == KEYTERM_MAX_COUNT
    long = ["x" * 500, "y" * 500, "z" * 500, "short"]
    out = limit_keyterms(long)
    assert sum(map(len, out)) <= KEYTERM_MAX_CHARS and "short" in out
    assert limit_keyterms([" a ", "a", "", "  "]) == ["a"]


# ------------------------------------------------------------------------------------------- messages
def make_conn(**kw):
    fc = FakeConnect(**kw)
    deltas = []
    conn = SttConnection("t", ["layer"], SttHandlers(on_delta=lambda full, fin: deltas.append((full, fin))), connect=fc, flush_timeout=1.0)
    assert wait_for(lambda: conn.opened or conn.closed)
    return conn, fc, deltas


def test_finals_concatenate_untrimmed_until_flush_done_and_finalize_is_sent():
    conn, fc, deltas = make_conn(transcript_msgs=finals("make it", " thinner", " please"))
    ws = fc.sockets[0]
    conn.begin()
    conn.send_audio(b"\x00" * 3200)
    assert conn.finish() == "make it thinner please"
    assert ws.texts == ["finalize"]
    assert ws.audio == [b"\x00" * 3200]
    assert deltas[-1] == ("make it thinner please", True)


def test_interim_is_replaced_and_dropped_on_flush_done():
    conn, fc, deltas = make_conn(
        transcript_msgs=[
            {"type": "transcript", "text": "blu", "is_final": False},
            {"type": "transcript", "text": "blue", "is_final": True},
            {"type": "transcript", "text": " big", "is_final": False},
            {"type": "flush_done"},
        ]
    )
    conn.begin()
    assert conn.finish() == "blue"
    assert ("blu", False) in deltas and ("blue big", False) in deltas


def test_audio_before_open_is_queued_then_finalize_follows_it():
    gate = threading.Event()
    fc = FakeConnect(transcript_msgs=finals("blue"), gate=gate)
    conn = SttConnection("t", [], connect=fc, flush_timeout=2.0)
    conn.begin()
    conn.send_audio(b"a" * 3200)
    conn.send_audio(b"b" * 3200)
    result = {}
    th = threading.Thread(target=lambda: result.setdefault("t", conn.finish()))
    th.start()
    time.sleep(0.05)
    gate.set()
    th.join(3)
    ws = fc.sockets[0]
    assert ws.sent == [b"a" * 3200, b"b" * 3200, "finalize"]
    assert result["t"] == "blue"


def test_finish_times_out_with_finals_plus_interim():
    conn, fc, _ = make_conn(transcript_msgs=[])
    ws = fc.sockets[0]
    conn.begin()
    ws.push({"type": "transcript", "text": "new", "is_final": True})
    ws.push({"type": "transcript", "text": " lay", "is_final": False})
    assert wait_for(lambda: conn.text() == "new lay")
    t0 = time.time()
    assert conn.finish(timeout=0.2) == "new lay"
    assert time.time() - t0 < 1.0


def test_socket_reused_across_utterances_begin_clears():
    conn, fc, _ = make_conn(transcript_msgs=finals("red"))
    conn.begin()
    assert conn.finish() == "red"
    conn.begin()
    assert conn.finish() == "red"  # second flush, fresh accumulator
    assert len(fc.sockets) == 1


def test_error_message_settles_and_reports():
    errors = []
    fc = FakeConnect(transcript_msgs=[{"type": "error", "message": "bad keyterm"}])
    conn = SttConnection("t", [], SttHandlers(on_error=errors.append), connect=fc, flush_timeout=2.0)
    assert wait_for(lambda: conn.opened)
    t0 = time.time()
    assert conn.finish() == ""
    assert time.time() - t0 < 1.0 and errors == ["bad keyterm"]


def test_refused_connection_is_reported_and_never_opened():
    errors, closes = [], []
    conn = SttConnection("t", [], SttHandlers(on_error=errors.append, on_close=closes.append), connect=FakeConnect(fail=True))
    assert wait_for(lambda: conn.closed)
    assert not conn.opened and closes == [1006] and errors
    assert conn.finish() == ""


def test_server_close_ends_reader_and_settles():
    conn, fc, _ = make_conn(transcript_msgs=[])
    fc.sockets[0].close()
    assert wait_for(lambda: conn.closed)
    assert conn.finish(timeout=0.1) == ""
    conn.send_audio(b"x")  # ignored after close, no raise


# ------------------------------------------------------------------------------------------- token
def test_mint_token_request_shape_and_errors():
    http = FakeHttp()
    tok = mint_token("sk-test", http, now=lambda: 100.0)
    method, url, headers, body = http.calls[0]
    assert (method, url) == ("POST", "https://api.cartesia.ai/access-token")
    assert headers["Authorization"] == "Bearer sk-test" and headers["Cartesia-Version"] == "2026-08-14"
    assert json.loads(body) == {"grants": {"stt": True, "tts": True}, "expires_in": 3600}
    assert tok.token == "tok-1" and "tok-1" not in repr(tok)
    with pytest.raises(TokenError) as e:
        mint_token("", http)
    assert e.value.reason == "key_missing"
    with pytest.raises(TokenError) as e:
        mint_token("k", FakeHttp(token_status=401))
    assert (e.value.reason, e.value.status) == ("upstream", 401)


def test_token_source_remints_after_45_minutes():
    clock = [0.0]
    src = TokenSource(lambda: "k", FakeHttp(), now=lambda: clock[0])
    a = src.get()
    clock[0] = REMINT_AFTER_S - 1
    assert src.get() is a and not src.due()
    clock[0] = REMINT_AFTER_S
    assert src.due()
    b = src.get()
    assert b.token != a.token
    assert needs_remint(None, 0)


def test_first_english_voice():
    assert first_english_voice("k", FakeHttp()) == "v-en"
    assert first_english_voice("k", FakeHttp(voices=[{"id": "x", "language": "de"}])) is None
    assert first_english_voice("", FakeHttp()) is None
