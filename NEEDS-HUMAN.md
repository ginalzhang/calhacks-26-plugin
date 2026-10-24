# NEEDS HUMAN

One prioritised list, most important first. **Nothing here has been verified on real hardware by any build
agent**: every automated test uses replayed landmarks, a fake helper, a fake mouse or a fake Krita.
`scripts/demo-check.sh` prints these items as NEEDS HUMAN. Click-by-click setup for non-experts:
[`scripts/human-setup.md`](scripts/human-setup.md). Tick each box and add one line of what you saw; paste
errors into DECISIONS.md. Tags in brackets say which agent wrote the item (A–G, F = docs/tests).

> If no human has ticked item 1 by the end of P1, the build treats Desk View as absent and continues.

## Top priority (hour 0)

0. [ ] **Port 3000 is taken on this Mac** [lead]: at 16:20 on Sat, another workspace's dev server
   (`calhacks-26/marseille`, `next-server`) was listening on :3000, so `npm run dev` here would not get it, and
   `npm run demo-chrome` / the helper's default Origin would point at the wrong app. Either stop that server
   first, or run Steady on another port end to end:
   `npm run dev -- -p 3100`, `npm run helper -- --origin http://localhost:3100`,
   `STEADY_URL='http://localhost:3100?demo=1' npm run demo-chrome`.

1. [ ] **Desk View in Chrome's camera list** [F, B]: `npm run demo-chrome`, allow the camera, Setup page ›
   Camera. Is "Desk View" listed (it is chosen by default when present)? If not, plug the iPhone in **over
   USB** and pick it as a plain Continuity Camera aimed down at the desk. Write which one you used.
   "Mirror camera" / "Rotate camera" must make the pointer move the same way as the hand; settings are
   remembered per camera.
2. [ ] **Krita paints from the helper on the real Mac** [lead, F, C]: grant the permissions in item 4, run
   `npm run helper`, Krita open beside the Chrome strip, rest your hand, dwell on Krita's canvas to lower the
   pen, move: does a stroke land in Krita? Dwell to lift.
3. [ ] **API keys → `.env.local`** [lead, E]: create `.env.local` with `CARTESIA_API_KEY=...` and
   `ANTHROPIC_API_KEY=...` (optionally `CARTESIA_VOICE_ID`), restart `npm run dev`. Until then voice and the
   Claude fallback run on mocks and the status bar says "key missing". Check:
   `curl -s -XPOST localhost:3000/api/cartesia-token` shows `"mock":false` and a non-null `voiceId`;
   `curl -s -XPOST localhost:3000/api/command -H 'content-type: application/json' -d '{"text":"make it thinner and a bit softer","context":{"tool":"brush","preset":null,"size":40,"opacity":100,"color":"#000000","steadiness":50,"lastActions":[]}}'`
   returns `"first":"smaller","second":"airbrush","mock":false` well under 2.5 s (the second call should be
   faster: cache).
