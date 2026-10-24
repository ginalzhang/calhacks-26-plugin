# Demo video script (2:00) — screen recording + phone B-roll

Record at the 22:00 freeze. Screen: Krita full screen with Steady's Chrome strip (320 px) on the left,
recorded with macOS Screenshot (`⌘ ⇧ 5`, "Record Entire Screen", microphone on). B-roll: a second phone
filming the hand on the desk from the side. Caption every shot that uses Simulate tremor with
**"Simulated tremor"**. Do not stage anything that did not work; cut an optional beat instead.

| Time | Shot | Audio / caption |
|---|---|---|
| 0:00 | B-roll: a hand struggling to grip a stylus, then setting it down and resting open on the desk, forearm on a rolled towel. | Caption: "What if you could paint without holding anything?" |
| 0:12 | Title card with the recorded user quote from `docs/user-interview.md`. **If no quote was recorded,** use instead: *"To lose the ability to draw would be a catastrophic loss of myself" — Peter Dunlap-Shohl, cartoonist (PBS Independent Lens).* | Read the quote, or silence. |
| 0:20 | Screen: Krita beside Steady's strip. Demo page, **Simulate tremor** on. Hold still (ring fills), draw a line: shaky. | Caption: **"Simulated tremor"** |
| 0:35 | Say **"steadier"**. The live trace shows the raw scribble (faded) under a clean stroke; the deviation number drops. | Caption: "Raw camera path (grey) vs what Krita receives" |
| 0:55 | Hands resting, voice only: **"blue"**, **"bigger"**, **"new layer"**, paint a stroke, **"eraser"**, **"undo that"**, **"save"**. Keep the status line ("Heard: …") visible. | Natural speech. |
| 1:05 | Say **"make it thinner and a bit softer"** → status: *Heard: smaller + airbrush*. Show Undo reversing both. | Caption: "Unmatched phrases go to Claude as text; you see what it heard, Undo reverses it." |
| 1:20 | *(Optional — only if P2a's Krita dwell-click works on the real Mac.)* Dwell on an enlarged Krita toolbox button: it clicks. | Caption: "Dwell to click Krita's own buttons" |
| 1:28 | *(Only if P2b Hatch landed.)* Say **"hatch"**; fast back-and-forth over Krita's parallel ruler; only forward passes leave ink. | Caption: "Hatch: forward passes only" |
| 1:35 | Mid-stroke, cover the camera with the other hand. Stroke ends cleanly, status "Tracking lost", then "Tracking back. Pen is up." | Caption: "Lose the hand → the pen lifts. Never a scribble." |
| 1:45 | Say **"quiet mode"** (or tap Quiet). Same actions with the **foot pedal** and tiles: pen down/up with the pedal, Blue tile, Undo tile. No speech. | Caption: "Everything voice does is also a tile, a typed command or a pedal." |
| 1:55 | Team card: names, "Built at Cal Hacks 13.0", repo URL. | — |

Checklist before export: no API keys or `.env` on screen; the Simulated-tremor caption is on every tremor
shot; nothing claims a medical benefit; length ≤ 2:00.

---

## Fallback video (record at 22:00 first, before the full script)

Needs **only Chrome and the camera**: no helper, no Krita, no API keys. This is the guaranteed demo
(P0 + the Demo panel). Open `npm run demo-chrome` (it opens `?demo=1`) with the window at a normal width so
the practice canvas sits beside the side panel. Rest the forearm on a rolled towel; iPhone wired, looking
down at the desk. Record with `⌘ ⇧ 5`. Total ≤ 1:30.

| Time | Shot | Caption |
|---|---|---|
| 0:00 | B-roll: hand sets a stylus down and rests open on the desk. | "No stylus. No grip." |
| 0:08 | Setup page: **Recalibrate**. Hold still (3 s), draw an easy circle (4 s), move right then away (3 s). | "15-second calibration" |
| 0:22 | Practice canvas: hold still (ring fills, cursor turns solid), write a short word, hold still to lift. | "Hold still to lower, hold still to lift" |
| 0:40 | Demo page: **Simulate tremor** on. Hold, draw a line: the faded raw trace scribbles, the stroke is cleaner; point at Deviation. | **"Simulated tremor"** |
| 0:55 | Tap **Steadiness up** twice (or **Steadier**); draw the same line; Deviation drops. Then **Steadiness down** to show the trade-off. | **"Simulated tremor"** · "Steadiness is a slider: ability changes hour to hour" |
| 1:10 | Press the pedal / F7: the line disappears (Undo). Cover the camera mid-stroke: the stroke ends cleanly, "Tracking lost", then "Tracking back. Pen is up." | "Lose the hand → the pen lifts" |
| 1:22 | **Next judge** clears the canvas and metrics. Team card. | "Built at Cal Hacks 13.0" |

Rules: the "Simulated tremor" caption stays on every tremor shot; never call the simulated shake a real
user's tremor; no medical claims.
