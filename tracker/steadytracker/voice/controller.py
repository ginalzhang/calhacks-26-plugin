"""VoiceController: the tracker's voice front door (agent E). Agent C constructs one and calls it.

    vc = VoiceController(parse, dispatch, status, heard, speak_enabled, settings_getter, keys,
                         dialog=..., dialog_open=..., context_getter=..., on_mic=..., on_level=...)
      parse(text, opts) -> ParseResult        brain {t:"parse"} round trip (blocking, from voice threads)
      dispatch(action, variant, arg, source)  -> brain {t:"action", ..., source: "voice"|"typed"|"claude"};
                                              several commands are sent 50 ms apart by us; a coalesced
                                              {undo, arg N} is sent once (the brain spaces the N undos)
      status(text, level)                     -> panel {t:"status"}
      heard(text, via)                        -> panel {t:"heard", via: "grammar"|"claude"}
      speak_enabled() -> bool                 extra TTS gate (settings.tts is also honoured)
      settings_getter() -> SteadySettings     dict (micSilenceMs, micCapMs, quiet, tts, inputs.voice, steadiness)
      keys                                    dict/obj/callable with CARTESIA_API_KEY, ANTHROPIC_API_KEY,
                                              CARTESIA_VOICE_ID (see keys.load_keys)
      dialog(msg)                             -> panel: {t:"dialog", dialog_id:"v-dlg-N", kind:"clarify", text,
                                              options} or {t:"dialog_close", dialog_id} (Claude clarify)
      dialog_open() -> bool                   True while a *brain* dialog (b-dlg-*) is open; omitted -> the brain
                                              decides dialogOpen inside parse
      on_mic(open, reason)                    the mic really opened/closed -> brain {t:"action", action:"mic",
                                              variant:"opened"|"closed", source:"system"}
    vc.open("tile" | "ptt")      # brain {t:"mic", open:true, reason}
    vc.close()                   # brain {t:"mic", open:false} / F10 up -> finalize -> grammar -> Claude -> dispatch
    vc.toggle()                  # tap semantics
    vc.on_brain_mic(open, reason)  # brain {t:"mic"} message as is, reason "ptt"|"tile"|"quiet"|"dialog"
    vc.set_quiet(True)           # quiet mode: mic cancelled (no transcript), TTS off
    vc.on_settings(settings)     # SteadySettings (partial ok)
    vc.speak(text)               # brain {t:"speak"}: only when enabled, not quiet, mic closed
    vc.submit_text(text)         # panel {t:"typed"}: same resolution path, async
    vc.dialog_answer(dialog_id, answer) -> bool  # panel {t:"dialog_answer"}; True if it was our v-dlg-* dialog
    vc.resolve_text(text, mode)  # synchronous resolution (returns the Resolution dict; no dispatch)
    vc.shutdown()

Close rules (§8, micpolicy.py): tap mode closes on the next tap, on settings.micSilenceMs of silence *after
speech onset*, or at settings.micCapMs counted from onset; push-to-talk closes on release only; no onset timeout.

Threads (all daemon): "steady-voice" (owns all mic/STT state; every public method only enqueues), PortAudio's
input callback (enqueues raw frames), "steady-stt" reader per Cartesia socket, "steady-voice-finish" per
utterance (finalize + resolve + dispatch, so the Claude call never blocks the mic), "steady-tts" per utterance
spoken. Callbacks (status/heard/dispatch/on_mic/on_level) are invoked from these threads: C must make them
thread-safe (e.g. post to its own loop).
"""

from __future__ import annotations

import queue
import threading
import time
from typing import Any, Callable, Dict, List, Mapping, Optional

from .audio import CaptureProcessor, float32_bytes_to_list
from .cartesia import CartesiaToken, TokenError, TokenSource, first_english_voice, urllib_http
from .claude import ClaudeInterpreter, ClaudeLog
from .keys import key as read_key
from .keyterms import stt_keyterms
from .mic import MicError, SoundDeviceMic
from .micpolicy import VOICE_LEVEL, MicTiming, auto_close_reason, new_mic_timing, note_activity
from .resolve import Resolver
from .stt import SttConnection, SttHandlers, websockets_connect
from .tts import TtsClient, confirmation_text

