"""Panel `preview`: 160×120 JPEG (base64) of the camera with the tracked point drawn, ≤ 5 fps.

The thumbnail is mirrored/rotated like the brain treats the landmarks (settings.mirrorCamera /
rotateCamera), so what the user sees matches the pointer. Without a camera image (replay) the point is
drawn on a dark blank thumbnail. Uses cv2 + numpy (lazy import); tests inject a fake encoder.
"""

from __future__ import annotations

import base64
from typing import Any, Optional, Tuple

from .config import PREVIEW_H, PREVIEW_W

Point = Optional[Tuple[float, float]]


def tracked_point(frame: Optional[dict], landmark: int = 5) -> Point:
    """Normalised (x, y) of the tracked landmark of hands[0], raw camera orientation."""
    if not frame:
        return None
    hands = frame.get("hands") or []
    if not hands:
        return None
    lms = hands[0].get("landmarks") or []
    if not lms:
        return None
    p = lms[landmark] if 0 <= landmark < len(lms) else lms[0]
    return float(p["x"]), float(p["y"])


def cv2_encoder(image: Any, point: Point, mirror: bool, rotate: bool, score: Optional[float] = None) -> bytes:
    import cv2
    import numpy as np

    if image is None:
        thumb = np.full((PREVIEW_H, PREVIEW_W, 3), 32, dtype=np.uint8)
    else:
        thumb = cv2.resize(image, (PREVIEW_W, PREVIEW_H), interpolation=cv2.INTER_AREA)
    if rotate:
        thumb = cv2.rotate(thumb, cv2.ROTATE_180)
    elif mirror:
        thumb = cv2.flip(thumb, 1)
    if point is not None:
        x, y = point
        if rotate:
            x, y = 1 - x, 1 - y
        elif mirror:
            x = 1 - x
        cx, cy = int(round(x * PREVIEW_W)), int(round(y * PREVIEW_H))
        good = score is None or score >= 0.6
        color = (80, 220, 80) if good else (0, 160, 255)  # BGR: green, amber when weak
        cv2.circle(thumb, (cx, cy), 6, (0, 0, 0), 3, lineType=cv2.LINE_AA)
        cv2.circle(thumb, (cx, cy), 6, color, 2, lineType=cv2.LINE_AA)
    ok, buf = cv2.imencode(".jpg", thumb, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
    if not ok:
        raise RuntimeError("jpeg encode failed")
    return bytes(buf)


def preview_message(jpeg: bytes) -> dict:
    return {"t": "preview", "jpeg_b64": base64.b64encode(jpeg).decode("ascii"), "w": PREVIEW_W, "h": PREVIEW_H}
