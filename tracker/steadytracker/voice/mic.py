"""Microphone source: sounddevice RawInputStream on the default input device at its native rate (float32 mono).

The native rate is re-read on every open (a Bluetooth headset switches the default device to 16/24 kHz), and the
DSP in audio.py resamples to 16 kHz. Opened only when the user opened the mic; closed on every close path.
"""

from __future__ import annotations

from typing import Any, Callable, Optional


class MicError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind  # "no_device" | "denied" | "failed"


class SoundDeviceMic:
    """``start(on_frames)`` -> (rate, channels). ``on_frames(raw_float32_bytes)`` runs on PortAudio's thread."""

    def __init__(self, device: Optional[Any] = None, block_ms: int = 20) -> None:
        self.device = device
        self.block_ms = block_ms
        self._stream: Any = None
        self.rate: float = 0.0
        self.channels = 1

    def start(self, on_frames: Callable[[bytes], None]) -> tuple:
        try:
            import sounddevice as sd
        except Exception as e:  # PortAudio missing
            raise MicError("failed", f"Audio library unavailable: {e}") from e
        try:
            info = sd.query_devices(self.device, kind="input")
        except Exception as e:
            raise MicError("no_device", "No microphone found.") from e
        rate = float(info.get("default_samplerate") or 48000.0)
        self.rate = rate
        self.channels = 1

        def cb(indata, _frames, _time, _status):
            on_frames(bytes(indata))

        try:
            self._stream = sd.RawInputStream(
                device=self.device,
                samplerate=rate,
                channels=1,
                dtype="float32",
                blocksize=max(64, int(rate * self.block_ms / 1000)),
                callback=cb,
            )
            self._stream.start()
        except Exception as e:
            self._stream = None
            raise MicError("failed", f"The microphone could not be opened: {e}") from e
        return rate, 1

    def stop(self) -> None:
        s, self._stream = self._stream, None
        if s is not None:
            try:
                s.stop()
            except Exception:
                pass
            try:
                s.close()
            except Exception:
                pass
