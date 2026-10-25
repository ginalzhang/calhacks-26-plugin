"""Cartesia Ink 2 streaming STT over the documented manual-finalize WebSocket (§8). Port of src/voice/sttClient.ts.

  wss://api.cartesia.ai/stt/websocket?model=ink-2&encoding=pcm_s16le&sample_rate=16000
    &cartesia_version=2026-08-14&access_token=<token>&keyterm=<phrase>&keyterm=<phrase>...

Audio: 100 ms binary pcm_s16le 16 kHz chunks. On mic close send the text "finalize"; ``transcript`` messages carry
``text`` as a delta: concatenate the ``is_final: true`` chunks, untrimmed, until ``flush_done`` (5 s timeout, then
finals + interim). No /stt/turns, no turn.* events. Keyterms are immutable per connection; the socket stays open
across utterances and is only replaced between utterances (new token / keyterms), never mid-utterance.

Threads: one reader thread per connection (connects, flushes queued audio, reads messages). ``send_audio`` may be
called from any thread; audio sent before the socket opens is queued, never dropped.
"""

from __future__ import annotations

import json
import threading
from typing import Any, Callable, List, Optional
from urllib.parse import quote

from .cartesia import CARTESIA_VERSION

STT_BASE = "wss://api.cartesia.ai/stt/websocket"
FLUSH_TIMEOUT_S = 5.0


def _enc(s: str) -> str:
    """encodeURIComponent: spaces -> %20."""
    return quote(s, safe="-_.!~*'()")


def build_stt_url(token: str, keyterms: List[str], base: str = STT_BASE) -> str:
    q = [
        "model=ink-2",
        "encoding=pcm_s16le",
        "sample_rate=16000",
        f"cartesia_version={CARTESIA_VERSION}",
        f"access_token={_enc(token)}",
    ]
    q += [f"keyterm={_enc(k)}" for k in keyterms]
    return f"{base}?{'&'.join(q)}"


def redact_url(url: str) -> str:
    """For logs: drop the access token."""
    import re

    return re.sub(r"access_token=[^&]*", "access_token=<redacted>", url)


def websockets_connect(url: str) -> Any:
    """Default factory: a websockets sync client (send/recv/close). Imported lazily."""
    from .cartesia import ws_connect

    return ws_connect(url, max_size=2**22)


class SttHandlers:
    def __init__(
        self,
        on_delta: Optional[Callable[[str, bool], None]] = None,
        on_error: Optional[Callable[[str], None]] = None,
        on_close: Optional[Callable[[int], None]] = None,
    ) -> None:
        self.on_delta = on_delta
        self.on_error = on_error
        self.on_close = on_close


class SttConnection:
    """One connection, many utterances: begin() -> send_audio()* -> finish() (returns the transcript)."""

    def __init__(
        self,
        token: str,
        keyterms: List[str],
        handlers: Optional[SttHandlers] = None,
        connect: Callable[[str], Any] = websockets_connect,
        flush_timeout: float = FLUSH_TIMEOUT_S,
        start: bool = True,
    ) -> None:
        self.url = build_stt_url(token, keyterms)
        self.handlers = handlers or SttHandlers()
        self._connect = connect
        self.flush_timeout = flush_timeout
        self._lock = threading.RLock()
        self._ws: Any = None
        self._queue: List[bytes] = []
        self._finalize_queued = False
        self._finals = ""
        self._interim = ""
        self._pending: Optional[threading.Event] = None
        self.closed = False
        self.opened = False  # a close before open = Cartesia unreachable/refused
        self.close_code: Optional[int] = None
        self._thread = threading.Thread(target=self._run, name="steady-stt", daemon=True)
        if start:
            self._thread.start()

    # ------------------------------------------------------------------ public
    def set_handlers(self, h: SttHandlers) -> None:
        self.handlers = h

    def begin(self) -> None:
        with self._lock:
            self._finals = ""
            self._interim = ""

    def send_audio(self, chunk: bytes) -> None:
        with self._lock:
            if self.closed:
                return
            if self._ws is not None:
                try:
                    self._ws.send(chunk)
                except Exception:
                    pass  # the reader thread sees the close
            else:
                self._queue.append(chunk)

    def finish(self, timeout: Optional[float] = None) -> str:
        """Mic closed: send "finalize"; return the concatenated finals once flush_done arrives (or on timeout)."""
        ev = threading.Event()
        with self._lock:
            if self.closed:
                return self.text()
            self._pending = ev
            if self._ws is not None:
                try:
                    self._ws.send("finalize")
                except Exception:
                    pass
            else:
                self._finalize_queued = True  # sent right after the queued audio on open
        ev.wait(self.flush_timeout if timeout is None else timeout)
        with self._lock:
            if self._pending is ev:
                self._pending = None
            text = self.text()
            self._interim = ""
            return text

    def close(self) -> None:
        with self._lock:
            if self.closed:
                return
            self.closed = True
            ws = self._ws
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass
        self._settle()

    def text(self) -> str:
        return self._finals + self._interim

    # ------------------------------------------------------------------ internals
    def _settle(self) -> None:
        with self._lock:
            ev = self._pending
            self._pending = None
        if ev is not None:
            ev.set()

    def _run(self) -> None:
        code = 1006
        try:
            ws = self._connect(self.url)
        except Exception as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            self._fail(f"Voice connection failed{f' ({status})' if status else ''}")
            return
        with self._lock:
            if self.closed:
                try:
                    ws.close()
                except Exception:
                    pass
                return
            self._ws = ws
            self.opened = True
            try:
                for b in self._queue:
                    ws.send(b)
                self._queue = []
                if self._finalize_queued:
                    self._finalize_queued = False
                    ws.send("finalize")
            except Exception:
                pass
        try:
            while True:
                msg = ws.recv()
                self._on_message(msg)
        except Exception as e:
            code = getattr(e, "code", None) or getattr(getattr(e, "rcvd", None), "code", None) or 1000
        with self._lock:
            self.closed = True
            self.close_code = int(code) if isinstance(code, int) else 1000
        self._settle()
        if self.handlers.on_close:
            self.handlers.on_close(self.close_code or 1000)

    def _fail(self, message: str) -> None:
        with self._lock:
            self.closed = True
            self.close_code = 1006
        if self.handlers.on_error:
            self.handlers.on_error(message)
        self._settle()
        if self.handlers.on_close:
            self.handlers.on_close(1006)

    def _on_message(self, data: Any) -> None:
        if not isinstance(data, str):
            return
        try:
            msg = json.loads(data)
        except ValueError:
            return
        if not isinstance(msg, dict):
            return
        typ = msg.get("type")
        if typ == "transcript":
            t = msg.get("text") if isinstance(msg.get("text"), str) else ""
            final = bool(msg.get("is_final"))
            with self._lock:
                if final:
                    self._finals += t  # deltas: concatenate, never trim or add spaces
                    self._interim = ""
                else:
                    self._interim = t
                full = self.text()
            if t and self.handlers.on_delta:
                self.handlers.on_delta(full, final)
        elif typ == "flush_done":
            with self._lock:
                self._interim = ""
            self._settle()
        elif typ == "error":
            if self.handlers.on_error:
                self.handlers.on_error(str(msg.get("message") or msg.get("title") or "Voice service error"))
            self._settle()
