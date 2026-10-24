# Steady — pitch (3 min) + Q&A (2 min)

**Rule for the presenter: demo first, talk second.** Lead with the pen-state law and the resting hand.
Never call it a "camera mouse" (that is prior art; see README › Prior art). Never name a diagnosis for
the person at the table, never show a tremor frequency, never say "treats" or "helps with" a condition.
Cite only the facts in README › Who it's for.

Setup before judges arrive: Krita fills the screen, Steady's Chrome strip (`npm run demo-chrome`) on the
left at 320 px, helper running, iPhone wired and looking down at the desk, a rolled towel under the
presenter's forearm, foot pedal on the floor, Demo page open. Fallback if Krita or the helper misbehaves:
the practice canvas + Simulate tremor + Steadiness ± tiles need only Chrome and the camera.

---

## 0:00–1:30 · Demo (no slides)

1. **(0:00)** Rest your forearm on the towel, fingers curled loosely. Say nothing yet. Hold still: the ring
   fills, the cursor turns solid. Draw a short wave in Krita. Hold still: the pen lifts.
   > "My hand is resting. I'm not holding anything. Holding still puts the pen down; holding still again
   > lifts it."
2. **(0:20)** Tap **Simulate tremor** on the Demo page. Draw again: the faded raw trace scribbles, the stroke
   in Krita stays clean; point at the deviation number.
   > "That shake is simulated and added before our filter. The grey line is what the camera sees; the ink is
   > what Krita gets."
3. **(0:40)** Say **"steadier"** (or tap Steadier): the deviation drops.
4. **(0:50)** Hands still resting, voice only: **"blue"**, **"bigger"**, **"new layer"**, paint, **"undo that"**.
   Then: **"make it thinner and a bit softer"** → status shows *Heard: smaller + airbrush*.
   > "When our grammar doesn't know a phrase, Claude turns the text into actions. You always see what it
   > heard, and Undo reverses it."
5. **(1:10)** Mid-stroke, cover the camera with your other hand. The stroke ends cleanly; status says
   tracking lost, pen is up.
6. **(1:20)** Press **F9** with the pedal (or say "pause"): the tile reads **Resume**; dwell on it to resume.

## 1:30–2:30 · Why it works

- **The pen-state law.** "Anything lifts. Only a dwell, the pen key, a pedal or the word *down* lowers.
  Nothing lowers by itself. So a resting hand can't leave ink, a lost hand can't scribble, and the mouse
  button is never left held: the helper lets go after 300 ms of silence, on pause, on tracking loss, on
  exit."
- **Resting-hand ergonomics.** "The hand rests on the desk. We track the knuckle, which moves with the
  forearm, so the elbow and shoulder do the work. No pinch, no grip, no finger held out: the MediaPipe "virtual mouse"
  projects click by pinching, which loads exactly the joint that hurts. Essential tremor is
  suppressed by resting the hand; that's the design."
- **Who.** "Digital artists who can't hold a stylus for long, or at all. 88.8 % of fine-arts students and
  faculty report musculoskeletal pain. In an ASSETS 2024 study of 15 disabled artists, participants avoided
  voice in shared spaces — so nothing in Steady is voice-only: every action is a big tile, a typed command,
  and the core ones a pedal key."

## 2:30–3:00 · Close

- "Three processes on one Mac: Chrome does the tracking and smoothing in a Worker, a Python helper moves the
  real pointer, a Krita plugin changes brushes and layers. Cartesia Ink 2 with keyterms for short commands;
  Claude only for text the grammar can't parse, never in the pointer path, never hearing audio."
- "Camera frames never leave the computer."
- "Next: a pilot with five artists through a hand clinic, a signed menu-bar app, and Windows."

---

## Q&A (2 min) — short, honest answers

- **"Isn't this a camera mouse?"** Camera mice move a pointer with the head and click by dwell; MediaPipe "virtual mouse"
  projects click by pinching. Steady is built around a hand that rests, tremor-aware smoothing before gain,
  a pen-state law that makes a resting hand unable to ink, and voice inside Krita.
- **"Lag?"** Each stroke starts a few pixels late by design (the dead zone); Help says start a little before
  the mark. Steadiness trades lag for smoothness and is a slider, because ability changes hour to hour.
- **"Pressure?"** Krita sees a mouse as full pressure; we set the brush's size to follow **Speed** instead,
  which gives tapers. No tablet-pressure injection.
- **"What if the voice recogniser gets it wrong?"** You see "Heard: …", Undo is one tap or pedal press, and
  everything voice does is also a tile and a typed command. We have not measured accuracy on dysarthric
  speech and say so.
- **"Did you test with real users?"** Say exactly what is true at the time (see `docs/user-interview.md`).
  If no interview was recorded, say so. Do not paraphrase a quote that was not recorded.
- **"Only Krita?"** Krita gets the deep integration (plugin). An app profile switches to keyboard shortcuts,
  and we built a Photoshop profile to show the same layer works elsewhere; "show numbers" puts numbered
  badges over Krita's own buttons so "click 5" reaches buttons too small to dwell on. Say plainly which of
  these were tried on real hardware (see NEEDS-HUMAN.md).
- **"What if my hand can't rest today?"** Head mode moves the pointer with the nose through the same
  pipeline; hand presets and named profiles ("Shaky day") switch everything at once. Same honesty rule.
- **"Is it medical?"** No. Steady is not a medical device and doesn't diagnose or treat anything.
- **"Privacy?"** Camera stays local. Audio goes to Cartesia only while the mic is open. Unmatched command text,
  never audio, goes to Anthropic with the current brush context.
- **"Cost?"** A Mac, an iPhone or webcam, and optionally a $60–90 foot pedal, versus about $1,249 for a
  clinical eye-gaze pointer.
