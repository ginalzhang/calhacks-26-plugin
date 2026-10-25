"""Fakes for the voice tests (tracker/tests/test_voice_*.py) and for C's integration tests: no microphone, no
audio output, no network. Never imported by the runtime code."""

from __future__ import annotations

import json
import queue
import threading


class Closed(Exception):
    code = 1000


class FakeWs:
    """Stands in for a websockets sync ClientConnection. ``on_finalize`` = messages pushed when "finalize" arrives."""

    def __init__(self, on_finalize=None):
        self.sent = []
        self._q: "queue.Queue" = queue.Queue()
        self.closed = False
        self.on_finalize = list(on_finalize or [])

    def send(self, data):
        if self.closed:
            raise Closed()
        self.sent.append(data)
        if data == "finalize":
            for m in self.on_finalize:
                self.push(m)

    def push(self, msg):
        self._q.put(json.dumps(msg) if isinstance(msg, dict) else msg)

    def recv(self, timeout=None):
        m = self._q.get()
        if m is Closed:
            raise Closed()
        return m

    def close(self):
        if not self.closed:
            self.closed = True
            self._q.put(Closed)

    @property
    def audio(self):
        return [s for s in self.sent if isinstance(s, (bytes, bytearray))]

    @property
    def texts(self):
        return [s for s in self.sent if isinstance(s, str)]


class FakeConnect:
    """Factory for SttConnection(connect=...). ``gate`` (threading.Event) delays the open."""

    def __init__(self, transcript_msgs=None, gate=None, fail=False):
        self.transcript_msgs = transcript_msgs or []
        self.gate = gate
        self.fail = fail
        self.urls = []
        self.sockets = []

    def __call__(self, url):
        self.urls.append(url)
        if self.gate is not None:
            self.gate.wait(5)
        if self.fail:
            raise OSError("refused")
        ws = FakeWs(on_finalize=self.transcript_msgs)
        self.sockets.append(ws)
        return ws


def finals(*parts):
    msgs = [{"type": "transcript", "text": p, "is_final": True} for p in parts]
    return msgs + [{"type": "flush_done"}]


class FakeHttp:
    def __init__(self, token_status=200, voices=None):
        self.calls = []
        self.token_status = token_status
        self.voices = voices if voices is not None else [{"id": "v-fr", "language": "fr"}, {"id": "v-en", "language": "en"}]
        self.n = 0

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append((method, url, dict(headers), body))
        if url.endswith("/access-token"):
            self.n += 1
            if self.token_status != 200:
                return self.token_status, b"{}"
            return 200, json.dumps({"token": f"tok-{self.n}"}).encode()
        if "/voices" in url:
            return 200, json.dumps({"data": self.voices}).encode()
        return 404, b""


class FakeMic:
    instances = []

    def __init__(self, rate=48000.0, fail=None):
        self.rate = rate
        self.fail = fail
        self.started = False
        self.stopped = False
        self.cb = None
        FakeMic.instances.append(self)

    def start(self, on_frames):
        if self.fail:
            raise self.fail
        self.started = True
        self.cb = on_frames
        return self.rate, 1

    def stop(self):
        self.stopped = True


class FakeInterpreter:
    def __init__(self, response=None):
        self.calls = []
        self.response = response or {"kind": "noop", "latencyMs": 5, "mock": False}

    def interpret(self, text, context):
        self.calls.append((text, context))
        return dict(self.response)

    def prewarm(self):
        return {"ok": True}


class FakePlayer:
    def __init__(self):
        self.played = []
        self.stops = 0

    def play(self, pcm):
        self.played.append(pcm)

    def stop(self):
        self.stops += 1

    def close(self):
        pass


class NoSoundDevice:
    """Installed as sys.modules['sounddevice'] in tests: any use fails loudly."""

    def __getattr__(self, name):
        raise AssertionError(f"tests must never touch sounddevice ({name})")


class Recorder:
    def __init__(self):
        self.items = []
        self.lock = threading.Lock()

    def __call__(self, *args):
        with self.lock:
            self.items.append(args if len(args) != 1 else args[0])
