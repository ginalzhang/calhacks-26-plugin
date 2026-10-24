import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLORCAP_RANGE,
  colorCapConfidence,
  colorCapFrame,
  detectColorCap,
  downsampleRgba,
  hueInRange,
  pickColourFromCentre,
  rgbToHsv,
  type RgbaImage,
} from "./colorCap";

type RGB = [number, number, number];
const NEON_GREEN: RGB = [57, 255, 20];
const RED: RGB = [235, 20, 30];
const DESK: RGB = [150, 120, 95]; // wood-ish, low saturation

function image(w: number, h: number, bg: RGB = DESK): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bg[0];
    data[i * 4 + 1] = bg[1];
    data[i * 4 + 2] = bg[2];
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}

function disc(img: RgbaImage, cx: number, cy: number, r: number, c: RGB) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
      const i = (y * img.width + x) * 4;
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
    }
  }
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addNoise(img: RgbaImage, amp: number, seed = 1) {
  const r = rng(seed);
  for (let i = 0; i < img.width * img.height * 4; i++) {
    if (i % 4 === 3) continue;
    img.data[i] = img.data[i] + (r() * 2 - 1) * amp;
  }
}

describe("colorCap colour math @P3", () => {
  it("@P3 rgbToHsv matches known colours", () => {
    expect(rgbToHsv(255, 0, 0)).toEqual([0, 1, 1]);
    expect(rgbToHsv(0, 255, 0)[0]).toBeCloseTo(120);
    expect(rgbToHsv(0, 0, 255)[0]).toBeCloseTo(240);
    expect(rgbToHsv(128, 128, 128)[1]).toBe(0);
    expect(rgbToHsv(0, 0, 0)).toEqual([0, 0, 0]);
  });

  it("@P3 hue ranges wrap through 0° for reds", () => {
    expect(hueInRange(350, 340, 20)).toBe(true);
    expect(hueInRange(5, 340, 20)).toBe(true);
    expect(hueInRange(30, 340, 20)).toBe(false);
    expect(hueInRange(120, 75, 165)).toBe(true);
    expect(hueInRange(200, 75, 165)).toBe(false);
  });

  it("@P3 downsample box-averages", () => {
    const img = image(4, 2, [0, 0, 0]);
    img.data.set([200, 100, 40, 255], 0);
    const out = downsampleRgba(img, 2, 1);
    expect(out.width).toBe(2);
    expect(out.data[0]).toBe(50); // 200 / 4 cells
    expect(out.data[4]).toBe(0);
  });
});

