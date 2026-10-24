# Steady

**Paint in Krita with a hand that rests on the desk. No stylus, no grip, no pinch.**

A webcam looks down at the desk and tracks a hand whose wrist and forearm rest on the table, a book or a
rolled towel. Steady smooths that hand's movement and drives the real Mac pointer, so the artist paints in
Krita with no stylus, no tablet, no mouse and no grip. Voice, a typed command box, big side-panel tiles and
any USB foot pedal replace the keyboard and the tablet's buttons.

Built in 36 hours at Cal Hacks 13.0. macOS 14+, desktop Chrome, Krita 5.3.x.

Steady is not a medical device. It does not diagnose, treat or measure any condition.

> **Verification status.** Everything below was built and tested with synthesised landmark replays, a fake
> helper and fake-mouse unit tests. Items that need a real webcam, a real Mac pointer or real Krita are
> listed in [`NEEDS-HUMAN.md`](NEEDS-HUMAN.md) and are **not** claimed as working until a human ticks them.

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
  So every action is also a tile, a typed command and (for the core ones) a pedal key.
- Cost: a clinical eye-gaze pointer costs about **$1,249** (Tobii PCEye 5); Steady needs the Mac, an iPhone or
  webcam, and optionally a **$60–90** foot pedal.

## How to run

Step-by-step for non-experts, with System Settings deep links: [`scripts/human-setup.md`](scripts/human-setup.md).

```bash
npm install
npm run assets               # once: download MediaPipe's wasm + hand/face models into public/mediapipe/
npm run dev                  # Next.js on http://localhost:3000
npm run helper               # Python helper: pointer, F-keys, Krita relay (creates a venv on first run)
npm run demo-chrome          # dedicated Chrome (own profile .steady-chrome) at http://localhost:3000?demo=1
npm run krita-plugin:install # copies the plugin into ~/Library/Application Support/krita/pykrita/
```

1. **Permissions:** grant **Accessibility** and **Input Monitoring** to the terminal app that launches the
   helper (Terminal, iTerm…), not to "python". Chrome needs Camera and Microphone.
2. **Turn off** macOS Voice Control, Dwell Control and Head Pointer while using Steady (they act on the same
   pointer and the same words). **Unplug drawing tablets** (Krita can latch into tablet mode).
3. **Krita 5.3.2.1** (5.3.x; not Krita 6). Enable the plugin: Settings › Configure Krita › Python Plugin
   Manager › Steady, then restart Krita. Then follow [`scripts/krita-setup.md`](scripts/krita-setup.md).
4. **Camera:** an iPhone as Continuity Camera, **wired over USB**, looking down at the desk. Choose "Desk View"
   if Chrome lists it.
5. **Chrome strip:** keep Steady's Chrome window as a ~320 px strip beside Krita (or on a second display),
   never fully behind Krita. The fps counter in the header proves it is alive.
6. **Pedal (recommended):** any USB/Bluetooth foot pedal or switch that sends **F8** is a one-switch pen
   (e.g. Elgato Stream Deck Pedal, PCsensor pedals). No grip needed. A Mac may need System Settings ›
   Keyboard › "Use F1, F2, etc. keys as standard function keys".
7. **Keys** (remappable): F8 pen · F9 pause/resume · F10 push-to-talk · F7 undo · F6 redo · F5 recenter ·
   F4 other hand · F3 Latch.
8. **If the pointer ever seems stuck, click the physical mouse once.**
9. **Port 3000.** The helper accepts WebSocket connections only from `http://localhost:3000` (any other
   website could otherwise move your mouse). If something else already uses port 3000, run Steady on another
   port and tell the helper: `npx next dev -p 3100` and `npm run helper -- --origin http://localhost:3100`
   (or `STEADY_ORIGIN=http://localhost:3100`). Only `localhost` / `127.0.0.1` origins are accepted.
10. **Optional: browser speech fallback.** Off by default. Setup › "Browser speech fallback" lets Chrome's
    own speech recognition stand in when Cartesia is unavailable; Chrome sends that audio to Google (see
    Privacy).

API keys (optional; without them voice and the Claude fallback run on mocks and the status bar says
"key missing"): put `CARTESIA_API_KEY` and `ANTHROPIC_API_KEY` in `.env.local` (see `.env.example`).

Tests: `npm test` (Vitest), `npm run pytest`, `npx playwright test` (synthesised landmark replays and a
fake helper; no camera, no Krita), and the phase gate `scripts/demo-check.sh P0|P1|P2a|P2b|P3|P4`, which
prints PASS/FAIL per definition-of-done item and NEEDS HUMAN for real-hardware checks
([`NEEDS-HUMAN.md`](NEEDS-HUMAN.md)).

