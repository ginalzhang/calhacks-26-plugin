/**
 * When does an open mic close by itself? (§8, §0 rule 5) Pure; injected timestamps.
 * - Push-to-talk: only on release. No onset timeout, no silence close, no cap while held.
 * - Tap: on the next tap, on `silenceMs` without speech activity *after speech has started*, or at
 *   `capMs` counted from speech onset. Nothing closes before speech starts (speech initiation can
 *   take seconds), so there is no onset timeout in either mode.
 * Speech onset/activity = a transcript delta, or a 100 ms chunk whose pre-gain RMS is above
 * VOICE_LEVEL (Ink 2 manual-finalize may not send interim deltas before "finalize", so audio
 * level is the fallback signal; see DECISIONS.md › Agent E).
 */
export const VOICE_LEVEL = 0.015;

export interface MicTiming {
  mode: "tap" | "ptt";
  /** First transcript delta or first voiced chunk; null until speech starts. */
  speechStartAt: number | null;
  /** Latest transcript delta or voiced chunk. */
  lastActivityAt: number | null;
}

export function newMicTiming(mode: "tap" | "ptt"): MicTiming {
  return { mode, speechStartAt: null, lastActivityAt: null };
}

export function noteActivity(m: MicTiming, t: number): MicTiming {
  return { ...m, speechStartAt: m.speechStartAt ?? t, lastActivityAt: t };
}

export function autoCloseReason(m: MicTiming, now: number, silenceMs: number, capMs: number): "silence" | "cap" | null {
  if (m.mode === "ptt" || m.speechStartAt === null) return null;
  if (now - m.speechStartAt >= capMs) return "cap";
  if (m.lastActivityAt !== null && now - m.lastActivityAt >= silenceMs) return "silence";
  return null;
}
