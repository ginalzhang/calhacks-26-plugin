/**
 * Camera on the main thread (§1): getUserMedia → MediaStreamTrackProcessor → transfer the readable to
 * the Worker. Fallback: requestVideoFrameCallback → ImageBitmap (the window must stay visible).
 * Owned by B.
 */
import type { WorkerBridge } from "./workerBridge";

export interface CameraInfo {
  deviceId: string;
  label: string;
}

export async function listCameras(): Promise<CameraInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs
    .filter((d) => d.kind === "videoinput")
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

/** Desk View if Chrome lists it, else the system default (first). */
export function pickDefaultCamera(cams: CameraInfo[]): CameraInfo | null {
  return cams.find((c) => /desk view/i.test(c.label)) ?? cams[0] ?? null;
}

/** Default Mirror: on for a front (FaceTime / built-in) camera, off for a top-down one (Desk View, Continuity). */
export function defaultMirrorFor(label: string): boolean {
  if (/desk view/i.test(label)) return false;
  return /facetime|built-in|front|integrated/i.test(label);
}

export async function openCamera(deviceId: string | null): Promise<MediaStream> {
  const base: MediaTrackConstraints = {
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 30 },
  };
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: { ...base, deviceId: { exact: deviceId } } });
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name !== "OverconstrainedError" && name !== "NotFoundError") throw err;
      // The remembered camera is gone: fall back to the default.
    }
  }
  return navigator.mediaDevices.getUserMedia({ video: base });
}

type MSTPCtor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream };

/**
 * Feed the Worker. Returns a stop function and whether the Worker path is in use
 * (false = main-thread fallback; caller should warn).
 */
export function feedWorker(stream: MediaStream, bridge: WorkerBridge, video: HTMLVideoElement | null): { stop: () => void; workerPath: boolean } {
  const track = stream.getVideoTracks()[0];
  const MSTP = (globalThis as unknown as { MediaStreamTrackProcessor?: MSTPCtor }).MediaStreamTrackProcessor;
  if (track && MSTP) {
    // Clone so the preview <video> and the processor don't fight over one track.
    const t2 = track.clone();
    const proc = new MSTP({ track: t2 });
    bridge.post({ type: "stream", readable: proc.readable }, [proc.readable as unknown as Transferable]);
    return { stop: () => t2.stop(), workerPath: true };
  }
  // Fallback: requestVideoFrameCallback on the main thread.
  let stopped = false;
  const v = video ?? document.createElement("video");
  if (!video) {
    v.muted = true;
    v.playsInline = true;
    v.srcObject = stream;
    void v.play().catch(() => undefined);
  }
  type RVFC = (cb: () => void) => number;
  const rvfc = (v as unknown as { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback?.bind(v);
  const loop = async () => {
    if (stopped) return;
    if (v.readyState >= 2) {
      try {
        const bmp = await createImageBitmap(v);
        bridge.post({ type: "bitmap", bitmap: bmp, t: performance.now() }, [bmp]);
      } catch {
        /* frame not ready */
      }
    }
    if (rvfc) rvfc(() => void loop());
    else setTimeout(() => void loop(), 33);
  };
  void loop();
  return { stop: () => (stopped = true), workerPath: false };
}