## How it works

Three processes on one Mac:

```
iPhone camera ──► Chrome page (Next.js)
                    Worker: hand landmarks (MediaPipe, or the Colour cap tracker) → One Euro filter
                            → active box → dwell → stroke modes → lazy brush
                    │  ws://127.0.0.1:8765 (Origin http://localhost:3000 only)
                    ▼
                  Python helper: Quartz pointer events · 300 ms watchdog · global F-keys · Krita window rect
                                 · dwell ring overlay that follows the pointer over Krita
                    │  tcp 127.0.0.1:8766
                    ▼
                  Krita plugin: brush, colour, size, opacity, layers, actions, canvas rect
```

Tracking runs in a Web Worker, not on the page's render loop, so it keeps going when Krita covers Chrome
(the dedicated Chrome from `npm run demo-chrome` also disables background throttling). The MediaPipe model
and wasm are served from Steady's own `/public/mediapipe/` (fetched once by `npm run assets`), so tracking
needs no network (*TODO: not yet tested with Wi-Fi off on the real Mac*).

**Two ways to track the hand.**
- **Hand landmarks (default):** MediaPipe's hand model; the pointer follows the index knuckle by default
  (fingertip, middle knuckle, wrist, or any of the 21 points are settings on the Setup page).
- **Colour cap:** for a hand in a glove, splint, compression glove or thumb brace, where a hand detector
  fails: stick a small bright-coloured sticker (or cap) on a knuckle or the back of the glove, choose
  "Colour cap" on the Setup page, and Steady follows that colour blob instead. Everything downstream is the
  same. *TODO: not yet tested with a real glove (see NEEDS-HUMAN.md).*

**Pipeline (filter before gain).** The index-knuckle landmark (default; it moves only with the wrist and
forearm and is unaffected by curled fingers or long nails) is filtered in camera pixels by a One Euro filter
(min cutoff 0.6 Hz, beta 0.005), mapped from a calibrated "active box" to the target with a gain of 2–4×,
then passed through a 12-unit lazy-brush dead zone. One **Steadiness** slider (0–100) moves both the cutoff
and the dead-zone radius. Calibration takes ≤ 15 s: hold still, draw a circle, move right then away.
Steady switches Krita's own brush smoothing to None once per session, because two filters in a row add lag.

**The pen-state law.** *Anything lifts; only dwell, the pen key, a pedal, or voice "down" lowers; nothing
auto-lowers, Latch included. Hatch mode is the single named exception.* Holding still for 800 ms lowers the
pen; holding still more tightly for 1.2 s lifts it; a slow deliberate stroke never lifts it; a resting hand
toggles at most once and never leaves ink.

**Stroke modes (opt-in).** Holding still to lower and lift is right for a resting hand but slow for
hatching. **Hatch** keeps the pen down and inks only forward passes; return passes are skipped. Because ink
in Krita cannot be taken back, the pointer stream runs ~120 ms behind in Hatch mode so Steady knows a pass
has ended before Krita hears about it; the status line reads "Hatch: forward passes only". **Dots** stamps
one click per dwell (stippling). **Dash** inks only while the hand moves; **Repeat** stamps a copy of the
last stroke at the cursor. Every lift source still lifts in every mode, and a still hand never adds ink.
Pair Hatch with Krita's parallel ruler assistant for straight parallel lines.

**Smoothing presets.** **Sketch** (Steadiness 25), **Ink mode** (70) and **Shade** (10, small dead zone:
artists shading with fast back-and-forth strokes find heavy smoothing confusing). Everything is still a
slider, because ability changes hour to hour.

**Hand presets and profiles.** Four preset tiles describe what a hand does, never a diagnosis:
*Sore joints, steady hand* (Steadiness 25, gain 3×); *Shakes when holding still or reaching* (70);
*Slow movements, shakes at rest* (45, gain 4×, dwell 1200 ms, Latch on); *Hard to hold still* (60, Latch on,
a wider dwell radius, and a one-time tip: the fastest way to lift the pen is a pedal, the pen key or saying
"up"). Profiles store the user's own values under their own names ("Steady day" and "Shaky day" are
pre-created); "save profile evening" / "profile evening" work by voice, typed command or tile. Re-baseline: every 10 min
Steady re-measures hand size and rescales the active box, because swelling changes through the day.

