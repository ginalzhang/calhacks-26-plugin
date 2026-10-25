"""MediaPipe Tasks HandLandmarker (Python, VIDEO mode) → LandmarkFrame dicts.

Same options as src/tracking/MediaPipeSource.ts: numHands 1, minHandDetectionConfidence 0.4,
float16 hand_landmarker.task, GPU delegate first then CPU (on creation failure or when
detect_for_video throws). Timestamps are strictly increasing ints (ms).

LandmarkFrame (src/tracking/LandmarkSource.ts):
  {t, width, height, hands: [{landmarks: [{x,y,z}]*21, score: handedness[0][0].score, handedness}], luma?}
Frames are RAW (not mirrored/rotated): the brain applies mirror/rotate.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

log = logging.getLogger("steady.tracker.landmarks")


def result_to_frame(result: Any, t: float, width: int, height: int, luma: Optional[float] = None) -> Dict[str, Any]:
    """HandLandmarkerResult → LandmarkFrame dict (pure; tested with fake result objects)."""
    hands: List[Dict[str, Any]] = []
    lms = getattr(result, "hand_landmarks", None) or []
    hd = getattr(result, "handedness", None) or []
    for i, pts in enumerate(lms):
        cats = hd[i] if i < len(hd) else []
        top = cats[0] if cats else None
        score = float(getattr(top, "score", 0.0) or 0.0) if top is not None else 0.0
        name = (getattr(top, "category_name", None) or getattr(top, "display_name", None) or "Right") if top else "Right"
        if name not in ("Left", "Right"):
            name = "Right"
        hands.append(
            {
                "landmarks": [{"x": float(p.x), "y": float(p.y), "z": float(getattr(p, "z", 0.0) or 0.0)} for p in pts],
                "score": score,
                "handedness": name,
            }
        )
    frame: Dict[str, Any] = {"t": float(t), "width": int(width), "height": int(height), "hands": hands}
    if luma is not None:
        frame["luma"] = float(luma)
    return frame


class MonotonicStamps:
    """Strictly increasing integer ms for detect_for_video (camera switches never go backwards)."""

    def __init__(self) -> None:
        self.last = -1

    def next(self, t_ms: float) -> int:
        ts = int(t_ms)
        if ts <= self.last:
            ts = self.last + 1
        self.last = ts
        return ts


class HandTracker:
    """Wraps mediapipe HandLandmarker. `detect(rgb, t_ms)` → result (or None on failure)."""

    def __init__(self, model_path: str, *, prefer_gpu: bool = True, on_warning=None) -> None:
        self.model_path = model_path
        self.delegate = "GPU" if prefer_gpu else "CPU"
        self._on_warning = on_warning
        self._lm = None
        self._stamps = MonotonicStamps()
        self._create(self.delegate)

    def _create(self, delegate: str) -> None:
        import mediapipe as mp  # noqa: F401
        from mediapipe.tasks import python as mp_tasks
        from mediapipe.tasks.python import vision

        if self._lm is not None:
            try:
                self._lm.close()
            except Exception:
                pass
            self._lm = None
        d = mp_tasks.BaseOptions.Delegate.GPU if delegate == "GPU" else mp_tasks.BaseOptions.Delegate.CPU
        opts = vision.HandLandmarkerOptions(
            base_options=mp_tasks.BaseOptions(model_asset_path=self.model_path, delegate=d),
            running_mode=vision.RunningMode.VIDEO,
            num_hands=1,
            min_hand_detection_confidence=0.4,
        )
        try:
            self._lm = vision.HandLandmarker.create_from_options(opts)
            self.delegate = delegate
            log.info("HandLandmarker ready (%s)", delegate)
        except Exception:
            if delegate == "GPU":
                log.warning("GPU HandLandmarker unavailable; using CPU", exc_info=True)
                self._warn("GPU tracking unavailable; using CPU.")
                self._create("CPU")
            else:
                raise

    def _warn(self, text: str) -> None:
        if self._on_warning:
            try:
                self._on_warning(text)
            except Exception:
                pass

    def detect(self, rgb, t_ms: float):
        import mediapipe as mp

        img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        ts = self._stamps.next(t_ms)
        try:
            return self._lm.detect_for_video(img, ts)
        except Exception:
            if self.delegate == "GPU":
                log.warning("GPU detect failed; switching to CPU", exc_info=True)
                self._warn("GPU tracking failed; using CPU.")
                self._create("CPU")
                try:
                    return self._lm.detect_for_video(img, self._stamps.next(t_ms))
                except Exception:
                    log.exception("CPU detect failed")
                    return None
            log.exception("detect failed")
            return None

    def close(self) -> None:
        if self._lm is not None:
            try:
                self._lm.close()
            except Exception:
                pass
            self._lm = None
