"""Cartesia Sonic TTS (§8; P2b). Port of src/voice/ttsClient.ts for the tracker.

  wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14&access_token=<token>
  Request: {model_id: "sonic-3.6", transcript, voice: {mode: "id", id}, language: "en",
            output_format: {container: "raw", encoding: "pcm_s16le", sample_rate: 24000}, context_id,
            max_buffer_delay_ms: 300}
  Cancel:  {context_id, cancel: true} (sent when the mic opens).
Playback: raw pcm_s16le 24 kHz mono through a sounddevice callback OutputStream (opened lazily, closed when idle).
Speaks only when enabled (settings.tts), not in quiet mode, and never while the mic is open. Voice id:
CARTESIA_VOICE_ID, else the first English voice from GET /voices, else TTS reports "voice unavailable".

Threads: ``speak()`` returns at once; a short-lived "steady-tts" thread mints/opens/sends; one reader thread per
socket feeds the player; PortAudio's callback thread drains the player buffer.
"""

from __future__ import annotations

import base64
import json
import threading
import time
import uuid
from typing import Any, Callable, Optional

from .cartesia import CARTESIA_VERSION, TokenError, TokenSource
from .stt import _enc

TTS_MODEL = "sonic-3.6"
TTS_RATE = 24000
TTS_URL = "wss://api.cartesia.ai/tts/websocket"

STATUS_TEXT = {
    "ok": "",
    "off": "Spoken replies are off.",
    "key_missing": "Spoken replies need a Cartesia key (key missing).",
    "voice_unavailable": "Spoken replies: voice unavailable.",
    "error": "Spoken replies stopped working.",
}

CONFIRMATIONS = {
    "saved": ("Saved", False),
    "new_layer": ("New layer", False),
    "didnt_catch": ("Didn't catch that; I heard", True),
    "needs_plugin": ("That needs the Krita plugin", False),
    "skin_saved": ("Skin colour saved", False),
    "brush_named": ("Brush named", True),
    "word_taken": ("That word is taken", False),
}
HEARD_MAX_WORDS = 12


def confirmation_text(kind: str, heard: Optional[str] = None) -> Optional[str]:
    c = CONFIRMATIONS.get(kind)
    if not c:
        return None
    text, with_heard = c
    if not with_heard:
        return text
    h = " ".join((heard or "").split()[:HEARD_MAX_WORDS])
    if not h:
        return "Didn't catch that" if kind == "didnt_catch" else None
    return f"{text} {h}"


def build_tts_request(text: str, voice_id: str, context_id: str) -> dict:
    return {
        "model_id": TTS_MODEL,
        "transcript": text,
        "voice": {"mode": "id", "id": voice_id},
        "language": "en",
        "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": TTS_RATE},
        "context_id": context_id,
        "max_buffer_delay_ms": 300,
    }


def build_tts_url(token: str) -> str:
    return f"{TTS_URL}?cartesia_version={CARTESIA_VERSION}&access_token={_enc(token)}"


class SoundDevicePlayer:
    """Callback OutputStream fed from a byte buffer; ``stop()`` silences at once (no blocking write to abort)."""

    IDLE_CLOSE_S = 1.0

    def __init__(self, rate: int = TTS_RATE) -> None:
        self.rate = rate
        self._buf = bytearray()
        self._lock = threading.Lock()
        self._stream: Any = None
        self._idle_since: Optional[float] = None

    def play(self, pcm: bytes) -> None:
        if not pcm:
            return
        with self._lock:
            self._buf.extend(pcm)
            self._idle_since = None
            if self._stream is None or not getattr(self._stream, "active", False):
                self._open()

    def _open(self) -> None:
        import sounddevice as sd  # lazy: never imported by tests

        def cb(outdata, frames, _time, _status):  # PortAudio thread
            n = frames * 2
            with self._lock:
                chunk = bytes(self._buf[:n])
                del self._buf[:n]
                if not chunk:
                    now = time.monotonic()
                    if self._idle_since is None:
                        self._idle_since = now
                    elif now - self._idle_since > self.IDLE_CLOSE_S:
                        outdata[:] = b"\x00" * len(outdata)
                        raise sd.CallbackStop()
            outdata[: len(chunk)] = chunk
            if len(chunk) < len(outdata):
                outdata[len(chunk):] = b"\x00" * (len(outdata) - len(chunk))

        try:
            if self._stream is not None:
                try:
                    self._stream.close()
                except Exception:
                    pass
            self._stream = sd.RawOutputStream(samplerate=self.rate, channels=1, dtype="int16", callback=cb)
            self._stream.start()
        except Exception:
            self._stream = None
            self._buf.clear()

    def stop(self) -> None:
        with self._lock:
            self._buf.clear()

    def close(self) -> None:
        self.stop()
        s, self._stream = self._stream, None
        if s is not None:
            try:
                s.abort()
                s.close()
            except Exception:
                pass


