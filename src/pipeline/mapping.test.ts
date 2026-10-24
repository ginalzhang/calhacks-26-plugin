import { describe, expect, it } from "vitest";
import { boxToTarget, calibratedGain, clampPointer, pickLandmark, transformNormalized } from "./mapping";
import { steadinessParams, suggestedSteadiness } from "./steadiness";
import { hand } from "./testSignals";

describe("camera transforms", () => {
  it("@P0 mirror maps x → 1 − x", () => {
    expect(transformNormalized({ x: 0.2, y: 0.3 }, { mirror: true, rotate: false })).toEqual({ x: 0.8, y: 0.3 });
  });
  it("@P0 rotate maps x → 1 − x, y → 1 − y", () => {
    const p = transformNormalized({ x: 0.2, y: 0.3 }, { mirror: false, rotate: true });
    expect(p.x).toBeCloseTo(0.8);
    expect(p.y).toBeCloseTo(0.7);
  });
  it("@P0 mirror + rotate compose (net y flip)", () => {
    const p = transformNormalized({ x: 0.2, y: 0.3 }, { mirror: true, rotate: true });
    expect(p.x).toBeCloseTo(0.2);
    expect(p.y).toBeCloseTo(0.7);
  });
  it("@P0 landmark pick is landmark-agnostic and returns camera px after transform", () => {
    const h = hand({ x: 100, y: 200 }, { idx: 9, wrist: { x: 120, y: 300 } });
    expect(pickLandmark(h, 9, { mirror: false, rotate: false })).toEqual({ x: 100, y: 200 });
    const m = pickLandmark(h, 0, { mirror: true, rotate: false });
    expect(m.x).toBeCloseTo(640 - 120);
    expect(m.y).toBeCloseTo(300);
  });
});

describe("steadiness", () => {
  it("@P0 piecewise-linear knots 0 → (1.2, 4), 50 → (0.6, 12), 100 → (0.3, 30)", () => {
    expect(steadinessParams(0)).toEqual({ minCutoff: 1.2, lazyRadius: 4 });
    expect(steadinessParams(50)).toEqual({ minCutoff: 0.6, lazyRadius: 12 });
    expect(steadinessParams(100)).toEqual({ minCutoff: 0.3, lazyRadius: 30 });
    const q = steadinessParams(25);
    expect(q.minCutoff).toBeCloseTo(0.9);
    expect(q.lazyRadius).toBeCloseTo(8);
    const r = steadinessParams(75);
    expect(r.minCutoff).toBeCloseTo(0.45);
    expect(r.lazyRadius).toBeCloseTo(21);
  });
  it("@P0 suggested Steadiness = clamp(round(8 × max(rest, kinetic)), 10, 90)", () => {
    expect(suggestedSteadiness(0.2, 0.5)).toBe(10);
    expect(suggestedSteadiness(3.1, 2)).toBe(25);
    expect(suggestedSteadiness(2, 5.06)).toBe(40);
    expect(suggestedSteadiness(20, 1)).toBe(90);
  });
});

describe("active box → target mapping", () => {
  const box = { x: 220, y: 165, w: 200, h: 150 }; // centre (320, 240)
  const target = { x: 400, y: 100, w: 800, h: 600 }; // centre (800, 400)
  it("@P1 calibrated gain = target width ÷ box width, clamped 2–4", () => {
    expect(calibratedGain(800, 200)).toBe(4);
    expect(calibratedGain(800, 300)).toBeCloseTo(2.667, 2);
    expect(calibratedGain(800, 1000)).toBe(2);
  });
  it("@P1 the box maps linearly onto the canvas rect and extrapolates beyond it", () => {
    const m = { box, target, gain: 4 };
    expect(boxToTarget({ x: 320, y: 240 }, m)).toEqual({ x: 800, y: 400 });
    expect(boxToTarget({ x: 220, y: 240 }, m)).toEqual({ x: 400, y: 400 }); // box left edge → canvas left edge
    expect(boxToTarget({ x: 420, y: 240 }, m)).toEqual({ x: 1200, y: 400 });
    // Beyond the box: linear extrapolation, past the canvas rect.
    expect(boxToTarget({ x: 470, y: 340 }, m)).toEqual({ x: 1400, y: 800 });
    expect(boxToTarget({ x: 470, y: 240 }, { ...m, flipX: true })).toEqual({ x: 200, y: 400 });
  });
  it("@P1 pointer is clamped to the screen bounds only (not the canvas)", () => {
    const screen = { x: 0, y: 0, w: 1440, h: 900 };
    const p = boxToTarget({ x: 600, y: 240 }, { box, target, gain: 4 }); // x = 1920
    expect(clampPointer(p, { screen, chrome: null, paused: false })).toEqual({ x: 1440, y: 400 });
    const inside = boxToTarget({ x: 470, y: 340 }, { box, target, gain: 4 });
    expect(clampPointer(inside, { screen, chrome: null, paused: false })).toEqual(inside);
  });
  it("@P1 while paused the pointer is clamped to Chrome's window rect", () => {
    const screen = { x: 0, y: 0, w: 1440, h: 900 };
    const chrome = { x: 0, y: 30, w: 320, h: 860 };
    expect(clampPointer({ x: 900, y: 10 }, { screen, chrome, paused: true })).toEqual({ x: 320, y: 30 });
    expect(clampPointer({ x: 100, y: 400 }, { screen, chrome, paused: true })).toEqual({ x: 100, y: 400 });
  });
});
