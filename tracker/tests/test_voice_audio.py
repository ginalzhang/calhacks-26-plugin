"""Agent E: capture DSP (port of steady-capture-worklet.js) and the mic close policy."""

import math
import struct
from array import array

import pytest

import voice_fakes  # noqa: F401  (sys.path)
from steadytracker.voice.audio import CHUNK, MAX_GAIN, CaptureProcessor, float32_bytes_to_list, float_to_int16
from steadytracker.voice.micpolicy import VOICE_LEVEL, auto_close_reason, new_mic_timing, note_activity

pytestmark = pytest.mark.P2a


def sine(rate, seconds, freq=440.0, amp=0.5, channels=1):
    n = int(rate * seconds)
    out = []
    for i in range(n):
        v = amp * math.sin(2 * math.pi * freq * i / rate)
        out.extend([v] * channels)
    return out


@pytest.mark.parametrize("rate", [48000, 44100, 24000, 16000, 8000])
def test_resampler_emits_16k_100ms_int16_chunks(rate):
    p = CaptureProcessor(rate)
    chunks = p.process(sine(rate, 1.0))
    # one second of input -> ten 100 ms chunks of 1600 samples (box filter, fractional step)
    assert len(chunks) in (9, 10)
    for c in chunks:
        assert len(c.pcm) == CHUNK * 2 == 3200
        samples = struct.unpack("<1600h", c.pcm)
        assert max(samples) <= 32767 and min(samples) >= -32768


def test_chunking_carries_across_calls():
    p = CaptureProcessor(48000)
    got = []
    data = sine(48000, 0.5)
    for i in range(0, len(data), 960):  # 20 ms blocks
        got += p.process(data[i : i + 960])
    assert len(got) == 5


def test_stereo_is_downmixed():
    mono = CaptureProcessor(16000, 1).process(sine(16000, 0.2))
    stereo = CaptureProcessor(16000, 2).process(sine(16000, 0.2, channels=2))
    assert [c.pcm for c in mono] == [c.pcm for c in stereo]


def test_level_is_pre_gain_and_quiet_speech_is_boosted():
    p = CaptureProcessor(16000)
    chunks = p.process(sine(16000, 3.0, amp=0.02))
    rms = 0.02 / math.sqrt(2)
    assert abs(chunks[-1].level - rms) < 0.002  # pre-gain RMS
    assert chunks[-1].meter > chunks[-1].level * 1.5  # gain normalisation lifted quiet speech
    assert 1.0 <= chunks[-1].gain <= MAX_GAIN


def test_silence_is_not_pumped_up():
    p = CaptureProcessor(16000)
    chunks = p.process([0.001] * 32000)
    assert chunks[-1].gain == pytest.approx(1.0)
    assert chunks[-1].level < VOICE_LEVEL


def test_soft_limiter_and_int16_conversion():
    p = CaptureProcessor(16000)
    chunks = p.process([1.5, -1.5] * 1600)
    s = struct.unpack("<1600h", chunks[0].pcm)
    assert max(s) <= 32767 and min(s) >= -32768
    assert float_to_int16(1.0) == 32767 and float_to_int16(-1.0) == -32768 and float_to_int16(0.0) == 0


def test_float32_bytes_roundtrip():
    raw = array("f", [0.25, -0.5]).tobytes()
    assert list(float32_bytes_to_list(raw)) == [0.25, -0.5]


# ------------------------------------------------------------------------------------------- mic policy
def test_tap_never_closes_before_speech_onset():
    m = new_mic_timing("tap")
    assert auto_close_reason(m, 10 * 60_000, 2000, 15000) is None  # no onset timeout


def test_tap_closes_on_silence_after_onset():
    m = note_activity(new_mic_timing("tap"), 1000)
    m = note_activity(m, 1500)
    assert auto_close_reason(m, 3400, 2000, 15000) is None
    assert auto_close_reason(m, 3500, 2000, 15000) == "silence"


def test_tap_closes_at_cap_from_onset():
    m = new_mic_timing("tap")
    t = 1000
    m = note_activity(m, t)
    while t < 16000:
        t += 100
        m = note_activity(m, t)  # continuous speech
    assert auto_close_reason(m, 16000, 2000, 15000) == "cap"


def test_ptt_never_auto_closes():
    m = note_activity(new_mic_timing("ptt"), 0)
    assert auto_close_reason(m, 60_000, 1000, 15000) is None
    assert auto_close_reason(m, 10 * 60_000, 1000, 15000) is None
