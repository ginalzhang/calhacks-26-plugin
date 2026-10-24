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
