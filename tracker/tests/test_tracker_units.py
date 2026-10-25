"""Pure pieces: landmark conversion, camera loop with fakes, replay expansion, persistence, keys, keymap."""

import threading
import time
from types import SimpleNamespace as NS

import pytest

from trackertest_kit import REPLAY_DIR, wait_until  # noqa: F401  (sets sys.path)
from steadytracker.app import release_reason
from steadytracker.camera import CameraSource, pick_default
from steadytracker.envkeys import load_keys, parse_env_file
from steadytracker.landmarks import MonotonicStamps, result_to_frame
from steadytracker.persistence import Store, deep_merge
from steadytracker.preview import preview_message, tracked_point
from steadytracker.replay import expand_compact_point, load_replay

pytestmark = pytest.mark.P1


def fake_result(score=0.9, name="Left", n=21):
    pts = [NS(x=i / 100, y=i / 200, z=-0.01) for i in range(n)]
    return NS(hand_landmarks=[pts], handedness=[[NS(score=score, category_name=name)]])


def test_result_to_frame_matches_landmark_frame_shape():
    f = result_to_frame(fake_result(), 1234.5, 640, 480, 87.0)
    assert f["t"] == 1234.5 and f["width"] == 640 and f["height"] == 480 and f["luma"] == 87.0
    h = f["hands"][0]
    assert h["score"] == 0.9 and h["handedness"] == "Left" and len(h["landmarks"]) == 21
    assert h["landmarks"][10] == {"x": 0.1, "y": 0.05, "z": -0.01}
    empty = result_to_frame(NS(hand_landmarks=[], handedness=[]), 1, 640, 480)
    assert empty == {"t": 1.0, "width": 640, "height": 480, "hands": []}
    assert result_to_frame(None, 2, 640, 480)["hands"] == []


def test_monotonic_stamps_strictly_increase():
    s = MonotonicStamps()
    assert [s.next(t) for t in (10.2, 10.7, 9.0, 11.0, 50)] == [10, 11, 12, 13, 50]


class FakeCapture:
    def __init__(self, n=40):
        self.n = n
        self.released = False

    def isOpened(self):
        return True

    def read(self):
        if self.n <= 0:
            time.sleep(0.005)
            return False, None
        self.n -= 1
        return True, NS(shape=(480, 640, 3))

    def release(self):
        self.released = True


class FakeLandmarker:
    def __init__(self):
        self.stamps = []

    def detect(self, rgb, t):
        self.stamps.append(t)
        return fake_result(name="Right")


def test_camera_source_with_fake_capture_and_landmarker():
    lm = FakeLandmarker()
    caps = []
    frames = []
    done = threading.Event()
    clock = iter(range(1000, 100000, 3))

    def opener(i):
        caps.append(i)
        return FakeCapture(25)

    def on_frame(f, img):
        frames.append(f)
        if len(frames) == 25:
            done.set()

    src = CameraSource(lambda: lm, open_capture=opener, to_rgb=lambda i: i, luma=lambda i: 99.0,
                       lister=lambda: [{"index": 0, "name": "Cam"}], clock=lambda: float(next(clock)))
    src.selected = 0
    src.start(on_frame)
    assert done.wait(3)
    src.stop()
    ts = [f["t"] for f in frames]
    assert ts == sorted(ts) and len(set(ts)) == len(ts)
    assert frames[0]["luma"] == 99.0 and frames[0]["hands"][0]["handedness"] == "Right"
    assert caps == [0]


def test_pick_default_prefers_saved_then_desk_view():
    cams = [{"index": 0, "name": "FaceTime HD Camera"}, {"index": 1, "name": "Zayan's iPhone Desk View Camera"}]
    assert pick_default(cams) == 1
    assert pick_default(cams, "FaceTime HD Camera") == 0
    assert pick_default([], None) == 0


def test_replay_expansion_matches_typescript():
    lms = expand_compact_point(300, 200, 5, "Right", 640, 480)
    assert len(lms) == 21
    assert lms[5] == pytest.approx({"x": 300 / 640, "y": 200 / 480, "z": 0.0})
    assert lms[0] == pytest.approx({"x": 320 / 640, "y": 270 / 480, "z": 0.0})
    left = expand_compact_point(300, 200, 5, "Left", 640, 480)
    assert left[5] == pytest.approx(lms[5]) and left[0]["x"] == pytest.approx(280 / 640)
    rep = load_replay(str(REPLAY_DIR / "no-hand.json"))
    assert rep["entries"] and rep["width"] == 640


def test_store_round_trip(tmp_path):
    st = Store(str(tmp_path / "Steady"))
    assert st.settings() == {} and st.latest_calibration() is None
    st.merge_settings({"steadiness": 60, "inputs": {"camera": True, "voice": True}})
    st.merge_settings({"inputs": {"voice": False}})
    assert st.settings() == {"steadiness": 60, "inputs": {"camera": True, "voice": False}}
    st.save_calibration({"handedness": "Right", "gain": 2, "createdAt": 10})
    st.save_calibration({"handedness": "Left", "gain": 3, "createdAt": 20})
    assert set(st.calibrations()) == {"Left", "Right"}
    assert st.latest_calibration()["gain"] == 3
    st.save("aliases", {"fluffy": "b) Airbrush Soft"})
    assert Store(str(tmp_path / "Steady")).aliases() == {"fluffy": "b) Airbrush Soft"}
    (tmp_path / "Steady" / "profiles.json").write_text("{broken")
    assert st.profiles() == {}
    assert deep_merge({"a": {"b": 1}}, {"a": {"c": 2}, "d": 3}) == {"a": {"b": 1, "c": 2}, "d": 3}


def test_env_keys_file_first_then_env(tmp_path):
    f = tmp_path / ".env.local"
    f.write_text('# keys\nexport ANTHROPIC_API_KEY="sk-file"\nCARTESIA_API_KEY=ck # comment\nOTHER=1\n')
    keys = load_keys(str(f), env={"ANTHROPIC_API_KEY": "sk-env", "CARTESIA_VOICE_ID": "v1"})
    assert keys == {"ANTHROPIC_API_KEY": "sk-file", "CARTESIA_API_KEY": "ck", "CARTESIA_VOICE_ID": "v1"}
    assert parse_env_file("A='x y'\n") == {"A": "x y"}
    assert load_keys(str(tmp_path / "missing"), env={}) == {}


def test_keys_are_never_logged(tmp_path, caplog):
    f = tmp_path / ".env.local"
    f.write_text("ANTHROPIC_API_KEY=sk-secret-123\n")
    with caplog.at_level("DEBUG"):
        load_keys(str(f), env={})
    assert "sk-secret-123" not in caplog.text


def test_release_reasons():
    assert release_reason("up") is None
    assert release_reason("brain crash") is None
    assert release_reason("watchdog: no message for 300 ms") == "watchdog"
    assert release_reason("hotkey ptt_down") == "ptt"
    assert release_reason("hotkey pause") == "hotkey"
    assert release_reason("pause") == "pause"
    assert release_reason("krita quit") == "krita_gone"
    assert release_reason("exception in pump") == "exception"


def test_preview_helpers():
    f = {"hands": [{"landmarks": [{"x": i / 21, "y": 0.5, "z": 0} for i in range(21)], "score": 0.9}]}
    assert tracked_point(f, 5) == (5 / 21, 0.5)
    assert tracked_point({"hands": []}) is None
    m = preview_message(b"abc")
    assert m == {"t": "preview", "jpeg_b64": "YWJj", "w": 160, "h": 120}
