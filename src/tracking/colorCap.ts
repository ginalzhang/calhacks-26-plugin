/**
 * Colour-cap detection: pure math, no DOM. Owned by G (P3).
 *
 * Finds the largest connected blob of a bright fingertip / knuckle sticker (default neon green) in an
 * RGBA image and turns it into a LandmarkFrame, so a hand in a compression glove, a thumb spica or a
 * splint can still drive the pointer (§11 P3, §13 "glove or splint defeats the detector").
 *
 * Pipeline: RGBA (any size; box-downsampled to ≤ 160×120) → HSV mask → 4-connected components →
 * largest component ≥ minArea → centroid in camera px + confidence 0..1.
 *
 * Confidence is mapped onto the pipeline's score thresholds (§0 rule 10):
 *   solid sticker ≥ 0.75 (Tracking) · faint/small/ragged 0.6–0.75 (Weak) · nothing usable < 0.6 (no detection).
 */
import type { HandObservation, LandmarkFrame, NormalizedLandmark } from "./LandmarkSource";

/** Hue in degrees 0..360; s, v in 0..1. hMin > hMax means the range wraps through 0° (reds). */
export interface HsvRange {
  hMin: number;
  hMax: number;
  sMin: number;
  vMin: number;
  /** Optional upper bounds (default 1). */
  sMax?: number;
  vMax?: number;
}

/** Default target: a neon / fluorescent green sticker (also catches lime and bright mint). */
export const DEFAULT_COLORCAP_RANGE: HsvRange = { hMin: 75, hMax: 165, sMin: 0.45, vMin: 0.35 };

/** Detection grid. 160×120 keeps a 640×480 frame at 1/4 scale (one cell = 4×4 camera px). */
export const GRID_WIDTH = 160;
export const GRID_HEIGHT = 120;

export interface ColorCapOptions {
  range?: HsvRange;
  /** Minimum blob area in grid cells (at 160×120). Below this: confidence < 0.6. Default 6. */
  minArea?: number;
  /** Area in grid cells at which the size term saturates ("a solid sticker"). Default 30. */
  solidArea?: number;
  /** Max grid width (the image is box-downsampled to fit). Default 160. */
  gridWidth?: number;
}

export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface BlobDetection {
  /** Largest component reaches minArea (confidence ≥ 0.6). */
  found: boolean;
  /** Centroid in the ORIGINAL image's pixels (camera px); NaN when there is no candidate at all. */
  x: number;
  y: number;
  /** Area of the largest component in grid cells (0 when none). */
  area: number;
  /** area ÷ bounding-box area, 0..1 (solid disc ≈ 0.79, square 1, scattered noise low). */
  fill: number;
  /** Mean saturation of the blob's cells, 0..1. */
  saturation: number;
  /** 0..1, see header. */
  confidence: number;
  /** Mean luma 0..255 of the whole image (Rec. 709, like MediaPipeSource). */
  luma: number;
  /** Grid size the detection ran on. */
  gridWidth: number;
  gridHeight: number;
}

// ----------------------------------------------------------------------------- colour

/** RGB 0..255 → [h 0..360, s 0..1, v 0..1]. */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const v = max / 255;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, v];
}

/** Whether hue h (degrees) lies in [hMin, hMax], wrapping through 0° when hMin > hMax. */
export function hueInRange(h: number, hMin: number, hMax: number): boolean {
  const hn = ((h % 360) + 360) % 360;
  const lo = ((hMin % 360) + 360) % 360;
  const hi = ((hMax % 360) + 360) % 360;
  return lo <= hi ? hn >= lo && hn <= hi : hn >= lo || hn <= hi;
}

export function inHsvRange(h: number, s: number, v: number, range: HsvRange): boolean {
  return (
    s >= range.sMin &&
    s <= (range.sMax ?? 1) &&
    v >= range.vMin &&
    v <= (range.vMax ?? 1) &&
    hueInRange(h, range.hMin, range.hMax)
  );
}

// ----------------------------------------------------------------------------- image

/** Box-average downsample to outW×outH (integer or fractional factors). Returns RGBA. */
export function downsampleRgba(img: RgbaImage, outW: number, outH: number): RgbaImage {
  const { data, width, height } = img;
  if (outW === width && outH === height) return img;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sx = width / outW;
  const sy = height / outH;
  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor(oy * sy);
    const y1 = Math.max(y0 + 1, Math.floor((oy + 1) * sy));
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor(ox * sx);
      const x1 = Math.max(x0 + 1, Math.floor((ox + 1) * sx));
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        let i = (y * width + x0) * 4;
        for (let x = x0; x < x1 && x < width; x++, i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          a += data[i + 3];
          n++;
        }
      }
      const o = (oy * outW + ox) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { data: out, width: outW, height: outH };
}

/** Grid size that fits maxW wide while keeping the aspect ratio (never upsamples). */
export function gridSizeFor(width: number, height: number, maxW = GRID_WIDTH): { w: number; h: number } {
  if (width <= maxW) return { w: width, h: height };
  const w = maxW;
  const h = Math.max(1, Math.round((height * maxW) / width));
  return { w, h };
}

