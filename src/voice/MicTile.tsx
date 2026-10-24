"use client";
/**
 * <MicTile> (§8, §0 rules 4/5/6/12): the Mic toggle B renders in the pinned header.
 * - A real <button> named "Mic" with aria-pressed, ≥ 64×64 px, text ≥ 18 px.
 * - Tap toggles. Push-to-talk via `pttHeld` (F10 / pedal): press opens, release closes.
 * - Opening calls onMicOpen (B lifts the pen) and cancels TTS.
 * - Tap mode closes on the next tap, on `micSilenceMs` of silence after speech starts, or at
 *   `micCapMs` from speech onset; nothing closes before speech starts; PTT has no timers at all.
 * - Live level meter; "Heard: …" via onStatus; the transcript goes through resolveText (grammar
 *   first, Claude only on no match, exact only in dialogs) and the Resolution goes to onResolution
 *   ("undo that" ×N arrives as N undo commands; B's dispatcher runs them serially).
 * - Quiet mode / disabled: the tile is disabled and any open mic is cancelled.
 * - Mic revoked / denied: a role="alert" banner; tiles, keys and the typed box remain the path.
 * - No Cartesia key / token error / socket failure: falls back to the browser's Web Speech API only
 *   if `allowWebSpeech` (settings.webSpeechFallback, opt-in) and the browser has it (P3; same open/close semantics; status says so, and the first time that Chrome sends the
 *   audio to Google); otherwise the tile does not open and the status says why.
 * - Offline (§13): voice is off with a clear message; tiles, keys and the typed box still work.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MicTileProps } from "../pipeline/types";
import { autoCloseReason, newMicTiming, noteActivity, VOICE_LEVEL, type MicTiming } from "./micPolicy";
import { resolveText } from "./resolve";
import { tts } from "./ttsClient";
import { VoiceSession } from "./voiceSession";
import { WEB_SPEECH_NOTICE, WEB_SPEECH_STATUS, webSpeechCtor } from "./webSpeech";

/** Web Speech privacy notice: shown in full the first time per page load, short after that. */
let webSpeechNoticeShown = false;

type Banner = null | { kind: "revoked" | "denied" | "no_device" | "unsupported" | "error"; text: string };

const BANNER_TEXT: Record<NonNullable<Banner>["kind"], string> = {
  revoked: "Microphone access was turned off. Tiles, keys and the typed box still work. To use voice again, allow the microphone for this site in Chrome.",
  denied: "Chrome is blocking the microphone. Tiles, keys and the typed box still work. To use voice, allow the microphone for this site in Chrome.",
  no_device: "No microphone found. Tiles, keys and the typed box still work.",
  unsupported: "This browser can't capture audio for voice. Use Chrome, or the tiles, keys and typed box.",
  error: "Voice stopped working. Tiles, keys and the typed box still work.",
};