**More ways in (P4).** *Head mode* moves the pointer with the nose tip (gain 6×) through the same pipeline,
for days when the hand can't rest at all. *Eyebrow lift* (opt-in) lifts the pen. *Show numbers* puts numbered
badges over Krita's own buttons (the plugin lists the visible widgets; the helper draws the badges), so
"click 5" presses a toolbar button too small to dwell on. An *app profile* switch ("photoshop mode") sends
Photoshop's shortcuts instead of Krita plugin commands, to show the same layer works in any drawing app.
*TODO: none of the P4 features has been tried with a real face, real Krita widgets or real Photoshop; see
NEEDS-HUMAN.md.*

**The dwell ring.** A small ring follows the pointer and fills while you hold still; it is filled while
drawing, hollow while hovering, grey where a dwell would do nothing, and a "?" when tracking is lost
(shape, not only colour). Over Krita it is a tiny click-through window drawn by the helper, never a
full-screen overlay (that would make macOS treat Chrome as hidden and stall tracking). If the overlay fails
it switches itself off and the earcons and side panel carry the feedback. F9 hides it.
*TODO: the overlay has not been verified on a real Mac; see NEEDS-HUMAN.md (brush outline must still show
through the ring).*

**Fail-safes.**
- The mouse button is never left held: the helper releases it if no message arrives for 300 ms, on tracking
  loss, on Pause, on push-to-talk, when the pointer leaves the canvas, on socket close, on exit, and inside a
  top-level exception handler.
- Tracking loss is one rule: a frame whose hand score is < 0.6 counts as no detection; after 300 ms without a
  good frame the button is released and the cursor becomes a hollow "?" ring with a reason. On re-acquire the
  pen stays up.
- **Pause** (F9, the Pause tile, voice "pause"/"stop") releases the button and clamps the pointer to Chrome's
  own window, so ink in Krita is impossible; the tile becomes **Resume** and stays reachable by dwell alone.
- No pinch, no grip, no finger held extended, no time limits, no drag required for any UI. Every action is a
  tile, a typed command and (except the mic and pen toggle) a voice phrase; the core ones also have a key.

## Cartesia features used

- **Ink 2 streaming speech-to-text** (`ink-2`, PCM 16 kHz) opened only while the mic is open (hold F10 /
  a pedal, or tap the Mic tile).
- **Keyterm biasing:** every voice phrase in the action table (≤ 100 terms, ≤ 1200 characters) so short
  commands like "blue", "bigger", "undo that" survive a loud hall.
- **Manual finalize** for push-to-talk: on release the client sends `finalize` and reads transcripts until
  `flush_done`.
- **Access-token flow:** `/api/cartesia-token` mints a short-lived token server-side; the API key never
  reaches the browser. Re-minted at 45 min, never mid-utterance.
- **Sonic 3.6 TTS** (`sonic-3.6`, raw PCM 24 kHz, streamed) for the few confirmations that can't be seen
  at a glance ("Saved", "New layer", "Didn't catch that; I heard …"), at most a few words, never on pen
  toggles, never while the mic is open (playback is cancelled on push-to-talk), off in quiet mode.
  *TODO: confirm it is live with a real key before submitting; delete this bullet if TTS did not land.*

**Opt-in fallback when Cartesia is unavailable:** Chrome's built-in Web Speech recognition, off by default
(Setup › "Browser speech fallback"). *Chrome sends that audio to Google's servers*, so it is used only when
the user turns it on, only while the mic is open, and the status reads "Using the browser's speech
recognition. Chrome sends this audio to Google while the mic is open." Tiles, typed commands and the pedal
never need either. *TODO: not yet tested with a real microphone.*

### Limitations (voice)
- Accuracy on dysarthric or accented speech has **not been measured**.
- Hall noise: keyterms help, but nothing is voice-only; tiles, typed commands and the pedal do everything.
- Token expiry: tokens last an hour and are re-minted at 45 min; a session left idle past expiry reconnects
  on the next push-to-talk.

## Where Claude is used and where it goes wrong

**Used for exactly one thing:** when the local grammar can't match a voice or typed command, its **text**
(never audio) and the context listed under Privacy go to `/api/command`, which asks `claude-haiku-5-5` for
structured output: up to two actions, a clarify prompt with 2–3 options, or "noop" for coughs and fillers.
Example: "make it thinner and a bit softer" → `smaller` + `airbrush`.

**Guards.** The status line always shows **"Heard: …"** and what Steady did; every Claude result is one
**Undo** away; ambiguous requests become numbered **clarify tiles** (accept/reject, never automatic, per the
ASSETS 2024 recommendation); a 2.5 s timeout or invalid output shows "Didn't catch that" with the two closest
grammar matches as tiles. Calls are logged locally (latency, accepted / rejected / timeout).

**Never used for:** the pointer path, audio, pen state, or anything without a visible "Heard:" and Undo.