describe("detectColorCap @P3", () => {
  it("@P3 finds a solid neon sticker at the right place with confidence ≥ 0.75", () => {
    const img = image(640, 480);
    disc(img, 412, 207, 14, NEON_GREEN);
    const det = detectColorCap(img);
    expect(det.found).toBe(true);
    expect(det.gridWidth).toBe(160);
    expect(det.gridHeight).toBe(120);
    expect(Math.abs(det.x - 412)).toBeLessThanOrEqual(3);
    expect(Math.abs(det.y - 207)).toBeLessThanOrEqual(3);
    expect(det.confidence).toBeGreaterThanOrEqual(0.75);
    expect(det.confidence).toBeLessThanOrEqual(1);
  });

  it("@P3 with two blobs, the largest wins", () => {
    const img = image(640, 480);
    disc(img, 100, 100, 9, NEON_GREEN);
    disc(img, 500, 380, 18, NEON_GREEN);
    const det = detectColorCap(img);
    expect(det.found).toBe(true);
    expect(Math.abs(det.x - 500)).toBeLessThanOrEqual(3);
    expect(Math.abs(det.y - 380)).toBeLessThanOrEqual(3);
  });

  it("@P3 no sticker → score < 0.6 and no hand in the frame", () => {
    const img = image(640, 480);
    disc(img, 300, 200, 40, [200, 170, 150]); // skin-ish, not green
    const det = detectColorCap(img);
    expect(det.found).toBe(false);
    expect(det.confidence).toBeLessThan(0.6);
    const frame = colorCapFrame(det, 10, 640, 480);
    expect(frame.hands).toEqual([]);
    expect(frame.luma).toBeGreaterThan(0);
  });

  it("@P3 a tiny speck is below 0.6 but still reported as a low-score hand", () => {
    const img = image(640, 480);
    disc(img, 320, 240, 3, NEON_GREEN); // ~2 grid cells
    const det = detectColorCap(img);
    expect(det.found).toBe(false);
    expect(det.confidence).toBeGreaterThan(0);
    expect(det.confidence).toBeLessThan(0.6);
    const frame = colorCapFrame(det, 10, 640, 480);
    expect(frame.hands).toHaveLength(1);
    expect(frame.hands[0].score).toBeLessThan(0.6);
  });

  it("@P3 a faint (small, washed-out) sticker scores in the Weak band 0.6–0.75", () => {
    const img = image(640, 480);
    disc(img, 320, 240, 9, [120, 190, 95]); // pale green, s ≈ 0.5, small
    const det = detectColorCap(img);
    expect(det.found).toBe(true);
    expect(det.confidence).toBeGreaterThanOrEqual(0.6);
    expect(det.confidence).toBeLessThan(0.75);
    // Washed-out stays Weak however big it is.
    const big = image(640, 480);
    disc(big, 320, 240, 20, [120, 190, 95]);
    const bigDet = detectColorCap(big);
    expect(bigDet.confidence).toBeGreaterThanOrEqual(0.6);
    expect(bigDet.confidence).toBeLessThan(0.75);
  });

  it("@P3 robust to pixel noise: still found within 4 px, no false positive on noisy desk", () => {
    const img = image(640, 480);
    disc(img, 210, 330, 14, NEON_GREEN);
    addNoise(img, 40, 7);
    const det = detectColorCap(img);
    expect(det.found).toBe(true);
    expect(Math.abs(det.x - 210)).toBeLessThanOrEqual(4);
    expect(Math.abs(det.y - 330)).toBeLessThanOrEqual(4);
    expect(det.confidence).toBeGreaterThanOrEqual(0.75);

    const empty = image(640, 480);
    addNoise(empty, 60, 3);
    expect(detectColorCap(empty).confidence).toBeLessThan(0.6);
  });

  it("@P3 salt noise of sticker-coloured pixels is not a sticker", () => {
    const img = image(640, 480);
    const r = rng(42);
    for (let k = 0; k < 400; k++) {
      const x = Math.floor(r() * 640);
      const y = Math.floor(r() * 480);
      disc(img, x + 0.5, y + 0.5, 0.8, NEON_GREEN);
    }
    expect(detectColorCap(img).confidence).toBeLessThan(0.6);
  });

  it("@P3 red sticker found with a wrapping hue range", () => {
    const img = image(640, 480);
    disc(img, 150, 120, 14, RED);
    disc(img, 500, 400, 14, NEON_GREEN); // ignored: not in range
    const det = detectColorCap(img, { range: { hMin: 340, hMax: 20, sMin: 0.45, vMin: 0.35 } });
    expect(det.found).toBe(true);
    expect(Math.abs(det.x - 150)).toBeLessThanOrEqual(3);
    expect(Math.abs(det.y - 120)).toBeLessThanOrEqual(3);
    // A hue just below 0° (magenta-red, h ≈ 350) is matched too.
    const img2 = image(640, 480);
    disc(img2, 320, 240, 14, [240, 20, 60]);
    expect(rgbToHsv(240, 20, 60)[0]).toBeGreaterThan(340);
    expect(detectColorCap(img2, { range: { hMin: 340, hMax: 20, sMin: 0.45, vMin: 0.35 } }).found).toBe(true);
    // The default (green) range ignores red.
    expect(detectColorCap(img).x).toBeCloseTo(500, -1);
  });

  it("@P3 works on an already-downsampled 160×120 image (Worker path)", () => {
    const img = image(160, 120);
    disc(img, 40, 90, 4, NEON_GREEN);
    const det = detectColorCap(img);
    expect(det.found).toBe(true);
    expect(Math.abs(det.x - 40)).toBeLessThanOrEqual(1);
    expect(Math.abs(det.y - 90)).toBeLessThanOrEqual(1);
    // Normalise by the 160×120 image, report the 640×480 camera frame.
    const frame = colorCapFrame(det, 5, 640, 480, "Left", 160, 120);
    expect(frame.width).toBe(640);
    expect(frame.hands[0].landmarks[5].x).toBeCloseTo(det.x / 160, 6);
    expect(frame.hands[0].handedness).toBe("Left");
  });
});