export function meanLuma(img: RgbaImage): number {
  const d = img.data;
  const n = img.width * img.height;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n * 4; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  return sum / n;
}

// ----------------------------------------------------------------------------- confidence

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Map blob stats to 0..1.
 *  - below minArea: 0.59 × area/minArea (always < 0.6; 0 with no blob);
 *  - otherwise 0.6 + 0.39 × q, q = (0.6·size + 0.4·fill) × (0.2 + 0.8·colour), where
 *    size = (area − minArea)/(solidArea − minArea), fill = (fill − 0.3)/0.4, colour = (sat − sMin)/0.3
 *    (each clamped 0..1). A washed-out sticker (saturation just above sMin) can't reach 0.75 however
 *    big it is; a vivid one reaches 0.75 from about 1.5 × minArea.
 *  A ragged blob (fill < 0.2) is capped below 0.6: it's scattered noise, not a sticker.
 */
export function colorCapConfidence(
  area: number,
  fill: number,
  saturation: number,
  opts: { minArea: number; solidArea: number; sMin: number },
): number {
  const { minArea, solidArea, sMin } = opts;
  if (area <= 0) return 0;
  if (area < minArea) return 0.59 * (area / minArea);
  const size = clamp01((area - minArea) / Math.max(1, solidArea - minArea));
  const fillQ = clamp01((fill - 0.3) / 0.4);
  const colour = clamp01((saturation - sMin) / 0.3);
  const q = (0.6 * size + 0.4 * fillQ) * (0.2 + 0.8 * colour);
  const c = 0.6 + 0.39 * q;
  return fill < 0.2 ? Math.min(c, 0.59) : c;
}

// ----------------------------------------------------------------------------- detection

/** Find the largest blob of `range` colour. Pure; O(grid cells). */
export function detectColorCap(img: RgbaImage, opts: ColorCapOptions = {}): BlobDetection {
  const range = opts.range ?? DEFAULT_COLORCAP_RANGE;
  const minArea = opts.minArea ?? 6;
  const solidArea = opts.solidArea ?? 30;
  const { w: gw, h: gh } = gridSizeFor(img.width, img.height, opts.gridWidth ?? GRID_WIDTH);
  const grid = downsampleRgba(img, gw, gh);
  const d = grid.data;
  const n = gw * gh;

  // Mask + per-cell saturation.
  const mask = new Uint8Array(n);
  const sat = new Float32Array(n);
  let lumaSum = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = d[p],
      g = d[p + 1],
      b = d[p + 2];
    lumaSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const [h, s, v] = rgbToHsv(r, g, b);
    if (inHsvRange(h, s, v, range)) {
      mask[i] = 1;
      sat[i] = s;
    }
  }
  const luma = n ? lumaSum / n : 0;

  // 4-connected components (iterative flood fill, labels in-place: 1 = unvisited, 2 = visited).
  const stack = new Int32Array(n);
  let best = { area: 0, sx: 0, sy: 0, ss: 0, minX: 0, maxX: 0, minY: 0, maxY: 0 };
  for (let start = 0; start < n; start++) {
    if (mask[start] !== 1) continue;
    let sp = 0;
    stack[sp++] = start;
    mask[start] = 2;
    let area = 0,
      sx = 0,
      sy = 0,
      ss = 0;
    let minX = gw,
      maxX = -1,
      minY = gh,
      maxY = -1;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % gw;
      const y = (i - x) / gw;
      area++;
      sx += x;
      sy += y;
      ss += sat[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[i - 1] === 1) (mask[i - 1] = 2), (stack[sp++] = i - 1);
      if (x < gw - 1 && mask[i + 1] === 1) (mask[i + 1] = 2), (stack[sp++] = i + 1);
      if (y > 0 && mask[i - gw] === 1) (mask[i - gw] = 2), (stack[sp++] = i - gw);
      if (y < gh - 1 && mask[i + gw] === 1) (mask[i + gw] = 2), (stack[sp++] = i + gw);
    }
    if (area > best.area) best = { area, sx, sy, ss, minX, maxX, minY, maxY };
  }

  if (best.area === 0) {
    return {
      found: false,
      x: NaN,
      y: NaN,
      area: 0,
      fill: 0,
      saturation: 0,
      confidence: 0,
      luma,
      gridWidth: gw,
      gridHeight: gh,
    };
  }
  // Area thresholds are defined at 160×120; scale them when the grid is smaller (tiny test images).
  const areaScale = (gw * gh) / (GRID_WIDTH * GRID_HEIGHT);
  const scaledMin = Math.max(1, minArea * Math.min(1, areaScale));
  const scaledSolid = Math.max(scaledMin + 1, solidArea * Math.min(1, areaScale));
  const bboxArea = (best.maxX - best.minX + 1) * (best.maxY - best.minY + 1);
  const fill = best.area / bboxArea;
  const saturation = best.ss / best.area;
  const confidence = colorCapConfidence(best.area, fill, saturation, {
    minArea: scaledMin,
    solidArea: scaledSolid,
    sMin: range.sMin,
  });
  // Cell centres → original pixels.
  const kx = img.width / gw;
  const ky = img.height / gh;
  return {
    found: confidence >= 0.6,
    x: (best.sx / best.area + 0.5) * kx,
    y: (best.sy / best.area + 0.5) * ky,
    area: best.area,
    fill,
    saturation,
    confidence,
    luma,
    gridWidth: gw,
    gridHeight: gh,
  };
}

