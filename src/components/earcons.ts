/**
 * Pen earcons (§3): two distinct short clicks for pen down / pen up. Off when earcons are off or in
 * quiet mode. Never speech. WebAudio; silently does nothing until the page may play audio.
 */
let ctx: AudioContext | null = null;

export function playEarcon(kind: "down" | "up") {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(kind === "down" ? 880 : 520, t);
    osc.frequency.exponentialRampToValueAtTime(kind === "down" ? 1320 : 340, t + 0.05);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.08);
  } catch {
    /* audio unavailable */
  }
}
