/**
 * MediaPipe asset locations (P3, §1: "P3 self-hosts under /public/mediapipe/"). Owned by G.
 *
 * `scripts/fetch-mediapipe.sh` fills public/mediapipe/ (wasm copied from node_modules, model downloaded
 * once). At start-up the Worker calls `resolveAssets()`, which HEAD-checks the self-hosted files and
 * falls back per asset to jsDelivr / Google storage, so a missing model never breaks tracking.
 *
 * Integration (MediaPipeSource.start, in the Worker):
 *   const assets = await resolveAssets(fetch, self.location.origin);
 *   fileset = await FilesetResolver.forVisionTasks(assets.wasmBase, useModule);
 *   baseOptions: { modelAssetPath: assets.modelUrl, delegate }
 */

export const TASKS_VISION_VERSION = "1.1.1";

/** Self-hosted (public/mediapipe/). Root-relative: resolve against the page / Worker origin. */
export const MEDIAPIPE_WASM_BASE = "/mediapipe/wasm";
export const HAND_MODEL_URL = "/mediapipe/hand_landmarker.task";

/** CDN fallbacks (what P0–P2 used). */
export const CDN_WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
export const CDN_HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

/** File HEAD-checked to decide whether the self-hosted wasm directory is usable. */
export const WASM_PROBE_FILE = "vision_wasm_internal.wasm";

export interface ResolvedAssets {
  wasmBase: string;
  modelUrl: string;
  selfHosted: { wasm: boolean; model: boolean };
}

type FetchLike = (input: string, init?: { method?: string; signal?: AbortSignal; cache?: RequestCache }) => Promise<{
  ok: boolean;
  status?: number;
  headers?: { get(name: string): string | null };
}>;

const join = (origin: string | undefined, path: string) => (origin ? origin.replace(/\/+$/, "") + path : path);

async function headOk(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<boolean> {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, { method: "HEAD", signal: ctrl?.signal, cache: "no-store" });
    if (!res.ok) return false;
    // A dev server's HTML 404/fallback page must not count as the asset.
    const type = res.headers?.get("content-type") ?? "";
    return !/text\/html/i.test(type);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * HEAD-check the self-hosted wasm and model; fall back to the CDN per asset. Never throws.
 * @param fetchImpl  `fetch` (injectable for tests)
 * @param origin     e.g. `self.location.origin`; omit to keep root-relative URLs
 */
export async function resolveAssets(
  fetchImpl: FetchLike = (globalThis.fetch as unknown as FetchLike),
  origin?: string,
  timeoutMs = 3000,
): Promise<ResolvedAssets> {
  const wasmBase = join(origin, MEDIAPIPE_WASM_BASE);
  const modelUrl = join(origin, HAND_MODEL_URL);
  if (typeof fetchImpl !== "function") {
    return { wasmBase: CDN_WASM_BASE, modelUrl: CDN_HAND_MODEL_URL, selfHosted: { wasm: false, model: false } };
  }
  const [wasm, model] = await Promise.all([
    headOk(fetchImpl, `${wasmBase}/${WASM_PROBE_FILE}`, timeoutMs),
    headOk(fetchImpl, modelUrl, timeoutMs),
  ]);
  return {
    wasmBase: wasm ? wasmBase : CDN_WASM_BASE,
    modelUrl: model ? modelUrl : CDN_HAND_MODEL_URL,
    selfHosted: { wasm, model },
  };
}