4. [ ] **Permissions for the terminal app that launches the helper** [F, C] (Terminal, iTerm, VS Code…, *not*
   python):
   - Accessibility: `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`, turn on
     your terminal app.
   - Input Monitoring: `x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent` (it
     appears after the helper's first start, which calls `CGRequestListenEventAccess`).
   - Quit and reopen the terminal app. `npm run helper` prints "Steady helper 0.1.0. Launched from: <app>"
     and no "!!" lines; if it names a different app, grant that one; "POINTER-LESS mode" means a permission
     is still missing.
5. [ ] **Conflicts off** [F, C]: System Settings › Accessibility › Voice Control OFF; Pointer Control: Dwell,
   Head pointer, Alternate pointer actions OFF; **unplug any drawing tablet**. If the F-keys change
   brightness/volume, turn on Keyboard › "Use F1, F2, etc. keys as standard function keys" (or use a
   pedal/keypad sending F8).
6. [ ] **Krita + plugin enabled** [F, D]: Krita 5.3.x (5.3.4 is on this Mac); `npm run krita-plugin:install`;
   Krita › Preferences… (Settings › Configure Krita…) › Python Plugin Manager › tick **Steady** › OK ›
   restart Krita; follow `scripts/krita-setup.md`. **Tools › Scripts › Steady: connection status** says
   "listening on 127.0.0.1:8766" and "Krita 5.3.x, PyQt5". If Steady is greyed out, hover it for the error
   and paste it into DECISIONS.md.
7. [ ] **Chrome beside Krita keeps running** [F, B, C]: `npm run demo-chrome` as a 320 px strip beside Krita,
   click into Krita, watch the header fps for 30 s (and later for a full 5-minute painting session): it keeps
   updating. If the status says "keep this window visible", MediaStreamTrackProcessor was missing.

## Real-hardware checklist

### Hand tracking and the practice canvas (P0)
8. [ ] **P0 definition of done** [F, B]: within 60 s of `npm run dev` the header shows **Tracking** and fps
   ≥ 20; a hollow cursor moves on the practice canvas; hold still 0.8 s → filled cursor, write a short legible
   word, hold still → pen lifts; press F7 (focus on the canvas; Esc first) → the stroke disappears;
   Steadiness up/down visibly changes a new line.
9. [ ] **Resting hand tracked with the knuckle** [F, A]: forearm on a towel, fingers curled loosely, landmark
   = index knuckle. "Tracking" for 30 s with no drift beyond a few px; hold still 10 s on the canvas: the pen
   lowers once and leaves no extra ink.
10. [ ] **Calibration on a real hand** [B, A]: Setup › Recalibrate: rest 3 s, circle 4 s, right-then-away 3 s;
    the status says if an axis was flipped; the suggested Steadiness and gain feel right (a slow, arm-sized
    movement crosses the canvas); "Use last setup" after reload draws within 3 s.
11. [ ] **Low-light warning** [B] appears when the desk is dark (main-thread luma < 50).

### Helper and pointer (P1)
12. [ ] **Real-pointer smoke test** [C] (Krita open, Chrome strip at http://localhost:3000, helper running):
    reload Steady → helper status connected, fps keeps running; lower the pen then press Ctrl-C in the
    helper's terminal mid-stroke → the stroke ends (button released); restart the helper.
13. [ ] **Covering the camera mid-stroke ends the stroke** [F, C] in Krita within ~0.3 s: no scribble,
    status says tracking lost, the pen stays up when the hand comes back.
14. [ ] **F9 pauses; Resume works by dwell** [F, C, B]: with Krita frontmost press F9 (or the pedal): pen
    lifts, Krita opens nothing, the tile reads "Resume", the pointer cannot leave Chrome's window; holding
    still on Resume resumes. Check this at 100 % page zoom (clamp and dwell-click assume 100 %): the dwell
    clicks the tile, not beside it. Press F8 in Finder/Safari: Steady does nothing and the other app gets
    the key.
15. [ ] **`kill -9` the helper while the pen is down** [C]: if the pointer seems stuck, one click on the
    physical mouse frees it (README).

### Krita plugin and keys (P2a)
16. [ ] **"blue" changes the colour** [F, D]: with a picture open, type `blue` in Steady's typed box (or
    `echo '{"id":"t1","cmd":"color","hex":"#1d4ed8"}' | nc -w 2 127.0.0.1 8766` → `{"id":"t1","ok":true,"color":"#1d4ed8"}`).
17. [ ] **F5/F6 no longer open Krita pop-ups** [F, D, C] after the helper connects (also F3 layer properties,
    F4 incremental backup); the `session_init` reply lists them in `cleared`.
18. [ ] **Brush smoothing switched to None once** [D]: after connecting with a picture open, Freehand Brush ›
    Tool Options shows Brush Smoothing **None**; set it back to Weighted, reconnect the helper: it stays
    Weighted.
19. [ ] **canvas_rect** [D]: `echo '{"id":"c1","cmd":"canvas_rect"}' | nc -w 2 127.0.0.1 8766` → `widget_class`
    `KisOpenGLCanvas2` and a `rect` matching the visible canvas in screen points. Record the class name in
    DECISIONS.md. **window_rect** matches Krita's frame; **list_actions** contains `merge_layer` "Merge with
    Layer Below".
20. [ ] **Presets by family** [D]: "brush", "pencil", "ink", "airbrush" each select a preset of that family;
    with eraser mode on (press E), "ink" turns eraser mode off.
21. [ ] **New layer + undo** [D]: "new layer" adds a layer above and selects it. Does Cmd+Z remove it? Note
    the answer in DECISIONS.md.
22. [ ] **Keystroke fallback** [C]: with the plugin disabled, "undo" → Krita undoes via `cmd+z` after being
    brought to the front; quit Krita → Steady says Krita is not running and no keys go elsewhere. Krita's
    "Clear" fires on Backspace and "Delete layer" on shift+forward-delete (keycodes not verified in Krita).
23. [ ] **Dwell-click hits an enlarged toolbox button** [F] (icons enlarged per `scripts/krita-setup.md`),
    and nothing clicks in the menu bar, the Dock or title bars.

### Voice (P2a / P2b)
24. [ ] **Cartesia smoke** [E]: `CARTESIA_API_KEY=… node scripts/cartesia-smoke.mjs` prints `flush_done`;
    with a 16 kHz mono s16le recording (`ffmpeg -i say-bigger.m4a -ar 16000 -ac 1 -f s16le say.raw`) it
    prints a transcript like " bigger". If the socket is rejected, paste the error into DECISIONS.md.
25. [ ] **Mic in Chrome** [E]: tap Mic, allow the microphone, say "blue": meter moves, "Heard: blue", Krita's
    colour changes. Hold F10 and say "undo that undo that": two undos. Tap Mic and stay silent 10 s: the mic
    stays open until you tap again.
26. [ ] **Quiet speech / headset** [E]: soft speech still transcribes; a Bluetooth headset connected
    mid-session still works on the next utterance.
27. [ ] **Mic revoked** [E]: revoke the mic in Chrome's site settings while open: a banner appears; tiles and
    the typed box still work.
28. [ ] **Sonic TTS** [E, F]: `sonic-3.6` is accepted by the TTS socket; "save" is answered "Saved"; nothing
    is spoken on pen toggles or while the mic is open.
29. [ ] **Aliases by voice** [F]: "call this brush fluffy", then "fluffy" selects that preset in Krita.
30. [ ] **Web Speech fallback (opt-in)** [E, F]: Setup › "Browser speech fallback" on, Cartesia key removed:
    tap Mic, say "blue": status reads "Using the browser's speech recognition. Chrome sends this audio to
    Google…" and "Heard: blue". Hold F10 for 20 s with pauses: recognition keeps going until release.
    Decide whether this fallback may ship given the privacy text (DECISIONS.md › Agent E).

### Stroke modes, overlay, other tracking (P2b / P3)
31. [ ] **Hatch in Krita** [F]: with Krita's parallel ruler assistant, "hatch" and scribble back and forth:
    only forward passes leave ink.
32. [ ] **Ring overlay** [C, F] (`npm run helper`; `-- --no-overlay` turns it off): a 160×160 pt ring follows
    the pointer (hollow with a filling arc while dwelling, filled while drawing, dashed grey outside the
    canvas, "?" when lost); no Dock icon; Krita keeps focus. **Hover Krita's brush outline through the
    ring** (macOS 26.3/26.4 transparent-window regression): the outline still shows and strokes still land;
    otherwise run with `--no-overlay` and note it. F9 hides the ring at once; it appears in Krita full screen
    and on every Space; the Chrome fps keeps running with the ring over Chrome; Ctrl-C quits cleanly.
33. [ ] **Pan / Pick in real Krita** [C, G]: "pan" then lower the pen on the canvas → middle-button drag pans,
    lifting ends it; "pick" then a dwell samples a colour and Krita returns to the brush.
34. [ ] **Remapped keys** [C]: remap Pen to a pedal key (e.g. PageUp): Krita no longer receives that key while
    Krita or Chrome is in front, and F8 passes through again.
35. [ ] **Colour cap on a glove or brace** [F, G]: neon-green sticker on the index knuckle of a gloved hand,
    Setup › Colour cap, Pick sticker colour (sticker in the middle of the view): "Tracking" (score ≥ 0.75)
    under desk light, the pointer follows, a stroke lands on the practice canvas and in Krita; dim the light:
    it drops to Weak/Lost rather than jumping. Try a red or orange sticker too.
36. [ ] **Exposure lock** [G]: Setup › Lock exposure after calibration on the FaceTime camera, Continuity
    Camera and Desk View; record which say "Exposure locked" vs "This camera can't lock exposure".
37. [ ] **Offline tracking** [F, G]: with Wi-Fi off, reload Steady: MediaPipe still starts (wasm + model
    from `/mediapipe/`). On a fresh clone run `npm run assets` (`scripts/fetch-mediapipe.sh`) first if
    `public/mediapipe` isn't committed.

### P4
38. [ ] **Head mode with a real face** [F]: Setup › Head mode: the pointer follows the nose tip at gain 6× and
    feels usable at arm's length from the camera.
39. [ ] **Eyebrow lift** [F]: with Eyebrow lift on, raising the eyebrows lifts the pen; talking, blinking and
    looking down at the desk do not.
40. [ ] **Numbers over Krita** [F]: View › Show numbers: the numbered badges line up over Krita's real
    widgets; "click 5" clicks the widget under badge 5; "hide numbers" clears them.
    [C] Needs the overlay (`npm run helper`, not `--no-overlay`). Yellow digits on black plates at each
    widget's top-left, readable from a normal seat, never covering a neighbouring button; Pause/F9 removes
    them. Default-size icons get smaller digits: enlarge toolbox icons per `scripts/krita-setup.md`. Hover
    Krita's brush outline under a badge (same transparent-window check as the ring).
41. [ ] **Photoshop app profile** [F]: Setup › App → Photoshop, Photoshop frontmost: "undo", "brush",
    "bigger", "smaller", "eraser" send the right Photoshop shortcuts.
    [C] Start the helper with `npm run helper -- --app photoshop` (Setup and helper must match). Also check the
    **unverified** shortcuts: new layer = cmd+alt+shift+n adds a layer with no dialog; line = u; solid = 0
    (100 % opacity); and zoom in/out (cmd+= / cmd+-), fit (cmd+0), 100 % (cmd+1), merge down (cmd+e),
    eyedropper (i). F-keys are consumed while Photoshop is in front and Krita is left alone.

## For the submission
42. [ ] **Record the fallback video first at 22:00** [F] (`docs/demo-video.md` › Fallback video: Chrome +
    camera only), then the full script (≤ 2:00, "Simulated tremor" caption on every tremor shot).
43. [ ] **User interview** [F]: one real artist answers `docs/user-interview.md`; replace the
    `<QUOTE PENDING …>` line with their exact words (with consent) or delete the slot. Never paraphrase into
    a quote.
44. [ ] **Claude failure examples** [F]: after a real session with keys, capture two real failures (wrong
    action; timeout or clarify) as screenshots in `docs/img/`, fill the TODOs in README › "Where Claude is
    used and where it goes wrong", plus the logged counts from the Demo page.
45. [ ] **Pitch rehearsal** [F] per `docs/pitch.md` under the judging table's light (the lighting warning
    stays off).