// ----------------------------------------------------------------------------- calibration

export interface PickColourResult {
  ok: boolean;
  /** Range to use (DEFAULT_COLORCAP_RANGE when !ok). */
  range: HsvRange;
  /** Mean hue of the sampled region, degrees. */
  hue: number;
  /** Status-line text. */
  message: string;
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
};

/**
 * "Pick colour from centre": the user holds the sticker in the middle of the camera view; sample a
 * centred square (side = `fraction` × the shorter image side, default 0.1) and return an HSV range
 * around it. Hue: saturation-weighted circular mean ± max(12°, 2.5 × circular spread), capped at ±40°.
 * sMin/vMin: 0.6 × the 10th percentile, floored at 0.25 / 0.2 so grey desk never matches.
 */
export function pickColourFromCentre(img: RgbaImage, fraction = 0.1): PickColourResult {
  const side = Math.max(3, Math.round(Math.min(img.width, img.height) * fraction));
  const x0 = Math.max(0, Math.floor(img.width / 2 - side / 2));
  const y0 = Math.max(0, Math.floor(img.height / 2 - side / 2));
  const x1 = Math.min(img.width, x0 + side);
  const y1 = Math.min(img.height, y0 + side);
  let cx = 0,
    cy = 0,
    wsum = 0;
  const ss: number[] = [];
  const vs: number[] = [];
  const hs: number[] = [];
  const ws: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      const [h, s, v] = rgbToHsv(img.data[i], img.data[i + 1], img.data[i + 2]);
      ss.push(s);
      vs.push(v);
      hs.push(h);
      const w = s * v;
      ws.push(w);
      const rad = (h * Math.PI) / 180;
      cx += w * Math.cos(rad);
      cy += w * Math.sin(rad);
      wsum += w;
    }
  }
  const medS = quantile(ss, 0.5);
  const medV = quantile(vs, 0.5);
  if (wsum <= 0 || medS < 0.3 || medV < 0.25) {
    return {
      ok: false,
      range: DEFAULT_COLORCAP_RANGE,
      hue: NaN,
      message: "Not a bright colour: hold the sticker in the middle of the camera view and try again",
    };
  }
  const hue = ((Math.atan2(cy, cx) * 180) / Math.PI + 360) % 360;
  // Weighted circular spread (degrees): mean absolute angular distance from the mean hue.
  let spread = 0;
  for (let k = 0; k < hs.length; k++) {
    let dh = Math.abs(hs[k] - hue) % 360;
    if (dh > 180) dh = 360 - dh;
    spread += ws[k] * dh;
  }
  spread /= wsum;
  const half = Math.min(40, Math.max(12, 2.5 * spread));
  const norm = (h: number) => ((h % 360) + 360) % 360;
  const range: HsvRange = {
    hMin: norm(hue - half),
    hMax: norm(hue + half),
    sMin: Math.max(0.25, 0.6 * quantile(ss, 0.1)),
    vMin: Math.max(0.2, 0.6 * quantile(vs, 0.1)),
  };
  return { ok: true, range, hue, message: "Sticker colour set" };
}

// ----------------------------------------------------------------------------- frame

/**
 * Detection → LandmarkFrame. One hand whose 21 landmarks all sit at the blob centroid (normalised),
 * so any landmark choice (knuckle 5, tip 8, wrist 0 for the hand lock) tracks the sticker.
 * No candidate at all → `hands: []` ("no hand"); a candidate below minArea → a hand with score < 0.6
 * (the pipeline treats it as no detection and never moves the pointer).
 */
export function colorCapFrame(
  det: BlobDetection,
  t: number,
  width: number,
  height: number,
  handedness: "Left" | "Right" = "Right",
  /** Size of the image the detection ran on, when it was not the camera frame (e.g. a 160×120 canvas). */
  imageWidth = width,
  imageHeight = height,
): LandmarkFrame {
  const hands: HandObservation[] = [];
  if (det.area > 0 && Number.isFinite(det.x) && Number.isFinite(det.y)) {
    const p: NormalizedLandmark = { x: det.x / imageWidth, y: det.y / imageHeight, z: 0 };
    const landmarks = Array.from({ length: 21 }, () => ({ ...p }));
    hands.push({ landmarks, score: det.confidence, handedness });
  }
  return { t, width, height, hands, luma: det.luma };
}
