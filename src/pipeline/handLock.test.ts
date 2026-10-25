import { describe, expect, it } from "vitest";
import { HandLock, RELOCK_MS } from "./handLock";
import type { HandObservation } from "../tracking/LandmarkSource";

const hand = (x: number, y: number, score = 0.95): HandObservation => ({
  landmarks: Array.from({ length: 21 }, () => ({ x, y, z: 0 })),
  score,
  handedness: "Right",
});
const tf = { mirror: false, rotate: false };

describe("hand lock re-lock (real-Mac fix)", () => {
  it("@P1 a single hand that comes back elsewhere is refused at first, then re-locked after holding steady", () => {
    const lock = new HandLock();
    const a = lock.choose([hand(0.3, 0.5)], tf, 0, 0);
    lock.accept(a.wrist!);
    // hand leaves and comes back at the far side of the frame
    expect(lock.choose([hand(0.8, 0.5)], tf, 0, 1000).reason).toBe("outside_area");
    expect(lock.choose([hand(0.81, 0.5)], tf, 0, 1000 + RELOCK_MS / 2).reason).toBe("outside_area");
    const r = lock.choose([hand(0.8, 0.51)], tf, 0, 1000 + RELOCK_MS + 10);
    expect(r.reason).toBeNull();
    expect(r.hand).not.toBeNull();
    expect(lock.ref!.x).toBeCloseTo(0.8, 2);
  });

  it("@P1 a hand that keeps jumping around never re-locks", () => {
    const lock = new HandLock();
    lock.accept(lock.choose([hand(0.2, 0.5)], tf, 0, 0).wrist!);
    let t = 100;
    for (const x of [0.7, 0.85, 0.7, 0.85, 0.7, 0.85, 0.7, 0.85]) {
      expect(lock.choose([hand(x, 0.2)], tf, 0, t).reason).toBe("outside_area");
      t += 200;
    }
  });

  it("@P1 a second hand / cup never steals the lock while the tracked hand is still seen", () => {
    const lock = new HandLock();
    lock.accept(lock.choose([hand(0.3, 0.5)], tf, 0, 0).wrist!);
    for (let t = 0; t <= 3000; t += 100) {
      const r = lock.choose([hand(0.31, 0.5), hand(0.85, 0.5)], tf, 0, t);
      expect(r.wrist!.x).toBeCloseTo(0.31, 2);
      lock.accept(r.wrist!);
    }
  });

  it("@P1 without a timestamp the old behaviour holds (no re-lock)", () => {
    const lock = new HandLock();
    lock.accept(lock.choose([hand(0.3, 0.5)], tf).wrist!);
    for (let i = 0; i < 100; i++) expect(lock.choose([hand(0.8, 0.5)], tf).reason).toBe("outside_area");
  });
});
