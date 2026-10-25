# Steady

**Paint in Krita with a hand that rests on the desk. No stylus, no grip, no pinch.**

Steady is a **Krita plugin**. A camera looks down at the desk and tracks a hand whose wrist and forearm rest
on the table, a book or a rolled towel. Steady smooths that hand's movement and drives the real Mac pointer,
so the artist paints on Krita's own canvas with no stylus, no tablet and no grip. Everything you see and
touch is a **Steady panel inside Krita** (a docker); the camera, voice and pointer work runs in a small
hidden helper app, **Steady Tracker**, that the panel starts and stops. Big panel tiles, voice, a typed
command box and the F-keys replace the tablet's buttons.

Built in 36 hours at Cal Hacks 13.0. macOS 14+ on Apple silicon, Krita 5.3.x. Hardware: the Mac, a camera
(an iPhone as Continuity Camera / Desk View, or the built-in camera), a microphone, the keyboard and a
mouse or touchpad. Nothing else.

Steady is not a medical device. It does not diagnose, treat or measure any condition.

> **Verification status.** The pointer pipeline, grammar and action dispatch are the same TypeScript code
> that was tested with synthesised landmark replays (Vitest/Playwright, 795 tests at the website freeze);
> the tracker, panel and bridge have pytest suites with fake cameras, a fake mouse and a fake Krita.
> Anything that needs a real camera, a real Mac pointer, real macOS permission dialogs or real Krita is
> listed in [`NEEDS-HUMAN.md`](NEEDS-HUMAN.md) and is **not** claimed as working until a human ticks it.

---

## Who it's for

**Digital artists and illustrators who can no longer hold a stylus for long, or at all.** That includes
adults with hand osteoarthritis (especially at the base of the thumb), rheumatoid arthritis, carpal tunnel,
RSI and tendinopathy, De Quervain's, focal hand dystonia, essential tremor, Parkinson's, hypermobility and
mild cerebral palsy. Steady describes what a hand does, never a diagnosis.

