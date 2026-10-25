"""Replay files (tests/fixtures/replay/*.json, public/replay/*.json) → LandmarkFrame dicts.

Port of src/tracking/ReplaySource.ts expandCompactPoint: compact files carry one tracked point per
frame in camera px; it is expanded into 21 landmarks with a fixed resting-hand offset.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

#: Right hand, palm down, seen from above; camera px offsets from the wrist (landmark 0).
RIGHT_HAND_OFFSETS: List[Tuple[int, int]] = [
    (0, 0), (-25, -15), (-45, -35), (-58, -55), (-68, -70), (-20, -70), (-22, -95), (-23, -112),
    (-24, -126), (0, -74), (0, -102), (0, -120), (0, -135), (18, -68), (20, -94), (21, -110),
    (22, -123), (34, -58), (38, -78), (40, -92), (42, -104),
]


def expand_compact_point(x: float, y: float, landmark: int, handedness: str, width: int, height: int):
    sx = -1 if handedness == "Left" else 1
    off = RIGHT_HAND_OFFSETS[landmark] if 0 <= landmark < len(RIGHT_HAND_OFFSETS) else (0, 0)
    wx = x - sx * off[0]
    wy = y - off[1]
    return [{"x": (wx + sx * ox) / width, "y": (wy + oy) / height, "z": 0.0} for ox, oy in RIGHT_HAND_OFFSETS]


def load_replay(path: str) -> Dict[str, Any]:
    """→ {fps, width, height, entries: [(dt_ms, hands)]}."""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    w, h = int(data.get("width", 640)), int(data.get("height", 480))
    fps = float(data.get("fps", 30) or 30)
    frame_ms = 1000.0 / fps
    entries: List[Tuple[float, list]] = []
    if data.get("format") == "full":
        frames = data.get("frames") or []
        first = frames[0]["t"] if frames else 0
        entries = [(float(fr["t"]) - first, fr.get("hands") or []) for fr in frames]
    else:
        lm = int(data.get("landmark", 5))
        hand = data.get("handedness", "Right")
        pts: List[Optional[list]] = data.get("points") or []
        for i, p in enumerate(pts):
            if not p:
                dt = entries[-1][0] + frame_ms if entries else i * frame_ms
                entries.append((dt, []))
                continue
            t, x, y, score = p[0], p[1], p[2], p[3]
            entries.append(
                (float(t), [{"landmarks": expand_compact_point(x, y, lm, hand, w, h), "score": float(score), "handedness": hand}])
            )
    return {"fps": fps, "width": w, "height": h, "entries": entries, "name": data.get("name", "")}
