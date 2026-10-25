"""When does an open mic close by itself? Port of src/voice/micPolicy.ts (§8, §0 rule 5). Pure; injected times.

- Push-to-talk: only on release. No onset timeout, no silence close, no cap while held.
- Tap: on the next tap, on ``silence_ms`` without speech activity *after speech has started*, or at ``cap_ms``
  counted from speech onset. Nothing closes before speech starts, so there is no onset timeout in either mode.
Speech onset/activity = a transcript delta, or a 100 ms chunk whose pre-gain RMS is >= VOICE_LEVEL.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Literal, Optional

VOICE_LEVEL = 0.015

Mode = Literal["tap", "ptt"]


@dataclass(frozen=True)
class MicTiming:
    mode: Mode
    speech_start_at: Optional[float] = None  # ms
    last_activity_at: Optional[float] = None  # ms


def new_mic_timing(mode: Mode) -> MicTiming:
    return MicTiming(mode=mode)


def note_activity(m: MicTiming, t: float) -> MicTiming:
    return replace(m, speech_start_at=m.speech_start_at if m.speech_start_at is not None else t, last_activity_at=t)


def auto_close_reason(m: MicTiming, now: float, silence_ms: float, cap_ms: float) -> Optional[str]:
    if m.mode == "ptt" or m.speech_start_at is None:
        return None
    if now - m.speech_start_at >= cap_ms:
        return "cap"
    if m.last_activity_at is not None and now - m.last_activity_at >= silence_ms:
        return "silence"
    return None
