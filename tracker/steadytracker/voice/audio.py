"""Capture DSP, a port of public/steady-capture-worklet.js (§8). Pure Python, no numpy.

- Downmix to mono, box-filter (averaging) resample from the device's native rate to 16 kHz.
- Gain normalisation for quiet speech: a slow RMS envelope drives a gain of 1-8x toward -20 dBFS; the gain
  only rises while there is signal above the noise floor; a soft limiter keeps samples within [-1, 1].
- Emits 100 ms chunks (1600 samples) of pcm_s16le bytes plus the pre-gain RMS ("level", voice activity) and
  post-gain RMS ("meter", level meter).
"""

from __future__ import annotations

import math
import sys
from array import array
from dataclasses import dataclass
from typing import Iterable, List, Sequence

TARGET_RATE = 16000
CHUNK = 1600  # 100 ms at 16 kHz
TARGET_RMS = 0.1  # about -20 dBFS
MAX_GAIN = 8.0
NOISE_FLOOR = 0.004


@dataclass
class Chunk:
    pcm: bytes  # frame_samples little-endian int16 samples (1600 -> 3200 bytes)
    level: float  # pre-gain RMS (voice activity)
    meter: float  # post-gain RMS (level meter)
    gain: float


def float_to_int16(y: float) -> int:
    if y > 1.0:
        y = 1.0
    elif y < -1.0:
        y = -1.0
    return int(y * 0x8000) if y < 0 else int(y * 0x7FFF)


class CaptureProcessor:
    """Stateful: feed it float32 frames at ``input_rate`` (any channel count); collect ``Chunk``s."""

    def __init__(self, input_rate: float, channels: int = 1, frame_samples: int = CHUNK) -> None:
        """``frame_samples``: output frame length at 16 kHz (1600 = 100 ms Cartesia chunks; 320 = 20 ms VAD frames)."""
        self.frame_samples = max(1, int(frame_samples))
        self.channels = max(1, int(channels))
        self.set_rate(input_rate)
        self.acc = 0.0
        self.acc_n = 0
        self.pos = 0.0
        self.last = 0.0
        self.out = array("h")
        self.env = 0.0
        self.gain = 1.0
        self.raw_sq = 0.0
        self.gain_sq = 0.0

    def set_rate(self, input_rate: float) -> None:
        """Re-read when the input device changes (Bluetooth headset at 16/24 kHz, 44.1 kHz built-in, ...)."""
        self.input_rate = float(input_rate) if input_rate and input_rate > 0 else float(TARGET_RATE)
        self.step = self.input_rate / TARGET_RATE

    def process(self, samples: Sequence[float]) -> List[Chunk]:
        """``samples``: interleaved float frames (len = frames * channels). Returns completed chunks."""
        out: List[Chunk] = []
        ch = self.channels
        if ch == 1:
            mono: Iterable[float] = samples
        else:
            mono = (sum(samples[i : i + ch]) / ch for i in range(0, len(samples) - ch + 1, ch))
        step = self.step
        for x in mono:
            self.acc += x
            self.acc_n += 1
            self.pos += 1.0
            # `while`, not `if`: a narrowband (8 kHz) input needs more than one output per input sample.
            while self.pos >= step:
                self.pos -= step
                s = self.acc / self.acc_n if self.acc_n > 0 else self.last
                self.last = s
                self.acc = 0.0
                self.acc_n = 0
                c = self._emit(s)
                if c is not None:
                    out.append(c)
        return out

    def _emit(self, s: float):
        a = s * s
        k = 0.01 if a > self.env else 0.0005  # envelope: fast attack, slow release
        self.env += k * (a - self.env)
        rms = math.sqrt(self.env)
        if rms > NOISE_FLOOR:
            want = min(MAX_GAIN, max(1.0, TARGET_RMS / rms))
            # gain falls quickly (protect against clipping) and rises slowly
            self.gain += (0.01 if want < self.gain else 0.0002) * (want - self.gain)
        y = s * self.gain
        if y > 0.9 or y < -0.9:
            y = math.tanh(y)  # soft limiter
        self.raw_sq += s * s
        self.gain_sq += y * y
        self.out.append(float_to_int16(y))
        if len(self.out) == self.frame_samples:
            buf = self.out
            if sys.byteorder != "little":
                buf.byteswap()
            c = Chunk(
                pcm=buf.tobytes(),
                level=math.sqrt(self.raw_sq / self.frame_samples),
                meter=math.sqrt(self.gain_sq / self.frame_samples),
                gain=self.gain,
            )
            self.out = array("h")
            self.raw_sq = 0.0
            self.gain_sq = 0.0
            return c
        return None


def float32_bytes_to_list(buf: bytes) -> array:
    """sounddevice RawInputStream(dtype='float32') delivers a native-endian float32 buffer."""
    a = array("f")
    a.frombytes(bytes(buf))
    return a


class Chunker:
    """Joins 20 ms frames into the 100 ms (3200-byte) binary chunks Cartesia gets. A partial tail is dropped."""

    def __init__(self, size: int = CHUNK * 2) -> None:
        self.size = size
        self._buf = bytearray()

    def add(self, pcm: bytes) -> List[bytes]:
        self._buf.extend(pcm)
        out = []
        while len(self._buf) >= self.size:
            out.append(bytes(self._buf[: self.size]))
            del self._buf[: self.size]
        return out

    def reset(self) -> None:
        self._buf.clear()
