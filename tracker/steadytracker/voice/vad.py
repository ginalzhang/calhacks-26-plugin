"""Local voice-activity detector for always-listening mode and the fast tap-mode close. Pure; 20 ms frames.

Energy detector on the pre-gain RMS of each 20 ms frame (audio.py ``Chunk.level``), with:
- an adaptive noise floor (seeded from the quietest frame of a short warm-up when the stream opens): falls fast to quieter frames, creeps up slowly on idle frames (so a fan that starts
  later is learned), and is bumped after an utterance that only ended at the cap (steady loud noise);
- hysteresis: speech starts above ``max(START_MIN, floor * START_RATIO)`` and continues while frames stay above
  ``max(STAY_MIN, floor * STAY_RATIO)``;
- onset after ``start_ms`` (200 ms) of voiced frames, tolerating gaps <= ``GAP_MS`` (consonants, short dips);
- end after ``end_ms`` (settings.utteranceEndMs, default 450 ms) below the stay threshold.
The caller keeps a pre-roll ring (``preroll_frames``) so the start of the word reaches Cartesia.
"""

from __future__ import annotations

from collections import deque
from typing import Deque, Optional

FRAME_MS = 20
FRAME_SAMPLES = 320  # 20 ms at 16 kHz
START_MS = 200
DEFAULT_END_MS = 450
END_MS_MIN, END_MS_MAX = 250, 1500
PREROLL_MS = 300
GAP_MS = 60
START_MIN = 0.012
STAY_MIN = 0.008
START_RATIO = 3.5
STAY_RATIO = 2.0
FLOOR_INIT = 0.003
FLOOR_MIN = 0.0005


def clamp_end_ms(v: object) -> int:
    try:
        n = int(float(v))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return DEFAULT_END_MS
    return max(END_MS_MIN, min(END_MS_MAX, n))


class Vad:
    def __init__(self, end_ms: int = DEFAULT_END_MS, start_ms: int = START_MS, warmup_ms: int = 0, floor: float = FLOOR_INIT) -> None:
        self.end_ms = clamp_end_ms(end_ms)
        self.start_ms = start_ms
        self.floor = floor
        self._warm_left = warmup_ms
        self._warm_min = 0.0
        self._warm_n = 0
        self.in_speech = False
        self.speech_seen = False  # any onset since reset()
        self._run_ms = 0
        self._gap_ms = 0
        self.silence_ms = 0
        self._utt_sum = 0.0
        self._utt_n = 0

    @property
    def start_threshold(self) -> float:
        return max(START_MIN, self.floor * START_RATIO)

    @property
    def stay_threshold(self) -> float:
        return max(STAY_MIN, self.floor * STAY_RATIO)

    def reset(self) -> None:
        """New listening session (keeps the learned noise floor)."""
        self.in_speech = False
        self.speech_seen = False
        self._run_ms = 0
        self._gap_ms = 0
        self.silence_ms = 0

    def update(self, level: float) -> Optional[str]:
        """Feed one 20 ms frame's pre-gain RMS. Returns "start", "end" or None."""
        if self._warm_left > 0:
            # Quietest frame of the warm-up: steady room noise is learned, someone already talking is not
            # (speech has gaps), so the first command after the stream opens is still heard.
            self._warm_left -= FRAME_MS
            self._warm_min = level if self._warm_n == 0 else min(self._warm_min, level)
            self._warm_n += 1
            if self._warm_left <= 0:
                self.floor = max(FLOOR_MIN, self._warm_min)
            return None
        if not self.in_speech:
            voiced = level >= self.start_threshold
            if voiced:
                self._run_ms += FRAME_MS
                self._gap_ms = 0
            else:
                self._gap_ms += FRAME_MS
                if self._gap_ms > GAP_MS:
                    self._run_ms = 0
            # noise floor (idle only): fast down, slow up; voiced frames barely move it
            if level < self.floor:
                self.floor += 0.3 * (level - self.floor)
            else:
                self.floor += (0.002 if voiced else 0.02) * (level - self.floor)
            self.floor = max(FLOOR_MIN, self.floor)
            if self._run_ms >= self.start_ms:
                self.in_speech = True
                self.speech_seen = True
                self.silence_ms = 0
                self._utt_sum = 0.0
                self._utt_n = 0
                return "start"
            return None
        self._utt_sum += level
        self._utt_n += 1
        if level >= self.stay_threshold:
            self.silence_ms = 0
        else:
            self.silence_ms += FRAME_MS
        if self.silence_ms >= self.end_ms:
            self._end()
            return "end"
        return None

    def _end(self) -> None:
        self.in_speech = False
        self._run_ms = 0
        self._gap_ms = 0
        self.silence_ms = 0

    def force_end(self, capped: bool = False) -> None:
        """Utterance cut by the cap (or by the caller). After a cap, steady noise is learned into the floor."""
        if capped and self._utt_n:
            self.floor = max(self.floor, 0.5 * self._utt_sum / self._utt_n)
        self._end()


class PreRoll:
    """Ring of the last ``ms`` of 20 ms frames (pcm bytes)."""

    def __init__(self, ms: int = PREROLL_MS) -> None:
        self.frames: Deque[bytes] = deque(maxlen=max(1, ms // FRAME_MS))

    def add(self, pcm: bytes) -> None:
        self.frames.append(pcm)

    def drain(self) -> list:
        out = list(self.frames)
        self.frames.clear()
        return out
