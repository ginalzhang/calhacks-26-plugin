"""Builds a synthetic camera clip from a real hand photo: hold still → draw a curve → hold still → move away.
Used to test Steady Tracker end to end through the REAL MediaPipe path (`run-tracker.sh --video clip.mp4`).

usage: python make_hand_video.py HAND.jpg OUT.mp4 [--mirror-check]
"""
import math
import sys

import cv2
import numpy as np

W, H, FPS = 640, 480, 30


def hand_patch(path):
    img = cv2.imread(path)
    h, w = img.shape[:2]
    # The MediaPipe sample photos are portrait shots of one hand on a plain background: scale so the hand
    # fills ~45 % of the frame height, like a hand ~50 cm from a laptop camera.
    scale = (H * 0.45) / h
    return cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)


def path_points():
    """(x, y) of the patch centre per frame, camera px."""
    pts = []
    def hold(x, y, secs):
        for i in range(int(secs * FPS)):
            # ±0.6 px of natural micro-jitter so it is a *real* hold, not a frozen frame
            pts.append((x + 0.6 * math.sin(i * 1.7), y + 0.6 * math.cos(i * 2.3)))
    def move(a, b, secs, wiggle=0.0):
        n = int(secs * FPS)
        for i in range(1, n + 1):
            u = i / n
            x = a[0] + (b[0] - a[0]) * u
            y = a[1] + (b[1] - a[1]) * u + wiggle * math.sin(u * math.pi * 2)
            pts.append((x, y))
    hold(240, 260, 1.0)                      # acquire + warm-up
    hold(240, 260, 2.0)                      # pen-down dwell (default 800 ms)
    move((240, 260), (400, 260), 2.0, 40)    # draw an S-ish stroke (~80 px/s)
    hold(400, 260, 3.0)                      # pen-up dwell (default 1200 ms)
    move((400, 260), (320, 200), 1.5)        # hover away (pen up)
    hold(320, 200, 1.0)
    return pts


def main():
    src, out = sys.argv[1], sys.argv[2]
    patch = hand_patch(src)
    ph, pw = patch.shape[:2]
    bg = np.full((H, W, 3), (178, 168, 150), np.uint8)  # warm desk-ish grey
    vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
    for (cx, cy) in path_points():
        frame = bg.copy()
        x0, y0 = int(cx - pw / 2), int(cy - ph / 2)
        xa, ya = max(0, x0), max(0, y0)
        xb, yb = min(W, x0 + pw), min(H, y0 + ph)
        frame[ya:yb, xa:xb] = patch[ya - y0 : yb - y0, xa - x0 : xb - x0]
        vw.write(frame)
    vw.release()
    print(f"wrote {out}: {len(path_points())} frames @ {FPS} fps")


if __name__ == "__main__":
    main()
