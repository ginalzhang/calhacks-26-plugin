# Steady — pitch (3 min) + Q&A (2 min)

**Rule for the presenter: demo first, talk second.** Lead with the pen-state law and the resting hand.
Never call it a "camera mouse" (that is prior art; see README › Prior art). Never name a diagnosis for
the person at the table, never show a tremor frequency, never say "treats" or "helps with" a condition.
Cite only the facts in README › Who it's for.

Setup before judges arrive: Krita fills the screen with the **Steady panel docked at the side**
(Settings › Dockers › Steady), a picture open, **Start** pressed (status says Tracking), iPhone wired and
looking down at the desk (Desk View chosen in the panel), a rolled towel under the presenter's forearm.
Nothing else is on screen: no browser, no terminal. Fallback if the plugin build misbehaves: the website
version (README › "Fallback: website version"; `npm run dev` + `npm run demo-chrome`) shows the same
pipeline on its practice canvas with only Chrome and the camera.

---

## 0:00–1:30 · Demo (no slides)

1. **(0:00)** Rest your forearm on the towel, fingers curled loosely. Say nothing yet. Hold still over
   Krita's canvas: the pen goes down. Draw a short wave in Krita. Hold still: the pen lifts.
   > "My hand is resting. I'm not holding anything. Holding still puts the pen down; holding still again
   > lifts it. Everything you see is inside Krita."
2. **(0:20)** *(Only if the panel's Simulate tremor toggle works on the real Mac.)* Turn on **Simulate
   tremor** in the panel. Draw again: the panel's live trace shows the raw path scribbling, the stroke in
   Krita stays clean; point at the deviation number.
   > "That shake is simulated and added before our filter. The faded line is what the camera sees; the ink
   > is what Krita gets."
3. **(0:40)** Say **"steadier"** (or press the Steadiness + tile): the deviation drops.
4. **(0:50)** Hands still resting, voice only (hold **F10** or tap **Mic**): **"blue"**, **"bigger"**,
   **"new layer"**, paint, **"undo that"**. Then type or say **"make it thinner and a bit softer"** → the
   panel shows *Heard: smaller + airbrush*.
   > "When our grammar doesn't know a phrase, Claude turns the text into actions. You always see what it
   > heard, and Undo reverses it."
5. **(1:10)** Mid-stroke, cover the camera with your other hand. The stroke ends cleanly; the panel says
   tracking lost, pen is up.
6. **(1:20)** Press **F9** (or say "pause"): the tile reads **Resume** and the pointer can't leave the
   panel; dwell on Resume to resume.

## 1:30–2:30 · Why it works

- **The pen-state law.** "Anything lifts. Only a dwell, the pen key or the word *down* lowers. Nothing
  lowers by itself. So a resting hand can't leave ink, a lost hand can't scribble, and the mouse button is
  never left held: Steady lets go after 300 ms of silence, on pause, on tracking loss, on Stop, on exit."
- **Resting-hand ergonomics.** "The hand rests on the desk. We track the knuckle, which moves with the
  forearm, so the elbow and shoulder do the work. No pinch, no grip, no finger held out: the MediaPipe
  "virtual mouse" projects click by pinching, which loads exactly the joint that hurts. Essential tremor is
  suppressed by resting the hand; that's the design."
- **Who.** "Digital artists who can't hold a stylus for long, or at all. 88.8 % of fine-arts students and
  faculty report musculoskeletal pain. In an ASSETS 2024 study of 15 disabled artists, participants avoided
  voice in shared spaces — so nothing in Steady is voice-only: every action is a big panel tile, a typed
  command, and the core ones an F-key."

## 2:30–3:00 · Close

- "It's a Krita plugin. The panel lives in Krita; because Krita can't use the camera on a Mac, the panel
  starts a small hidden app, Steady Tracker, that does the camera, the pointer and the voice. The smoothing
  and the pen law are the same TypeScript we tested with hundreds of replayed hands. Cartesia Ink 2 with
  keyterms for short commands; Claude only for text the grammar can't parse, never in the pointer path,
  never hearing audio."
- "Camera frames never leave the computer."
- "Next: a pilot with five artists through a hand clinic, a signed tracker app, and Windows."

---

## Q&A (2 min) — short, honest answers

- **"Isn't this a camera mouse?"** Camera mice move a pointer with the head and click by dwell; MediaPipe
  "virtual mouse" projects click by pinching. Steady is built around a hand that rests, tremor-aware smoothing
  before gain, a pen-state law that makes a resting hand unable to ink, and voice inside Krita.
- **"Why a separate app?"** Krita for macOS has no camera permission, and anything it launches directly
  inherits that. Steady Tracker is launched through macOS, so it asks for the camera under its own name. The
  panel starts and stops it; the user never sees it.
- **"Lag?"** Each stroke starts a few pixels late by design (the dead zone): start a little before the mark.
  Steadiness trades lag for smoothness and is a slider, because ability changes hour to hour.
- **"Pressure?"** Krita sees a mouse as full pressure; we set the brush's size to follow **Speed** instead,
  which gives tapers. No tablet-pressure injection.
- **"What if the voice recogniser gets it wrong?"** You see "Heard: …", Undo is one tile or F7, and everything
  voice does is also a tile and a typed command. We have not measured accuracy on dysarthric speech and say so.
- **"Did you test with real users?"** Say exactly what is true at the time (see `docs/user-interview.md`).
  If no interview was recorded, say so. Do not paraphrase a quote that was not recorded.
- **"What did you test on real hardware?"** Say exactly what is ticked in NEEDS-HUMAN.md, nothing more.
- **"Only Krita?"** Yes for the plugin. The website version also has a Photoshop keyboard-shortcut profile,
  head mode and numbered badges over Krita's buttons; say plainly that those are website-only and which were
  tried on real hardware.
- **"Is it medical?"** No. Steady is not a medical device and doesn't diagnose or treat anything.
- **"Privacy?"** Camera stays local. Audio goes to Cartesia only while the mic is open. Unmatched command text,
  never audio, goes to Anthropic with the current brush context.
- **"Cost?"** A Mac and an iPhone or webcam, versus about $1,249 for a clinical eye-gaze pointer.