class TtsClient:
    def __init__(
        self,
        tokens: TokenSource,
        voice_id: Callable[[], Optional[str]],
        socket: Optional[Callable[[str], Any]] = None,
        player: Optional[Callable[[], Any]] = None,
        on_status: Optional[Callable[[str, str], None]] = None,
        new_context_id: Callable[[], str] = lambda: f"steady-{uuid.uuid4().hex[:12]}",
        threaded: bool = True,
    ) -> None:
        self._tokens = tokens
        self._voice_id = voice_id
        self._socket_factory = socket
        self._player_factory = player or SoundDevicePlayer
        self._on_status = on_status
        self._new_context_id = new_context_id
        self._threaded = threaded
        self._lock = threading.RLock()
        self.enabled = True
        self.quiet = False
        self.mic_open = False
        self.status = "ok"
        self._ws: Any = None
        self._ws_token: Optional[str] = None
        self._player: Any = None
        self.context_id: Optional[str] = None
        self._gen = 0

    # ------------------------------------------------------------------ gating
    def _set_status(self, s: str) -> None:
        if s == self.status:
            return
        self.status = s
        if self._on_status and STATUS_TEXT.get(s):
            self._on_status(s, STATUS_TEXT[s])

    def allowed(self) -> bool:
        return self.enabled and not self.quiet and not self.mic_open

    def set_enabled(self, on: bool) -> None:
        self.enabled = bool(on)
        if not on:
            self.cancel()

    def set_quiet(self, q: bool) -> None:
        self.quiet = bool(q)
        if q:
            self.cancel()

    def set_mic_open(self, open_: bool) -> None:
        """The mic opened (push-to-talk start / Mic tile): stop speaking at once."""
        self.mic_open = bool(open_)
        if open_:
            self.cancel()

    def cancel(self) -> None:
        with self._lock:
            self._gen += 1
            cid, ws = self.context_id, self._ws
            self.context_id = None
            if self._player is not None:
                self._player.stop()
        if cid and ws is not None:
            try:
                ws.send(json.dumps({"context_id": cid, "cancel": True}))
            except Exception:
                pass

    # ------------------------------------------------------------------ speaking
    def speak_confirmation(self, kind: str, heard: Optional[str] = None) -> bool:
        text = confirmation_text(kind, heard)
        return self.speak(text) if text else False

    def speak(self, text: str) -> bool:
        """Returns False when it will not be spoken (off, quiet, mic open, empty). Never blocks on the network."""
        if not self.allowed() or not (text or "").strip():
            return False
        with self._lock:
            gen = self._gen
        if self._threaded:
            threading.Thread(target=self._speak_job, args=(text.strip(), gen), name="steady-tts", daemon=True).start()
        else:
            self._speak_job(text.strip(), gen)
        return True

    def _speak_job(self, text: str, gen: int) -> None:
        try:
            tok = self._tokens.get()
        except TokenError as e:
            self._set_status("key_missing" if e.reason == "key_missing" else "error")
            return
        vid = self._voice_id()
        if not vid:
            self._set_status("voice_unavailable")
            return
        if not self.allowed() or gen != self._gen:
            return  # mic opened / cancelled while minting
        self.cancel()
        with self._lock:
            gen = self._gen
        ws = self._socket(tok.token)
        if ws is None:
            self._set_status("error")
            return
        with self._lock:
            if not self.allowed() or gen != self._gen:
                return
            cid = self._new_context_id()
            self.context_id = cid
        self._set_status("ok")
        try:
            ws.send(json.dumps(build_tts_request(text, vid, cid)))
        except Exception:
            self._set_status("error")

    def _socket(self, token: str) -> Any:
        with self._lock:
            if self._ws is not None and self._ws_token == token:
                return self._ws
            old, self._ws = self._ws, None
        if old is not None:
            try:
                old.close()
            except Exception:
                pass
        try:
            factory = self._socket_factory
            if factory is None:
                from .cartesia import ws_connect

                factory = lambda u: ws_connect(u, max_size=2**24)  # noqa: E731
            ws = factory(build_tts_url(token))
        except Exception:
            return None
        with self._lock:
            self._ws = ws
            self._ws_token = token
        threading.Thread(target=self._reader, args=(ws,), name="steady-tts-reader", daemon=True).start()
        return ws

    def _reader(self, ws: Any) -> None:
        try:
            while True:
                self.on_message(ws.recv())
        except Exception:
            pass
        with self._lock:
            if self._ws is ws:
                self._ws = None
                self._ws_token = None

    def on_message(self, data: Any) -> None:
        if not isinstance(data, str):
            return
        try:
            m = json.loads(data)
        except ValueError:
            return
        if not isinstance(m, dict) or not m.get("context_id") or m.get("context_id") != self.context_id:
            return  # cancelled or stale
        if m.get("type") == "chunk" and isinstance(m.get("data"), str):
            if not self.allowed():
                return
            try:
                pcm = base64.b64decode(m["data"])
            except Exception:
                return
            with self._lock:
                if self._player is None:
                    self._player = self._player_factory()
                player = self._player
            player.play(pcm)
        elif m.get("type") == "error":
            self._set_status("error")

    def shutdown(self) -> None:
        self.cancel()
        with self._lock:
            ws, self._ws = self._ws, None
            p = self._player
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass
        if p is not None and hasattr(p, "close"):
            p.close()