export default function MicTile(props: MicTileProps) {
  const { quiet, disabled, pttHeld, micSilenceMs, micCapMs } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false); // finalizing / resolving
  const [meter, setMeter] = useState(0);
  const [banner, setBanner] = useState<Banner>(null);

  const sessionRef = useRef<VoiceSession | null>(null);
  const timingRef = useRef<MicTiming | null>(null);
  const openRef = useRef(false);
  const propsRef = useRef(props);
  propsRef.current = props;

  const session = () => (sessionRef.current ??= new VoiceSession());

  const status = useCallback((text: string, level: "status" | "alert" = "status") => {
    propsRef.current.onStatus(text, level);
  }, []);

  const finishOpen = useCallback(() => {
    openRef.current = false;
    timingRef.current = null;
    setOpen(false);
    setMeter(0);
    tts.setMicOpen(false);
  }, []);

  const closeMic = useCallback(
    async (why: "tap" | "ptt" | "silence" | "cap") => {
      if (!openRef.current) return;
      finishOpen();
      setBusy(true);
      try {
        const transcript = (await session().close()).trim();
        if (!transcript) {
          if (session().cartesiaFailed) {
            status(
              propsRef.current.allowWebSpeech && webSpeechCtor()
                ? "Couldn't reach the voice service. Next time Steady uses the browser's speech recognition."
                : "Couldn't reach the voice service. Tiles, keys and the typed box still work.",
              "alert",
            );
          } else {
            status(why === "cap" ? "Mic closed at the time limit. Didn't hear a command." : "Didn't hear anything.");
          }
          return;
        }
        status(`Heard: ${transcript}`);
        const p = propsRef.current;
        const r = await resolveText(transcript, {
          mode: "voice",
          dialogOpen: p.dialogOpen,
          context: p.getContext(),
          onStatus: (t, l) => status(t, l),
        });
        propsRef.current.onResolution(r);
      } finally {
        setBusy(false);
      }
    },
    [finishOpen, status],
  );

  const openMic = useCallback(
    async (mode: "tap" | "ptt") => {
      const p = propsRef.current;
      if (p.quiet || p.disabled) return;
      if (openRef.current) {
        if (timingRef.current) timingRef.current = { ...timingRef.current, mode };
        return;
      }
      openRef.current = true;
      timingRef.current = newMicTiming(mode);
      setOpen(true);
      setBanner(null);
      tts.setMicOpen(true); // cancels any speech in progress
      p.onMicOpen(); // B lifts the pen (push-to-talk start lifts the pen)
      status("Listening…");
      const res = await session().open({
        onActivity: () => {
          if (openRef.current && timingRef.current) timingRef.current = noteActivity(timingRef.current, Date.now());
        },
        onDelta: (full) => {
          if (!openRef.current || !timingRef.current) return;
          timingRef.current = noteActivity(timingRef.current, Date.now());
          status(`Heard: ${full}…`);
        },
        onLevel: (level, m) => {
          setMeter(m);
          if (openRef.current && timingRef.current && level >= VOICE_LEVEL) {
            timingRef.current = noteActivity(timingRef.current, Date.now());
          }
        },
        onEnded: (reason) => {
          finishOpen();
          session().cancel();
          setBanner({ kind: reason === "revoked" ? "revoked" : "error", text: BANNER_TEXT[reason === "revoked" ? "revoked" : "error"] });
          status(reason === "revoked" ? "Microphone access was turned off." : "Microphone stopped.", "alert");
        },
        onError: (m) => status(`Voice: ${m}`, "alert"),
      }, { allowWebSpeech: p.allowWebSpeech === true });
      if (res.ok && res.engine === "webspeech" && openRef.current) {
        status(webSpeechNoticeShown ? WEB_SPEECH_STATUS : WEB_SPEECH_NOTICE);
        webSpeechNoticeShown = true;
      }
      if (!res.ok) {
        if (!openRef.current) return; // closed or cancelled meanwhile
        finishOpen();
        if (res.reason === "offline") {
          status("Voice is off: no network connection. Tiles, keys and the typed box still work.", "alert");
        } else if (res.reason === "key_missing") {
          status("Voice needs a Cartesia key (key missing). Use the tiles or type the command.");
        } else if (res.reason === "token_failed") {
          status("Voice is unavailable (no connection to the voice service). Tiles, keys and the typed box still work.", "alert");
        } else if (res.reason !== "failed" || res.message !== "cancelled") {
          const kind = res.reason === "denied" || res.reason === "no_device" || res.reason === "unsupported" ? res.reason : "error";
          setBanner({ kind, text: BANNER_TEXT[kind] });
          status(BANNER_TEXT[kind], "alert");
        }
      }
    },
    [finishOpen, status],
  );

  // Push-to-talk edges.
  const prevPtt = useRef(pttHeld);
  useEffect(() => {
    if (pttHeld && !prevPtt.current) void openMic("ptt");
    if (!pttHeld && prevPtt.current) void closeMic("ptt");
    prevPtt.current = pttHeld;
  }, [pttHeld, openMic, closeMic]);

  // Tap-mode auto close (silence after speech / cap from speech onset).
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => {
      const t = timingRef.current;
      if (!t) return;
      const why = autoCloseReason(t, Date.now(), micSilenceMs, micCapMs);
      if (why) void closeMic(why);
    }, 100);
    return () => clearInterval(id);
  }, [open, micSilenceMs, micCapMs, closeMic]);

  // Quiet mode / disabled: cancel an open mic, no transcript.
  useEffect(() => {
    tts.setQuiet(quiet);
    if ((quiet || disabled) && openRef.current) {
      finishOpen();
      session().cancel();
      status(quiet ? "Quiet mode: mic off." : "Mic off.");
    }
  }, [quiet, disabled, finishOpen, status]);

  // Spoken-reply problems ("voice unavailable", "key missing") surface in the status line.
  useEffect(
    () =>
      tts.onStatus((st, text) => {
        if (st !== "ok" && text) status(text);
      }),
    [status],
  );

  // Unmount: release everything.
  useEffect(
    () => () => {
      sessionRef.current?.dispose();
      tts.setMicOpen(false);
    },
    [],
  );

  const onClick = () => {
    if (openRef.current) void closeMic(timingRef.current?.mode === "ptt" ? "ptt" : "tap");
    else void openMic("tap");
  };

  const pct = Math.min(100, Math.round(Math.sqrt(meter) * 160));

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-pressed={open}
        disabled={quiet || disabled}
        onClick={onClick}
        data-testid="mic-tile"
        data-busy={busy ? "true" : undefined}
        className={[
          "relative flex min-h-16 min-w-16 flex-col items-center justify-center rounded-lg border-2 px-3 py-2 text-lg font-semibold",
          "focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-yellow-400",
          "disabled:cursor-not-allowed disabled:opacity-60",
          open ? "border-white bg-red-700 text-white" : "border-neutral-300 bg-neutral-900 text-white",
        ].join(" ")}
      >
        <span>Mic</span>
        <span aria-hidden="true" className="mt-1 block h-2 w-10 overflow-hidden rounded bg-neutral-700">
          <span className="block h-full bg-green-400" style={{ width: `${open ? pct : 0}%` }} />
        </span>
        <span aria-hidden="true" className="text-sm font-normal">
          {open ? "On" : busy ? "…" : "Off"}
        </span>
      </button>
      {banner && (
        <div role="alert" className="rounded border-2 border-yellow-400 bg-neutral-900 p-2 text-lg text-white">
          {banner.text}
        </div>
      )}
    </div>
  );
}

export { MicTile };
