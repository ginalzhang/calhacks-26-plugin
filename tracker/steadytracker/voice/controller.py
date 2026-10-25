"""VoiceController: the tracker's voice front door (agent E). Agent C constructs one and calls it.

    vc = VoiceController(parse, dispatch, status, heard, speak_enabled, settings_getter, keys,
                         dialog=..., dialog_open=..., context_getter=..., on_mic=..., on_listening=..., on_level=...)
      parse(text, opts) -> ParseResult        brain {t:"parse"} round trip (blocking, from voice threads)
      dispatch(action, variant, arg, source)  -> brain {t:"action", ..., source: "voice"|"typed"|"claude"};
                                              several commands are sent 50 ms apart by us; a coalesced
                                              {undo, arg N} is sent once (the brain spaces the N undos)
      status(text, level)                     -> panel {t:"status"}
      heard(text, via)                        -> panel {t:"heard", via: "grammar"|"claude"}
      speak_enabled() -> bool                 extra TTS gate (settings.tts is also honoured)
      settings_getter() -> SteadySettings     dict (alwaysListen, utteranceEndMs, micSilenceMs, micCapMs, quiet,
                                              tts, inputs.voice, steadiness)
      keys                                    dict/obj/callable with CARTESIA_API_KEY, ANTHROPIC_API_KEY,
                                              CARTESIA_VOICE_ID (see keys.load_keys)
      dialog(msg)                             -> panel: {t:"dialog", dialog_id:"v-dlg-N", kind:"clarify", text,
                                              options} or {t:"dialog_close", dialog_id} (Claude clarify)
      dialog_open() -> bool                   True while a *brain* dialog (b-dlg-*) is open; omitted -> the brain
                                              decides dialogOpen inside parse
      on_mic(open, reason)                    the explicit mic (tile / F10) really opened/closed -> brain
                                              {t:"action", action:"mic", variant:"opened"|"closed", source:"system"}
      on_listening(listening)                 always-listening stream opened/closed. NOT a brain mic event (it must
                                              not lift the pen, and the brain's micOpen must stay false so F10 and
                                              the Mic tile still work): show it on the panel ("Listening").
    vc.open("tile" | "ptt")      # brain {t:"mic", open:true, reason}
    vc.close()                   # brain {t:"mic", open:false} / F10 up -> finalize -> grammar -> Claude -> dispatch
    vc.toggle()                  # tap semantics
    vc.on_brain_mic(open, reason)  # brain {t:"mic"} message as is, reason "ptt"|"tile"|"quiet"|"dialog"
    vc.set_quiet(True)           # quiet mode: mic and always-listening closed (no transcript), TTS off
    vc.on_settings(settings)     # SteadySettings (partial ok); alwaysListen on/off opens/closes the stream
    vc.speak(text)               # brain {t:"speak"}: only when enabled, not quiet, mic closed, nobody talking
    vc.submit_text(text)         # panel {t:"typed"}: same resolution path, async
    vc.dialog_answer(dialog_id, answer) -> bool  # panel {t:"dialog_answer"}; True if it was our v-dlg-* dialog
    vc.resolve_text(text, mode)  # synchronous resolution (returns the Resolution dict; no dispatch)
    vc.listening                 # True while the always-listening stream is open
    vc.shutdown()

Explicit mic close rules (§8, micpolicy.py + vad.py): tap mode closes on the next tap, after
settings.utteranceEndMs (default 450 ms) of silence once the local VAD heard speech, or (fallback when the VAD
never heard speech but transcript deltas / short sounds were seen) after settings.micSilenceMs; at
settings.micCapMs from speech onset; push-to-talk closes on release only; no onset timeout anywhere.

Always-listening (settings.alwaysListen, opt-in): the input stream stays open while not quiet and voice input is
on. A local VAD (20 ms frames, adaptive noise floor, hysteresis, 200 ms to start, 300 ms pre-roll) opens an
utterance; only then are the pre-roll and live 100 ms chunks sent to the one warm Cartesia socket; after
utteranceEndMs of silence (or micCapMs) "finalize" -> transcript -> brain grammar -> dispatch. Nothing is sent
while nobody speaks. Grammar only: no Claude call for ambient speech (it would act on, and send off-machine,
conversation that was never meant for Steady). Capture is muted while TTS speaks + 300 ms. The pen is not lifted.
Tile / F10 temporarily take over the mic and hand it back afterwards.

Threads (all daemon): "steady-voice" (owns all mic/STT state; every public method only enqueues; 100 ms tick),
PortAudio's input callback (enqueues raw frames), "steady-stt" reader per Cartesia socket, "steady-voice-finish"
per utterance (finalize + resolve + dispatch, so the Claude call never blocks the mic), "steady-tts" per line
spoken. Callbacks are invoked from these threads: C must make them thread-safe (e.g. post to its own loop).
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from typing import Any, Callable, Dict, List, Mapping, Optional

from .audio import CaptureProcessor, Chunker, float32_bytes_to_list
from .cartesia import CartesiaToken, TokenError, TokenSource, first_english_voice, urllib_http
from .claude import ClaudeInterpreter, ClaudeLog
from .keys import key as read_key
from .keyterms import stt_keyterms
from .mic import MicError, SoundDeviceMic
from .micpolicy import VOICE_LEVEL, MicTiming, auto_close_reason, new_mic_timing, note_activity
from .resolve import Resolver
from .stt import SttConnection, SttHandlers, websockets_connect
from .tts import TtsClient, confirmation_text
from .vad import DEFAULT_END_MS, FRAME_MS, FRAME_SAMPLES, PREROLL_MS, START_MS, PreRoll, Vad, clamp_end_ms

log = logging.getLogger("steady.voice")  # timings and states only: never keys, tokens, audio or transcripts

DEFAULT_SILENCE_MS = 2000
DEFAULT_CAP_MS = 15000
TICK_S = 0.1
COMMAND_GAP_S = 0.05  # "blue bigger": commands of one utterance go to the brain 50 ms apart
CHOICE_INDEX = {"choice_one": 0, "choice_two": 1, "choice_three": 2}
CHOICE_WORDS = ["One", "Two", "Three"]
IDLE_RECONNECT_MS = 5 * 60 * 1000  # always-listening: replace a socket idle this long (between utterances)
RECONNECT_BACKOFF_MS = 2000
ALWAYS_WARMUP_MS = 200  # learn the room's noise floor when the stream opens

MSG = {
    "listening": "Listening…",
    "always_on": "Listening for commands (always on).",
    "always_off": "Always listening off.",
    "no_cartesia_key": "Voice needs a Cartesia key (key missing). Use the tiles or type the command.",
    "token_failed": "Voice is unavailable (no connection to the voice service). Tiles, keys and the typed box still work.",
    "unreachable": "Couldn't reach the voice service. Tiles, keys and the typed box still work.",
    "nothing": "Didn't hear anything.",
    "cap_nothing": "Mic closed at the time limit. Didn't hear a command.",
    "quiet": "Quiet mode: mic off.",
    "voice_off": "Voice input is off in Settings. Tiles, keys and the typed box still work.",
    "no_device": "No microphone found. Tiles, keys and the typed box still work.",
    "mic_failed": "The microphone could not be opened. Allow Steady Tracker in System Settings › Privacy & Security › Microphone. Tiles, keys and the typed box still work.",
}


def _get(settings: Any, name: str, default: Any = None) -> Any:
    if settings is None:
        return default
    if isinstance(settings, Mapping):
        return settings.get(name, default)
    return getattr(settings, name, default)


def _as_callable(v: Any) -> Callable[[], Any]:
    return v if callable(v) else (lambda: v)


class VoiceController:
    def __init__(
        self,
        parse: Callable[[str, Dict[str, Any]], Dict[str, Any]],
        dispatch: Callable[[str, Optional[str], Optional[float], str], None],
        status: Callable[[str, str], None],
        heard: Callable[[str, str], None],
        speak_enabled: Any,
        settings_getter: Callable[[], Any],
        keys: Any,
        *,
        dialog: Optional[Callable[[Dict[str, Any]], None]] = None,
        context_getter: Optional[Callable[[], Dict[str, Any]]] = None,
        dialog_open: Optional[Callable[[], bool]] = None,
        aliases_getter: Optional[Callable[[], Optional[Dict[str, str]]]] = None,
        on_mic: Optional[Callable[[bool, str], None]] = None,
        on_listening: Optional[Callable[[bool], None]] = None,
        on_level: Optional[Callable[[float, float], None]] = None,
        # --- injection points (tests); defaults are the real devices/services
        mic_factory: Optional[Callable[[], Any]] = None,
        stt_connect: Optional[Callable[[str], Any]] = None,
        http: Optional[Callable[..., Any]] = None,
        interpreter: Optional[Any] = None,
        claude_log: Optional[ClaudeLog] = None,
        tts: Optional[TtsClient] = None,
        keyterms: Optional[List[str]] = None,
        now_ms: Optional[Callable[[], float]] = None,
        sleep: Callable[[float], None] = time.sleep,
        threaded: bool = True,
        prewarm: bool = True,
    ) -> None:
        self._parse = parse
        self._dispatch = dispatch
        self._status = status
        self._heard = heard
        self._speak_enabled = _as_callable(speak_enabled)
        self._settings = settings_getter
        self._keys = keys
        self._context = context_getter or (lambda: {"steadiness": _get(self._settings(), "steadiness", 50)})
        self._dialog_cb = dialog
        self._dialog_open = dialog_open  # None: the brain decides dialogOpen
        self._sleep = sleep
        self._clarify: Optional[Dict[str, Any]] = None
        self._clarify_seq = 0
        self._clarify_lock = threading.RLock()
        self._last_via: Optional[str] = None
        self._aliases = aliases_getter or (lambda: None)
        self._on_mic = on_mic
        self._on_listening = on_listening
        self._on_level = on_level
        self._mic_factory = mic_factory or SoundDeviceMic
        self._stt_connect = stt_connect or websockets_connect
        self._http = http or urllib_http
        self._now_ms = now_ms or (lambda: time.monotonic() * 1000.0)
        self._threaded = threaded

        self.tokens = TokenSource(lambda: read_key(self._keys, "CARTESIA_API_KEY"), self._http)
        self.keyterms = list(keyterms) if keyterms is not None else stt_keyterms()
        self.interpreter = interpreter or ClaudeInterpreter(lambda: read_key(self._keys, "ANTHROPIC_API_KEY"))
        self.resolver = Resolver(self._parse, self.interpreter, claude_log or ClaudeLog())
        self._voice_id_cache: Optional[tuple] = None
        self.tts = tts or TtsClient(self.tokens, self._voice_id, on_status=lambda _s, t: self._status(t, "status"), now_ms=self._now_ms)

        # explicit mic (tile / F10), owned by the voice thread
        self.is_open = False
        self.quiet = bool(_get(self._safe(self._settings, None), "quiet", False))
        self.mode: Optional[str] = None
        self.timing: Optional[MicTiming] = None
        self._mic: Any = None
        self._proc: Optional[CaptureProcessor] = None
        self._chunker = Chunker()
        self._vad: Optional[Vad] = None
        # always-listening
        self.listening = False
        self._amic: Any = None
        self._aproc: Optional[CaptureProcessor] = None
        self._agen = 0
        self._avad: Optional[Vad] = None
        self._apreroll = PreRoll(PREROLL_MS + START_MS)
        self._achunker = Chunker()
        self._utt: Optional[Dict[str, Any]] = None  # live always-mode utterance
        self._waiting: List[Dict[str, Any]] = []  # ended utterances whose socket was still busy
        self._last_utt_ms = 0.0
        self._next_reconnect_ms = 0.0
        self.utterances = 0  # always-mode utterances sent to Cartesia (tests/metrics)
        # sockets
        self._conn: Optional[SttConnection] = None
        self._conn_token: Optional[CartesiaToken] = None
        self._busy_conns: set = set()
        self._cartesia_broken = False
        self._finishers: List[threading.Thread] = []
        self._stopped = False

        self.tts.set_quiet(self.quiet)
        self.tts.set_enabled(self._tts_enabled())

        self._q: "queue.Queue[tuple]" = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        if threaded:
            self._thread = threading.Thread(target=self._loop, name="steady-voice", daemon=True)
            self._thread.start()
            if prewarm:
                threading.Thread(target=self._prewarm, name="steady-voice-prewarm", daemon=True).start()
        self._post(("sync",))

    # ================================================================== public API (any thread)
    def open(self, reason: str = "tile") -> None:
        self._post(("open", "ptt" if reason == "ptt" else "tap", reason))

    def close(self) -> None:
        self._post(("close", None))

    def toggle(self) -> None:
        self._post(("toggle",))

    def cancel(self) -> None:
        self._post(("cancel", None))

    def on_brain_mic(self, open_: bool, reason: str) -> None:
        if open_:
            self.open(reason)
        elif reason == "quiet":
            self._post(("cancel", MSG["quiet"]))
        else:
            self.close()

    def set_quiet(self, quiet: bool) -> None:
        self._post(("quiet", bool(quiet)))

    def on_settings(self, settings: Any) -> None:
        self._post(("settings", settings))

    def speak(self, text: str) -> bool:
        if self.is_open or self._utt is not None or self.quiet or not self._tts_enabled():
            return False
        return self.tts.speak(text)

    def claude_enabled(self) -> bool:
        """settings.claudeFallback (default OFF since 19:10 Sat, user decision: Cartesia hears, Steady's own grammar
        decides; nothing goes to Anthropic unless the user turns this on)."""
        return bool(_get(self._safe(self._settings, None), "claudeFallback", False))

    def resolve_text(self, text: str, mode: str = "typed", allow_claude: bool = True) -> Dict[str, Any]:
        allow_claude = allow_claude and self.claude_enabled()
        mine = self._clarify is not None
        ext = self._safe(self._dialog_open, False) if self._dialog_open is not None else None
        dialog_open = True if (mine or ext) else (False if ext is not None else None)
        return self.resolver.resolve(
            text,
            mode=mode,
            dialog_open=dialog_open,
            context=self._safe(self._context, {}),
            aliases=self._safe(self._aliases, None),
            on_status=self._status,
            allow_claude=allow_claude,
        )

    @property
    def clarify_open(self) -> bool:
        return self._clarify is not None

    def dialog_answer(self, dialog_id: str, answer: str) -> bool:
        """Panel answered a dialog. Returns False (not ours) for the brain's b-dlg-* dialogs."""
        with self._clarify_lock:
            c = self._clarify
            if c is None or c["id"] != dialog_id:
                return False
            self._clarify = None
        self._answer_clarify(c, answer, from_panel=True)
        return True

    def submit_text(self, text: str, mode: str = "typed") -> None:
        """Typed box: resolve off-thread, then heard() + dispatch()."""
        if self._threaded:
            threading.Thread(target=self._resolve_and_dispatch, args=(text, mode), name="steady-voice-typed", daemon=True).start()
        else:
            self._resolve_and_dispatch(text, mode)

    def claude_undone(self) -> None:
        self.resolver.mark_last_rejected()

    def tick(self) -> None:
        """Auto-close / socket upkeep; the voice thread calls this every 100 ms (tests call it when threaded=False)."""
        self._post(("tick",))

    def shutdown(self) -> None:
        self._post(("shutdown",))
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        for th in list(self._finishers):
            th.join(timeout=0.1)

    # ================================================================== internals
    def _post(self, cmd: tuple) -> None:
        if self._threaded:
            self._q.put(cmd)
        else:
            self._handle(cmd)

    def _loop(self) -> None:
        next_tick = time.monotonic() + TICK_S
        while not self._stopped:
            try:
                cmd = self._q.get(timeout=max(0.0, next_tick - time.monotonic()))
            except queue.Empty:
                cmd = ("tick",)
            if time.monotonic() >= next_tick:
                next_tick = time.monotonic() + TICK_S
                if cmd[0] != "tick":
                    self._safe_handle(("tick",))
            self._safe_handle(cmd)

    def _safe_handle(self, cmd: tuple) -> None:
        try:
            self._handle(cmd)
        except Exception as e:  # never let the voice thread die; release the mic
            try:
                self._stop_mic()
                self._finish_open()
                self._stop_always(report=True, utt="cancel")
            except Exception:
                pass
            self._status(f"Voice error: {e.__class__.__name__}. Tiles, keys and the typed box still work.", "alert")

    @staticmethod
    def _safe(fn: Callable[[], Any], default: Any) -> Any:
        try:
            return fn()
        except Exception:
            return default

    def _setting(self, name: str, default: Any, latest: Any = None) -> Any:
        v = _get(latest, name, None) if latest is not None else None
        if v is None:
            v = _get(self._safe(self._settings, None), name, None)
        return default if v is None else v

    def _end_ms(self) -> int:
        return clamp_end_ms(self._setting("utteranceEndMs", DEFAULT_END_MS))

    def _cap_ms(self) -> float:
        return float(self._setting("micCapMs", DEFAULT_CAP_MS) or DEFAULT_CAP_MS)

    def _tts_enabled(self) -> bool:
        s = self._safe(self._settings, None)
        return bool(self._safe(self._speak_enabled, True)) and bool(_get(s, "tts", True))

    def _voice_enabled(self, latest: Any = None) -> bool:
        inputs = self._setting("inputs", None, latest)
        return bool(_get(inputs, "voice", True)) if inputs is not None else True

    def _voice_id(self) -> Optional[str]:
        env = read_key(self._keys, "CARTESIA_VOICE_ID")
        if env:
            return env
        api = read_key(self._keys, "CARTESIA_API_KEY")
        if self._voice_id_cache and self._voice_id_cache[0] == api:
            return self._voice_id_cache[1]
        vid = first_english_voice(api, self._http)
        self._voice_id_cache = (api, vid)
        return vid

    def _prewarm(self) -> None:
        try:
            self.tokens.get()
        except Exception:
            pass
        if self.claude_enabled():
            try:
                self.interpreter.prewarm()
            except Exception:
                pass

    def _handle(self, cmd: tuple) -> None:
        op = cmd[0]
        if op == "aaudio":
            self._do_always_audio(cmd[1], cmd[2])
        elif op == "audio":
            self._do_audio(cmd[1])
        elif op == "open":
            self._do_open(cmd[1], cmd[2])
        elif op == "close":
            self._do_close(cmd[1] or ("ptt" if self.mode == "ptt" else "tap"))
        elif op == "toggle":
            if self.is_open:
                self._do_close("tap")
            else:
                self._do_open("tap", "tile")
        elif op == "cancel":
            self._do_cancel(cmd[1])
        elif op == "activity":
            if self.is_open and self.timing is not None:
                self.timing = note_activity(self.timing, self._now_ms())
        elif op == "tick":
            self._do_tick()
        elif op == "conn_free":
            self._do_conn_free(cmd[1])
        elif op == "sync":
            self._sync_always()
        elif op == "quiet":
            self.quiet = cmd[1]
            self.tts.set_quiet(self.quiet)
            if self.quiet and self.is_open:
                self._do_cancel(MSG["quiet"])
            self._sync_always()
        elif op == "settings":
            s = cmd[1]
            q = _get(s, "quiet", None)
            if q is not None and bool(q) != self.quiet:
                self.quiet = bool(q)
                self.tts.set_quiet(self.quiet)
                if self.quiet and self.is_open:
                    self._do_cancel(MSG["quiet"])
            tts_val = _get(s, "tts", None)
            if tts_val is None:
                self.tts.set_enabled(self._tts_enabled())
            else:
                self.tts.set_enabled(bool(tts_val) and bool(self._safe(self._speak_enabled, True)))
            if not self._voice_enabled(s) and self.is_open:
                self._do_cancel(MSG["voice_off"])
            if self._avad is not None:
                self._avad.end_ms = clamp_end_ms(self._setting("utteranceEndMs", DEFAULT_END_MS, s))
            self._sync_always(s)
        elif op == "shutdown":
            self._stopped = True
            self._stop_mic()
            self._finish_open()
            self._stop_always(report=True, utt="cancel")
            if self._conn is not None:
                self._conn.close()
                self._conn = None
            self.tts.shutdown()

    # ------------------------------------------------------------------ sockets
    def _ensure_conn(self) -> Optional[SttConnection]:
        """The one warm socket; minted/replaced only between utterances. None when no token."""
        try:
            tok = self.tokens.get()
        except TokenError as e:
            self._status(MSG["no_cartesia_key"] if e.reason == "key_missing" else MSG["token_failed"], "status" if e.reason == "key_missing" else "alert")
            return None
        conn = self._conn
        if conn is not None and conn in self._busy_conns:
            return conn  # still finishing the previous utterance: the caller waits for it
        if conn is None or conn.closed or self._conn_token is None or self._conn_token.token != tok.token:
            if conn is not None:
                conn.close()
            conn = SttConnection(tok.token, self.keyterms, self._stt_handlers(), connect=self._stt_connect)
            self._conn = conn
            self._conn_token = tok
        else:
            conn.set_handlers(self._stt_handlers())
        return conn

    def _stt_handlers(self) -> SttHandlers:
        def on_delta(full: str, _final: bool) -> None:
            self._post(("activity",))
            # Live partials only for an explicit Mic/F10 utterance; always-listening hears the room, so nothing
            # partial is shown (the final text appears only if it is a command).
            if self.is_open:
                self._status(f"Heard: {full}…", "status")

        def on_error(m: str) -> None:
            self._status(f"Voice: {m}", "alert")

        return SttHandlers(on_delta=on_delta, on_error=on_error, on_close=lambda _c: None)

    def _start_finish(self, conn: SttConnection, why: str, always: bool) -> None:
        self._busy_conns.add(conn)
        if self._threaded:
            th = threading.Thread(target=self._finish_utterance, args=(conn, why, always), name="steady-voice-finish", daemon=True)
            self._finishers = [t for t in self._finishers if t.is_alive()] + [th]
            th.start()
        else:
            self._finish_utterance(conn, why, always)

    def _do_conn_free(self, conn: SttConnection) -> None:
        self._busy_conns.discard(conn)
        if self.tokens.due() or conn.closed or conn is not self._conn:
            # between utterances: drop a socket whose token is due, or one replaced while it was finishing
            conn.close()
            if self._conn is conn:
                self._conn = None
                self._conn_token = None
        # Always-mode speech that started while this socket was finishing: send it now, oldest first.
        if self._waiting:
            w = self._waiting.pop(0)
            self._release_waiting(w)
            self._start_finish(w["conn"], w["ended"] or "end", True)
            return  # the socket is busy again; the live utterance (if any) waits for the next conn_free
        utt = self._utt
        if utt is not None and utt.get("wait"):
            self._release_waiting(utt)

    def _release_waiting(self, utt: Dict[str, Any]) -> None:
        conn = utt["conn"]
        if conn.closed:
            conn = self._ensure_conn()
            if conn is None:
                utt["pending"] = []
                return
            utt["conn"] = conn
        conn.begin()
        for c in utt["pending"]:
            conn.send_audio(c)
        utt["pending"] = []
        utt["wait"] = False

    # ------------------------------------------------------------------ always-listening
    def _always_wanted(self, latest: Any = None) -> bool:
        return (
            bool(self._setting("alwaysListen", False, latest))
            and not self.quiet
            and self._voice_enabled(latest)
            and bool(read_key(self._keys, "CARTESIA_API_KEY"))
            and not self.is_open
            and not self._stopped
        )

    def _sync_always(self, latest: Any = None) -> None:
        want = self._always_wanted(latest)
        if want and not self.listening:
            self._start_always()
        elif not want and self.listening:
            off = not bool(self._setting("alwaysListen", False, latest)) or self.quiet or not self._voice_enabled(latest)
            self._stop_always(report=True, utt="cancel" if off else "finish")
            if off and not self.quiet:
                self._status(MSG["always_off"], "status")

    def _start_always(self) -> None:
        mic = self._mic_factory()
        self._agen += 1
        gen = self._agen
        cb = (lambda raw: self._q.put(("aaudio", raw, gen))) if self._threaded else (lambda raw: self._handle(("aaudio", raw, gen)))
        try:
            rate, channels = mic.start(cb)
        except MicError as e:
            self._status(MSG["no_device"] if e.kind == "no_device" else MSG["mic_failed"], "alert")
            return
        except Exception:
            self._status(MSG["mic_failed"], "alert")
            return
        self._amic = mic
        self._aproc = CaptureProcessor(rate, channels, frame_samples=FRAME_SAMPLES)
        if self._avad is None:
            self._avad = Vad(self._end_ms(), warmup_ms=ALWAYS_WARMUP_MS)
        else:
            self._avad.reset()
            self._avad.end_ms = self._end_ms()
        self._apreroll.drain()
        self._achunker.reset()
        self.listening = True
        log.info("always-listening on (rate %.0f Hz, utteranceEndMs %d)", rate, self._avad.end_ms)
        self._last_utt_ms = self._now_ms()
        self._ensure_conn()  # warm the socket now, so the first command doesn't wait for a handshake
        if self._on_listening:
            self._on_listening(True)
        self._status(MSG["always_on"], "status")

    def _stop_always(self, report: bool, utt: str = "finish") -> None:
        if not self.listening and self._amic is None:
            return
        mic, self._amic = self._amic, None
        self._agen += 1  # frames still queued from this stream are dropped
        if mic is not None:
            mic.stop()
        self._aproc = None
        cur = self._utt
        if cur is not None:
            if utt == "finish":
                self._end_utt("closed")
            else:
                self._utt = None
                self._achunker.reset()
                if not cur.get("wait") and cur["conn"] is not None:
                    cur["conn"].close()  # audio already sent must never leak into a later utterance
                    if self._conn is cur["conn"]:
                        self._conn = None
                        self._conn_token = None
        if utt == "cancel":
            self._waiting = []
        self._apreroll.drain()
        was = self.listening
        self.listening = False
        if was:
            log.info("always-listening off (%s)", utt)
        if report and was and self._on_listening:
            self._on_listening(False)

    def _do_always_audio(self, raw: bytes, gen: int) -> None:
        if not self.listening or gen != self._agen or self._aproc is None or self._avad is None:
            return
        frames = self._aproc.process(float32_bytes_to_list(raw))
        if self.tts.muted(self._now_ms()) and self._utt is None:
            # Our own voice must never become a command: drop the frames (and the pre-roll) while we speak.
            self._apreroll.drain()
            self._avad.reset()
            return
        vad = self._avad
        cap = self._cap_ms()
        for f in frames:
            if self._on_level:
                self._on_level(f.level, f.meter)
            ev = vad.update(f.level)
            if self._utt is None:
                self._apreroll.add(f.pcm)
                if ev == "start":
                    self._begin_utt()
                continue
            self._utt_add(f.pcm)
            self._utt["ms"] += FRAME_MS
            if ev == "end":
                self._end_utt("end")
            elif self._utt["ms"] >= cap:
                vad.force_end(capped=True)
                self._end_utt("cap")

    def _begin_utt(self) -> None:
        conn = self._ensure_conn()
        if conn is None:
            self._apreroll.drain()
            return
        wait = conn in self._busy_conns
        utt = {"conn": conn, "pending": [], "wait": wait, "ms": START_MS, "ended": None}
        if not wait:
            conn.begin()
        self._utt = utt
        self.utterances += 1
        self._achunker.reset()
        for pcm in self._apreroll.drain():
            self._utt_add(pcm)
        self._status(MSG["listening"], "status")

    def _utt_add(self, pcm: bytes) -> None:
        utt = self._utt
        if utt is None:
            return
        for c in self._achunker.add(pcm):
            if utt["wait"]:
                utt["pending"].append(c)
            else:
                utt["conn"].send_audio(c)

    def _end_utt(self, why: str) -> None:
        utt, self._utt = self._utt, None
        self._achunker.reset()
        self._last_utt_ms = self._now_ms()
        if utt is None:
            return
        if utt["wait"]:
            utt["ended"] = why
            self._waiting.append(utt)
            return
        log.info("utterance end (%s) after %d ms of audio", why, utt["ms"])
        self._start_finish(utt["conn"], why, True)

    # ------------------------------------------------------------------ explicit mic: open
    def _refuse_open(self, message: str, level: str = "status") -> None:
        # The brain may already think the mic is open (it sent {t:"mic", open:true}): tell it it is not.
        if self._on_mic:
            self._on_mic(False, "refused")
        self._status(message, level)

    def _do_open(self, mode: str, reason: str) -> None:
        if self.quiet:
            self._refuse_open(MSG["quiet"])
            return
        if not self._voice_enabled():
            self._refuse_open(MSG["voice_off"])
            return
        if self.is_open:
            if self.timing is not None and mode != self.timing.mode:
                self.timing = MicTiming(mode=mode, speech_start_at=self.timing.speech_start_at, last_activity_at=self.timing.last_activity_at)
                self.mode = mode
            return
        if not read_key(self._keys, "CARTESIA_API_KEY"):
            self._refuse_open(MSG["no_cartesia_key"])
            return
        # Tile / F10 take the mic over from always-listening (an utterance in flight is finished first).
        self._stop_always(report=False, utt="finish")
        self.is_open = True
        self.mode = mode
        self.timing = new_mic_timing(mode)  # type: ignore[arg-type]
        self._vad = Vad(self._end_ms()) if mode == "tap" else None
        if self._avad is not None and self._vad is not None:
            self._vad.floor = self._avad.floor
        self._chunker.reset()
        self.tts.set_mic_open(True)  # cancels any speech in progress
        if self._on_mic:
            self._on_mic(True, reason)  # the brain lifts the pen on push-to-talk start
        self._status(MSG["listening"], "status")

        # Mic first, so speech that starts before the socket opens is queued, not lost.
        mic = self._mic_factory()
        try:
            rate, channels = mic.start(lambda raw: self._q.put(("audio", raw)) if self._threaded else self._handle(("audio", raw)))
        except MicError as e:
            self._finish_open()
            self._status(MSG["no_device"] if e.kind == "no_device" else MSG["mic_failed"], "alert")
            self._sync_always()
            return
        except Exception:
            self._finish_open()
            self._status(MSG["mic_failed"], "alert")
            self._sync_always()
            return
        self._mic = mic
        self._proc = CaptureProcessor(rate, channels, frame_samples=FRAME_SAMPLES)
        conn = self._conn
        if conn is not None and conn in self._busy_conns:
            self._conn = None  # the previous utterance is still finishing on it: use a fresh socket
        conn = self._ensure_conn()
        if conn is None:
            self._stop_mic()
            self._finish_open()
            self._sync_always()
            return
        conn.begin()

    # ------------------------------------------------------------------ explicit mic: audio + timing
    def _do_audio(self, raw: bytes) -> None:
        if not self.is_open or self._proc is None:
            return
        now = self._now_ms()
        for f in self._proc.process(float32_bytes_to_list(raw)):
            if self._conn is not None:
                for c in self._chunker.add(f.pcm):
                    self._conn.send_audio(c)
            if f.level >= VOICE_LEVEL and self.timing is not None:
                self.timing = note_activity(self.timing, now)
            if self._on_level:
                self._on_level(f.level, f.meter)
            if self._vad is not None and self._vad.update(f.level) == "end":
                self._do_close("vad_end")  # fast end of utterance (utteranceEndMs after the VAD heard speech)
                return

    def _do_tick(self) -> None:
        now = self._now_ms()
        if self.is_open and self.timing is not None:
            silence = float(self._setting("micSilenceMs", DEFAULT_SILENCE_MS) or DEFAULT_SILENCE_MS)
            why = auto_close_reason(self.timing, now, silence, self._cap_ms())
            if why == "silence" and self._vad is not None and self._vad.speech_seen:
                why = None  # the VAD heard speech: its utteranceEndMs rule closes, micSilenceMs is only the fallback
            if why:
                self._do_close(why)
            return
        if self.listening and self._utt is None:
            conn = self._conn
            if conn is not None and conn in self._busy_conns:
                return
            if conn is None or conn.closed:
                if now >= self._next_reconnect_ms:
                    self._next_reconnect_ms = now + RECONNECT_BACKOFF_MS
                    self._ensure_conn()
            elif now - self._last_utt_ms >= IDLE_RECONNECT_MS or self.tokens.due():
                conn.close()
                self._conn = None
                self._last_utt_ms = now
                self._ensure_conn()

    # ------------------------------------------------------------------ explicit mic: close / cancel
    def _stop_mic(self) -> None:
        mic, self._mic = self._mic, None
        self._proc = None
        self._vad = None
        if mic is not None:
            mic.stop()
        if self._threaded:  # drop audio frames still queued from the closed stream
            keep = []
            while True:
                try:
                    c = self._q.get_nowait()
                except queue.Empty:
                    break
                if c[0] != "audio":
                    keep.append(c)
            for c in keep:
                self._q.put(c)

    def _finish_open(self) -> None:
        was = self.is_open
        self.is_open = False
        self.timing = None
        self.mode = None
        self.tts.set_mic_open(False)
        if was and self._on_mic:
            self._on_mic(False, "closed")

    def _do_close(self, why: str) -> None:
        if not self.is_open:
            return
        # Process frames that arrived before the stop so the tail of the utterance reaches Cartesia.
        if self._threaded:
            pending = []
            while True:
                try:
                    pending.append(self._q.get_nowait())
                except queue.Empty:
                    break
            for c in pending:
                if c[0] == "audio" and self.is_open:
                    self._do_audio(c[1])
                elif c[0] != "audio":
                    self._q.put(c)
            if not self.is_open:  # the VAD closed it while flushing
                return
        self._stop_mic()
        self._finish_open()
        conn = self._conn
        if conn is not None:
            self._start_finish(conn, why, False)
        self._sync_always()

    def _do_cancel(self, message: Optional[str]) -> None:
        was = self.is_open
        self._stop_mic()
        self._finish_open()
        if was and self._conn is not None:
            # Audio already sent for this utterance must never leak into the next one: drop the socket.
            self._conn.close()
            self._conn = None
            self._conn_token = None
        if was and message:
            self._status(message, "status")
        self._sync_always()

    def _finish_utterance(self, conn: SttConnection, why: str, always: bool = False) -> None:
        t0 = time.monotonic()
        try:
            text = conn.finish().strip()
            t1 = time.monotonic()
            if not conn.opened:
                self._cartesia_broken = True
        finally:
            self._post(("conn_free", conn))
        if not text:
            log.info("%s utterance (%s): EMPTY transcript after %d ms (opened=%s)", "always" if always else "mic", why,
                     (time.monotonic() - t0) * 1000, conn.opened)
            if not conn.opened:
                self._status(MSG["unreachable"], "alert")
            elif not always:
                self._status(MSG["cap_nothing"] if why == "cap" else MSG["nothing"], "status")
            return
        self._resolve_and_dispatch(text, "always" if always else "voice")
        log.info("%s utterance (%s): finalize->transcript %d ms, ->dispatched %d ms", "always" if always else "mic", why,
                 (t1 - t0) * 1000, (time.monotonic() - t0) * 1000)

    def _resolve_and_dispatch(self, text: str, mode: str) -> None:
        text = (text or "").strip()
        if not text:
            return
        always = mode == "always"
        if always:  # ambient speech: grammar only, never Claude
            r = self.resolve_text(text, "voice", allow_claude=False)
        else:
            r = self.resolve_text(text, mode)
        heard = r.get("heard") or text
        kind = r.get("kind")
        # Always-listening hears the whole room: only show text that became a command. Chatter is never put on
        # screen (real-Mac screenshot 19:12 Sat: "Heard: Bro, I have leg warmers…").
        if not always or kind == "commands":
            self._heard(heard, "claude" if r.get("via") == "claude" else "grammar")
        log.info("heard %r -> %s %s", text[:60], kind,
                 [c.get("action") for c in (r.get("commands") or [])] if kind == "commands" else "")
        clarify = self._clarify
        if clarify is not None:
            # Our clarify prompt is open: exact "one/two/three/cancel/no" answer it; any other exact command
            # dismisses it (rejected) and still executes (§0 rule 5).
            if kind == "commands":
                cmds = r.get("commands") or []
                first = cmds[0].get("action") if cmds else None
                if first in CHOICE_INDEX or first in ("cancel", "no"):
                    with self._clarify_lock:
                        if self._clarify is clarify:
                            self._clarify = None
                    self._answer_clarify(clarify, first, from_panel=False)
                    return
                with self._clarify_lock:
                    if self._clarify is clarify:
                        self._clarify = None
                self._answer_clarify(clarify, "cancel", from_panel=False, quiet=True)
            else:
                self._status("Say one, two or three, or cancel.", "status")
                return
        if kind == "commands":
            source = "claude" if r.get("via") == "claude" else ("typed" if mode == "typed" else "voice")
            cmds = list(r.get("commands") or [])
            if cmds and cmds[0].get("action") == "undo" and self._last_via == "claude":
                self.resolver.mark_last_rejected()  # "undo that" right after a Claude action
            self._last_via = r.get("via")
            self._send_commands(cmds, source)
        elif kind == "clarify":
            self._open_clarify(r.get("options") or [], heard)
        elif kind == "noop":
            self._last_via = None
        elif kind == "none":
            refused = r.get("refused")
            if always and not refused:
                return  # room chatter: say nothing, show nothing (it is only in the local log)
            if refused:
                self.speak(confirmation_text("word_taken") or "")
                return
            names = [self.resolver.table.by_id[c].label for c in r.get("closest") or [] if c in self.resolver.table.by_id]
            tail = f" Closest: {', '.join(names)}." if names else ""
            self._status(f"Didn't catch that. Heard: \u201c{heard}\u201d.{tail}", "status")
            self.speak(confirmation_text("didnt_catch", heard) or "")

    def _send_commands(self, cmds: List[Dict[str, Any]], source: str) -> None:
        for i, c in enumerate(cmds):
            if i:
                self._sleep(COMMAND_GAP_S)
            self._dispatch(str(c.get("action")), c.get("variant"), c.get("arg"), source)

    def _open_clarify(self, options: List[str], heard: str) -> None:
        t = self.resolver.table
        with self._clarify_lock:
            self._clarify_seq += 1
            c = {"id": f"v-dlg-{self._clarify_seq}", "options": list(options[:3]), "heard": heard}
            self._clarify = c
        opts = [{"id": o, "label": f"{CHOICE_WORDS[i]}: {t.by_id[o].label if o in t.by_id else o}"} for i, o in enumerate(c["options"])]
        text = f"Heard \u201c{heard}\u201d. Which did you mean? Say one, two or three, or cancel."
        if self._dialog_cb is not None:
            self._dialog_cb({"t": "dialog", "dialog_id": c["id"], "kind": "clarify", "text": text, "options": opts})
        else:
            self._status(text + " " + "; ".join(o["label"] for o in opts), "status")

    def _answer_clarify(self, c: Dict[str, Any], answer: str, from_panel: bool, quiet: bool = False) -> None:
        if not from_panel and self._dialog_cb is not None:
            self._dialog_cb({"t": "dialog_close", "dialog_id": c["id"]})
        pick: Optional[str] = None
        if answer in CHOICE_INDEX:
            i = CHOICE_INDEX[answer]
            pick = c["options"][i] if i < len(c["options"]) else None
        elif answer in c["options"]:
            pick = answer
        if pick is None:
            self.resolver.resolve_clarify(False)
            if not quiet:
                self._status("Cancelled.", "status")
            return
        self.resolver.resolve_clarify(True)
        self._last_via = "claude"
        self._dispatch(pick, None, None, "claude")