DEFAULT_SILENCE_MS = 2000
DEFAULT_CAP_MS = 15000
TICK_S = 0.1
COMMAND_GAP_S = 0.05  # "blue bigger": commands of one utterance go to the brain 50 ms apart
CHOICE_INDEX = {"choice_one": 0, "choice_two": 1, "choice_three": 2}
CHOICE_WORDS = ["One", "Two", "Three"]

MSG = {
    "listening": "Listening…",
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
        self.tts = tts or TtsClient(self.tokens, self._voice_id, on_status=lambda _s, t: self._status(t, "status"))

        # state owned by the voice thread
        self.is_open = False
        self.quiet = bool(_get(self._settings(), "quiet", False))
        self.mode: Optional[str] = None
        self.timing: Optional[MicTiming] = None
        self._mic: Any = None
        self._proc: Optional[CaptureProcessor] = None
        self._conn: Optional[SttConnection] = None
        self._conn_token: Optional[CartesiaToken] = None
        self._busy_conns: set = set()
        self._cartesia_broken = False
        self._last_level_emit = 0.0
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
        if self.is_open or self.quiet or not self._tts_enabled():
            return False
        return self.tts.speak(text)

    def resolve_text(self, text: str, mode: str = "typed") -> Dict[str, Any]:
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
        """Auto-close check; the voice thread calls this every 100 ms (tests call it directly when threaded=False)."""
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
            except Exception:
                pass
            self._status(f"Voice error: {e.__class__.__name__}. Tiles, keys and the typed box still work.", "alert")

    @staticmethod
    def _safe(fn: Callable[[], Any], default: Any) -> Any:
        try:
            return fn()
        except Exception:
            return default

    def _tts_enabled(self) -> bool:
        s = self._safe(self._settings, None)
        return bool(self._safe(self._speak_enabled, True)) and bool(_get(s, "tts", True))

    def _voice_enabled(self) -> bool:
        inputs = _get(self._safe(self._settings, None), "inputs", None)
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
        try:
            self.interpreter.prewarm()
        except Exception:
            pass

    def _handle(self, cmd: tuple) -> None:
        op = cmd[0]
        if op == "open":
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
        elif op == "audio":
            self._do_audio(cmd[1])
        elif op == "activity":
            if self.is_open and self.timing is not None:
                self.timing = note_activity(self.timing, self._now_ms())
        elif op == "tick":
            self._do_tick()
        elif op == "quiet":
            self.quiet = cmd[1]
            self.tts.set_quiet(self.quiet)
            if self.quiet and self.is_open:
                self._do_cancel(MSG["quiet"])
        elif op == "settings":
            s = cmd[1]
            q = _get(s, "quiet", None)
            if q is not None and bool(q) != self.quiet:
                self._handle(("quiet", bool(q)))
            tts_val = _get(s, "tts", None)
            if tts_val is None:
                self.tts.set_enabled(self._tts_enabled())
            else:
                self.tts.set_enabled(bool(tts_val) and bool(self._safe(self._speak_enabled, True)))
            inputs = _get(s, "inputs", None)
            if inputs is not None and not bool(_get(inputs, "voice", True)) and self.is_open:
                self._do_cancel(MSG["voice_off"])
        elif op == "shutdown":
            self._stopped = True
            self._stop_mic()
            self._finish_open()
            if self._conn is not None:
                self._conn.close()
                self._conn = None
            self.tts.shutdown()

    # ------------------------------------------------------------------ open
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
        self.is_open = True
        self.mode = mode
        self.timing = new_mic_timing(mode)  # type: ignore[arg-type]
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
            return
        except Exception:
            self._finish_open()
            self._status(MSG["mic_failed"], "alert")
            return
        self._mic = mic
        self._proc = CaptureProcessor(rate, channels)

        try:
            tok = self.tokens.get()
        except TokenError as e:
            self._stop_mic()
            self._finish_open()
            self._status(MSG["no_cartesia_key"] if e.reason == "key_missing" else MSG["token_failed"], "status" if e.reason == "key_missing" else "alert")
            return
        conn = self._conn
        if conn is None or conn.closed or conn in self._busy_conns or self._conn_token is None or self._conn_token.token != tok.token:
            if conn is not None and conn not in self._busy_conns:
                conn.close()
            conn = SttConnection(tok.token, self.keyterms, self._stt_handlers(), connect=self._stt_connect)
            self._conn = conn
            self._conn_token = tok
        else:
            conn.set_handlers(self._stt_handlers())
        conn.begin()

    def _stt_handlers(self) -> SttHandlers:
        def on_delta(full: str, _final: bool) -> None:
            self._post(("activity",))
            self._status(f"Heard: {full}…", "status")

        def on_error(m: str) -> None:
            self._status(f"Voice: {m}", "alert")

        def on_close(_code: int) -> None:
            pass

        return SttHandlers(on_delta=on_delta, on_error=on_error, on_close=on_close)

    # ------------------------------------------------------------------ audio + timing
    def _do_audio(self, raw: bytes) -> None:
        if not self.is_open or self._proc is None:
            return
        for c in self._proc.process(float32_bytes_to_list(raw)):
            if self._conn is not None:
                self._conn.send_audio(c.pcm)
            if c.level >= VOICE_LEVEL and self.timing is not None:
                self.timing = note_activity(self.timing, self._now_ms())
            if self._on_level:
                self._on_level(c.level, c.meter)

    def _do_tick(self) -> None:
        if not self.is_open or self.timing is None:
            return
        s = self._safe(self._settings, None)
        silence = float(_get(s, "micSilenceMs", DEFAULT_SILENCE_MS) or DEFAULT_SILENCE_MS)
        cap = float(_get(s, "micCapMs", DEFAULT_CAP_MS) or DEFAULT_CAP_MS)
        why = auto_close_reason(self.timing, self._now_ms(), silence, cap)
        if why:
            self._do_close(why)

    # ------------------------------------------------------------------ close / cancel
    def _stop_mic(self) -> None:
        mic, self._mic = self._mic, None
        self._proc = None
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
                if c[0] == "audio":
                    self._do_audio(c[1])
                else:
                    self._q.put(c)
        self._stop_mic()
        self._finish_open()
        conn = self._conn
        if conn is None:
            return
        self._busy_conns.add(conn)
        if self._threaded:
            th = threading.Thread(target=self._finish_utterance, args=(conn, why), name="steady-voice-finish", daemon=True)
            self._finishers = [t for t in self._finishers if t.is_alive()] + [th]
            th.start()
        else:
            self._finish_utterance(conn, why)

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

    def _finish_utterance(self, conn: SttConnection, why: str) -> None:
        try:
            text = conn.finish().strip()
            if not conn.opened:
                self._cartesia_broken = True
            if self.tokens.due() or conn.closed:  # between utterances: drop a socket whose token is due
                conn.close()
                if self._conn is conn:
                    self._conn = None
                    self._conn_token = None
        finally:
            self._busy_conns.discard(conn)
        if not text:
            if not conn.opened:
                self._status(MSG["unreachable"], "alert")
            else:
                self._status(MSG["cap_nothing"] if why == "cap" else MSG["nothing"], "status")
            return
        self._resolve_and_dispatch(text, "voice")

    def _resolve_and_dispatch(self, text: str, mode: str) -> None:
        text = (text or "").strip()
        if not text:
            return
        r = self.resolve_text(text, mode)
        heard = r.get("heard") or text
        self._heard(heard, "claude" if r.get("via") == "claude" else "grammar")
        kind = r.get("kind")
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