46. [ ] **README TODO markers** [F]: after the checks above, delete or confirm every *TODO* in README.md
    (Sonic, Web Speech, offline assets, Colour cap, ring overlay, head mode, numbers, Claude examples).

## Agent D
9. **(P4) Numbered widgets line up:** after enlarging the toolbox icons (scripts/krita-setup.md §6), run `echo '{"id":"w1","cmd":"list_widgets"}' | nc -w 2 127.0.0.1 8766`. Check that number 1… follow reading order, that each toolbox button's `rect` sits exactly on that button on screen (hover its top-left corner and compare with the pointer's screen position), that labels are readable tool names (not object names like `KritaShape/...`), that hidden/collapsed dockers contribute nothing, and whether palette swatches (`KisPaletteView`) and preset-docker cells (`KisResourceItemListView`) appear. Note any class names that don't show up in DECISIONS.md.
9. **(round 3) Head mode on a real face:** Input › Head mode: the pointer follows the nose tip (gain 6×). Eyebrow lift: raising the eyebrows while drawing lifts the pen and never lowers it.
10. **(round 3) Numbers over Krita:** View › Show numbers draws badges over Krita's buttons (helper overlay); "click 3" clicks the third; moving Krita's window hides them.
11. **(round 3) Page fit at 320×900** was computed, not measured, this round (B ran no Playwright): F's page-fit spec should cover the new Modes / Input / Krita pages.

## Agent H
1. **Unsealed real helper vs real Krita (cannot be automated safely):** `scripts/integration-check.sh` proves page ↔ real helper ↔ real bridge with every input path sealed. Before the demo, run `npm run helper` (Accessibility granted) with Krita open. Check that a plugin-down fallback (quit Krita's plugin, say "undo") posts cmd+z **into Krita only**. Note that with `--no-pointer` the helper still posts keys and activates Krita (DECISIONS.md, Agent H, gap 1). Do not rely on `--no-pointer` as a "safe" mode.
2. **macOS permission prompts:** the first real `npm run helper` from a new terminal app can open the Accessibility and Input Monitoring dialogs. This happens even with `--no-pointer --no-hotkeys`. Grant them before demoing.
