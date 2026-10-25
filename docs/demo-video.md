# Demo video script (2:00) — screen recording + phone B-roll

Record at the 22:00 freeze. Screen: **Krita full screen with the Steady panel docked at the side**
(Settings › Dockers › Steady), a picture open, Start pressed. No browser, no terminal on screen. Record with
macOS Screenshot (`⌘ ⇧ 5`, "Record Entire Screen", microphone on). B-roll: a second phone filming the hand on
the desk from the side. Caption every shot that uses Simulate tremor with **"Simulated tremor"**. Do not
stage anything that did not work; cut an optional beat instead. Keep the panel's status line ("Heard: …",
Tracking) readable in every screen shot (zoom in during editing if needed).

| Time | Shot | Audio / caption |
|---|---|---|
| 0:00 | B-roll: a hand struggling to grip a stylus, then setting it down and resting open on the desk, forearm on a rolled towel. | Caption: "What if you could paint without holding anything?" |
| 0:12 | Title card with the recorded user quote from `docs/user-interview.md`. **If no quote was recorded,** use instead: *"To lose the ability to draw would be a catastrophic loss of myself" — Peter Dunlap-Shohl, cartoonist (PBS Independent Lens).* | Read the quote, or silence. |
| 0:20 | Screen: Krita with the Steady panel. Press **Start**: status goes to **Tracking**, the camera preview shows the hand. Hold still over the canvas (pen down), draw a wave, hold still (pen lifts). | Caption: "A Krita plugin. The hand rests; holding still lowers and lifts the pen." |
| 0:35 | *(Only if the panel's Simulate tremor works.)* Panel: **Simulate tremor** on; draw a line; the live trace shows the raw scribble (faded) under the clean stroke. Say **"steadier"**: the deviation number drops. | Caption: **"Simulated tremor"** · "Raw camera path (faded) vs what Krita receives" |
| 0:55 | Hands resting, voice only (hold F10): **"blue"**, **"bigger"**, **"new layer"**, paint a stroke, **"eraser"**, **"undo that"**, **"save"**. Keep "Heard: …" visible. | Natural speech. |
| 1:05 | Type in the panel's box (or say) **"make it thinner and a bit softer"** → *Heard: smaller + airbrush*. Press **Undo** to reverse both. | Caption: "Unmatched phrases go to Claude as text; you see what it heard, Undo reverses it." |
| 1:20 | *(Optional — only if it works on the real Mac.)* Dwell on an enlarged Krita toolbox button: it clicks. | Caption: "Dwell to click Krita's own buttons" |
| 1:28 | *(Only if Hatch works in the plugin build.)* Say **"hatch"**; fast back-and-forth over Krita's parallel ruler; only forward passes leave ink. | Caption: "Hatch: forward passes only" |
| 1:35 | Mid-stroke, cover the camera with the other hand. Stroke ends cleanly; the panel says tracking lost, then "Tracking back. Pen is up." | Caption: "Lose the hand → the pen lifts. Never a scribble." |
| 1:45 | Say **"quiet mode"** (or tap Quiet). Same actions without speech: **F8** pen down/up, a colour tile, the **Undo** tile, **F9** pause → Resume by dwell. | Caption: "Everything voice does is also a tile, a typed command or a key." |
| 1:55 | Team card: names, "Built at Cal Hacks 13.0", repo URL. | — |

Checklist before export: no API keys, `.env.local` or Terminal on screen; the Simulated-tremor caption is on
every tremor shot; nothing claims a medical benefit; length ≤ 2:00.

---

## Fallback video (record first, before the full script)

The guaranteed cut. **Plugin version** (preferred): needs Krita, the Steady panel and the camera only; no API
keys (voice and Claude beats are left out). Total ≤ 1:30.

| Time | Shot | Caption |
|---|---|---|
| 0:00 | B-roll: hand sets a stylus down and rests open on the desk. | "No stylus. No grip." |
| 0:08 | Krita with the Steady panel: **Start**, then **Calibrate**. Hold still (3 s), draw an easy circle (4 s), move right then away (3 s). | "15-second calibration" |
| 0:22 | Hold still over the canvas (pen down), write a short word in Krita, hold still to lift. | "Hold still to lower, hold still to lift" |
| 0:40 | *(If available.)* Panel: **Simulate tremor** on; draw a line; then Steadiness **+** twice and draw it again; the deviation drops. | **"Simulated tremor"** · "Steadiness is a slider: ability changes hour to hour" |
| 1:00 | **F7**: the stroke disappears (Undo). Cover the camera mid-stroke: the stroke ends cleanly, "Tracking lost", then "Tracking back. Pen is up." | "Lose the hand → the pen lifts" |
| 1:15 | **F9** → the tile reads Resume; dwell on it. Team card. | "Built at Cal Hacks 13.0" |

**If the plugin build is not working at 22:00,** record the same beats with the **website version** instead
(README › "Fallback: website version": `npm run demo-chrome` opens `?demo=1`; use its practice canvas,
Setup › Recalibrate, Demo › Simulate tremor and Next judge), and say in the Devpost text that the video shows
the website build.

Rules: the "Simulated tremor" caption stays on every tremor shot; never call the simulated shake a real
user's tremor; no medical claims.
