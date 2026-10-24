import { describe, expect, it } from "vitest";
import {
  EXPOSURE_AUTO,
  EXPOSURE_CANT_LOCK,
  EXPOSURE_CANT_UNLOCK,
  EXPOSURE_LOCKED,
  exposureModes,
  lockExposure,
  unlockExposure,
  type ExposureTrack,
} from "./exposure";

function fakeTrack(opts: {
  modes?: unknown;
  noCaps?: boolean;
  capsThrow?: boolean;
  reject?: boolean;
  ignore?: boolean;
}): ExposureTrack & { applied: MediaTrackConstraints[]; mode: string } {
  const t = {
    applied: [] as MediaTrackConstraints[],
    mode: "continuous",
    getCapabilities: opts.noCaps
      ? undefined
      : () => {
          if (opts.capsThrow) throw new Error("ended");
          return opts.modes === undefined ? {} : { exposureMode: opts.modes };
        },
    getSettings: () => ({ exposureMode: t.mode }),
    applyConstraints: async (c: MediaTrackConstraints) => {
      t.applied.push(c);
      if (opts.reject) throw new DOMException("nope", "OverconstrainedError");
      if (opts.ignore) return;
      const m = (c.advanced?.[0] as { exposureMode?: string } | undefined)?.exposureMode;
      if (m) t.mode = m;
    },
  };
  return t;
}

describe("exposure lock @P3", () => {
  it("@P3 locks when the camera offers manual exposure", async () => {
    const t = fakeTrack({ modes: ["continuous", "manual"] });
    expect(await lockExposure(t)).toBe(EXPOSURE_LOCKED);
    expect(t.applied).toEqual([{ advanced: [{ exposureMode: "manual" }] }]);
    expect(t.mode).toBe("manual");
    expect(await unlockExposure(t)).toBe(EXPOSURE_AUTO);
    expect(t.mode).toBe("continuous");
  });

  it("@P3 reports can't-lock without manual mode and never calls applyConstraints", async () => {
    for (const t of [
      fakeTrack({ modes: ["continuous"] }),
      fakeTrack({}),
      fakeTrack({ noCaps: true }),
      fakeTrack({ capsThrow: true }),
      fakeTrack({ modes: "weird" }),
    ]) {
      expect(await lockExposure(t)).toBe(EXPOSURE_CANT_LOCK);
      expect(t.applied).toHaveLength(0);
    }
    expect(await lockExposure(null)).toBe(EXPOSURE_CANT_LOCK);
    expect(await unlockExposure(undefined)).toBe(EXPOSURE_CANT_UNLOCK);
    expect(await unlockExposure(fakeTrack({ modes: ["manual"] }))).toBe(EXPOSURE_CANT_UNLOCK);
  });

  it("@P3 never throws when applyConstraints rejects", async () => {
    const t = fakeTrack({ modes: ["manual", "continuous"], reject: true });
    await expect(lockExposure(t)).resolves.toBe(EXPOSURE_CANT_LOCK);
    await expect(unlockExposure(t)).resolves.toBe(EXPOSURE_CANT_UNLOCK);
  });

  it("@P3 a camera that resolves but ignores the constraint is reported honestly", async () => {
    const t = fakeTrack({ modes: ["manual", "continuous"], ignore: true });
    expect(await lockExposure(t)).toBe(EXPOSURE_CANT_LOCK);
  });

  it("@P3 exposureModes reads capabilities defensively", () => {
    expect(exposureModes(fakeTrack({ modes: ["manual", 3, "continuous"] }))).toEqual(["manual", "continuous"]);
    expect(exposureModes(fakeTrack({ modes: "manual" }))).toEqual(["manual"]);
    expect(exposureModes(null)).toEqual([]);
  });
});
