import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CDN_HAND_MODEL_URL,
  CDN_WASM_BASE,
  HAND_MODEL_URL,
  MEDIAPIPE_WASM_BASE,
  TASKS_VISION_VERSION,
  WASM_PROBE_FILE,
  resolveAssets,
} from "./assets";

type Res = { ok: boolean; status: number; headers: { get(n: string): string | null } };
const res = (ok: boolean, type = "application/octet-stream"): Res => ({
  ok,
  status: ok ? 200 : 404,
  headers: { get: (n) => (n.toLowerCase() === "content-type" ? type : null) },
});

function fakeFetch(table: Record<string, Res | "throw" | "hang">) {
  const calls: Array<{ url: string; method?: string }> = [];
  const f = (url: string, init?: { method?: string; signal?: AbortSignal }) => {
    calls.push({ url, method: init?.method });
    const r = table[url];
    if (r === "throw") return Promise.reject(new TypeError("network"));
    if (r === "hang")
      return new Promise<Res>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    return Promise.resolve(r ?? res(false));
  };
  return { f, calls };
}

const ORIGIN = "http://localhost:3000";
const WASM_URL = `${ORIGIN}${MEDIAPIPE_WASM_BASE}/${WASM_PROBE_FILE}`;
const MODEL_URL = `${ORIGIN}${HAND_MODEL_URL}`;

describe("MediaPipe assets @P3", () => {
  it("@P3 uses self-hosted files when both HEAD checks pass", async () => {
    const { f, calls } = fakeFetch({ [WASM_URL]: res(true, "application/wasm"), [MODEL_URL]: res(true) });
    const a = await resolveAssets(f, ORIGIN);
    expect(a).toEqual({
      wasmBase: `${ORIGIN}/mediapipe/wasm`,
      modelUrl: `${ORIGIN}/mediapipe/hand_landmarker.task`,
      selfHosted: { wasm: true, model: true },
    });
    expect(calls.every((c) => c.method === "HEAD")).toBe(true);
  });

  it("@P3 falls back per asset: missing model → Google storage, wasm stays local", async () => {
    const { f } = fakeFetch({ [WASM_URL]: res(true, "application/wasm") });
    const a = await resolveAssets(f, ORIGIN);
    expect(a.wasmBase).toBe(`${ORIGIN}/mediapipe/wasm`);
    expect(a.modelUrl).toBe(CDN_HAND_MODEL_URL);
  });

  it("@P3 an HTML 200 (dev-server fallback page), a network error or a hang all mean CDN", async () => {
    const { f } = fakeFetch({ [WASM_URL]: res(true, "text/html; charset=utf-8"), [MODEL_URL]: "throw" });
    expect(await resolveAssets(f, ORIGIN)).toMatchObject({
      wasmBase: CDN_WASM_BASE,
      modelUrl: CDN_HAND_MODEL_URL,
      selfHosted: { wasm: false, model: false },
    });
    const hang = fakeFetch({ [WASM_URL]: "hang", [MODEL_URL]: res(true) });
    const a = await resolveAssets(hang.f, ORIGIN, 20);
    expect(a.wasmBase).toBe(CDN_WASM_BASE);
    expect(a.modelUrl).toBe(MODEL_URL);
  });

  it("@P3 root-relative URLs without an origin; no fetch at all → CDN", async () => {
    const { f, calls } = fakeFetch({});
    await resolveAssets(f);
    expect(calls.map((c) => c.url).sort()).toEqual([HAND_MODEL_URL, `${MEDIAPIPE_WASM_BASE}/${WASM_PROBE_FILE}`].sort());
    const a = await resolveAssets(undefined as never);
    expect(a.selfHosted).toEqual({ wasm: false, model: false });
  });

  it("@P3 CDN pin matches the installed tasks-vision version", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"));
    expect(pkg.dependencies["@mediapipe/tasks-vision"]).toBe(TASKS_VISION_VERSION);
    expect(CDN_WASM_BASE).toContain(`@${TASKS_VISION_VERSION}/`);
  });

  it("@P3 public/mediapipe holds the wasm files when fetch-mediapipe.sh has run", () => {
    const dir = path.resolve(__dirname, "../../public/mediapipe");
    if (!existsSync(dir)) return; // not fetched on this machine: resolveAssets falls back to the CDN
    for (const name of ["vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_module_internal.js"]) {
      expect(existsSync(path.join(dir, "wasm", name))).toBe(true);
    }
    const model = path.join(dir, "hand_landmarker.task");
    if (existsSync(model)) expect(statSync(model).size).toBeGreaterThan(1_000_000);
  });
});