- Art practice hurts: **88.8 %** of fine-arts students and faculty report musculoskeletal pain and **64 %** a
  practice-related disorder ([Work, doi:10.3233/WOR-203157](https://doi.org/10.3233/WOR-203157)).
- The thumb base, which a stylus grip and every "pinch to click" gesture load, has osteoarthritis in
  **22.4 %** of UK adults over 50 ([ACR abstract](https://acrabstracts.org/?p=1568)).
- In writer's cramp, only handwriting, not steadiness or aiming tests, separated patients from controls
  ([PMC5547537](https://pmc.ncbi.nlm.nih.gov/articles/PMC5547537/)), so a grip-free posture is a plausible,
  untested workaround.
- Essential tremor is suppressed by resting the hand. **That is the ergonomic core of Steady:** the hand rests;
  larger joints (elbow, shoulder) do the work; the forearm slides.
- A Krita user with a shaky hand on Weighted smoothing: *"The lag seems barely noticeable with HUGE upside…
  This is a game changer!"* ([krita-artists.org](https://krita-artists.org/t/shaky-hand-with-drawing/109056)).
- Cartoonist Peter Dunlap-Shohl, on Parkinson's: *"To lose the ability to draw would be a catastrophic loss of
  myself"* ([PBS Independent Lens](https://www.pbs.org/independentlens/?p=28501)).
- Voice cannot be the only way in: a baseline recogniser had **36.3 %** word error on Parkinson's speech vs
  **3.4 %** on typical speech ([PMC12379581](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12379581/)). In an
  ASSETS 2024 study of 15 disabled artists, **7** did not know their OS had accessibility features, and
  participants avoided voice and head control in shared spaces
  ([ASSETS 2024](https://cil.csit.carleton.ca/b/wp-content/uploads/2024/09/Digital_Artists___ASSETS_24___RC.pdf)).
  So every action is also a panel tile, a typed command and (for the core ones) a key.
- Cost: a clinical eye-gaze pointer costs about **$1,249** (Tobii PCEye 5); Steady needs the Mac and an
  iPhone or webcam.

## How to install

One command, safe to run again (it skips what is already done). `--dry-run` prints every step without
changing anything.

```bash
bash scripts/install-steady.sh            # or: bash scripts/install-steady.sh --dry-run
```

It checks the prerequisites (macOS on Apple silicon, Krita in `/Applications`, Node ≥ 20, Python 3.12 from
Homebrew; if Python is missing it prints `brew install python@3.12`), then:

1. `npm install` (only if `node_modules` is missing);
2. `npm run brain:build` → `tracker/brain/dist/brain.mjs` (the tested TypeScript pipeline as one Node file);
3. the tracker's Python 3.12 environment (`tracker/.venv`: MediaPipe, OpenCV, sounddevice, pyobjc);
4. the MediaPipe hand model, downloaded once (`scripts/fetch-mediapipe.sh`), so tracking needs no network;
5. the panel's action table, generated from `src/actions.ts` (`scripts/gen-plugin-actions.mjs`);
6. the Krita plugin → `~/Library/Application Support/krita/pykrita/` (`scripts/krita-plugin-install.sh`);
7. **Steady Tracker.app** → `~/Applications/Steady Tracker.app` (`scripts/build-tracker-app.sh --install`). The
   app is a small launcher for `scripts/run-tracker.sh`, so tracker code updates need no rebuild; the
   installer rebuilds it only when the build script changed or with `--rebuild-tracker`, because every
   rebuild changes its ad-hoc signature and macOS may forget the permissions;
8. it reports whether the API keys are in `.env.local`, and prints the steps below.

Then, in Krita (once):

1. **Krita › Preferences…** (Settings › Configure Krita…) › **Python Plugin Manager** › tick **Steady** › OK.
2. **Quit Krita and open it again.**
3. **Settings › Dockers › Steady** (or **Tools › Steady › Show panel**). Dock the panel at the side of the canvas.
4. Press **Start** at the top of the panel. macOS asks for **Camera** and **Microphone** for **"Steady
   Tracker"**: allow both. Then turn **"Steady Tracker"** on under System Settings › Privacy & Security ›
   **Accessibility** and **Input Monitoring**. Until then the panel shows "Steady Tracker needs permission",
   one line per missing permission and an "Open … settings" button for each; afterwards press Stop, then Start.
   Tracker log: `~/Library/Logs/Steady/tracker.log`.

Before painting:

- **Turn off** macOS Voice Control, Dwell Control and Head Pointer (System Settings › Accessibility); they act on
  the same pointer and the same words. **Unplug drawing tablets** (Krita can latch into tablet mode).
- **Krita 5.3.x** (5.3.4 is on the build Mac; not Krita 6). Follow [`scripts/krita-setup.md`](scripts/krita-setup.md)
  (enlarge toolbox icons, lock dockers, a brush whose size follows Speed).
- **Camera:** an iPhone as Continuity Camera, **wired over USB**, looking down at the desk; choose "Desk View" in
  the panel's camera list if it is there. The built-in camera works too if it can see the desk.
- **F-keys:** a Mac may need System Settings › Keyboard › "Use F1, F2, etc. keys as standard function keys".
- **If the pointer ever seems stuck, click the physical mouse or touchpad once.**

Step-by-step for non-experts, with System Settings deep links: [`scripts/human-setup.md`](scripts/human-setup.md).

**API keys** (optional; without them voice and the Claude fallback run on mocks and the panel says "key
missing"): put `CARTESIA_API_KEY` and `ANTHROPIC_API_KEY` (optionally `CARTESIA_VOICE_ID`) in `.env.local` at
the repo root (see `.env.example`). Steady Tracker reads that file (its path is baked into the app when it is
built), then the environment.

## How to use (panel tour)

Rest your forearm on the desk or a rolled towel, fingers curled loosely. Move from the elbow and shoulder;
let the forearm slide; keep the wrist straight.

**The pinned header** (always visible):

- **Start / Stop.** Start launches Steady Tracker; the tile then reads Stop, which quits it (the mouse button is
  released first). Beside it: the tracking dot and word (**Tracking** / **Weak** / **Lost**: a dot *and* a word),
  the fps, and whether the tracker and Krita are connected.
- **Status, "Heard: …" and "Undo: …"** lines: what Steady heard, what it did, and what Undo would undo.
- **Core tiles**, each with its key: **Pen** (F8), **Pause** (F9), **Mic** (F10, hold to talk), **Undo** (F7),
  **Redo** (F6), **Recenter** (F5), **Other hand** (F4), **Latch** (F3). The keys are global while Krita is in
  front and are remappable; a Mac may need "Use F1, F2, etc. keys as standard function keys". Any USB foot pedal
  or switch programmed to send one of these keys works too (optional).
- **Page tiles:** Steady · Presets · Modes · Setup · Input · Timing · Krita · Paint · Colour · View · Layers · Demo.

**First run:** a Privacy box (the text under Privacy below) until you press **Got it**; a permissions box
whenever Steady Tracker is missing a permission.

**Pages:**

- **Setup.** The camera **preview** (160×120, the tracked point drawn on it), the **Camera** list (Desk View is
  preferred when present), **Mirror camera** / **Rotate camera**, **Recalibrate**, **Pointer point** (index
  knuckle by default), **Use last setup**, and profiles (**Steady day**, **Shaky day**, **Save profile**).
- **Recalibrate** takes about 15 s: hold still (3 s), draw an easy circle (4 s), move right then away (3 s); a
  progress box shows each step on every page. Calibration is kept per hand.
- **Rest hand → pointer.** The pointer follows the index knuckle (it moves only with the wrist and forearm).
- **Dwell to lower, dwell to lift.** Hold still ~0.8 s over Krita's canvas: the pen goes down and you paint.
  Hold still more tightly ~1.2 s: the pen lifts. A slow, deliberate stroke never lifts; a resting hand never
  leaves ink. Over the panel's tiles (and Krita's buttons), a dwell is one left click.
- **Steady.** The Steadiness slider (with − and + tiles), **Steadier** / **Looser**, **Dots**, **Hatch**, **Quiet**.
- **Presets.** Hand presets that describe what a hand does: *Sore joints, steady hand*, *Shakes when holding
  still or reaching*, *Slow movements, shakes at rest*, *Hard to hold still*. Change any slider afterwards.
- **Modes.** Smoothing presets **Sketch**, **Ink mode**, **Shade**; Hatch variants, **Dash**, **Repeat stroke**.
- **Paint.** The **typed box** (Return or **Run**): the same grammar as voice, e.g. `blue`, `size 20`,
  `new layer`; what the grammar can't match goes to Claude (below). Brush, Pencil, Ink, Airbrush, Eraser,
  Bigger, Smaller, Size, Fade, Solid, Opacity, Line.
- **Colour / View / Layers.** Colours, lighter/darker, swap, pick; zoom, fit, rotate, mirror, pan; new layer,
  merge down, hide/show, delete/clear layer (these two ask for confirmation), save.
- **Timing / Input / Krita.** Dwell times; turning each input (dwell, keys, camera, voice) on or off, spoken
  replies, sounds; Krita-side settings.
- **Demo.** **Simulate tremor**, **Next judge**, a live trace of the raw (faded) and drawn paths and the deviation.
- **Mic.** Tap the Mic tile to open or close the microphone, or hold F10 to talk. Say "blue", "bigger",
  "new layer", "undo that", "steadier", "save". The status line always shows **"Heard: …"** and what Steady did.
- **Pause / Resume.** F9, the Pause tile, or saying "pause". The button is released, the pointer is clamped to the
  Steady panel, so ink in Krita is impossible, and the tile becomes **Resume**, reachable by dwell alone.

## How it works

```
Krita
 ├─ Steady panel (docker, PyQt5)  ──tcp 127.0.0.1:8767 (JSON lines)──►  Steady Tracker.app (Python 3.12)
 │    tiles, sliders, status, preview, mic, typed box                  ├─ camera (OpenCV AVFoundation) → MediaPipe HandLandmarker (Python)
 │                                                                     ├─ brain: `node tracker/brain/dist/brain.mjs` (stdin/stdout JSON lines)
 └─ Steady bridge (tcp 127.0.0.1:8766) ◄────────────────────────────── │     = src/pipeline (One Euro, dwell, pen law, calibration, Hatch…)
      action/color/size/preset/layers/canvas_rect/list_widgets…        │       + grammar + action dispatch (pure TS, the tested code, bundled)
                                                                       ├─ pointer + watchdog + hotkeys (reuses helper/steadyhelper)
                                                                       ├─ voice: mic (sounddevice) → Cartesia Ink 2 STT; Sonic TTS; Claude fallback
                                                                       └─ Krita relay → bridge 8766 (reuses helper/steadyhelper/krita_relay)
```

Full contract: [`tracker/PROTOCOL.md`](tracker/PROTOCOL.md) (panel ↔ tracker, tracker ↔ brain) and
[`docs/PROTOCOL.md`](docs/PROTOCOL.md) (tracker ↔ Krita bridge, unchanged from the website build).

**Why a separate tracker app.** Krita for macOS has no camera permission (no `NSCameraUsageDescription` in its
`Info.plist`), and a process Krita spawns directly inherits that, so macOS blocks the camera. The panel
therefore launches **Steady Tracker.app** with `open`: launched by LaunchServices, it is its own "responsible
process" and asks for Camera, Microphone, Accessibility and Input Monitoring under its own name. It has no
Dock icon; the panel is its only face.

**Why a Node "brain".** Every decision (filter, gain, dwell, pen state, calibration, stroke modes, grammar,
which Krita command to send) is the TypeScript pipeline that was built and tested for the website version,
bundled with esbuild into one file and driven over stdin/stdout. The Python tracker does only I/O: camera →
landmarks in, pointer events and Krita commands out. If the brain crashes, the tracker releases the button and
restarts it once.

**Pipeline (filter before gain).** The index-knuckle landmark (default; it moves only with the wrist and
forearm and is unaffected by curled fingers or long nails) is filtered in camera pixels by a One Euro filter
(min cutoff 0.6 Hz, beta 0.005), mapped from a calibrated "active box" to Krita's canvas with a gain of 2–4×,
then passed through a 12-unit lazy-brush dead zone. One **Steadiness** slider (0–100) moves both the cutoff
and the dead-zone radius. Steady switches Krita's own brush smoothing to None once per session, because two
filters in a row add lag.

**The pen-state law.** *Anything lifts; only dwell, the pen key or voice "down" lowers; nothing auto-lowers,
Latch included. Hatch mode is the single named exception.* (A pedal sending the pen key counts as the pen key.)

**Stroke modes (opt-in).** **Hatch** keeps the pen down and inks only forward passes (the pointer stream runs
~120 ms behind so Steady knows a pass has ended before Krita hears about it); **Dots** stamps one click per
dwell; **Dash** inks only while the hand moves; **Repeat** stamps a copy of the last stroke. Every lift source
still lifts in every mode, and a still hand never adds ink.

**Fail-safes.**
- The mouse button is never left held: Steady Tracker releases it if the pointer stream stops for 300 ms, on
  tracking loss, on Pause, on push-to-talk, when the pointer leaves the canvas, when the brain crashes, when the
  panel disconnects or presses Stop, on exit, and inside a top-level exception handler.
- Tracking loss is one rule: a frame whose hand score is < 0.6 counts as no detection; after 300 ms without a
  good frame the button is released and the status gives a reason. On re-acquire the pen stays up.
- **Pause** releases the button and clamps the pointer to the Steady panel's rect; the tracker also refuses
  `down` while paused.
- Clicks only ever land inside Krita's main window (which contains the docked panel) or a floating Steady
  panel: never the menu bar, the Dock or another app.
- No pinch, no grip, no finger held extended, no time limits, no drag required for any UI.

## Cartesia features used

- **Ink 2 streaming speech-to-text** (`ink-2`, `pcm_s16le` 16 kHz from the Mac's microphone via sounddevice),
  opened only while the mic is open (hold F10, or tap the Mic tile).
- **Keyterm biasing:** every voice phrase in the action table (≤ 100 terms, ≤ 1200 characters) so short
  commands like "blue", "bigger", "undo that" survive a loud hall.
- **Manual finalize** for push-to-talk: on release the tracker sends `finalize` and reads transcripts until
  `flush_done`.
- **Access-token flow:** Steady Tracker mints a short-lived token (`POST /access-token`, STT + TTS grants, 1 h)
  with the API key and opens the sockets with the token; it is re-minted after 45 min, only between utterances.
  The key and token are never logged.
- **Sonic 3.6 TTS** (`sonic-3.6`, raw PCM 24 kHz, streamed) for the few confirmations that can't be seen at a glance
  ("Saved", "New layer", "Didn't catch that"), a few words at most, never on pen toggles, never while the mic is
  open, off in quiet mode. *TODO: confirm with a real key on the real Mac (NEEDS-HUMAN.md); delete this bullet
  if TTS did not land in the plugin build.*

The API key stays on this Mac: Steady Tracker reads it from `.env.local`. Without it, voice is off and the panel
says "Voice needs a Cartesia key (key missing). Use the tiles or type the command."

### Limitations (voice)
- Accuracy on dysarthric or accented speech has **not been measured**; English only.
- Hall noise: keyterms help, but nothing is voice-only; tiles, typed commands and keys do everything.
- No network → voice and the Claude fallback are off (with a clear status); tiles, keys, the typed grammar and
  the plugin still work.

## Where Claude is used and where it goes wrong

**Used for exactly one thing:** when the local grammar can't match a voice or typed command, its **text**
(never audio) and the context listed under Privacy go to `claude-haiku-5-5` for structured output: up to two
actions, a clarify prompt with 2–3 options, or "noop" for coughs and fillers. Example: "make it thinner and a
bit softer" → `smaller` + `airbrush`.

**Guards.** The panel's status line always shows **"Heard: …"** and what Steady did; every Claude result is one
**Undo** away; ambiguous requests become numbered **clarify tiles** in the panel (accept/reject, never
automatic, per the ASSETS 2024 recommendation); a 2.5 s timeout or invalid output shows "Didn't catch that"
with the two closest grammar matches as tiles. Calls are logged locally
(`~/Library/Application Support/Steady/claude-log.jsonl`: latency, accepted / rejected / timeout).

**Key missing:** without `ANTHROPIC_API_KEY` a local keyword mock answers instead and the panel says "Claude
key missing", so the flow can be shown, but nothing is sent anywhere. With the key, Steady Tracker calls
Anthropic directly (Python SDK; there is no server route in the plugin build).

**Never used for:** the pointer path, audio, pen state, or anything without a visible "Heard:" and Undo.

**Logged counts:** *TODO — fill from `claude-log.jsonl` after a real session with a key (calls / accepted /
timeouts). No numbers until a real run exists.*

**Failure example 1:** *TODO — a real transcript where Claude picked the wrong action, the screenshot
(`docs/img/claude-failure-1.png`), and how Heard:/Undo recovered it. Do not invent this.*

**Failure example 2:** *TODO — a real timeout or clarify case with screenshot
(`docs/img/claude-failure-2.png`). Do not invent this.*

## Privacy

Camera frames never leave this computer; the camera sees the desk, so papers on it are visible to the app, and processing is local only. Microphone audio goes to Cartesia only while the mic is open. When the local grammar can't match a command, its text (never audio) plus the current tool, preset, size, opacity, colour, Steadiness and your last three actions go to our server and on to Anthropic. The helper and the Krita plugin listen on `127.0.0.1` only and send nothing off the machine.

*In the plugin build* "our server" is the Steady Tracker process on this Mac, which calls Anthropic's API
directly, and "the helper" is Steady Tracker itself (it listens on `127.0.0.1:8767` for the panel; the Krita
bridge listens on `127.0.0.1:8766`). The panel's first-run Privacy box says it that way: "Steady Tracker and
the Krita plugin listen on 127.0.0.1 only and send nothing else off the machine." Settings, calibration and the Claude log stay in
`~/Library/Application Support/Steady/`.

## Pressure

Krita treats every mouse event as **pressure 1.0**, so pressure-mapped brushes paint at full size and there
is no taper. The answer is in Krita, not in Steady: in the brush editor set the **Size** (and optionally
Opacity) sensor to **Speed** instead of Pressure (faster is thinner, and it works with mouse events), add the
**Fade** sensor for a start taper, or pick a preset whose size is not pressure-driven. Size and opacity are
also a voice or typed command away ("size 20", "fade"). Steady does not inject tablet pressure.

## Prior art

Hej Stylus and Lazy Nezumi smooth a **held** stylus. Camera Mouse, eViacam and macOS Head Pointer move a
pointer with the head and click by dwell. Project Gameface clicks by facial gesture. Pawvis tracks a hand in
the air and clicks by a finger dip or dwell. mctrl clicks by pinch. None combine a **resting, no-grip hand**,
**tremor-aware smoothing** and **voice inside Krita**, and none state a pen-state law that makes a resting
hand unable to leave ink.

## From hackathon to Monday

- An OT / hand-clinic pilot with 5 artists.
- A signed and notarised Steady Tracker so Camera / Accessibility / Input Monitoring permissions survive updates.
- A Windows tracker.
- On-device speech recognition as an option for shared studios and flaky networks.
- A full accessibility audit of the panel with disabled users.

## Known limitations

- **Real-hardware status:** *TODO — the plugin build (panel, Steady Tracker, real permissions, real strokes in
  Krita) is verified only as far as NEEDS-HUMAN.md is ticked. Update this line after the checklist.*
- Steady Tracker is built locally and ad-hoc signed. macOS ties permissions to the app's signature, so after a
  rebuild macOS may ask again (or the old grant may silently stop working): remove "Steady Tracker" from
  Accessibility / Input Monitoring and add it again.
- There is no dwell-ring overlay over the canvas in the plugin build: the panel's status, tracking word and
  preview carry the feedback. *TODO: confirm against the final tracker build.*
- The panel renders the whole shared action table, so it also shows tiles for **Head mode**, **Eyebrow lift**,
  **Colour cap** / **Pick sticker colour**, **Lock exposure**, **Show numbers** / **Click number** and the
  **Photoshop** app profile. At the time of writing Steady Tracker tracks the hand only (MediaPipe
  HandLandmarker) and draws no overlay, so those work in the **website version** only (below).
  *TODO: update if they are ported to the tracker.*
- Camera angles from a wheelchair or a bed are untested.
- MediaPipe's detection confidence can be lower for darker skin in low light; Steady surfaces the tracking
  word and a lighting warning, and better light is the fix.
- Dysarthric and accented speech accuracy is not measured; English only.
- No pressure or tilt: tapering comes only from Krita's Speed sensor.
- macOS on Apple silicon only; one display; Krita only (5.3.x; a Krita 6 install is not supported).
- The camera can see papers on the desk (processing is local only).
- Whether Desk View appears in the tracker's camera list was unverified at the time of writing.

---

## Fallback: website version

The original build (a Chrome side panel next to Krita, with a practice canvas and a Demo page) stays in the
repo, untouched, as a fallback demo that needs only Chrome and a camera. It was verified with 795 automated
tests at the P4 freeze; its real-hardware checks are in NEEDS-HUMAN.md › "Fallback: website version".

```bash
npm install
npm run assets               # once: MediaPipe wasm + hand/face models into public/mediapipe/
npm run dev                  # Next.js on http://localhost:3000
npm run helper               # Python helper: pointer, F-keys, Krita relay (creates helper/.venv on first run)
npm run demo-chrome          # dedicated Chrome (own profile .steady-chrome) at http://localhost:3000?demo=1
npm run krita-plugin:install # the same Krita bridge plugin
```

- **Permissions:** grant **Accessibility** and **Input Monitoring** to the terminal app that launches the helper
  (Terminal, iTerm…), not to "python". Chrome needs Camera and Microphone.
- **Chrome strip:** keep Steady's Chrome window as a ~320 px strip beside Krita, never fully behind Krita; the
  fps counter in the header proves it is alive.
- **Port 3000:** the helper accepts WebSocket connections only from `http://localhost:3000`. If something else
  uses port 3000: `npx next dev -p 3100` and `npm run helper -- --origin http://localhost:3100`.
- **Website-only features:** the practice canvas; the **Demo page** (`?demo=1`: Simulate tremor, live trace,
  metrics, Next judge); **Colour cap** tracking for a gloved or braced hand; **Head mode** and **Eyebrow lift**;
  **Show numbers** badges over Krita's buttons; the **Photoshop** app profile; an opt-in **browser speech
  fallback** (Chrome's Web Speech, which sends audio to Google; off by default); the access-token route
  `/api/cartesia-token` and the Claude route `/api/command`.
- **Tests:** `npm test` (Vitest), `npm run pytest`, `npx playwright test`, and the phase gate
  `scripts/demo-check.sh P0|P1|P2a|P2b|P3|P4`.

**Metrics (Demo page).** Deviation (px) = RMS distance of the drawn path from its own ±100 ms moving average
over the last 3 s; last-stroke time; command success rate (commands that resolved to ≥ 1 executed action ÷
commands attempted, fillers excluded); Claude calls / accepted / timeouts; camera fps; detection fps; helper
round-trip. "Simulated tremor" adds band-limited 4–10 Hz noise to the raw landmark pixels **before** the
filter; anything recorded with it on is captioned so.
