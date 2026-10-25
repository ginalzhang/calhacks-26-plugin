"""Steady voice (agent E): mic capture -> Cartesia Ink 2 STT -> brain grammar -> Claude fallback; Sonic TTS.

Entry point for the tracker (agent C): ``VoiceController`` in ``controller.py``. Importing this package
never opens the microphone, never imports sounddevice and never touches the network.
"""

from __future__ import annotations

__all__ = ["VoiceController", "load_keys"]


def __getattr__(name: str):  # lazy: keep `import steadytracker.voice` cheap and side-effect free
    if name == "VoiceController":
        from .controller import VoiceController

        return VoiceController
    if name == "load_keys":
        from .keys import load_keys

        return load_keys
    raise AttributeError(name)
