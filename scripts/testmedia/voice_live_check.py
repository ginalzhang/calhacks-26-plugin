"""Live voice check WITHOUT the microphone: plays synthetic speech (macOS `say`) through the real always-listening
VAD → real Cartesia Ink 2 → real brain grammar, and reports speech-end → dispatch latency per command.
usage: tracker/.venv/bin/python scripts/testmedia/voice_live_check.py WORD.wav [WORD.wav ...]
"""
import json, os, subprocess, sys, threading, time, wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tracker")); sys.path.insert(0, str(ROOT / "helper"))
from steadytracker.voice.controller import VoiceController  # noqa: E402
from steadytracker.envkeys import load_keys  # noqa: E402

RATE = 48000

def load(p):
    w = wave.open(p); a = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0
    return a

clips = [(Path(p).stem, load(p)) for p in sys.argv[1:]]
silence = lambda s: np.zeros(int(RATE * s), np.float32)
timeline, ends, t = [silence(1.5)], {}, 1.5
for name, a in clips:
    timeline.append(a); t += len(a) / RATE; ends[name] = t; timeline.append(silence(2.5)); t += 2.5
audio = np.concatenate(timeline)

class FileMic:
    def __init__(self): self._stop = False; self.t0 = None
    def start(self, on_frames):
        def run():
            self.t0 = time.monotonic(); n = int(RATE * 0.02)
            for i in range(0, len(audio), n):
                if self._stop: return
                on_frames(audio[i:i + n].tobytes())
                target = self.t0 + (i + n) / RATE
                d = target - time.monotonic()
                if d > 0: time.sleep(d)
        threading.Thread(target=run, daemon=True).start(); return RATE, 1
    def stop(self): self._stop = True

brain = subprocess.Popen(["node", str(ROOT / "tracker/brain/dist/brain.mjs")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
brain.stdin.write(json.dumps({"t": "init", "settings": {}, "calibration": None, "now": 0}) + "\n"); brain.stdin.flush()
lock = threading.Lock(); seq = [0]
def parse(text, opts):
    with lock:
        seq[0] += 1; rid = f"v{seq[0]}"
        brain.stdin.write(json.dumps({"t": "parse", "id": rid, "text": text, "opts": {"mode": opts.get("mode", "voice")}}) + "\n"); brain.stdin.flush()
        while True:
            m = json.loads(brain.stdout.readline())
            if m.get("t") == "parsed" and m.get("id") == rid: return m["result"]

mic = FileMic(); results = []
def dispatch(action, variant, arg, source):
    at = time.monotonic() - mic.t0; results.append((action, at)); print(f"  dispatch {action!r} at {at:.2f}s ({source})", flush=True)
settings = {"alwaysListen": True, "utteranceEndMs": 450, "quiet": False, "inputs": {"voice": True}, "micCapMs": 15000, "micSilenceMs": 2000, "tts": False}
vc = VoiceController(parse, dispatch, lambda txt, lvl: print("  status:", txt, flush=True), lambda txt, via: print(f"  heard: {txt!r} via {via}", flush=True),
                     False, lambda: settings, load_keys(str(ROOT / ".env.local")), mic_factory=lambda: mic, prewarm=False)
vc.on_settings(settings)
time.sleep(len(audio) / RATE + 3)
vc.shutdown(); brain.kill()
print("\nspeech end → dispatch:")
for name, end in ends.items():
    hit = [at for a, at in results if name in a or (name == "blue" and a == "colour_blue")]
    print(f"  {name:7s} {('%.0f ms' % ((hit[0] - end) * 1000)) if hit else 'NOT DISPATCHED'}")
