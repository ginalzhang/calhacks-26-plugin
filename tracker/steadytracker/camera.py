"""Frame sources: the real camera (OpenCV AVFoundation + HandLandmarker) and replay files (--fake-camera).

Both run on their own thread and call `on_frame(landmark_frame, image_bgr_or_None)`.

Camera indices: OpenCV's AVFoundation backend opens index i of
`[AVCaptureDevice devicesWithMediaType:Video] + [... Muxed]` sorted by uniqueID (checked against the
cv2 5.0 binary's selectors), so `list_cameras()` builds the same list with PyObjC to get names
("Desk View" is preferred by default). Frames are sent RAW; mirror/rotate are the brain's job.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Dict, List, Optional

from .config import CAMERA_FPS, CAMERA_H, CAMERA_W, LUMA_EVERY, now_ms
from .landmarks import result_to_frame

log = logging.getLogger("steady.tracker.camera")

OnFrame = Callable[[Dict[str, Any], Any], None]


# ------------------------------------------------------------------ device list
def list_cameras() -> List[Dict[str, Any]]:
    """[{index, name, unique_id}] in OpenCV's AVFoundation index order. [] if AVFoundation is missing.
    Reads device names only; never opens a device and never prompts."""
    try:
        import AVFoundation as AVF
    except Exception:
        log.warning("AVFoundation (pyobjc) unavailable; camera names unknown")
        return []
    devs = []
    for mt in (AVF.AVMediaTypeVideo, AVF.AVMediaTypeMuxed):
        try:
            devs.extend(list(AVF.AVCaptureDevice.devicesWithMediaType_(mt) or []))
        except Exception:
            log.exception("devicesWithMediaType failed")
    devs.sort(key=lambda d: str(d.uniqueID()))
    return [{"index": i, "name": str(d.localizedName()), "unique_id": str(d.uniqueID())} for i, d in enumerate(devs)]


def pick_default(cameras: List[Dict[str, Any]], preferred_name: Optional[str] = None) -> int:
    """Saved camera name → first "Desk View" → index 0."""
    if preferred_name:
        for c in cameras:
            if c.get("name") == preferred_name:
                return int(c["index"])
    for c in cameras:
        if "desk view" in str(c.get("name", "")).lower():
            return int(c["index"])
    return 0


# ------------------------------------------------------------------ base
class FrameSource:
    kind = "base"

    def __init__(self) -> None:
        self._on_frame: Optional[OnFrame] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self.selected = 0
        self.camera_fps = 0.0
        self._stamps: List[float] = []

    def cameras(self) -> List[Dict[str, Any]]:
        return []

    def start(self, on_frame: OnFrame) -> None:
        self._on_frame = on_frame
        self._stop.clear()
        self._thread = threading.Thread(target=self._guarded_run, name=f"steady-{self.kind}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        t = self._thread
        if t is not None and t is not threading.current_thread():
            t.join(timeout=2)
        self._thread = None

    def select(self, index: int) -> None:
        """Switch camera (restarts the capture thread)."""
        self.selected = int(index)
        if self._on_frame is not None and self._thread is not None:
            cb = self._on_frame
            self.stop()
            self.start(cb)

    def _guarded_run(self) -> None:
        try:
            self._run()
        except Exception:
            log.exception("%s source crashed", self.kind)

    def _run(self) -> None:  # pragma: no cover - abstract
        raise NotImplementedError

    def _count(self, t: float) -> None:
        self._stamps.append(t)
        cutoff = t - 1000.0
        while self._stamps and self._stamps[0] < cutoff:
            self._stamps.pop(0)
        self.camera_fps = float(len(self._stamps))

    def _emit(self, frame: Dict[str, Any], image: Any) -> None:
        cb = self._on_frame
        if cb is not None:
            try:
                cb(frame, image)
            except Exception:
                log.exception("on_frame failed")


# ------------------------------------------------------------------ real camera
def _cv2_to_rgb(img):
    import cv2

    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def _cv2_luma(img) -> float:
    import cv2

    small = cv2.resize(img, (80, 60), interpolation=cv2.INTER_AREA)
    return float(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).mean())


def _cv2_open(index: int):
    import cv2

    cap = cv2.VideoCapture(int(index), cv2.CAP_AVFOUNDATION)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAMERA_W)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAMERA_H)
    cap.set(cv2.CAP_PROP_FPS, CAMERA_FPS)
    try:
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    except Exception:
        pass
    return cap


class CameraSource(FrameSource):
    """Real camera → HandLandmarker. Everything system-facing is injectable for tests:
    `open_capture(index)` → object with read()/release()/isOpened(); `tracker` with detect(rgb, t);
    `to_rgb(img)`, `luma(img)`; `lister()` → cameras."""

    kind = "camera"

    def __init__(
        self,
        tracker_factory: Callable[[], Any],
        *,
        open_capture: Callable[[int], Any] = _cv2_open,
        to_rgb: Callable[[Any], Any] = _cv2_to_rgb,
        luma: Callable[[Any], float] = _cv2_luma,
        lister: Callable[[], List[Dict[str, Any]]] = list_cameras,
        clock: Callable[[], float] = now_ms,
        on_warning: Optional[Callable[[str], None]] = None,
        reopen_s: float = 1.0,
    ) -> None:
        super().__init__()
        self._tracker_factory = tracker_factory
        self._tracker = None
        self._open = open_capture
        self._to_rgb = to_rgb
        self._luma = luma
        self._lister = lister
        self._clock = clock
        self._on_warning = on_warning
        self._reopen_s = reopen_s
        self._last_t = -1.0
        self.frames = 0

    def cameras(self) -> List[Dict[str, Any]]:
        try:
            return self._lister()
        except Exception:
            log.exception("camera list failed")
            return []

    def _warn(self, text: str) -> None:
        if self._on_warning:
            try:
                self._on_warning(text)
            except Exception:
                pass

    def _run(self) -> None:
        if self._tracker is None:
            self._tracker = self._tracker_factory()
        cap = None
        failures = 0
        last_luma: Optional[float] = None
        try:
            while not self._stop.is_set():
                if cap is None:
                    cap = self._open(self.selected)
                    if cap is None or not cap.isOpened():
                        self._warn("Camera not available. Check Camera permission for Steady Tracker.")
                        cap = None
                        self._stop.wait(self._reopen_s)
                        continue
                ok, img = cap.read()
                if not ok or img is None:
                    failures += 1
                    if failures >= 30:
                        self._warn("The camera stopped sending frames; reopening it.")
                        try:
                            cap.release()
                        except Exception:
                            pass
                        cap = None
                        failures = 0
                        self._stop.wait(self._reopen_s)
                    else:
                        self._stop.wait(0.01)
                    continue
                failures = 0
                t = self._clock()
                if t <= self._last_t:
                    t = self._last_t + 1.0
                self._last_t = t
                self._count(t)
                h, w = (img.shape[0], img.shape[1]) if hasattr(img, "shape") else (CAMERA_H, CAMERA_W)
                if self.frames % LUMA_EVERY == 0:
                    try:
                        last_luma = self._luma(img)
                    except Exception:
                        last_luma = None
                self.frames += 1
                result = self._tracker.detect(self._to_rgb(img), t)
                frame = result_to_frame(result, t, w, h, last_luma)
                self._emit(frame, img)
        finally:
            if cap is not None:
                try:
                    cap.release()
                except Exception:
                    pass


# ------------------------------------------------------------------ replay (--fake-camera)
class ReplaySource(FrameSource):
    """Plays a replay JSON in real time (speed× faster for tests). `t` comes from the tracker clock,
    strictly increasing. No image (the preview draws the point on a blank thumbnail)."""

    kind = "replay"

    def __init__(
        self,
        path: str,
        *,
        speed: float = 1.0,
        loop: bool = False,
        clock: Callable[[], float] = now_ms,
        on_end: Optional[Callable[[], None]] = None,
    ) -> None:
        super().__init__()
        from .replay import load_replay

        self.path = path
        self.replay = load_replay(path)
        self.speed = max(0.01, float(speed))
        self.loop = loop
        self._clock = clock
        self._on_end = on_end
        self._last_t = -1.0
        self.emitted = 0

    def cameras(self) -> List[Dict[str, Any]]:
        return [{"index": 0, "name": f"Replay: {self.replay.get('name') or 'file'}"}]

    def _run(self) -> None:
        entries = self.replay["entries"]
        w, h = self.replay["width"], self.replay["height"]
        while not self._stop.is_set():
            start = time.monotonic()
            for dt, hands in entries:
                target = start + (dt / 1000.0) / self.speed
                delay = target - time.monotonic()
                if delay > 0 and self._stop.wait(delay):
                    return
                if self._stop.is_set():
                    return
                t = self._clock()
                if t <= self._last_t:
                    t = self._last_t + 1.0
                self._last_t = t
                self._count(t)
                self.emitted += 1
                self._emit({"t": t, "width": w, "height": h, "hands": hands}, None)
            if not self.loop:
                break
        if self._on_end:
            try:
                self._on_end()
            except Exception:
                log.exception("on_end failed")
