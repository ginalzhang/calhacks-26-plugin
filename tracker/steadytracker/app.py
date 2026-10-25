"""TrackerApp: the glue (tracker/PROTOCOL.md).

  frame source thread ──frame──► brain (node)           brain ──pen──► Pointer (steadyhelper) ─► Quartz
  50 ms tick ───────────tick──►                          brain ──krita/keys──► KritaRelay 8766 / KeyOutput
  hotkeys (pynput tap) ─hotkey─►                         brain ──state/status/dialog──► panel 8767
  panel 8767 ─action/typed/settings/calibrate/…─►        brain ──speak/mic──► voice (agent E)
  Krita window + canvas rect (1 s) ──rects──►            brain ──calibration/settings_changed──► Store

Safety (pen-state law, tracker half):
- Watchdog: the brain must print something at least every 300 ms while a button is held (every stdout
  line feeds it; `pen {events:[]}` is a valid heartbeat). Otherwise the button is released and the
  brain gets `helper_event released {reason:"watchdog"}`.
- Brain crash → release at once, restart once (re-init with persisted settings/calibration).
- `down` refused while paused, without Accessibility, with --no-input-less fakes, or when Krita is not
  frontmost; clicks only inside Krita's main window or the panel rect, and inside the usable area.
- Krita quits → release. Every exit path releases (stop(), atexit/signals in main.py).

Everything system-facing is injected so pytest drives the real app with fakes.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import uuid
from typing import Any, Callable, Dict, List, Optional

from steadyhelper.config import KRITA_BUNDLE_ID
from steadyhelper.hotkeys import HotkeyRouter
from steadyhelper.krita_relay import PluginDown
from steadyhelper.macos import usable_at
from steadyhelper.pointer import Pointer, Refused, inside
from steadyhelper.watchdog import Watchdog

from . import REPO, VERSION
from .brain import BrainProcess
from .config import (
    BRAIN_MAX_RESTARTS,
    BRAIN_WATCHDOG_S,
    PANEL_HOST,
    PANEL_PORT,
    PARSE_TIMEOUT_S,
    PERMISSIONS_PERIOD_S,
    PREVIEW_MIN_INTERVAL_S,
    RECTS_PERIOD_S,
    TICK_S,
    now_ms,
)
from .keys_out import KeyOutput
from .panel_server import PanelServer
from .permissions import permissions_message
from .persistence import Store
from .preview import preview_message, tracked_point

log = logging.getLogger("steady.tracker")

#: Pointer release reasons the brain asked for itself (or nobody is left to tell).
_SILENT_RELEASES = ("up", "middle_up", "down", "pan", "shutdown", "exit", "click")


def release_reason(raw: str) -> Optional[str]:
    """Pointer release reason → helper_event released.data.reason (None = the brain asked for it)."""
    if raw in _SILENT_RELEASES or raw.startswith(("signal", "brain crash")):
        return None
    if raw.startswith("watchdog"):
        return "watchdog"
    if raw == "pause":
        return "pause"
    if raw == "hotkey ptt_down":
        return "ptt"
    if raw.startswith("hotkey"):
        return "hotkey"
    if raw.startswith("krita"):
        return "krita_gone"
    if "exception" in raw:
        return "exception"
    return "other"


class TrackerApp:
    def __init__(
        self,
        *,
        source,
        brain_cmd: List[str],
        pointer: Pointer,
        system,
        key_poster,
        store: Store,
        relay=None,
        panel_host: str = PANEL_HOST,
        panel_port: int = PANEL_PORT,
        permissions_probe: Callable[[], Dict[str, bool]] = lambda: {},
        allow_input: bool = True,
        real_pointer: bool = False,
        hotkey_listener: Optional[Callable[[HotkeyRouter], Any]] = None,
        voice_factory: Optional[Callable[["TrackerApp"], Any]] = None,
        preview_encoder: Optional[Callable[..., bytes]] = None,
        request_microphone: Optional[Callable[[], None]] = None,
        keys: Optional[Dict[str, str]] = None,
        brain_cwd: Optional[str] = REPO,
        brain_env: Optional[Dict[str, str]] = None,
        tick_s: float = TICK_S,
        watchdog_s: float = BRAIN_WATCHDOG_S,
        rects_period: float = RECTS_PERIOD_S,
        permissions_period: float = PERMISSIONS_PERIOD_S,
        preview_interval: float = PREVIEW_MIN_INTERVAL_S,
        parse_timeout: float = PARSE_TIMEOUT_S,
        max_restarts: int = BRAIN_MAX_RESTARTS,
        clock: Callable[[], float] = now_ms,
        require_krita_frontmost: bool = True,
    ) -> None:
        self.source = source
        self.pointer = pointer
        self.system = system
        self.store = store
        self.relay = relay
        self.allow_input = allow_input
        self.real_pointer = real_pointer
        self._permissions_probe = permissions_probe
        self._hotkey_listener_factory = hotkey_listener
        self._voice_factory = voice_factory
        self._preview_encoder = preview_encoder
        self._request_microphone = request_microphone
        self.keys = dict(keys or {})
        self.tick_s = tick_s
        self.rects_period = rects_period
        self.permissions_period = permissions_period
        self.preview_interval = preview_interval
        self.parse_timeout = parse_timeout
        self.max_restarts = max_restarts
        self.clock = clock
        self.require_krita_frontmost = require_krita_frontmost

        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.stop_event: Optional[asyncio.Event] = None
        self._tasks: set = set()
        self._stopping = False

        # pointer + watchdog (the watchdog watches the BRAIN's output)
        pointer.on_release = self._on_pointer_release
        self.watchdog = Watchdog(pointer, timeout=watchdog_s)
        self._flush_handle: Optional[asyncio.TimerHandle] = None

        # brain
        self.brain = BrainProcess(brain_cmd, self._brain_line, self._brain_exit, cwd=brain_cwd, env=brain_env)
        self.brain_restarts = 0
        self.brain_ready = False
        self.brain_dead = False
        self._parse_waiters: Dict[str, asyncio.Future] = {}

        # keys + relay
        self.key_out = KeyOutput(
            system, key_poster, allow=allow_input, accessibility=lambda: bool(self.permissions.get("accessibility", True))
        )
        if relay is not None:
            relay._on_state = self._on_krita_state  # set before start()

        # panel
        self.panel = PanelServer(
            self.handle_panel, on_connect=self._on_panel_hello, host=panel_host, port=panel_port
        )

        # hotkeys (consumed only while Krita is frontmost; the helper's Chrome rule is masked out)
        self._front: Optional[str] = None
        self.router = HotkeyRouter(
            emit=self._hotkey_threadsafe,
            frontmost=lambda: self._front if self._front == KRITA_BUNDLE_ID else None,
            has_client=lambda: self.brain.alive,
        )
        self._listener = None

        # mirrored state
        self.settings: Dict[str, Any] = store.settings()
        self.preview_on = bool(self.settings.get("preview", False))
        self.permissions: Dict[str, bool] = {}
        self.panel_rect: Optional[Dict[str, float]] = None
        self.krita_rect: Optional[Dict[str, float]] = None
        self.canvas_rect: Optional[Dict[str, float]] = None
        self._krita_running = False
        self._last_rects: Optional[Dict[str, Any]] = None
        self.brain_state: Optional[Dict[str, Any]] = None
        self.dialog_open = False
        self._tracker_dialogs: Dict[str, Dict[str, Any]] = {}
        self._last_frame: Optional[Dict[str, Any]] = None
        self._last_image: Any = None
        self._frame_seq = 0
        self._preview_seq = -1
        self.previews_sent = 0
        self.frames_sent = 0
        self.voice = None

    # ================================================================== lifecycle
    async def start(self) -> "TrackerApp":
        self.loop = asyncio.get_running_loop()
        self.stop_event = asyncio.Event()
        await self.panel.start()
        self._refresh_frontmost()
        self.permissions = self._probe_permissions()
        self._apply_accessibility()
        self.watchdog.start()
        if self.relay is not None:
            self.relay.start()
        self._start_brain()
        if self._voice_factory is not None:
            try:
                self.voice = self._voice_factory(self)
            except Exception:
                log.exception("voice unavailable")
                self.voice = None
        if self._hotkey_listener_factory is not None and self.allow_input:
            try:
                self._listener = self._hotkey_listener_factory(self.router)
            except Exception:
                log.exception("hotkey listener failed to start")
        self.source.start(self._on_frame)
        self._spawn(self._tick_loop())
        self._spawn(self._rects_loop())
        self._spawn(self._permissions_loop())
        self._spawn(self._preview_loop())
        log.info("Steady Tracker %s ready (panel %s:%d)", VERSION, self.panel.host, self.panel.port)
        return self

    async def stop(self) -> None:
        if self._stopping:
            return
        self._stopping = True
        self.pointer.release("shutdown")
        if self._listener is not None:
            try:
                self._listener.stop()
            except Exception:
                pass
        try:
            self.source.stop()
        except Exception:
            log.exception("source stop failed")
        for t in list(self._tasks):
            t.cancel()
        for t in list(self._tasks):
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        await asyncio.get_running_loop().run_in_executor(None, self.brain.stop)
        if self.voice is not None and hasattr(self.voice, "close"):
            try:
                self.voice.close()
            except Exception:
                log.exception("voice close failed")
        if self.relay is not None:
            await self.relay.stop()
        await self.panel.stop()
        self.watchdog.stop()
        self.pointer.release("shutdown")

    def request_stop(self) -> None:
        self.pointer.release("shutdown")
        if self.stop_event is not None:
            self.stop_event.set()

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    def _call_soon(self, fn, *args) -> None:
        loop = self.loop
        if loop is not None and not loop.is_closed():
            try:
                loop.call_soon_threadsafe(fn, *args)
            except RuntimeError:
                pass

    # ================================================================== brain
    def brain_send(self, msg: Dict[str, Any]) -> bool:
        return self.brain.send(msg)

    def _start_brain(self) -> None:
        self.brain_ready = False
        try:
            self.brain.start()
        except Exception as exc:
            log.exception("could not start the brain")
            self.brain_dead = True
            self.panel.send({"t": "status", "text": f"Steady could not start ({type(exc).__name__}).", "level": "alert"})
            return
        self.brain_send(
            {
                "t": "init",
                "settings": dict(self.settings),
                "calibration": self.store.latest_calibration(),
                "now": self.clock(),
            }
        )
        self._last_rects = None
        self._send_rects()
        if self.relay is not None and self.relay.connected:
            self._helper_event("krita_state", {"connected": True})

    def _brain_line(self, msg: Dict[str, Any]) -> None:
        """Brain reader thread: every line is a heartbeat; handle it on the loop thread."""
        self.watchdog.feed()
        self._call_soon(self._on_brain, msg)

    def _brain_exit(self, code: Optional[int]) -> None:
        """Brain reader thread: the process died. Release NOW, then restart once on the loop."""
        self.pointer.release("brain crash")
        self._call_soon(self._restart_brain, code)

    def _restart_brain(self, code: Optional[int]) -> None:
        if self._stopping:
            return
        for fut in self._parse_waiters.values():
            if not fut.done():
                fut.set_result(None)
        self._parse_waiters.clear()
        if self.brain_restarts < self.max_restarts:
            self.brain_restarts += 1
            log.warning("restarting the brain (exit code %s)", code)
            self.panel.send({"t": "status", "text": "Steady restarted. Pen is up.", "level": "alert"})
            self._start_brain()
        else:
            self.brain_dead = True
            self.panel.send(
                {"t": "status", "text": "Steady stopped working. Quit and reopen Steady Tracker.", "level": "alert"}
            )

    def _helper_event(self, event: str, data: Optional[Dict[str, Any]] = None) -> None:
        msg: Dict[str, Any] = {"t": "helper_event", "event": event, "now": self.clock()}
        if data is not None:
            msg["data"] = data
        self.brain_send(msg)

    def _on_brain(self, msg: Dict[str, Any]) -> None:
        t = msg.get("t")
        try:
            if t == "pen":
                for ev in msg.get("events") or []:
                    self._pen(ev)
            elif t == "state":
                st = msg.get("state")
                if isinstance(st, dict):
                    self._apply_state(st)
                    self.panel.send_state(st)
            elif t == "status":
                self.panel.send({"t": "status", "text": str(msg.get("text", "")), "level": msg.get("level", "status")})
            elif t == "krita":
                self._spawn(self._relay_krita(msg))
            elif t == "keys":
                self._spawn(self._post_keys(msg))
            elif t == "parsed":
                fut = self._parse_waiters.pop(str(msg.get("id")), None)
                if fut is not None and not fut.done():
                    fut.set_result(msg.get("result"))
            elif t == "dialog":
                self.dialog_open = True
                self.panel.send({k: v for k, v in msg.items()})
            elif t == "calibration":
                cal = msg.get("calibration")
                if isinstance(cal, dict):
                    self.store.save_calibration(cal)
            elif t == "settings_changed":
                patch = msg.get("settings")
                if isinstance(patch, dict):
                    self.settings = self.store.merge_settings(patch)
            elif t == "speak":
                self._voice_call("speak", str(msg.get("text", "")))
            elif t == "mic":
                opening = bool(msg.get("open"))
                if opening and self._request_microphone is not None and self.allow_input:
                    self._request_microphone()
                self._voice_call("on_mic", opening, str(msg.get("reason", "tile")))
            elif t == "ready":
                self.brain_ready = True
                log.info("brain ready (%s)", msg.get("version"))
            elif t == "error":
                log.warning("brain error: %s", msg.get("text"))
            else:
                log.debug("unhandled brain message %r", t)
        except Exception:
            self.pointer.release("exception in brain handler")
            log.exception("brain message %r failed", t)

    def _apply_state(self, st: Dict[str, Any]) -> None:
        self.brain_state = st
        paused = bool(st.get("paused"))
        if paused and not self.pointer.paused:
            if self.panel_rect:
                self.pointer.set_chrome_rect(self.panel_rect)
            self.pointer.pause()
        elif not paused and self.pointer.paused:
            self.pointer.resume()
        s = st.get("settings")
        if isinstance(s, dict) and "preview" in s:
            self.preview_on = bool(s["preview"])

    # ------------------------------------------------------------------ pen → pointer
    def _pen(self, ev: Dict[str, Any]) -> None:
        kind = ev.get("type")
        p = self.pointer
        x, y = float(ev.get("x", 0.0)), float(ev.get("y", 0.0))
        if kind == "move":
            self._schedule_pump(p.move(x, y))
        elif kind in ("down", "middle_down"):
            code = self._down_refusal()
            if code is not None:
                self._helper_event("refused_down", {"code": code, "button": "left" if kind == "down" else "middle"})
                return
            self._schedule_pump(p.move(x, y))
            try:
                self._schedule_pump(p.down() if kind == "down" else p.middle_down())
            except Refused as r:
                self._helper_event("refused_down", {"code": r.code, "button": "left" if kind == "down" else "middle"})
        elif kind == "up":
            self._schedule_pump(p.up())
        elif kind == "middle_up":
            self._schedule_pump(p.middle_up())
        elif kind == "click":
            code = self._click_refusal(x, y)
            if code is not None:
                self._helper_event("refused_down", {"code": code, "button": "left", "click": True, "x": x, "y": y})
                return
            try:
                p.click(x, y)
            except Refused as r:
                self._helper_event("refused_down", {"code": r.code, "button": "left", "click": True, "x": x, "y": y})

    def _down_refusal(self) -> Optional[str]:
        if self.pointer.paused:
            return "paused"
        if not self.pointer.enabled:
            return "permission"
        if self.require_krita_frontmost and self._front != KRITA_BUNDLE_ID:
            return "krita_not_frontmost"
        return None

    def _click_refusal(self, x: float, y: float) -> Optional[str]:
        if not self.pointer.enabled:
            return "permission"
        if not (inside(self.krita_rect, x, y) or inside(self.panel_rect, x, y)):
            return "outside_krita"
        try:
            ok = usable_at(x, y, self.system.screens())
        except Exception:
            ok = None
        if ok is False:
            return "outside_usable"
        if self.pointer.paused and not inside(self.panel_rect, x, y):
            return "outside_panel"
        return None

    def _schedule_pump(self, delay: float) -> None:
        if delay > 0 and self._flush_handle is None and self.loop is not None:
            self._flush_handle = self.loop.call_later(delay, self._pump)

    def _pump(self) -> None:
        self._flush_handle = None
        try:
            delay = self.pointer.pump()
        except Exception:
            log.exception("pointer pump failed")
            self.pointer.release("exception in pump")
            return
        self._schedule_pump(delay)

    def _on_pointer_release(self, raw: str, button: str) -> None:
        """Any thread. Tell the brain when the tracker (not the brain) released a button."""
        reason = release_reason(raw)
        if reason is None:
            return
        self._call_soon(self._helper_event, "released", {"reason": reason, "button": button})

    # ------------------------------------------------------------------ krita / keys
    async def _relay_krita(self, msg: Dict[str, Any]) -> None:
        rid = str(msg.get("id"))
        cmd = msg.get("cmd") if isinstance(msg.get("cmd"), dict) else {}
        req = {**cmd, "id": rid}
        data: Dict[str, Any]
        try:
            if self.relay is None:
                raise PluginDown()
            reply = await self.relay.request(req)
            data = {**{k: v for k, v in reply.items()}, "id": rid, "ok": bool(reply.get("ok")), "via": "plugin"}
        except PluginDown:
            fb = msg.get("fallback_keys")
            if fb:
                ok, err = await self.key_out.post(str(fb))
                data = {"id": rid, "ok": ok, "via": "keys"}
                if err:
                    data["error"] = err
            else:
                data = {"id": rid, "ok": False, "error": "plugin_down"}
        except asyncio.TimeoutError:
            data = {"id": rid, "ok": False, "via": "plugin", "error": "timeout"}
        except Exception as exc:
            log.exception("krita relay failed")
            data = {"id": rid, "ok": False, "via": "plugin", "error": f"internal: {exc}"}
        self._helper_event("krita_reply", data)

    async def _post_keys(self, msg: Dict[str, Any]) -> None:
        rid = str(msg.get("id"))
        try:
            ok, err = await self.key_out.post(str(msg.get("combo", "")))
        except Exception as exc:
            log.exception("keys failed")
            ok, err = False, f"internal: {exc}"
        data: Dict[str, Any] = {"id": rid, "ok": ok, "via": "keys"}
        if err:
            data["error"] = err
        self._helper_event("krita_reply", data)

    def _on_krita_state(self, connected: bool) -> None:
        self._helper_event("krita_state", {"connected": bool(connected)})
        if not connected:
            self.canvas_rect = None
            self._send_rects()

    # ------------------------------------------------------------------ hotkeys
    def _hotkey_threadsafe(self, name: str) -> None:
        """Key tap thread. Lifting is always safe, so pen/pause/PTT-start lift at once."""
        if name in ("pen", "pause", "ptt_down"):
            self.pointer.release(f"hotkey {name}")
        self._call_soon(self.on_hotkey, name)

    def on_hotkey(self, name: str) -> None:
        self.brain_send({"t": "hotkey", "key": name, "now": self.clock()})

    # ------------------------------------------------------------------ frames
    def _on_frame(self, frame: Dict[str, Any], image: Any) -> None:
        """Frame source thread."""
        self._last_frame = frame
        self._last_image = image
        self._frame_seq += 1
        if self.brain.send({"t": "frame", "frame": frame}):
            self.frames_sent += 1

    # ================================================================== periodic loops
    def _refresh_frontmost(self) -> None:
        try:
            self.system.pump()
            self._front = self.system.frontmost_bundle_id()
        except Exception:
            log.debug("frontmost refresh failed", exc_info=True)

    async def _tick_loop(self) -> None:
        while True:
            self._refresh_frontmost()
            self.brain_send({"t": "tick", "now": self.clock()})
            await asyncio.sleep(self.tick_s)

    def _rects(self) -> Dict[str, Any]:
        screen = None
        usable = None
        try:
            s = self.system.screen()
            screen = {"x": 0.0, "y": 0.0, "w": float(s["w"]), "h": float(s["h"])}
        except Exception:
            pass
        try:
            usable = self.system.visible_frame()
        except Exception:
            pass
        return {
            "canvas": self.canvas_rect,
            "krita": self.krita_rect,
            "screen": screen,
            "usable": usable,
            "panel": self.panel_rect,
        }

    def _send_rects(self) -> None:
        rects = self._rects()
        if rects != self._last_rects:
            if self.brain_send({"t": "rects", "rects": rects}):
                self._last_rects = rects

    async def refresh_rects(self) -> None:
        try:
            running = self.system.krita_pid() is not None
            self.krita_rect = self.system.krita_window_rect() if running else None
        except Exception:
            log.exception("krita window lookup failed")
            running = False
            self.krita_rect = None
        if self._krita_running and not running:
            self.pointer.release("krita quit")
        self._krita_running = running
        if self.relay is not None and self.relay.connected:
            try:
                reply = await self.relay.request({"id": f"trk-canvas-{uuid.uuid4().hex[:8]}", "cmd": "canvas_rect"})
                self.canvas_rect = reply.get("rect") if reply.get("ok") else None
            except (PluginDown, asyncio.TimeoutError):
                pass
            except Exception:
                log.exception("canvas_rect failed")
        self._send_rects()

    async def _rects_loop(self) -> None:
        while True:
            await self.refresh_rects()
            await asyncio.sleep(self.rects_period)

    def _probe_permissions(self) -> Dict[str, bool]:
        try:
            p = dict(self._permissions_probe() or {})
        except Exception:
            log.exception("permission probe failed")
            p = {}
        for k in ("camera", "microphone", "accessibility", "input_monitoring"):
            p[k] = bool(p.get(k, False))
        return p

    def _apply_accessibility(self) -> None:
        if self.real_pointer:
            enabled = bool(self.permissions.get("accessibility"))
            if self.pointer.enabled and not enabled:
                self.pointer.release("permission lost")
            self.pointer.enabled = enabled

    async def _permissions_loop(self) -> None:
        while True:
            await asyncio.sleep(self.permissions_period)
            p = self._probe_permissions()
            if p != self.permissions:
                self.permissions = p
                self._apply_accessibility()
                self.panel.send(permissions_message(p))

    async def _preview_loop(self) -> None:
        while True:
            await asyncio.sleep(self.preview_interval)
            self.preview_tick()

    def preview_tick(self) -> bool:
        """One preview step: ≤ 1 per preview_interval, only with a panel, settings.preview and a new frame."""
        if not (self.preview_on and self.panel.connected and self._preview_encoder is not None):
            return False
        if self._frame_seq == self._preview_seq or self._last_frame is None:
            return False
        self._preview_seq = self._frame_seq
        frame = self._last_frame
        lm = int(self.settings.get("landmark", 5) or 5)
        pt = tracked_point(frame, lm)
        score = (frame.get("hands") or [{}])[0].get("score") if frame.get("hands") else None
        try:
            jpeg = self._preview_encoder(
                self._last_image,
                pt,
                bool(self.settings.get("mirrorCamera", False)),
                bool(self.settings.get("rotateCamera", False)),
                score,
            )
        except Exception:
            log.exception("preview encode failed")
            return False
        if self.panel.send(preview_message(jpeg)):
            self.previews_sent += 1
            return True
        return False

    # ================================================================== panel
    def _cameras_message(self) -> Dict[str, Any]:
        cams = [{"index": int(c["index"]), "name": str(c["name"])} for c in self.source.cameras()]
        return {"t": "cameras", "list": cams, "selected": int(getattr(self.source, "selected", 0))}

    def _on_panel_hello(self) -> None:
        self.panel.send(self._cameras_message())
        self.panel.send(permissions_message(self.permissions))
        self.panel.resend_state()
        if self.brain_dead:
            self.panel.send(
                {"t": "status", "text": "Steady stopped working. Quit and reopen Steady Tracker.", "level": "alert"}
            )

    async def handle_panel(self, msg: Dict[str, Any]):
        t = msg["t"]
        now = self.clock()
        if t == "action":
            if not isinstance(msg.get("action"), str):
                return False, "bad_args"
            out: Dict[str, Any] = {"t": "action", "action": msg["action"], "source": msg.get("source") or "tile", "now": now}
            if msg.get("variant") is not None:
                out["variant"] = msg["variant"]
            if "arg" in msg:
                out["arg"] = msg["arg"]
            return self._brain_ok(out)
        if t == "typed":
            text = str(msg.get("text", "")).strip()
            if not text:
                return False, "empty"
            self._spawn(self.resolve_text(text, "typed"))
            return True, None
        if t == "settings":
            patch = msg.get("settings")
            if not isinstance(patch, dict):
                return False, "bad_args"
            self.settings = self.store.merge_settings(patch)
            if "preview" in patch:
                self.preview_on = bool(patch["preview"])
            return self._brain_ok({"t": "settings", "settings": patch})
        if t == "calibrate":
            steps = [s for s in (msg.get("steps") or [1, 2, 3]) if s in (1, 2, 3)]
            return self._brain_ok({"t": "calibrate", "steps": steps or [1, 2, 3], "now": now})
        if t == "camera":
            return self._select_camera(msg.get("index"))
        if t == "mic":
            on = bool(msg.get("on"))
            return self._brain_ok(
                {"t": "action", "action": "mic", "variant": "open" if on else "close", "source": "tile", "now": now}
            )
        if t == "panel_rect":
            rect = msg.get("rect")
            if not _is_rect(rect):
                return False, "bad_args"
            self.panel_rect = {k: float(rect[k]) for k in ("x", "y", "w", "h")}
            self.pointer.set_chrome_rect(self.panel_rect)
            self._send_rects()
            return True, None
        if t == "dialog_answer":
            did = str(msg.get("dialog_id", ""))
            self.dialog_open = False
            if did in self._tracker_dialogs:
                self._answer_tracker_dialog(did, str(msg.get("answer", "")))
                return True, None
            return self._brain_ok({"t": "dialog_answer", "dialog_id": did, "answer": str(msg.get("answer", "")), "now": now})
        if t == "quit":
            self.pointer.release("quit")
            self.loop.call_later(0.05, self.request_stop)
            return True, None
        return False, "unknown_type"

    def _brain_ok(self, msg: Dict[str, Any]):
        if self.brain_send(msg):
            return True, None
        return False, "brain_down"

    def _select_camera(self, index: Any):
        cams = self.source.cameras()
        try:
            idx = int(index)
        except (TypeError, ValueError):
            return False, "bad_args"
        match = [c for c in cams if int(c["index"]) == idx]
        if cams and not match:
            return False, "no_camera"
        try:
            self.source.select(idx)
        except Exception as exc:
            log.exception("camera switch failed")
            return False, f"internal: {type(exc).__name__}"
        if match:
            self.store.set_tracker_pref("camera", match[0]["name"])
        self.panel.send(self._cameras_message())
        return True, None

    # ------------------------------------------------------------------ typed / voice text
    async def parse(self, text: str, mode: str) -> Optional[Dict[str, Any]]:
        rid = f"p-{uuid.uuid4().hex[:10]}"
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._parse_waiters[rid] = fut
        opts = {"mode": mode, "dialogOpen": self.dialog_open, "aliases": self.store.aliases()}
        if not self.brain_send({"t": "parse", "id": rid, "text": text, "opts": opts}):
            self._parse_waiters.pop(rid, None)
            return None
        try:
            return await asyncio.wait_for(fut, self.parse_timeout)
        except asyncio.TimeoutError:
            return None
        finally:
            self._parse_waiters.pop(rid, None)

    def _run_commands(self, commands: List[Dict[str, Any]], source: str) -> None:
        for c in commands:
            if not isinstance(c, dict) or not isinstance(c.get("action"), str):
                continue
            out: Dict[str, Any] = {"t": "action", "action": c["action"], "source": source, "now": self.clock()}
            if c.get("variant") is not None:
                out["variant"] = c["variant"]
            if c.get("arg") is not None:
                out["arg"] = c["arg"]
            self.brain_send(out)

    async def resolve_text(self, text: str, mode: str = "typed") -> str:
        """typed box / voice transcript → brain grammar → (Claude fallback via voice) → actions.
        Returns "grammar" | "claude" | "clarify" | "none" (for tests and logs)."""
        source = "typed" if mode == "typed" else "voice"
        result = await self.parse(text, mode)
        if isinstance(result, dict) and result.get("kind") == "match":
            self.panel.send({"t": "heard", "text": text, "via": "grammar"})
            self._run_commands(result.get("commands") or [], source)
            return "grammar"
        closest: List[str] = list((result or {}).get("closest") or []) if isinstance(result, dict) else []
        refused = (result or {}).get("refused") if isinstance(result, dict) else None
        if refused and refused.get("reason") == "alias_taken":
            self.panel.send({"t": "status", "text": f'"{refused.get("word")}" is already a command.', "level": "status"})
            return "none"
        res = await self._claude_fallback(text)
        if isinstance(res, dict):
            kind = res.get("kind")
            if kind == "commands" and res.get("commands"):
                self.panel.send({"t": "heard", "text": res.get("heard") or text, "via": "claude"})
                self._run_commands(res["commands"], "claude")
                return "claude"
            if kind == "clarify" and res.get("options"):
                self._open_clarify(text, [str(o) for o in res["options"]][:4])
                return "clarify"
            if kind == "noop":
                self.panel.send({"t": "heard", "text": res.get("heard") or text, "via": "claude"})
                return "none"
            closest = list(res.get("closest") or closest)
        self.panel.send({"t": "status", "text": _didnt_catch(closest), "level": "status"})
        return "none"

    async def _claude_fallback(self, text: str):
        fn = getattr(self.voice, "resolve_text", None) if self.voice is not None else None
        if fn is None:
            return None
        try:
            res = fn(text, self.brain_state)
            if inspect.isawaitable(res):
                res = await asyncio.wait_for(res, 8.0)
            return res
        except Exception:
            log.exception("Claude fallback failed")
            return None

    def _open_clarify(self, heard: str, options: List[str]) -> None:
        did = f"trk-{uuid.uuid4().hex[:8]}"
        self._tracker_dialogs[did] = {"options": options}
        self.dialog_open = True
        self.panel.send(
            {
                "t": "dialog",
                "dialog_id": did,
                "kind": "clarify",
                "text": f'Did you mean… ("{heard}")',
                "options": [{"id": o, "label": o.replace("_", " ").capitalize()} for o in options]
                + [{"id": "cancel", "label": "Cancel"}],
            }
        )

    def _answer_tracker_dialog(self, did: str, answer: str) -> None:
        d = self._tracker_dialogs.pop(did, None)
        if d and answer in d["options"]:
            self._run_commands([{"action": answer}], "claude")

    # ------------------------------------------------------------------ voice hooks (agent E)
    def on_transcript(self, text: str) -> None:
        """E calls this (any thread) with a final transcript."""
        text = (text or "").strip()
        if text:
            self._call_soon(lambda: self._spawn(self.resolve_text(text, "voice")))

    def on_voice_status(self, text: str, level: str = "status") -> None:
        """E calls this (any thread) for mic/STT status lines."""
        self.panel.send_threadsafe({"t": "status", "text": str(text), "level": level if level in ("status", "alert") else "status"})

    def on_mic_state(self, open_: bool, reason: str = "") -> None:
        """E calls this (any thread) when the mic actually opened/closed by itself (silence, cap, error)."""
        if not open_:
            self._call_soon(
                self.brain_send,
                {"t": "action", "action": "mic", "variant": "close", "source": "system", "now": self.clock()},
            )

    def _voice_call(self, name: str, *args) -> None:
        fn = getattr(self.voice, name, None) if self.voice is not None else None
        if fn is None:
            return
        try:
            fn(*args)
        except Exception:
            log.exception("voice.%s failed", name)


def _is_rect(r: Any) -> bool:
    return isinstance(r, dict) and all(isinstance(r.get(k), (int, float)) for k in ("x", "y", "w", "h"))


def _didnt_catch(closest: List[str]) -> str:
    if not closest:
        return "Didn't catch that."
    names = [c.replace("_", " ") for c in closest[:2]]
    return "Didn't catch that. Try: " + " or ".join(f'"{n}"' for n in names) + "."