**Logged counts:** *TODO — fill from the Demo panel's Claude metrics after a real session (calls / accepted /
timeouts). No numbers until a real run exists.*

**Failure example 1:** *TODO — a real transcript where Claude picked the wrong action, the screenshot
(`docs/img/claude-failure-1.png`), and how Heard:/Undo recovered it. Do not invent this.*

**Failure example 2:** *TODO — a real timeout or clarify case with screenshot
(`docs/img/claude-failure-2.png`). Do not invent this.*

## Metrics

Shown on the Demo page (`?demo=1`; `aria-live="off"`), reset by **Next judge**.

| Metric | Formula |
|---|---|
| Deviation (px) | Shake that survives smoothing: the RMS distance of the drawn (post-lazy-brush) path from its own ±100 ms moving average over the last 3 s, in target units: √( (1/N) Σᵢ ‖pᵢ − p̄ᵢ‖² ), where p̄ᵢ is the mean of the points within ±100 ms of pᵢ. It drops as Steadiness rises. |
| Last-stroke time (ms) | t(pen up) − t(pen down) of the most recent stroke |
| Command success rate | commands that resolved to ≥ 1 executed action (grammar or Claude) ÷ commands attempted (voice transcripts + typed submissions); fillers resolved to `noop` are excluded from both |
| Claude calls / accepted / timeouts | calls = POSTs to `/api/command` excluding the pre-warm; accepted = results whose actions were executed (including a chosen clarify option); timeouts = calls with no answer within 2.5 s |
| Camera fps | camera frames received in the last 1 s |
| Detection fps | hand-landmark results produced in the last 1 s |
| Helper round-trip (ms) | time from a `ping` to the `pong` echoing its id (latest) |

"Simulated tremor" (Demo page) adds band-limited 4–10 Hz noise to the raw landmark pixels **before** the
filter (±4 px at rest, up to ±8 px when moving fast); anything recorded with it on is captioned so.

## Privacy

Camera frames never leave this computer; the camera sees the desk, so papers on it are visible to the app, and processing is local only. Microphone audio goes to Cartesia only while the mic is open. When the local grammar can't match a command, its text (never audio) plus the current tool, preset, size, opacity, colour, Steadiness and your last three actions go to our server and on to Anthropic. The helper and the Krita plugin listen on `127.0.0.1` only and send nothing off the machine.

*Opt-in speech fallback:* only if you turn on Setup › "Browser speech fallback" and Cartesia is
unavailable, Chrome's own speech recognition is used instead, and **Chrome sends that microphone audio to
Google** while the mic is open. The status line says so whenever it is active. It is off by default.

## Pressure

Krita treats every mouse event as **pressure 1.0**, so pressure-mapped brushes paint at full size and there
is no taper. The answer is in Krita, not in Steady: in the brush editor set the **Size** (and optionally
Opacity) sensor to **Speed** instead of Pressure (faster is thinner, and it works with mouse events), add the
**Fade** sensor for a start taper, or pick a preset whose size is not pressure-driven. Size and opacity are
also a voice command away ("size 20", "fade"). Steady does not inject tablet pressure.

## Prior art

Hej Stylus and Lazy Nezumi smooth a **held** stylus. Camera Mouse, eViacam and macOS Head Pointer move a
pointer with the head and click by dwell. Project Gameface clicks by facial gesture. Pawvis tracks a hand in
the air and clicks by a finger dip or dwell. mctrl clicks by pinch. None combine a **resting, no-grip hand**,
**tremor-aware smoothing** and **voice inside Krita**, and none state a pen-state law that makes a resting
hand unable to leave ink.

## From hackathon to Monday

- An OT / hand-clinic pilot with 5 artists.
- A signed macOS menu-bar app so Accessibility / Input Monitoring permissions persist.
- A Windows helper.
- On-device speech recognition as an option for shared studios and flaky networks.
- A full WCAG audit with disabled users, beyond the automated axe gate.

## Known limitations

- Camera angles from a wheelchair or a bed are untested; glasses glare will matter for the planned Head mode.
- MediaPipe's detection confidence can be lower for darker skin in low light; Steady surfaces the tracking
  confidence and a lighting warning, and better light is the fix.
- Dysarthric and accented speech accuracy is not measured; English only.
- No pressure or tilt: tapering comes only from Krita's Speed sensor.
- macOS only; one display; Krita via the plugin, other apps only via keyboard shortcuts.
- The camera can see papers on the desk (processing is local only).
- Whether Chrome lists iPhone "Desk View" was unverified at the time of writing.
- A Krita 6 install is not supported (the plugin warns; 5.3 is the tested line).
