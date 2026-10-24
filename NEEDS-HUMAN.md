# NEEDS HUMAN

Most important first. Nothing here has been verified on real hardware by the build agent.

1. **Desk View camera:** open `http://localhost:3000` in Chrome, allow the camera, open the camera dropdown on the Setup page. Is "Desk View" listed? If not, use the iPhone as a plain Continuity Camera aimed at the desk, **wired over USB**.
2. **Krita paints from the helper on the real Mac:** grant Accessibility + Input Monitoring to Terminal, run `npm run helper`, Krita open beside the Chrome strip, rest your hand: does a stroke land in Krita?
3. **API keys missing:** create `.env.local` with `CARTESIA_API_KEY=...` and `ANTHROPIC_API_KEY=...`, then restart `npm run dev`. Until then voice and the Claude fallback run on mocks and the status bar says "key missing".

## Agent D
Krita plugin checks (real Krita 5.3.x; none of these were run by the build agent, which never launched Krita):
1. **Plugin loads:** `npm run krita-plugin:install`, Krita › Preferences… › Python Plugin Manager › tick **Steady** › OK › restart Krita. Then **Tools › Scripts › Steady: connection status** says "listening on 127.0.0.1:8766" and "Krita 5.3.x, PyQt5". (If Steady is greyed out in the manager, hover it for the error and paste it into DECISIONS.md.)
2. **"blue" changes the colour:** with a picture open and `npm run helper` running, type `blue` in Steady's typed box (or `echo '{"id":"t1","cmd":"color","hex":"#1d4ed8"}' | nc -w 2 127.0.0.1 8766`). The foreground colour swatch turns blue and the reply is `{"id":"t1","ok":true,"color":"#1d4ed8"}`.
3. **F5/F6 no longer open Krita pop-ups** after the helper connects (also F3 layer properties, F4 incremental backup). The `session_init` reply lists them in `cleared`.
4. **Brush smoothing switched to None once:** after connecting with a picture open, the Freehand Brush tool's Tool Options show Brush Smoothing **None**; set it back to Weighted, disconnect/reconnect the helper: it must stay Weighted.
5. **canvas_rect class name:** `echo '{"id":"c1","cmd":"canvas_rect"}' | nc -w 2 127.0.0.1 8766` → `widget_class` should be `KisOpenGLCanvas2` and `rect` should match the visible canvas in screen points (move the pointer to the canvas's top-left corner: macOS coordinates should be ≈ `x,y`). Record the class name in DECISIONS.md.
6. **Presets by family:** "brush", "pencil", "ink", "airbrush" each select a preset of that family; with eraser mode on (press E), saying "ink" turns eraser mode off.
7. **New layer + undo:** "new layer" adds a layer above the current one and selects it. Does Cmd+Z remove it? (libkis node insertion may not be undoable; note the answer in DECISIONS.md.)
8. **window_rect** matches Krita's window frame; **list_actions** contains `merge_layer` with text "Merge with Layer Below".

## Agent F

Hour-0 setup, click by click: `scripts/human-setup.md`. Tick each box and add one line of what you saw.
None of these has been verified by a build agent; `scripts/demo-check.sh` prints them as NEEDS HUMAN.

### Hour 0 (do first; if nobody ticks these by the end of P1 the build treats Desk View as absent)
- [ ] **Desk View:** `npm run demo-chrome`, allow the camera, Setup page › camera dropdown. Is "Desk View" listed? If not, plug the iPhone in **over USB** and pick it as a plain Continuity Camera aimed at the desk. Write which one you used.
- [ ] **Permissions:** Accessibility (`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`) and Input Monitoring (`...?Privacy_ListenEvent`) are ON for **Terminal** (the app that runs `npm run helper`); Terminal restarted; `npm run helper` no longer reports a missing permission.
- [ ] **Conflicts off:** System Settings › Accessibility › Voice Control OFF; Pointer Control: Dwell, Head pointer, Alternate pointer actions OFF; any drawing tablet unplugged.
- [ ] **Krita + plugin:** Krita 5.3.x installed (5.3.4 is on this Mac); `npm run krita-plugin:install`; Settings › Configure Krita › Python Plugin Manager › Steady ticked; Krita restarted; `scripts/krita-setup.md` followed.
- [ ] **Chrome beside Krita:** Steady's Chrome as a 320 px strip beside Krita, click into Krita, watch the header fps for 30 s: it keeps updating (write the range you saw).

### Real-hardware checks (§10), after P1 / P2a land
- [ ] **Resting hand tracked with the knuckle:** forearm on a towel, fingers curled loosely, landmark = index knuckle (default). Tracking word reads "Tracking" for 30 s with no pointer drift beyond a few px.
- [ ] **P0 on the practice canvas within 60 s of `npm run dev`:** cursor appears, hold still → pen down, write a short legible word, hold still → pen up, press F7 → the word disappears, Steadiness − / + tiles visibly change a new stroke.
- [ ] **Krita paints from the helper:** with the helper running and Krita focused, the same resting hand paints a stroke in Krita.
- [ ] **Covering the camera mid-stroke ends the stroke** in Krita cleanly: no scribble, status says tracking lost, and the pen stays up when the hand comes back.
- [ ] **F9 pauses and the Resume tile works by dwell:** F9 (or the pedal) → tile reads "Resume", the pointer cannot leave Chrome's window, holding still on Resume resumes.
- [ ] **Dwell-click hits an enlarged toolbox button** in Krita (toolbox icons enlarged per `scripts/krita-setup.md`), and nothing clicks in the menu bar, the Dock or title bars. (P2a)
- [ ] **Plugin loads in Krita 5.3.x:** typed or spoken "blue" changes Krita's foreground colour; **F5 and F6 no longer open Krita's brush editor / presets popups.** (P2a)
- [ ] **Ring overlay** (P3) is visible over Krita, and Krita's brush outline still shows when hovering through the ring (macOS 26.3/26.4 transparent-window click regression check).
- [ ] **Chrome strip keeps running** while Krita is focused for a full 5-minute painting session (fps counter never freezes).

### For the submission
- [ ] **User interview:** one real artist answers `docs/user-interview.md`; replace the `<QUOTE PENDING …>` line with their exact words (with consent) or delete the slot. Never paraphrase into a quote.
- [ ] **Claude failure examples:** after a real session with keys, capture two real failures (wrong action; timeout or clarify) as screenshots in `docs/img/` and fill the TODOs in README › "Where Claude is used and where it goes wrong", plus the logged counts from the Demo page.
- [ ] **Demo video** recorded per `docs/demo-video.md` (≤ 2:00, "Simulated tremor" captions on every tremor shot).
- [ ] **Pitch rehearsal** per `docs/pitch.md` under the judging table's light (check the lighting warning stays off).

## Agent E
Voice and Claude run on mocks until keys exist; none of the items below was verified by the build agent.
1. **Keys:** put `CARTESIA_API_KEY` and `ANTHROPIC_API_KEY` (optionally `CARTESIA_VOICE_ID`) in `.env.local`, restart `npm run dev`. `curl -s -XPOST localhost:3000/api/cartesia-token` should now show `"mock":false` and a non-null `voiceId`; `curl -s -XPOST localhost:3000/api/command -H 'content-type: application/json' -d '{"text":"make it thinner and a bit softer","context":{"tool":"brush","preset":null,"size":40,"opacity":100,"color":"#000000","steadiness":50,"lastActions":[]}}'` should return `"first":"smaller","second":"airbrush","mock":false` in well under 2.5 s (run it twice: the second call should be faster from the cache).
2. **Cartesia smoke (2 min):** `CARTESIA_API_KEY=… node scripts/cartesia-smoke.mjs` prints `flush_done` and an empty transcript; with a 16 kHz mono s16le recording (`ffmpeg -i say-bigger.m4a -ar 16000 -ac 1 -f s16le say.raw`) it should print `TRANSCRIPT: " bigger"`-ish. If the socket is rejected, paste the error into DECISIONS.md (the browser uses this exact URL).
3. **Mic in Chrome:** tap Mic, allow the microphone, say "blue": the meter moves, status shows "Heard: blue", Krita colour changes. Hold F10 and say "undo that undo that": two undos. Tap Mic and stay silent for 10 s: the mic must stay open (no onset timeout) until you tap again.
4. **Quiet speech / headset:** speak softly: does Ink 2 still transcribe (gain normalisation)? Connect a Bluetooth headset mid-session: the next utterance should still transcribe (sample rate re-read).
5. **Mic revoked:** while the mic is open, revoke the mic in Chrome's site settings: a yellow banner appears and tiles/typed box still work.
6. **Sonic (P2b):** check that `sonic-3.6` is accepted by the TTS socket (the SDK's model list only names up to sonic-3.5).
7. **Web Speech fallback (no Cartesia key):** in Chrome, tap Mic and say "blue": the status should read "Using the browser's speech recognition. Chrome sends this audio to Google…" and "Heard: blue". Hold F10 for 20 s with pauses: recognition must keep going until release. Decide whether this fallback may ship given the privacy text (DECISIONS.md › Agent E).

## Agent C
Nothing here has been run against the real pointer; the helper's tests use a fake mouse, fake key poster and fake app/window provider.

1. **Grant permissions to the terminal app you launch the helper from** (Terminal, iTerm, VS Code, …, *not* python):
   - Accessibility: open `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` (System Settings › Privacy & Security › Accessibility), turn on your terminal app.
   - Input Monitoring: open `x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent`, turn on your terminal app (it appears after the helper's first start, which calls `CGRequestListenEventAccess`).
   - Quit and reopen the terminal app afterwards. The helper prints the exact app name it detected at startup ("Launched from: …"); if it names the wrong app, grant that one.
2. **Turn off** macOS Dwell Control and Head Pointer (System Settings › Accessibility › Pointer Control) and Voice Control (Accessibility › Voice Control). **Unplug any drawing tablet.**
3. If the F-keys control brightness/volume, turn on System Settings › Keyboard › "Use F1, F2, etc. keys as standard function keys" (or use a pedal/keypad sending F8).
4. **Real-pointer smoke test** (Krita 5.3 open, Chrome strip with `npm run dev` at http://localhost:3000):
   1. `npm run helper`. Expect "Steady helper 0.1.0. Launched from: <your terminal>" and no "!!" lines. If you see "POINTER-LESS mode", redo step 1.
   2. Reload Steady in Chrome; the helper status should read connected; the fps counter keeps running.
   3. Rest your hand, dwell over Krita's canvas to lower the pen, move: a stroke appears in Krita. Dwell to lift.
   4. Lower the pen, then press Ctrl-C in the helper's terminal mid-stroke: the stroke must end (button released). Restart the helper.
   5. Lower the pen, cover the camera: the stroke ends within ~0.3 s with no scribble.
   6. With Krita frontmost press F9: pen lifts, Krita does NOT open anything; the Pause tile reads Resume; dwell on Resume works. Press F8 in Finder/Safari: nothing in Steady happens and the other app gets the key normally.
   7. With Krita frontmost, F5/F6 must not open Krita's brush editor/presets (helper consumes them).
   8. With the Krita plugin disabled, say/type "undo": Krita undoes via the keystroke (`cmd+z`) after Krita is brought to the front. Quit Krita and try again: Steady reports Krita is not running and no keys go anywhere else.
   9. `kill -9` the helper while the pen is down: if the pointer seems stuck, click the physical mouse once (README).
   10. Verify Krita's "Clear" fires on Backspace and "Delete layer" on shift+forward-delete via the keystroke fallback (keycodes chosen from the macOS keymap, not verified in Krita).
5. **Ring overlay (P3), real screen:** `npm run helper` (overlay on by default; `npm run helper -- --no-overlay` to turn it off).
   1. A 160×160 pt ring follows the pointer while Steady sends `ring` messages: hollow blue with a filling arc while dwelling, filled orange while drawing, dashed grey outside the canvas, "?" when tracking is lost. No Dock icon appears and Krita keeps focus.
   2. **Hover Krita's brush outline through the ring** (macOS 26.3/26.4 regression: transparent windows may intercept clicks). The brush outline must still show under the ring and strokes must still land. If not: run with `--no-overlay` and note it in DECISIONS.md.
   3. F9 hides the ring at once; Resume shows it again. Put Krita in full screen: the ring still appears there (FullScreenAuxiliary) and on every Space.
   4. With the Chrome strip next to Krita, the fps counter keeps running while the ring is over Chrome (the window is never full-screen, so Chrome is not marked occluded).
   5. Ctrl-C in the helper terminal quits cleanly with the overlay on (button released, ring gone).
6. **Pan (P3):** say/tap "pan", then lower the pen over Krita's canvas: the canvas pans (middle-button drag) and lifting ends the pan.
7. **Remapped keys (P2b):** in Settings remap Pen to a pedal key (e.g. PageUp) and confirm Krita no longer receives that key while Krita or Chrome is in front, and F8 is passed through again.


## Agent A
- With a real webcam and a resting hand: run calibration and check the suggested Steadiness and gain feel right (a slow, arm-sized movement should cross the canvas); hold still 10 s on the canvas and confirm the pen lowers once and leaves no extra ink. All pipeline numbers so far come from synthetic 30 fps signals only.

## Agent B
1. **Real webcam, resting hand (P0 DoD):** `npm run dev`, open http://localhost:3000, allow the camera. Within 60 s: the header shows **Tracking** and an fps number ≥ 20; a hollow cursor moves on the practice canvas; hold still 0.8 s → filled cursor, draw a word, hold still → pen lifts; press F7 (with focus on the canvas; press Esc first) → the last stroke disappears; Steadiness up/down changes the line.
2. **Desk View / camera picker:** Setup page › Camera lists "Desk View" (chosen by default when present); "Mirror camera" / "Rotate camera" make the pointer move the same way as the hand; settings are remembered per camera.
3. **Calibration on a real hand:** Setup › Recalibrate: rest 3 s, circle 4 s, right-then-away 3 s; the status says if an axis was flipped; "Use last setup" after reload draws within 3 s.
4. **Occluded window:** with `npm run demo-chrome` as a 320 px strip beside Krita and Krita focused, the header fps keeps counting (Worker path). If the status says "keep this window visible", MediaStreamTrackProcessor was missing.
5. **Window rect at zoom ≠ 100 %:** Pause clamp and dwell-click coordinates assume 100 % page zoom; check that a dwell on the Resume tile (helper running) clicks the tile, not beside it.
6. **Low light warning** appears when the desk is dark (main-thread luma < 50).

### Agent F (round 2: P2b / P3 real-hardware checks)
- [ ] **Colour cap with a glove or brace:** put a bright sticker on the back of a glove (or a thumb brace), Setup › Colour cap, rest the hand: the tracking word reads "Tracking" and a stroke lands on the practice canvas and in Krita.
- [ ] **Ring overlay over Krita:** the dwell ring follows the pointer over Krita, fills on a dwell, and Krita's own brush outline is still visible when hovering through the ring; clicks pass through it.
- [ ] **Hatch in Krita:** with Krita's parallel ruler assistant, say/press "hatch" and scribble back and forth: only forward passes leave ink.
- [ ] **Sonic TTS** (if keys present): "save" is answered "Saved"; nothing is spoken on pen toggles or while the mic is open.
- [ ] **Offline tracking:** with Wi-Fi off, reload Steady: hand tracking still starts (self-hosted MediaPipe assets).
- [ ] **Web Speech fallback** (only if shipped): with the Cartesia key removed, the status bar says speech goes via Google while the mic is open.
- [ ] **Record the fallback video** first at 22:00 (`docs/demo-video.md` › Fallback video: Chrome + camera only).