describe("colorCapFrame @P3", () => {
  it("@P3 emits one hand with 21 identical normalised landmarks, score and luma", () => {
    const img = image(640, 480);
    disc(img, 320, 120, 14, NEON_GREEN);
    const det = detectColorCap(img);
    const f = colorCapFrame(det, 1234, 640, 480);
    expect(f.t).toBe(1234);
    expect(f.hands).toHaveLength(1);
    const h = f.hands[0];
    expect(h.landmarks).toHaveLength(21);
    expect(h.handedness).toBe("Right");
    expect(h.score).toBe(det.confidence);
    for (const p of h.landmarks) {
      expect(p.x).toBeCloseTo(det.x / 640, 6);
      expect(p.y).toBeCloseTo(det.y / 480, 6);
      expect(p.z).toBe(0);
    }
    expect(h.landmarks[0]).not.toBe(h.landmarks[5]); // independent objects
    expect(f.luma).toBeCloseTo(det.luma, 6);
  });

  it("@P3 confidence mapping stays inside its bands", () => {
    const o = { minArea: 6, solidArea: 30, sMin: 0.45 };
    expect(colorCapConfidence(0, 0, 0, o)).toBe(0);
    expect(colorCapConfidence(5, 1, 1, o)).toBeLessThan(0.6);
    expect(colorCapConfidence(6, 0.8, 0.5, o)).toBeGreaterThanOrEqual(0.6);
    expect(colorCapConfidence(6, 0.8, 0.5, o)).toBeLessThan(0.75);
    expect(colorCapConfidence(40, 0.78, 0.9, o)).toBeGreaterThanOrEqual(0.75);
    expect(colorCapConfidence(200, 1, 1, o)).toBeLessThan(1);
    expect(colorCapConfidence(200, 0.1, 1, o)).toBeLessThan(0.6); // ragged
  });
});

describe("pickColourFromCentre @P3", () => {
  it("@P3 samples the centre and returns a range that detects that sticker", () => {
    const img = image(640, 480);
    const ORANGE: RGB = [255, 120, 10];
    disc(img, 320, 240, 30, ORANGE);
    addNoise(img, 15, 9);
    const pick = pickColourFromCentre(img);
    expect(pick.ok).toBe(true);
    expect(pick.hue).toBeGreaterThan(20);
    expect(pick.hue).toBeLessThan(40);
    expect(pick.range.sMin).toBeGreaterThanOrEqual(0.25);
    // Move the sticker: the picked range finds it; the default green range doesn't.
    const scene = image(640, 480);
    disc(scene, 100, 380, 14, ORANGE);
    const det = detectColorCap(scene, { range: pick.range });
    expect(det.found).toBe(true);
    expect(Math.abs(det.x - 100)).toBeLessThanOrEqual(3);
    expect(detectColorCap(scene).found).toBe(false);
  });

  it("@P3 picking a red sticker produces a wrapping range", () => {
    const img = image(640, 480);
    disc(img, 320, 240, 30, [250, 15, 25]);
    // Half the centre slightly magenta so the hue straddles 0°.
    disc(img, 335, 240, 20, [245, 15, 45]);
    const pick = pickColourFromCentre(img);
    expect(pick.ok).toBe(true);
    expect(pick.range.hMin).toBeGreaterThan(pick.range.hMax); // wraps
    const scene = image(640, 480);
    disc(scene, 500, 100, 14, [240, 20, 60]);
    expect(detectColorCap(scene, { range: pick.range }).found).toBe(true);
  });

  it("@P3 refuses a grey / dark centre", () => {
    const pick = pickColourFromCentre(image(640, 480, [128, 128, 128]));
    expect(pick.ok).toBe(false);
    expect(pick.range).toEqual(DEFAULT_COLORCAP_RANGE);
    expect(pick.message).toMatch(/bright colour/);
  });
});
