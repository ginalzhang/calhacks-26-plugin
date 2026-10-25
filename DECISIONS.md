# DECISIONS

Every non-obvious choice, with the clock. Newest at the bottom of each section.

## Clock
- 2026-10-24 14:13 PDT (Sat) — start. Feature freeze Sat 22:00. Devpost deadline Sun 09:00.
  Budgets: P0 3 h (→ ~17:30), P1 4 h (→ ~21:30), P2a starts after; whatever of P2a is not done by 22:00 is cut.

## Environment
- Krita installed is **5.3.4** (spec targets 5.3.2.1; same Qt5/PyQt5 5.3 line). Chrome 155. Node 25, Python 3.14 default; helper venv uses python3.12 (pyobjc/pynput wheels).
- No `CARTESIA_API_KEY` / `ANTHROPIC_API_KEY` at start → routes ship with mocks (see NEEDS-HUMAN.md).
- TypeScript pinned to 5.9.3 (7.x is the new native compiler; Next 16 tooling compatibility unverified).

## Contracts (lead)
- Krita `action` command uses field `action` (not `id`), because `id` is the message id on every message.
- Added messages beyond §5: `chrome_rect` (Worker→helper, so the helper can gate clicks while paused), `pong` and `ack` replies, `session_init` and `get_state` plugin commands (keeps "plugin never pushes unsolicited messages"). `krita` may carry `fallback_keys`.
- Fake helper listens on 18765 (+ HTTP control 18767) so tests never fight a real helper on 8765.
- Action table: `tilePhase` added (tile/key may exist before the voice row). Added rows `simulate_tremor`, `next_judge` (P1 Demo) and `clear_practice` so every tile is in the table.
- "No two phrases within each other's fuzzy threshold" is checked only for pairs where at least one phrase is fuzzy-eligible; `latch`/`hatch` are 1 apart but both are mode-changing (never fuzzy).

## Action table requests
(Subagents: add requested rows here; the lead merges them into src/actions.ts.)
- (Agent D) `delete_layer.krita.lookupText` is "delete layer" but Krita 5.3.4's action is `remove_layer`, text "&Remove Layer" — no action text contains "delete layer", so the lookup would fail. Suggest `lookupText: "remove layer"`.
- (Agent D) `clear_layer` keystroke fallback is `delete`, but Krita's `clear` action on **macOS** is bound to **Backspace** (`<shortcut operatingSystem="macos">Backspace</shortcut>`). Suggest `keys: "backspace"` (or confirm the helper maps "delete" to the Mac delete/backspace key, kVK 0x33). `lookupText: "clear"` matches "C&lear" → "Clear" after mnemonic stripping.

## Phase logs
- 2026-10-24 14:21 PDT — contracts committed; launching agents A–F (round 1: A/B/F → P0+P1, C → P1, D/E → P2a).

### Agent D (Krita plugin) — 2026-10-24 14:23–14:40 PDT
- **Verified in the Krita 5.3.4 bundle** (`/Applications/krita.app`, `CFBundleVersion 5.3.4`, PyKrita 5.3.4.1; bundled Python **3.13**, PyQt5): every §7 action id exists — `edit_undo edit_redo file_save zoom_to_fit zoom_to_100pct view_zoom_in view_zoom_out rotate_canvas_left rotate_canvas_right reset_canvas_rotation mirror_canvas view_show_canvas_only` in `kritamenu.action`; `erase_action eraser_preset_action increase_brush_size decrease_brush_size increase_opacity decrease_opacity add_new_paint_layer set_{no,simple,weighted,stabilizer}_brush_smoothing` in `krita.action`. Also verified: `KritaShape/KisToolBrush` (tools.action), `merge_layer` ("&Merge with Layer Below", Ctrl+E), `remove_layer` ("&Remove Layer", Shift+Delete), `clear` ("C&lear", **macOS shortcut Backspace**, Del elsewhere), `toggle_layer_visibility`.
- **Krita's default F-keys** (bundle): F1 help_contents, F2 RenameCurrentLayer, **F3 layer_properties, F4 save_incremental_backup, F5 show_brush_editor (checkable), F6 show_brush_presets**; nothing on F7–F10. `session_init`/`clear_shortcuts` clear exact matches only (Shift+F6 "featherselection" is untouched) and keep any other shortcut on the same action.
- **libkis API names** checked against the bundled `krita.pyi` stub: View has `setForeGroundColor/foregroundColor/brushSize/setBrushSize/paintingOpacity/setPaintingOpacity/setCurrentBrushPreset/currentBrushPreset/eraserMode/setEraserMode`; Window `qwindow()` returns the QMainWindow; `ManagedColor.fromQColor(qcolor, canvas)`; `Node.paintPath/paintLine/paintPolygon` exist in 5.3.4 (P4 exact-hatch is possible; not built).
- Bundled plugins import PyQt6 first, then PyQt5; ours imports **PyQt5 first** (the tested 5.3 line) with a PyQt6 fallback (QOpenGLWidget from QtOpenGLWidgets on Qt6). Off-5.3 versions get a `warning` in the `session_init` reply and in the status dialog.
- `dispatch.py` is pure (no Qt/krita imports; AST-checked in a test). The Adapter interface lives in `dispatch.py`; `adapter.py` is the only file that touches Krita. Session state (`Session.smoothing`: untouched → pending → done) lives on the adapter, which is created once per Krita process.
- **Smoothing → None once per process.** The `set_*_brush_smoothing` actions are not checkable (bundle) so the current mode cannot be read; the switch counts as done when the action was found and enabled. They act on the Freehand Brush tool's options, so the adapter triggers `KritaShape/KisToolBrush` first and re-triggers the smoothing action 150 ms later (tool option widgets may be created a tick late). With no document open at `session_init`, the reply says `smoothing_pending: true` and the switch happens on the first later command that has a view (not `ping`); that reply carries `smoothing_changed: true`. A user `smoothing` command ends any pending switch; nothing re-applies it.
- `session_init` clears shortcuts on every call (idempotent: a second call reports `cleared: []`). Runtime `setShortcut` is per Krita session (not written to Krita's shortcut file), so a restarted Krita gets them cleared again on connect; krita-setup.md explains the permanent manual way.
- Preset matching (`match_preset`): exact name (case-insensitive; alias path) → every query word must prefix-match a word of the name (leading "x) " stripped; "ink" ≠ "pinky"); eraser presets excluded unless the query asks for one; tie-break: keyword earliest in the name, then shortest, then alphabetical. No preset names in plugin code (test greps for them). No match → `no_preset`.
- Erase toggle on preset change: if `erase_action` is checked, trigger it (Krita's own path), then also `view.setEraserMode(False)` if the view still reports eraser mode. Reply has `eraser_cleared`.
- `new_layer` uses `createNode`/`addChildNode`/`setActiveNode` per spec, inserted **directly above the active layer** (like Krita's own New Layer) rather than at the top of root; default name "Steady N". libkis node insertion is probably not on Krita's undo stack (NEEDS-HUMAN).
- `layer_nav` moves among siblings only (bottom→top order of `childNodes()`); at the top/bottom it stays and replies the current layer. `layer_visible` calls `refreshProjection()`.
- `canvas_rect`: search the main window's `findChildren(QWidget)` for visible ≥100×100 widgets: class in {`KisOpenGLCanvas2`, `KisQPainterCanvas`} first, then any class containing "Canvas" but not "Controller", then any QOpenGLWidget; largest wins; `mapToGlobal(0,0)` + width/height (Qt logical px = macOS points). Reply carries `widget_class` so the human check can confirm the name. No view → `no_canvas_rect` (reason `no_view`) so the browser falls back to corner marking. `window_rect` = `qwindow().frameGeometry()` (includes the title bar, like CGWindowList bounds).
- `list_actions` strips Qt mnemonics (`&Merge with Layer Below` → `Merge with Layer Below`) and skips actions without an objectName.
- Clamps: size 1–1000 px; opacity 0–100 %; `color_adjust` dv must be in −1..1 and shifts HSV value additively.
- Bridge: `ThreadingTCPServer` (allow_reuse_address, daemon threads) on 127.0.0.1:8766; requests on one connection are handled in order (so pipelined "undo ×5" stays serial). GUI thread busy > 4 s (below the helper relay's 5 s) → `error:"timeout"` (the queued command is cancelled, never run late). Invalid JSON line → `{id:"", ok:false, error:"bad_args"}`. `ping` also goes through the GUI queue, so it proves the drain is alive. Port busy → status "could not listen…", plugin keeps loading.
- Plugin adds **Tools › Scripts › "Steady: connection status"** (listening state, helper connected, commands handled, Krita/PyQt version and the "tested on 5.3" note).
- Install script copies only `steady.desktop` + `steady/*.py` (no tests, no caches), replaces only Steady's own folder, honours `KRITA_PYKRITA_DIR`; tested with `HOME` pointed at a temp dir. Not run against the real folder.
- P4 note only (not built): exact hatch via `Node.paintPath(QPainterPath)` — the method exists in 5.3.4's stub; whether one call = one undo step and how Speed sensors behave must be verified in Krita.

### Agent D — round 3 (P4 `list_widgets`) — 2026-10-24 15:45–15:48 PDT
- `list_widgets {max?}`: the adapter walks `qwindow().findChildren(...)` and returns raw candidates; the pure `dispatch.order_widgets` filters, labels, orders and numbers them (tested with a fake adapter and with stub Qt).
  - Candidates: every `QAbstractButton` that is visible and whose `visibleRegion()` is not empty (covers `KoToolBoxButton` toolbox buttons, toolbar `QToolButton`s, `KoDockWidgetTitleBarButton` docker title buttons); every visible tab of every `QTabBar` (tabbed dockers); cells of item views of class `KisPaletteView` (palette swatches, label = cell tooltip/display text, else "Swatch N") and `KisResourceItemListView` (preset docker, else "Preset N"), ≤ 64 cells per view, only cells whose centre is inside the viewport.
  - **Class names verified** as strings in the Krita 5.3.4 bundle: `KoToolBoxButton`, `KoToolBox`, `KisOpenGLCanvas2`, `KisQPainterCanvas`, `KisPresetChooser`, `KisMainWindow` (libkritaui); `KoDockWidgetTitleBarButton`, `KoDockWidgetTitleBar`, `KisPaletteView` (libkritawidgets); `KisResourceItemListView` (libkritaresourcewidgets). `KoResourceItemView` (older Krita) is **not** in 5.3.4. The code itself only relies on Qt base classes for buttons/tabs; the two item-view names gate cell enumeration.
  - Filters: visible, enabled, ≥ 8×8 pt, centre on some `QGuiApplication.screens()` geometry, non-empty label; duplicates (same label + rect) dropped. Label = toolTip → text → objectName, with HTML tags, `&nbsp;` and `&` mnemonics removed, ≤ 60 chars.
  - Reading order: sort by vertical centre; a widget joins the current row if its centre is within half the row-leader's height; rows top→bottom, left→right inside a row. `max` default 40, hard cap 200; non-positive/non-integer → `bad_args`. No main window → `no_window`; no document is fine (the toolbox exists).
- Registered the `P4` marker in `krita-plugin/tests/conftest.py` (pytest.ini lists P0–P3 only; lead may move it there).
- **`paint_path` (exact hatch probe) not built**: it needs screen→image coordinate mapping through the canvas transform and a real-Krita check that one `Node.paintPath` call is one undo step; not trivial without Krita. `Node.paintPath(QPainterPath, strokeStyle, fillStyle)` and `paintLine/paintPolygon` exist in 5.3.4's `krita.pyi`.

### Agent D — safety round (review R10, H4) — 2026-10-24 15:58–15:59 PDT
- **Bridge closes the connection on the first line that is not a JSON object** (invalid JSON, array, string, number) or any line over 1 MiB, after one `{id:"", ok:false, error:"bad_args", message:"…; closing"}` reply. An HTTP POST from a web page to 127.0.0.1:8766 is cut off at its request line, so its body is never executed (test sends a real POST with JSON lines in the body: nothing runs). Blank lines are still skipped; `unknown_cmd` and other well-formed errors keep the connection open.
- **`action` allowlist** (`dispatch.ALLOWED_ACTIONS`): the §7 ids verified in the 5.3.4 bundle, plus `merge_layer`, `remove_layer`, `clear`, `toggle_layer_visibility` (the ids the browser finds by text via `list_actions`; verified in the bundle) and the four smoothing ids. Anything else → `ok:false, error:"action_not_allowed"` before Krita is touched. `unknown_action` now means "allowed id, but this Krita doesn't have it". A test checks every `cmd:"action"` id in src/actions.ts is on the list. (The adapter's own internal `KritaShape/KisToolBrush` trigger for smoothing is not reachable through `action`.)
- **H4:** `Bridge.stop()` now shuts down and closes every open client socket (tracked per connection); `connections` drops to 0.
- Contract note for the lead: new error code `action_not_allowed` for PROTOCOL.md's error list.

## Contract change requests

### From Agent D (plugin) — additive, no change made to the contracts
1. **PROTOCOL.md plugin table: document extra reply fields the plugin sends** (all passthrough-compatible with `PluginReplySchema`): `action` → `checked` (checkable actions, e.g. `erase_action`, so the Eraser tile's `aria-pressed` can follow Krita); `color` → `color`; `preset` → `eraser_cleared`; `layer_visible` → `visible`; `smoothing` → `mode`; `canvas_rect` → `widget_class`; `session_init` → `smoothing_pending` (no document yet) and `warning` (not Krita 5.3).
2. **Any `krita_reply` may carry `smoothing_changed: true` once** (deferred one-time switch to None when `session_init` arrived before a document was open). Request: the Worker/page shows the same "Krita smoothing set to None" notice whenever it sees it.
3. **Error codes to list**: `unknown_action`, `action_disabled` (action exists but Krita disabled it, e.g. no document), `no_preset`, `no_layer`, `no_window`, `timeout` (GUI thread busy > 4 s). `canvas_rect` with no document answers `no_canvas_rect` (+ `reason:"no_view"`) rather than `no_view`, so the browser's corner-marking fallback triggers on one code. Invalid JSON line → `{id:"", ok:false, error:"bad_args"}`.
4. **Helper (Agent C): raise the asyncio stream limit for the plugin socket.** `asyncio.open_connection()` defaults to a 64 KiB line limit and `readline()` raises `ValueError` past it, which drops the connection. A stock Krita 5.3.4 has ≈700 actions in its bundled .action files (≈38 KB as compact `list_actions` JSON) plus runtime/plugin actions, so the `list_actions` reply can approach 64 KiB. Suggest `asyncio.open_connection(host, port, limit=1 << 20)`. The plugin already sends compact, non-`\u`-escaped UTF-8 (a translated Krita UI would otherwise be ~6× bigger).

### Agent E
- 2026-10-24 14:23 PDT — start (P2a voice + API routes). 14:35 — P2a code + tests in place. 14:37 — A's grammar.ts landed; `tsc --noEmit` clean for src/voice + src/app/api; `npx vitest run src/voice src/app` 8 files / 64 tests green. Routes also smoke-tested under `next dev` (mock responses; with a fake key the SDK path bundles and returns `reason:"key_missing"` on the upstream 401).
- **STT: manual socket, not the SDK (decided 14:27, inside the 20-minute box, from the installed 4.2.0 sources; no key, so no live smoke).** `@cartesia/cartesia-js` 4.2.0 does support the browser (`client.stt.manualFinalize.websocket({...})` puts `access_token` + `cartesia_version` in the query and repeats `keyterm` via qs `arrayFormat:"repeat"`), so it would build the same URL. Chosen against because its WS module does `require('ws')` (optional peer dep, **not installed**) inside try/catch, which the Next/Turbopack client bundle may refuse to resolve, and that can't be verified without a build. The manual socket is the documented §8 fallback, ~150 lines, and unit-tested with a fake WebSocket. `scripts/cartesia-smoke.mjs` (Node 22+, global WebSocket) exercises the exact same URL for a human with a key.
- Speech onset / activity for the tap-mode silence close and the cap = first transcript delta **or** the first 100 ms chunk whose pre-gain RMS ≥ 0.015 (`src/voice/micPolicy.ts`). Reason: Ink 2 manual-finalize may emit no interim deltas before `finalize`, in which case "silence after the first transcript delta" could never fire. Nothing closes before onset in tap mode; PTT never auto-closes.
- STT socket stays open across utterances (begin/finish per utterance). A cancelled utterance (quiet mode switched on mid-utterance) closes the socket so its audio can't leak into the next transcript. Token ≥ 45 min old → socket closed right after the utterance's `flush_done`; the next mic open re-mints. `finish()` gives up after 5 s without `flush_done` and uses finals + interim.
- Capture: mic acquired only while open (getUserMedia per utterance, fully released on close). Worklet = box-filter resampler to 16 kHz (handles < 16 kHz headsets too) + slow-envelope gain 1–8× toward −20 dBFS that only rises above a noise floor, soft limiter; posts 1600-sample chunks with pre-gain RMS (VAD) and post-gain RMS (meter). Device change → graph rebuilt, `AudioContext.sampleRate` re-read. Track ends on its own → banner (`revoked` if Permissions API says denied).
- No Cartesia key → the Mic tile does not open the mic at all; status "Voice needs a Cartesia key (key missing). Use the tiles or type the command." (no point asking for mic permission for audio that can't be transcribed).
- Claude action enum = action rows with voice phrases, phase ≤ max(BUILD_PHASE, P2b), excluding dialog words (yes/no/cancel/one/two/three: exact-match only), `mic`/`pen_toggle` (key/tile only) and demo controls (`simulate_tremor`, `next_judge`, `clear_practice`). SYSTEM_BLOCK ≈ 8.3 k chars ≈ 2.1 k tokens (min cacheable for Haiku 5.5 is 512), generated once at module load from `ACTIONS` + `PRESET_FAMILIES`, no per-request data.
- `thinking:{type:"disabled"}` is valid on claude-haiku-5-5 only at effort ≤ high; we send effort "low", so it's accepted (checked against the claude-api skill's model table).
- Server classification: `APIConnectionTimeoutError` → timeout; `AuthenticationError` → key_missing; non-HTTP `AnthropicError` (the SDK throws this when zod/JSON parse of structured output fails) → invalid; `parsed_output === null` → invalid; anything else → upstream (client maps to "offline"). Clarify options deduped and trimmed to 3; a clarify with no known option → invalid. A size/opacity returned without a number is dropped.
- Client gives up on `/api/command` at 4 s (server budget 2.5 s + round trip) → reason timeout. `navigator.onLine === false` → offline without a request.
- "undo that" ×N: `resolveText` returns N `{action:"undo"}` commands (cap 20) for a transcript made only of "undo that" (typed also accepts bare "undo"); not applied while a dialog is open.
- Mock `/api/command` (no ANTHROPIC_API_KEY): keyword matcher in `src/app/api/command/mock.ts` validated through the same zod schema; no hit → `{kind:"error", reason:"key_missing", mock:true}` so the UI shows "Didn't catch that" + closest two; filler → noop; "make it lighter" → clarify [lighter, fade]. `resolveText` reports "Claude key missing: using the offline keyword matcher." via `onStatus`.
- Token route: voice id = `CARTESIA_VOICE_ID`, else first English voice from `GET /voices` (the endpoint `client.voices.list()` pages over) called with fetch so the server bundle never loads the SDK's `ws` peer either; failure → `voiceId:null` → TTS status "voice unavailable".
- TTS (P2b, built but unwired): manual WS to `/tts/websocket`, `model_id:"sonic-3.6"` (not in the SDK's TTSModel literal list, which tops out at sonic-3.5; it's typed `string & {}` so it's accepted; verify with a key), voice `{mode:"id", id}`, raw pcm_s16le 24 kHz, `max_buffer_delay_ms:300`; `cancel:true` on mic open; silent in quiet mode / setting off / mic open.
- Claude log (`steady.claudeLog.v1`, last 200): outcomes accepted / rejected / pending / noop / timeout / invalid / offline / key_missing / upstream; prewarm not logged (matches F's README formula "excl. pre-warm").
- **Integration notes for B:** render `<MicTile/>` from `@/voice` (client-only); call `prewarmClaude()` once at app start; when a Claude clarify closes call `resolveClarify(pickedAnOption)`; if the user says/presses undo right after a `via:"claude"` resolution call `markLastClaudeRejected()`; mirror settings into `tts.setEnabled(settings.tts)` and `tts.setQuiet(settings.quiet)`; use `tts.speak("Saved")` etc. for non-visible confirmations; metrics panel reads `summariseClaudeLog()` and re-renders on `onClaudeLogChange`.
- 2026-10-24 15:05 PDT — round 2 start.
- **Undo coalescing moved to the grammar:** A's grammar now returns `{action:"undo", arg:N}` for "undo that ×N" (types.ts contract), so `resolveText` no longer pre-coalesces into N separate commands; it passes the grammar's command through. `undoRunCount` removed.
- **`name_brush` is never Claude's:** rows with `arg:"word"` are excluded from the Claude enum and SYSTEM_BLOCK, and `resolveText` drops a word-arg action if one ever comes back (alias words must come from the user verbatim; the grammar puts the word in `variant`, which `resolveText` passes through unchanged).
- **TTS confirmations:** `speakConfirmation(kind, heard?)` with a fixed table (saved, new_layer, didnt_catch, needs_plugin, skin_saved, brush_named, word_taken), each ≤ 5 words; heard text capped at 12 words; no pen-toggle kind exists. Never while the mic is open (re-checked after the token/socket awaits too), cancel `{context_id, cancel:true}` + stop playback on mic open, silent in quiet mode or with the setting off. Voice-id failure → status "Spoken replies: voice unavailable." (MicTile forwards `tts.onStatus` to the status line). `TtsClient` takes injectable socket/player/token deps.
- **Web Speech fallback (P3) — PRIVACY:** OPT-IN (lead, 15:09): only when `MicTileProps.allowWebSpeech` (settings.webSpeechFallback, default false) is true; otherwise no key keeps "Voice needs a Cartesia key… use the tiles or type". When allowed, used only when Cartesia is unavailable (mock token = no key, token mint error, or a Cartesia socket that closed before ever opening → later utterances) and `SpeechRecognition`/`webkitSpeechRecognition` exists. Same open/close semantics (tap or push-to-talk; recognition runs only while open; `continuous`, interim results, en-US; if Chrome ends recognition by itself while the mic is still open it is restarted, so there is still no time limit). **Chrome's Web Speech sends the audio to Google's servers**, unlike rule 9's "Microphone audio goes to Cartesia only while the mic is open". The status line shows "Using the browser's speech recognition. Chrome sends this audio to Google while the mic is open." the first time per page load, then "Using the browser's speech recognition." No level meter on this path (no audio access); speech onset/activity come from `onspeechstart` and results.
  - **For F (README › Privacy / Cartesia features, one line):** "If Cartesia is unavailable (no key or no connection), the Mic tile falls back to Chrome's built-in speech recognition, which sends your microphone audio to Google while the mic is open; the status line says so when it happens."
  - **For the lead:** the first-run privacy text (§0 rule 9) is exact-match with §8; if the fallback ships enabled, that text needs this extra sentence, or the fallback should be gated behind a setting. Not changed by E (not my file).
- **Refused alias (15:12):** grammar nomatch with `refused:{reason:"alias_taken", word}` → `resolveText` returns `{kind:"none", reason:"nomatch", closest:[]}` without calling Claude (status "That word is taken: …"); B checks `isAliasTaken(r)` (exported from `src/voice`, returns the word or null) and calls `speakConfirmation("word_taken")`.
- **Network down (§13):** `navigator.onLine === false` → the Mic tile does not open ("Voice is off: no network connection. Tiles, keys and the typed box still work.", alert; Web Speech also needs the network so it is not tried); `resolveText` still runs the grammar, skips Claude without a request and says "Offline: only exact commands work…". Grammar, tiles, keys and the plugin path don't touch the network.

### Agent F
- 2026-10-24 14:24 PDT — start (tests, fixtures, demo-check, docs).
- Replay fixtures are synthesised by `node scripts/gen-replay.mjs` (seeded PRNG, deterministic; `--check` detects drift) into `tests/fixtures/replay/` and mirrored byte-for-byte to `public/replay/` (Vitest `tests/unit/replay-fixtures.test.ts` asserts the mirror). Compact format, 640×480 camera px, 30 fps, landmark 5, right hand. Extra top-level fields `description`, `marks` (segment start times, ms) and `stations` are informational; ReplaySource ignores them.
- Fixtures: `rest-still`, `calibration-sequence` (loops, so a late-starting calibration still sees still→circle→right/away), `dwell-stroke-word` (cursive "mum", 55 camera px/s), `calibrate-then-word` (cold start), `tremor-line` (6 Hz ±5 px), `tracking-loss-mid-stroke` (30 frames score 0.5 with ±100 px junk positions), `hand-outside-area` (jump to (600,40)), `no-hand` (null frames), `probe` + `wander` (dwell-on-tile tests).
- Dwell-on-tile tests (Resume by dwell) fit the camera-px → target-units mapping from `state().pointer` plateaus on the `probe` fixture (lazy-brush lag corrected by the Steadiness radius along the approach), then serve a route-generated fixture (`context.route('**/replay/dwell-at.json')`) that holds still over the tile's centre. Screen ↔ client conversion: browser chrome above the viewport = `outerHeight − innerHeight`.
- Playwright tests seed `localStorage["steady.calibration.v1"]` (`{Right, Left}` Calibration, box 224,144 192×192, gain 2) so P0/P1 tests skip calibration; if the page ignores it, the word tests fall back to `calibrate-then-word`. "Use last setup" is clicked if visible.
- Page-fit test measures the visible `role="tabpanel"` (or `[data-page]`) and `document.scrollingElement`, at 320×900. 200 % zoom is emulated as a 160×450 CSS-px viewport at deviceScaleFactor 2; the header-pinned check scrolls to the bottom and requires the page tab to stay in view.
- axe: tags wcag2a/2aa/21a/21aa/22aa, all pages, 100 % and 200 %; violations are attached and logged; `AXE_GATE=1` makes them fatal.
- `scripts/demo-check.sh N`: tsc → Vitest `-t "@P0|…"` (`--passWithNoTests`) → pytest `-m "P0 or …"` (exit 5 = pass) → Playwright `--grep`. DoD items PASS only if ≥ 1 mapped test ran and all mapped tests passed (skipped = FAIL); "every @PN Vitest/pytest" items FAIL when no test carries that tag. Real-hardware items print NEEDS HUMAN.
- Metric formulas written into README › Metrics (deviation RMS over 3 s, last-stroke ms, command success rate = resolved-and-executed ÷ attempted with `noop` excluded, Claude calls excl. pre-warm / accepted / timeouts > 2.5 s, camera fps, detection fps, latest ping→pong). B/E: please compute them this way or tell F to change the README.
- UI names the tests rely on beyond the brief (B): the typed-command box is a `textbox` whose accessible name contains "command" or "type" (suggest "Type a command"); the Steadiness −/+ tiles are the first/last `<button>` in the slider's nearest container (or named "Steadiness −"/"Steadiness +"); the metrics region carries `aria-live="off"` and its text mentions deviation, stroke, success, Claude, camera, detection, round-trip; status text is in `role="status"`.

### Agent C (helper, fake helper, helperClient, krita.ts)
- 2026-10-24 14:22 PDT start; 14:40 helper + fake helper + TS client green (P1).
- Package is `helper/steadyhelper/` (not `steady`) so it never collides with the plugin's `steady` package in one pytest run; tests use uniquely named files (`test_helper_*.py`, `steadyhelper_testkit.py`) and no `conftest.py` for the same reason. Modules: `server.py` (WebSocket + dispatch), `pointer.py` (pen-state law, coalescing), `watchdog.py` (thread), `hotkeys.py` (pure router + pynput `darwin_intercept`), `krita_relay.py`, `macos.py` (Quartz/AppKit backends), `permissions.py`, `keys.py` (combo → keycode), `protocol.py` (Python mirror of the zod schemas), `fakes.py`.
- Bad Origin (incl. no Origin): handshake accepted then closed with **4003** before any message is read (PROTOCOL.md says close code 4003). Nothing is processed from such a socket.
- Pointer events: own thin Quartz backend (`CGEventCreateMouseEvent` → `kCGHIDEventTap`, MouseMoved vs LeftMouseDragged by our own button state) instead of `pynput.mouse.Controller`, so the move/drag choice is explicit and testable. Moves coalesced to ≤ 120 Hz (pending point flushed by `call_later`; button events flush first so a stroke ends at its last point, as a drag).
- Watchdog feeds on every *valid* message (garbage does not keep the button held). Releases also on: socket close (any client), `up`, `pause`, pause/pen/ptt_down hotkeys (helper lifts immediately, Worker follows), per-message exception (reply `error code:"internal"`), atexit, SIGINT/SIGTERM/SIGHUP, top-level exception (`run_guarded`).
- While paused the helper also clamps `move` to the last `chrome_rect` (defence in depth; Worker clamps too). Refusals are `error {code:"paused"|"outside_chrome"}` echoing the id. Pause state survives a reconnect and is reported in `hello.paused`; the Worker should send `resume` if it starts unpaused.
- `click` with `reactivate_krita`: Krita is activated 120 ms after the click so Chrome processes the click first.
- `keys`: refuses with `ack ok:false error:"krita_not_frontmost"` if Krita is not frontmost 150 ms after activation (never posts keys into another app); `bad_combo` for unparseable combos; `permission` without Accessibility. "delete" = forward delete (kVK 117), "backspace" = kVK 51, "+" = shift+'='.
- Frontmost app: `NSWorkspace.frontmostApplication()` goes stale in a process with no Cocoa run loop, so the asyncio main thread pumps the run loop every 50 ms and caches the bundle id; the key tap reads the cache.
- Hotkeys: consumed only when a Worker is connected AND Krita/Chrome is frontmost (with no Worker connected the page's own keydown owns the keys). Key-up of a consumed key-down is always consumed (F10 release always sends `ptt_up`); auto-repeat consumed silently; events posted by our own pid pass through. Default F3–F10 only (remap needs a contract message, see requests).
- Input Monitoring is read with `CGPreflightListenEventAccess()`: pynput's `Listener.IS_TRUSTED` is `AXIsProcessTrusted()` (the Accessibility bit) on macOS. Without Accessibility → pointer-less mode (`down`/`click` answer `error code:"permission" which:"accessibility"`). Without Input Monitoring → no key tap.
- Launching app = furthest ancestor process that is an `.app/Contents/MacOS/` executable (TCC's responsible app), else `TERM_PROGRAM`. Startup warnings (Dwell Control / Head Pointer / Voice Control / tablets) are console-only plus process sniffing for tablet drivers and VoiceControl; no protocol message exists for warnings.
- Krita relay: `open_connection(limit=1<<20)` (D's request; list_actions ≈ 38 KB); over-long line → reconnect. Plugin reply fields pass through unchanged in `krita_reply` (+ `via:"plugin"`); timeout 5 s → `error:"timeout"`. `krita`/`keys` are handled in tasks so a slow plugin never stalls moves (tested).
- Fake helper: canned plugin payloads per cmd (list_actions includes merge/remove/clear, presets, canvas_rect, session_init, get_state); `/config` also takes `canvas_rect`/`window_rect` (null → error) and `payloads` (F's request); `GET /messages?t=move` filter and `GET /health`. With `krita:false` it replies `plugin_down` even when `fallback_keys` is present (literal PROTOCOL.md; the real helper would answer `ok:true via:"keys"`).
- `helperClient.ts`: export `createHelperClient(opts)` / class `HelperSocketClient` (+ `helperUrlFromSearch(location.search)` for `?helper=`). Backoff 250 ms → 5 s. `request()` rejects with `HelperRequestError{reason:"timeout"|"closed"}` (never a sync throw; pending requests reject on socket close). **Keepalive on by default**: sends `ping` whenever nothing was sent for 100 ms (any send resets it), so B need not implement the ping rule (sending own pings is harmless). All valid helper messages (replies included) go to `onMessage`.
- `krita.ts`: `kritaMessageFor(action, {arg, pluginConnected, lookups, skinHex})`; plugin down + keys → still a `krita` message with `fallback_keys` (helper decides); plugin-only → `needs_plugin`; `size` clamped 1–1000, `opacity` 0–100, missing number → `unknown`. `buildLookups(list_actions)` tiers: exact text → id → synonym ("delete layer"→"remove layer", "merge with layer below"→"merge down") → starts-with → contains; destructive rows only the first three; ties = no match. `kritaConnectMessages()` = session_init(f3..f10), list_actions, list_presets, canvas_rect. Brush via keystroke `b` cannot clear the erase toggle (plugin path does).
- 14:44 `warning` (lead accepted request 2): after `hello` and any permission errors, each new client gets one `warning {code, message}` per active startup warning. Detected from running processes: `voice_control` (process `VoiceControl`) and `tablet` (Wacom/Huion/XP-Pen/Gaomon/TabletDriver). `dwell_control` and `head_pointer` have no reliable process signature, so they are never emitted and stay in the console reminder only; `overlay_disabled` waits for the P3 overlay.
- 14:50 Origins (lead request; port 3000 may be taken): `--origin` (repeatable) or `STEADY_ORIGIN` (comma-separated) on both helper and fake helper; flags win over env, env over the default (exactly `http://localhost:3000`). Only `http(s)://localhost|127.0.0.1[:port]` with no path/userinfo; anything else (incl. `*`) exits 2 at startup with a clear message. Listing an origin replaces the default (repeat `--origin` to keep 3000). The helper still refuses a missing Origin; the fake still accepts it. Validator: `helper/steadyhelper/origins.py` (the fake keeps a stdlib copy to stay standalone).
- Round 2 (15:05–15:11 PDT):
  - `keymap` (P2b): replaces the whole map (atomic swap); combos are matched on keycode + cmd/ctrl/alt/shift (Fn and keypad bits ignored, so F-keys work with the Fn flag macOS sets); a key-up is matched by keycode only, so a key held across a remap (e.g. PTT) still sends `ptt_up`. Refused with `ack ok:false error:"bad_combo"`: unparseable combos, combos that collide after normalisation ("F8"/"f8", "command+z"/"cmd+z"), and `ptt_up` as a value (not a key of its own). Unknown hotkey names fail the schema (`error bad_message`). A refused map leaves the previous one in place. The map survives reconnects (the Worker resends it on connect anyway).
  - Pan (P3): `middle_down`/`middle_up` → kCGEventOtherMouseDown/Up (kCGMouseButtonCenter = 2), `move` while held → kCGEventOtherMouseDragged. `release()` (watchdog, pause, socket close, exit, exceptions, hotkeys) lifts both buttons; lowering one button lifts the other; `middle_down` refused while paused (`error paused`) or without Accessibility.
  - Ring overlay (P3): logic in `helper/steadyhelper/ring.py` (pure: state → shape/colour/dash/progress; ≤ 60 Hz throttle where the newest frame wins and visibility changes are never delayed; `OverlayController` that only touches the view via callAfter/callLater and disables itself for good on any exception, then `warning overlay_disabled` to current and later clients). AppKit view + runner in `overlay.py` (imported only when enabled; never in tests). Shapes: hover = hollow ring + progress arc (blue), drawing = filled disc (orange), outside = dashed hollow grey, lost = "?" in a dashed amber ring. Hidden on `pause`, on F9 (immediately, before the Worker's `pause`), on `ring state:"hidden"` and when the last Worker disconnects. With the overlay on, the Cocoa event loop owns the main thread (NSApplication accessory policy: no Dock icon, never steals focus) and the asyncio server runs in a thread; SIGINT/SIGTERM/SIGHUP handled by `signal.signal` on the main thread with a 250 ms callLater tick so Python handlers run. If the window can't be created, the helper runs without it and sends `overlay_disabled`.
  - `krita.ts`: `keymapMessage(map)` accepts `{combo: hotkeyName}` or `{combo: actionId}` (so `keymapMessage(DEFAULT_KEYS)` equals the protocol example); `ACTION_TO_HOTKEY` exported. pick / line / name_brush needed no code (generic keys / plugin-only paths); tests added.
- Round 3 (15:45–15:50 PDT, P4):
  - `numbers`: validated (items null or [{n,label,rect}]), acked. Badges are laid out by the pure `ring.layout_badges` (pytest @P4): top-left of each widget rect, yellow digits on a near-black plate with a white border (≥ 7:1), digits ≥ 28 pt (up to 40 pt for big widgets), and the badge is NEVER larger than its rect. **Conflict resolved:** a widget smaller than a 28 pt plate (35 pt tall; Krita's default icons are 22–32 px) gets its digits shrunk to fit (floor 10 pt) and `full_size=False`, rather than covering neighbouring widgets; krita-setup.md already says to enlarge toolbox icons. AppKit draws one small window per badge (never one big window). `numbers` answers `ack ok:false error:"overlay_disabled"` with `--no-overlay`/overlay failed, `error:"paused"` for non-null items while paused; pause clears the badges and they stay off after resume until the Worker resends; the last Worker disconnecting clears them. Max 99 badges.
  - Second app: **chose the helper CLI flag** `--app krita|photoshop` (env `STEADY_APP`) over a per-message field, so protocol.ts is untouched. It selects the bundle id (`com.adobe.Photoshop`) used for: the `keys` frontmost check/activation, global-key consumption (that app or Chrome), the `krita_window_rect` reports and `hello.krita_running`. Field names keep "krita" (contract); `keys` errors keep `krita_not_running` / `krita_not_frontmost` even for Photoshop. With a non-Krita app the helper does not connect to the plugin port, so every `krita` message uses its `fallback_keys`. The page's App setting and the helper flag must match (the helper can't be switched at runtime).
  - `src/desktop/apps.ts`: `APP_PROFILES` (Krita = the action table's keystroke fallbacks; Photoshop = macOS defaults for undo, redo, brush, eraser, bigger/smaller, zoom in/out (cmd+= / cmd+-), fit (cmd+0), actual (cmd+1), swap, save, merge down (cmd+e), pick (i); `unverified: true`: new layer = cmd+alt+shift+n (no dialog), line = u (last-used shape tool), solid = 0 (100 % opacity)). `appMessageFor(action, app, opts)`: Krita → `kritaMessageFor`; other apps → `keys` only, Krita-only actions → `needs_plugin`, canvas actions → `unknown`.
  - Fake helper: `krita {cmd:"list_widgets"}` answers the two-widget list (override with `POST /config {"widgets": [...]}`); `numbers` and `keymap` are acked and recorded.
  - Python `protocol.py` knows `list_widgets` (optional `max`) and `numbers`.
- Safety round (15:58–16:06 PDT), fixes for review R + integration H:
  - R2: one Worker at a time, newest wins. A new valid connection closes the old one with code **4001** ("replaced by a newer Steady window"); its buttons are released at that moment, and its own close path no longer releases (so it can't lift a button the new Worker has just pressed). Messages still in flight from the old socket are ignored. The fake helper still accepts several clients (tests only).
  - R5: no button held and nothing queued → hover moves coalesce as before. A button held, or anything still queued → every move AND the button events after it go into an ordered queue drained at ≤ 120 Hz by a call_later chain (button events execute as soon as their turn comes). So Repeat / Hatch replay / Dash keep their shape and the `up` lands after the last point. Bound: 240 moves (2 s at 120 Hz), oldest moves dropped first. Fail-safe releases (watchdog, pause, hotkeys, socket close, exceptions, click) DROP the queue and lift immediately. The Worker's own `up` is ordered behind queued moves (≤ 8 ms at real-time rates).
  - R7: `released {reason, button}` is sent when a button was actually held and the release was not requested by the Worker. Reasons: watchdog / pause / hotkey (F8, F9) / ptt (F10) / exception (handler or pump) / other (a click while held). It is not sent for `up`, `middle_up`, one button replacing the other, socket close, replacement or exit.
  - R8: `hello.visible_frame` = NSScreen.mainScreen().visibleFrame in Quartz top-left points. `click` is refused with `ack ok:false error:"outside_usable"` when the point is outside the visibleFrame of the screen that contains it (multi-display aware; off every screen → refused). Unknown geometry → allowed and logged, so Resume stays reachable. An auto-hidden Dock is not excluded (macOS then reports nearly the full screen): known gap.
  - H1/H2: `--no-pointer` now also blocks key posting (`ack ok:false error:"input_disabled"`; `krita` fallbacks too) and app activation (including the re-activation after a Chrome-tile click). `--no-input` = the same, plus no global key tap and no permission prompts or requests (reads AXIsProcessTrusted / CGPreflightListenEventAccess only).
  - `numbers` does have a handler (round 3). Without the overlay it answers `ack ok:false error:"overlay_disabled"`, never `bad_message` (tested). R likely saw it before round 3 landed.
  - R6: the helper keeps pause across reconnects (fail-safe); the Worker reconciles from `hello.paused`.
  - Test fix: `test_release_after_300ms_silence` was flaky (it read `watchdog.fired` before the watchdog thread incremented it); it now waits for the counter.
- Not run: `scripts/run-helper.sh` end to end (it would prompt for Accessibility and drive the real pointer); `MacSystem` read-only calls (frontmost, screen, Krita pid) were checked once on this Mac.

### Agent A (pipeline, calibration, grammar, Hatch)
- 2026-10-24 14:21 PDT start; 14:35 P0+P1 green (60 Vitest); 14:40 P2a grammar + P2b Hatch/Dots green. `npx vitest run src/pipeline`: 7 files / 89 tests (@P0 40, @P1 19, @P2a 22, @P2b 8); `tsc --noEmit` clean.
- **One Euro acceptance (own 40-line filter, per axis, real ms timestamps → s), measured at defaults (beta 0.005):** (a) RMS y residual **0.40 px** (≤ 0.75); (b) 2 Hz amplitude **37.3 px** (≥ 32.5); (c) ramp lag **51 ms** (≤ 150). Sweep 0.003→0.01: (a) 0.38→0.45, (b) 31.9→43.1, (c) 66→34 ms; 0.003 fails (b); **smallest passing beta 0.004**. Defaults pass, so **beta stays 0.005** (no fallback needed). 10 Hz at 15 fps aliases to ~5 Hz and leaves > 1.5× the 30 fps residual (documented by test).
- Mapping: uniform scale `gain` about the active-box centre → canvas-rect centre (keeps circles round; with the calibrated gain the box width maps exactly onto the canvas width), linear extrapolation beyond, clamp to screen only; Chrome-rect clamp while paused applies only to target `krita` (practice-canvas px are not screen points). Calibration flipX/flipY are applied about the box centre. No calibration → central half of the frame, gain = canvas.w ÷ box.w clamped 2–4.
- Active box "padded 20 %" = 10 % each side (box 1.2× the circle's bounding box).
- Dwell: start when all points of the last 250 ms lie within r_in of their centroid; progress counts from the first point of that window; cancel beyond 2 r_in (pen-down/click) or r_in/2 (pen-up). **Extra safety beyond §3:** after any lift (dwell, key, voice, left canvas) and after a dwell-click, a new dwell needs both 600 ms *and* a move > r_out from where the lift/click happened; after a re-acquire following Lost, likewise. Without this a resting hand lifted by voice/key would be re-lowered by dwell 1.4 s later (a dab of ink). First acquire is not gated (P0 DoD: hold still to start drawing).
- Lift < 80 ms after a down is ignored only for user lifts (dwell, pen key, voice); safety lifts (pause, tracking loss, left canvas, ptt, mode change) always lift.
- Dwell-click: never in the menu bar (top 40 pt of the screen) or a window's title bar (top 28 pt of the Chrome/Krita rect); never when the pointer is pinned at a clamp edge (otherwise, while paused, a hand outside Chrome's rect pins the pointer on Chrome's edge and dwell would click there). Krita's window counts from P2a (`createPipeline(config, { phase })`, default `BUILD_PHASE`). `click` events are emitted only for target `krita` with the helper connected; for the practice-canvas target the DwellView still reports `click` + progress outside the canvas.
- `rects.canvas === null`: target `canvas` = whole target is canvas; target `krita` = no ink until the canvas rect is known.
- Tracking: Weak during the 300 ms grace period; "detection fps" = frames given to `step()` per second over the last 1 s (needs ≥ 5 frames over ≥ 500 ms); `too_dark` when `frame.luma < 40`; Lost reason priority outside_area > too_dark > low_fps (< 10 fps) > no_hand. One Euro + lazy brush reset on (re)acquire; warm-up = first 10 accepted frames emit no pointer.
- Simulate tremor: 6 seeded sinusoids per axis in 4–10 Hz, weights normalised so the peak ≤ amplitude; amplitude 4 → 8 px linear in hand speed 0–100 px/s (speed EMA ~150 ms). `PipelineOutput.raw` and the rawTrail include the simulated tremor (that is the "raw scribble" the Demo shows).
- `deviationPx` = RMS distance of the drawn (post-lazy-brush) path from its own ±100 ms moving average over the last 3 s, in target units: it measures the shake that survives smoothing, so it **drops** when Steadiness rises (the demo script's "deviation drops"). A literal raw-vs-smoothed distance would *rise* with Steadiness and is dominated by lag. See contract request.
- Calibration: rest jitter = RMS of the One Euro output about its mean (2D); kinetic jitter = RMS of the One Euro output about its ±150 ms moving average during the circle; step 3 uses displacement in the first/second 1.5 s (≥ 10 px to decide); "away" must move the pointer up.
- Steadier/looser change the setting at once (slider shows it) but the filter/radius apply on the next pen-up. `pipeline.snapshot()` is the source of truth for steadiness/latch after `action()`; B should mirror from it rather than overwrite with stale settings.
- Recenter / Other hand / setTarget / landmark-mirror-rotate change lift the pen (`mode_change`); landmark/mirror/rotate changes also restart the filter and the warm-up gate.
- Grammar: stoplist words are skipped as fillers ("um blue" = blue), never matched; a leftover number is tolerated; > 2 commands = no-match; consecutive "undo that"/"redo" coalesce to one command with `arg = count`; arg actions without a number return `arg: null`; fuzzy compares a k-word window (longest first) with every eligible phrase; aliases (P2b) are exact-only and return `{action:"alias", variant:<preset name>}`; `keyterms()` = all voice phrases (all phases) + "layer": 84 entries / 544 chars. `validateAlias` also refuses stoplist words, number words and multi-word aliases.
- Hatch (P2b): works on the pre-lazy-brush point (the dead zone would move turning points by R); forwards points `hatchLag` ms late **and never past the current extremum candidate**, so nothing after the peak is ever sent while the button is down; alternate = every pass inked as its own stroke (5 passes → 5 strokes, matching §10). Pen key and Pause exit Hatch; tracking loss lifts and keeps the mode; pen-up dwell is off while hatching. Dots: a pen-down dwell emits `down`+`up` and the pen stays up.
- Note for B: during calibration step 1 the hand is still, so the pen-down dwell would fire; ignore pen events (or set `inputs.dwell=false`) while calibrating.

### Agent B (Worker, camera, side panel, calibration UI, Demo page) — 14:22–14:50 PDT
- **Target units.** Practice target = page **viewport CSS px** (not canvas-local): the practice canvas rect is reported in viewport px, so the pointer extrapolates off the canvas onto the side panel and the page hover-dwell hit-tests with `elementFromPoint`. Krita target = screen points.
- **Window rect** sent to the Worker/helper is the page **viewport** in screen points (`screenX`, `screenY + outerHeight − innerHeight`, `innerWidth`, `innerHeight`), not the outer window: Pause clamps the pointer to Steady's content, never Chrome's toolbar. Correct at 100 % zoom only (CSS px = points); also exposed as `__steady.windowRect()`.
- **Tile activation (§3).** No helper → the page activates the button under the dwell anchor when `dwell.kind==="click"` reaches progress 1 (A's pipeline emits `click` events only for Krita+helper). Practice target + helper connected → the **Worker** sends `click {x,y}` (screen points) to the helper on that same edge; the page never self-clicks while the helper is open.
- **Keys.** One document `keydown` listener; mapped F-keys are always `preventDefault`ed (F5 must never reload), then ignored when the helper is open, when `inputs.keys` is off, or when focus is in button/input/textarea/select. Esc focuses the practice canvas unless a dialog consumed it. F10 = push-to-talk (`pttHeld` for E's MicTile).
- **Steadier/looser** are handled on the page (±10, 1 s debounce for non-tile sources) as a settings change; A's pipeline defers application to the next pen-up. Latch goes through the Worker (helper F3 path is the same) and the page persists `mirror.latch`. Simulate tremor is a settings toggle (not a pipeline action) so it cannot double-toggle.
- **Calibration**: steps [1,2,3] with A's `createCalibrator({steps, targetWidth, prior, now})`; dwell is disabled in the pipeline while calibrating (step 1 is a still hand). Result → localStorage per hand, Steadiness slider moved to `suggestedSteadiness`, gain override cleared. No auto-calibration on first run (the default box already draws); "Use last setup" (Setup page) loads the newest stored calibration.
- **Pages (320 × 900, measured headless):** header ≈ 428 px (status 4 lines + 2 tab rows + 2 core rows); every page area is 473 px and every page fits (Steady 15 tiles + Steadiness; Setup: camera select + "Next camera", Mirror camera / Rotate camera / Recalibrate, "Pointer point" select + "Next point", Use last setup / Draw in Krita / Mark corners, Gain slider; Timing: 5 sliders + 4 toggles; Demo; Paint: typed box + 14 tiles; Colour; View; Layers). axe: 0 violations on every page at 320×900 and 640×450 (≈200 %). Below 700 px viewport height the document scrolls and only the status lines stay pinned (a fully pinned 428 px header would leave no page area at 200 %).
- **Selects get a dwell path:** "Next camera" and "Next point" tiles cycle the native selects (a `<select>` cannot be opened by dwell).
- **Slider ± steps:** Steadiness ±5, dwell times ±50 ms, Mic silence ±0.5 s, Mic limit ±5 s, Hatch lag ±10 ms, Gain ±0.5 (2–10). 50 ms steps on 7–45 s ranges would need hundreds of dwells.
- **Gain** lives on Setup (Steady page is full). **Typed box** lives on the Paint page (only page with room).
- **Skin tile**: one tile reads "Save current colour as skin" until a skin is saved (then "Skin" + a separate save tile spanning 2 columns), so the label never appears twice.
- **MediaPipe in the Worker:** Turbopack emits the Worker so that `importScripts` works, so the classic wasm loader is tried first and the ES-module loader second (`forVisionTasks(base, false)` then `true`). Verified headless with Chrome's fake camera: GPU delegate starts, detection runs. Detection timestamps = `performance.now()` forced strictly increasing (same clock as `pipeline.tick`). CPU fallback on create failure, on a `detectForVideo` throw, or when it returns no result object for 2 s ("returns nothing" read as no result, not "no hand").
- **sentToHelper()**: the Worker mirrors every sent message on a `BroadcastChannel("steady-sent-to-helper")` (WorkerToPage has no message for it; see contract request).
- **Earcons**: two WebAudio clicks for pen down/up (off with `earcons:false` or quiet).
- **Dev server note**: port 3000 was held by another workspace's dev server during this round; B verified on `next dev -p 3100` with the fake helper on 38765/38767 (origin patched in-process, file untouched).

### Agent A — round 2 (P2b/P3 pipeline), 2026-10-24 15:04–15:12 PDT
- **name_brush grammar:** "call this brush fluffy" / typed "alias fluffy" → `{action:"name_brush", variant:"fluffy"}` (next non-filler token; following tokens may chain a second command). No word → `{action:"name_brush", arg:null}` (caller opens the text field). A word refused by `validateAlias` → `{kind:"nomatch", closest:["name_brush"], refused:{reason:"alias_taken", word}}`; `ParseResult` is unchanged, so narrow with `isAliasRefusal(r)` from `src/pipeline/grammar.ts` and say "That word is taken" **instead of calling Claude** (E: check it before step 2 of resolution).
- **Smoothing presets** (`action("smoothing_sketch"|"smoothing_ink"|"smoothing_shade")`): Steadiness 25 / 70 / 10, Shade caps the lazy radius at 5; applied at the next pen-up like steadier. Any other Steadiness change (slider, ±, steadier/looser) clears the preset and the cap.
- **Dash:** pen-down (dwell/key/voice) only *arms* the pen (pipeline DRAWING, no `down` event); the engine presses the button only while the hand moves. Speed comes from the **raw** mapped landmark over 100 ms (on 25 / off 10 units/s): the One Euro output lags ~250 ms at 40 units/s and still creeps ~17 units/s through a 300 ms pause, so a pause never showed in it. Ink follows the One Euro output; a mark starts only when the One Euro point has also left its rest anchor by r_in/2 (so tremor on a resting hand, which makes raw speed high, never inks; tested with Simulate tremor). Pauses ≥ `dashPauseMs` (default 200; read from `settings.dashPauseMs` if present) end the mark at the last inked point and trim the held points. The pen-up dwell still disarms after a long rest. Lifting while a dash mark is not pressed sends no extra `up` (same for Hatch return passes).
- **Repeat** (`action("repeat")`): stamps the last inked stroke (any mode except pan; recorded from the emitted down/move/up events) with its first point at the cursor, exact offsets; clipped at the canvas rect; ends with `up` reason `pen_key` (no "repeat" LiftReason); afterwards a resting hand must move away before dwell can lower again.
- **Pan** (`action("pan")` toggles armed): the next pen-down is a pan drag, moves use the raw mapped landmark (filter and dead zone bypassed), exits on lift. Events stay `down`/`move`/`up`; the Worker checks `panState(pipeline).batchIsPan` after each `step/tick/action/setTarget` call and sends `middle_down`/`middle_up` instead. Pan strokes are never recorded for Repeat.
- **Pick** (`action("pick")`): the next dwell inside the canvas is one `click` (target krita: when the helper is connected; practice canvas: always) instead of a pen-down; `modeState(p).batchPickSampled` is true for that one batch only → caller sends "brush". Afterwards a resting hand must move away before dwell lowers the pen.
- `modeState(pipeline)` (exported from `pipeline.ts`) exposes panArmed/panning/batchIsPan/pickArmed/batchPickSampled/preset/lazyRadius/dashButtonDown/lastStroke without touching the `Pipeline` contract.
- **Other hand:** `mirrorCalibration(c, frameW)` mirrors the box about the frame's vertical centre and swaps handedness (gain, jitter, camera flips kept); `createCalibrator({..., prior: otherHandCal, mirrorPrior: true, frameW})` uses it for every value the rerun steps don't measure.
- Vitest: 8 files / 104 tests (@P0 40, @P1 19, @P2a 22, @P2b 14, @P3 9).

### Agent B round 2 — 15:04–15:25 PDT
- **P2a blocker (typed "steadier" stuck at 50):** root cause was the page's steadier/looser debounce ref starting at 0 — `performance.now()` counts from navigation, so any steadier within the first second after load was swallowed. The ref now starts at −∞ and the 1 s debounce applies to voice/Claude only (§0 rule 8 says voice); tiles and typed commands always apply. The Worker no longer lists steadier/looser (the page owns them as a settings change; the mirror reports the new value at once, the filter applies at pen-up in A's pipeline).
- **Header pinned at 200 %:** the panel is always a fixed-height (100vh) column with the header on top and only the page container scrolling; narrow windows no longer stack the practice area *below* the panel (that made the whole document scroll the header away) — it sits to the right with `min-width: 480px` and the document scrolls sideways. Below 700 px of height the header scrolls inside itself (max 60vh) so a page area remains; a page that overflows gets `tabindex=0` (axe scrollable-region-focusable). F's a11y spec: 0 violations at 100 % and 200 %.
- **Mic tile height:** E's button has `min-h-16` = 4rem = 72 px at our 18 px root; capped to 64 px in `.mic-cell` CSS (header back to 416 px, page area 484 px).
- **Page re-layout (every page still fits 320×900, measured):** Setup = camera select + Next camera; Mirror camera, Rotate camera, Colour cap; Recalibrate, Use last setup, Pick sticker colour; Lock exposure, Draw in Krita, Browser speech fallback; the Web Speech note under it when on. **View** now also hosts Mark corners, a "Pointer point" cycling tile (shows the current point; all 21 landmarks, named ones first — replaces the select), the Gain slider and the input toggles (Dwell click, All dwell, Keys, Camera). Timing = six sliders (Pen-down hold, Pen-up hold, Mic silence, Mic limit, Hatch lag, Dash pause). Nothing else had room; adding a 9th tab would push every page over 900 px in Demo mode.
- **P2b/P3 wiring:** every pipeline action the page posts reaches `pipeline.action` (the Worker no longer whitelists). Hatch status line "Hatch: forward passes only (lag N ms)"; Dots/Dash status lines. Quiet = settings.quiet → MicTile disabled, TTS quiet, earcons off. Other hand: uses the stored calibration for that hand, else A's `mirrorCalibration` as the prior and reruns steps 1–2 (stored per detected hand). Break nudge: every 20 min of session, deferred while the pen is down, non-blocking banner at the bottom of the panel with the Later tile, any other action dismisses it and still runs; off under `?demo=1`; gated on the `later` tile phase (P2b). Aliases: "Name this brush" tile opens a `role=dialog` with a text field (or `alias <word>` / `call this brush <word>`), `validateAlias` + E's `isAliasTaken` → "That word is taken" + `speakConfirmation("word_taken")`; preset name from `krita get_state`, stored under STORAGE_KEYS.aliases; typed aliases pass `aliases` to resolveText; voice aliases are matched on the page after a no-match (MicTileProps has no aliases prop). Destructive layer rows use the alertdialog. TTS via `speakConfirmation` (saved, new_layer, word_taken, didnt_catch, brush_named, skin_saved). `keymap` is sent by the Worker on helper connect and whenever settings.keymap changes (mic key → `ptt_down`).
- **Pan / Pick:** after every pipeline call the Worker checks `panState().batchIsPan` (→ `middle_down`/`middle_up`) and `modeState().batchPickSampled` (→ status + the brush Krita message via C's `kritaMessageFor`).
- **Colour cap (G):** Setup "Colour cap" toggle (persisted in `steady.trackSource.v1`) posts the page-local action `set_source` (variant hand|colorcap); the Worker swaps MediaPipeSource ↔ ColorCapSource and the page re-feeds a fresh camera stream. "Pick sticker colour" → `pickColourFromCentre()` message in the status line (range not persisted yet). Exposure: locked on the original track after calibration (camera source only), unlocked on Recalibrate / camera switch, Lock exposure toggle. MediaPipeSource uses G's `resolveAssets` (self-hosted /mediapipe/ first, CDN fallback). Verified with Chrome's fake camera: switch to Colour cap (CPU, 20 fps), pick colour, lock exposure, switch back (GPU).
- Note: P2b/P3 tiles still render disabled while BUILD_PHASE = P2a (rule 6); their wiring is verified through `__steady.dispatch`.

### Agent A — round 3 (P4 pipeline), 2026-10-24 15:44–15:49 PDT; Vitest 9 files / 121 tests (@P4 17)
- Follow-up: switched to the accepted contract fields: eyebrow lifts use reason "eyebrow"; settings keys read directly from `SteadySettings`; `PROFILES_STORAGE_KEY = STORAGE_KEYS.profiles`; `createCalibrator()` returns `StepCalibrator` with `recordHand(landmarks, w, h)` (B calls it next to `feed`) and stores the median as `Calibration.handScale`, which the pipeline uses as the re-baseline reference in Hand mode (otherwise it measures 2 s after start). 122 tests green.
- **Grammar:** "click five"/"click 12" → `{action:"click_number", arg}`. `use_profile`/`save_profile` take a **multi-word** name: the rest of the utterance (leading fillers dropped) goes in `variant` ("use profile shaky day" → "shaky day"), so a profile command never chains; no name → `arg:null`. An action with `phraseVariants` matched by its typed form takes a following variant word ("app photoshop" → app_profile/photoshop). With all P4 rows the keyterms are still within the caps (≤ 100 / ≤ 1200, tested), and the no-two-phrases-within-threshold test still passes.
- **Hand presets** (`presets.ts`, `handPresetSettings(id)`): each preset sets the whole hand-related set (Steadiness, gainOverride, dwell down/up, Latch, dwellRadius, tileHoverPx); anything a preset doesn't name returns to the default (gain null = calibrated), so switching presets is deterministic. Slow movements: dwell 1200 ms, pen-up 1800 (1.5×). Hard to hold still: `dwellRadius: 60` = r_in floor (so r_out = 120 and a resting hand must move > 120 units before dwell re-arms), `tileHoverPx: 40` (page-side), `tip` = the one-time text. `pipeline.action("preset_*")` applies it (Steadiness deferred to pen-up as always); B must also persist `handPresetSettings(id)` minus `tip` into its settings.
- **Extra settings keys** the pipeline reads through `setSettings` (beyond the `SteadySettings` contract): `dwellRadius`, `lockLandmark`, `dashPauseMs` (`tileHoverPx` is for the page).
- **Profiles** (`profiles.ts`): store `{version:1, active, profiles:[{name, settings, calibration?}]}` under `steady.profiles.v1` (`PROFILES_STORAGE_KEY`). Stored fields = tunables only (not camera id/mirror/rotate or Simulate tremor). "Steady day" = defaults, "Shaky day" = 70 + Latch. `findProfile` matches exact (case-insensitive), then a unique prefix ("shaky"), then a unique substring; ambiguous → null. `parseProfiles` never throws: invalid fields are dropped, nameless profiles skipped, built-ins re-added, unknown active → Steady day.
- **Re-baseline:** hand scale = diagonal of the bounding box of all landmarks (camera px), median over 2 s. The reference is taken automatically 2 s after start, after `setCalibration`, and after a landmark/lock change. Every 10 min the box scale becomes now/ref (5 % dead band, clamped 0.5–2), and the effective gain = base gain ÷ scale (box rescaled about its centre). Never mid-stroke: if due while drawing, it runs on the first frame after the lift. `action("rebaseline")` forces it after a fresh 2 s window (not an action-table row). `modeState(p).boxScale` reports it.
- **Head mode:** `headModeConfig()` = `{landmark: 1, lockLandmark: 1, gainOverride: 6}`; `action("head_mode", {variant:"on"|"off"})` (toggle without a variant) applies it or `handModeConfig()`. B's face source puts the face landmarks in `hands[0].landmarks` (score = face confidence or 1; handedness "Right"). The hand lock uses `landmarks[lockLandmark]` (the nose) instead of the wrist. Changing it lifts the pen, restarts the filter and warm-up, and resets the re-baseline.
- **Eyebrow pen-up:** `new EyebrowLift()` / `eyebrowLift()` returns true once per raise: `browInnerUp` above 0.5 for 150 ms continuously; re-arms only below 0.3; between 0.3 and 0.5 it holds its state. B then calls `pipeline.action("eyebrow_raise", t)`, which only lifts (reason `pen_key`; no "eyebrow" LiftReason) and does nothing when the pen is up.

### Agent B round 3 (P4 UI) — 15:45–15:53 PDT
- **Pages:** P4 adds 13 tiles, so the side panel now has **Steady, Modes, Setup, Input, Timing, Krita, Paint, Colour, View, Layers (+ Demo)** — 3 tab rows; header 488 px, page area 412 px at 320×900. The layout is explicit in `PAGE_LAYOUT` (Pages.tsx); every non-dialog action has exactly one tile (checked with a tsx script). Steady: Steadiness, the 4 hand presets (2 columns), Steadier/Looser/Hatch/Dots/Quiet/Clear practice. Modes: Sketch/Ink mode/Shade, Hatch variants, Stop hatching, Dash, Repeat stroke, Hatch lag, Dash pause. Setup: camera, Mirror/Rotate/Recalibrate, Use last setup/Draw in Krita/Save profile, Use profile + profile tiles (Steady day, Shaky day, user profiles; first 5). Input: Colour cap, Pick sticker colour, Lock exposure, Head mode, Eyebrow lift, Pointer point, Browser speech fallback (+ note), Dwell click/All dwell/Keys/Camera. Timing: 4 dwell/mic sliders. Krita: Mark corners, App: Krita|Photoshop, Gain. Paint and Colour use 4 columns (short labels). View: view tiles + Show/Hide/Click number + the numbers list. Heights computed, **not measured** (no Playwright this round): every page ≤ 396 px of content; Input with the Web Speech note on is the tightest (≈ 388 px).
- **Hand presets:** `handPresetSettings(id)` (minus `tip`) saved into settings + `pipeline.action(preset_*)`; the Hard-to-hold-still tip shows once (`steady.tipsShown.v1`). `tileHoverPx` widens the page hover-dwell hit test to the nearest enabled button within that many px. Latch mirror-sync now ignores the Worker for 1.5 s after a local change (a preset set Latch and the 33 ms-stale mirror flipped it back).
- **Profiles:** A's profiles.ts store under STORAGE_KEYS.profiles; typed "save profile <name>" / "profile <name>" / "use profile <name>" pre-parsed on the page (multi-word names); tiles use a profile; Use/Save without a name open a text field.
- **Numbers:** Show numbers → `krita list_widgets` → `numbers {items}` to the helper and a text list on View; `click_number n` → `click` at the rect centre, refused in the top 40 pt or outside `kritaWindowRect`; Hide numbers, Pause and a Krita window move send `numbers {items:null}`. A failed `numbers` ack (overlay_disabled / paused) keeps the panel list.
- **Head mode / Eyebrow lift:** MediaPipeSource runs a FaceLandmarker (float16, blendshapes) lazily when either is on. Head mode: face landmarks replace the hands in the frame (score 1, "Right") and the Worker applies `headModeConfig()` (back: `handModeConfig(landmark)`); Colour cap is suspended while Head mode is on. Eyebrow: `browInnerUp` → A's `EyebrowLift` → `pipeline.action("eyebrow_raise")` (lift only). Settings keys `headMode`, `eyebrowLift`, `appProfile` are B-side extras on the settings object (not in SteadySettings).
- **App profile:** C's `appMessageFor(action, app, opts)` for every Krita-scoped action; Photoshop status "Photoshop: shortcuts only. Restart the helper with: npm run helper -- --app photoshop".
- **Calibration** now calls `calibrator.recordHand(...)` next to `feed` (re-baseline reference). Re-baseline itself (every 10 min) is not wired yet.

### Agent A — safety round (review R #3, #8, #4), 2026-10-24 15:58 PDT
- R3: `setCalibration` now queues a `mode_change` lift (`up` goes out on the next `step()`/`tick()`, before any move through the new mapping; filter + warm-up restart; re-armed). New `setCalibrating(pipeline, on)` (exported from `pipeline.ts`/`index.ts`): while on, pen-down from every source (pen key, pedal, voice, dwell, Dots, Repeat) is refused, and a pen that is down is lifted on the next frame. **B must call it when the calibrator starts and when it ends/cancels.**
- R8: `clickZone` also requires `rects.usable` (helper visible frame) when present.
- R4 (my code, fixed too): `lower()` emits `move` to the exact down point before `down` when it differs from the last move (Hatch/Dash press at the pre-point, not the lazy pointer).
- Tests: `src/pipeline/safety.test.ts` (7). `npx vitest run src/pipeline`: 10 files / 129 tests.

### Agent B safety round (R1, R3, R4, R6, R7, R8, R9, ring) — 15:58–16:01 PDT
- **R1:** `source=replay`, `replay=`, `target=krita`, `helper=` and `privacy=pending` are read only when `NEXT_PUBLIC_STEADY_TEST === "1"`; a normal build always uses the camera, the default helper URL and the practice target (`demo=1` stays). The Worker gets `helperUrl: null` in `init` until the first-run privacy card's "Got it" is persisted; then the page posts the page-local action `connect_helper` (variant = URL). Test builds treat privacy as acknowledged unless `?privacy=pending` (so F/H can test the gate). On a narrow strip the privacy card floats over the panel (fixed, bottom) so it is reachable.
- **R3:** `setCalibrating(pipeline, true|false)` at calibration start / finish / `use_calibration` cancel (replaces B's old "dwell off while calibrating" hack).
- **R4:** the Worker sends `move {x,y}` of the event immediately before every `down` / `middle_down`.
- **R6/H5:** on `hello`, a helper `paused` that differs from the Worker's is reconciled with `pause`/`resume`. A helper `error` `paused` / `permission` (a refused `down`) force-lifts the Worker pen (A's `force_lift`, reason "socket") and raises a persistent alert ("Helper is paused: press Resume (F9)…" / "Krita isn't receiving the pen: grant Accessibility…"). Alerts now persist on the page until the Worker clears them (empty alert) — routine status never hides an alert; cleared on Resume, on a hello with both permissions, and on tracking re-acquire (lost alerts only).
- **R7:** `released {reason}` force-lifts the Worker pen; if a stroke was in progress, role="alert" "Pen released: <reason>".
- **R8:** `hello.visible_frame` → `rects.usable`; the Worker never sends `click` outside it (or above y 40 when unknown); numbered clicks check it too.
- **R9:** page zoom = `devicePixelRatio / hello.screen.scale` (fallback base 2 when dpr ≥ 1.5, else 1); `outerWidth/innerWidth` is wrong with side panels/DevTools and `visualViewport.scale` is pinch zoom. `window_rect` = viewport in screen points (`innerWidth × zoom`, `screenY + outerHeight − innerHeight × zoom`) plus `zoom`; the Worker scales CSS px → points for practice-target clicks and divides for the canvas-target viewport; the overlay converts back with the same zoom.
- **Ring:** the Worker sends `ring {state, progress, x, y}` from the 30 Hz mirror tick, only on change; `hidden` when paused, on the practice target or with no pointer; `lost` / `drawing` / `outside` (click zone or gated) / `hover`.
- Untested in a browser (no Playwright this round): tsc clean; a test-flag dev server serves the replay page (200).

## Contract change requests
- **F → lead (target selection in tests):** the P1 Playwright tests need the Worker to target Krita (send `move`/`down`/`up` to the helper) without real Krita. Request either a URL param `?target=krita` (tests already append it) or `SteadyTestHooks.setTarget(target: Target): void`. Without one of these, "page sends move/down/up in order" can only pass if the page targets Krita automatically when the helper connects.
- **F → lead/C (fake helper canvas rect):** add `POST /config {"canvas_rect": {x,y,w,h}}` to the fake helper so `krita {cmd:"canvas_rect"}` replies `{ok:true, rect}`; ink is rect-gated, so without a canvas rect no `down` can be sent in tests. Tests already send it (and tolerate a non-2xx reply).
- **F → lead (nice to have):** `SteadyTestHooks.windowRect(): Rect | null` returning the last rect the page reported to the Worker, so tests convert `click {x,y}` screen points with exactly the Worker's numbers.
- 14:36 lead: merged D's action-table requests (delete_layer lookup 'remove layer'; clear_layer fallback 'backspace' — Krita 5.3.4 binds Clear to Backspace on macOS).
- **C → lead (keymap):** §4 says keys are remappable in Settings, but the helper is the key source while connected and has no way to learn the map. Request Worker→helper `keymap {map: Record<keyCombo, HotkeyName>}` (helper replies `ack`). Until then the helper uses F3–F10 only.
- **C → lead (warnings):** request helper→Worker `warning {code: "conflicting_accessibility"|"tablet"|..., message}` so the startup warnings (Dwell Control, Head Pointer, Voice Control, tablet driver) reach Steady's status line; today they are console-only.
- **C → lead (ack error codes):** `ack.error` values used by the helper beyond PROTOCOL.md: `krita_not_frontmost`, `bad_combo`, `permission` (keys); `krita_reply.error` adds `timeout` and `internal: …`. Please list them in PROTOCOL.md.
- **A → lead (deviation semantics):** `MirrorState.deviationPx` comment says "raw vs smoothed"; A implements the shake surviving smoothing (see Agent A) so it drops with Steadiness. Please reword the comment (and F's README formula) or tell A to switch.
- **A → lead (alias action):** grammar returns `{action:"alias", variant:<preset name>}` for user aliases (P2b); there is no `alias` row in `actions.ts`. Request a row (`id:"alias"`, typed `alias <word>`, voice "call this brush …") or bless the id as grammar-only.
- **A → lead (undo count):** `ParsedCommand.arg` carries the repeat count for coalesced undo/redo; document it in `types.ts` next to `ParsedCommand`.
- **A → lead (additive, no edit made):** `createPipeline(config, opts?: { phase?: Phase })` — optional second arg for phase-gated behaviour (Krita-window dwell-click from P2a), default `BUILD_PHASE`.
- 14:40 lead: added helper→Worker `warning` message (C request 2) and documented extra error strings (C request 3). Keymap message (C request 1) deferred to P2b: helper uses F3–F10 defaults; page-side remap applies only without helper.
- 14:41 lead resolutions: F target → both `?target=krita` and `SteadyTestHooks.setTarget()`; `SteadyTestHooks.windowRect()` added. A deviation semantics accepted (types.ts comment reworded; F to match README formula). A alias → blessed as grammar-only id `alias` (tile "Name this brush" lands with P2b aliases). A undo count + createPipeline opts documented in types.ts. F/C fake-helper canvas_rect config already done by C.
- **B → lead (sent log):** `WorkerToPage` has no message for "what the Worker sent to the helper", so `__steady.sentToHelper()` is fed by a `BroadcastChannel("steady-sent-to-helper")` (src/tracking/sentChannel.ts). Optional: add `{type:"sent", msg}` to `WorkerToPage` and B switches.
- **B → lead (action rows, optional):** non-action tiles exist for settings: "Mirror camera", "Rotate camera", "Next camera", "Next point", "Use last setup", "Draw in Krita", "Mark corners", "Dwell click", "All dwell", "Keys", "Camera". Rule 4 wants voice/typed paths for actions; if wanted, add rows (e.g. `draw_in_krita` / `practice`, `mark_corners`, `use_last_setup`) and B will wire them.
- (F, 14:55) Contract requests above resolved by lead/B/C: `?target=krita`, `__steady.setTarget()`, `__steady.windowRect()`, fake helper `canvas_rect` config and `--origin`. Tests switch target via the real Setup › "Draw in Krita" tile and convert screen↔client with `__steady.windowRect()` (the viewport rect the Worker uses). README deviation formula changed to the lead's definition (RMS of the drawn path from its own ±100 ms moving average over 3 s).
- (F) Ports: port 3000 may be held by another workspace's Next server. `playwright.config.ts` reuses THIS checkout's own `next dev` (found via lsof cwd), else uses `STEADY_PORT`/`BASE_URL`, else 3000 if free, else 3100; when not on :3000 the fake helper runs on 28765/28767 with `--origin <app origin>`. `demo-check.sh` applies the same 3000→3100 rule.
- (F) Practice-canvas Playwright tests run at 1280×900: in the 320 px strip the practice canvas stacks below the fold (the strip is the Krita layout). Page-fit tests stay at 320×900 and assert the page container ([data-page]) only; the document itself scrolls because the camera/canvas stack below the panel.
- (F) Fixture motion that must NOT dwell is ≥ 150 camera px/s (circling): with r_in = 15 target units and gain 2, anything slower than ~60 camera px/s counts as still within 250 ms and lowers the pen (seen in the first run: a 40 px/s drift re-lowered the pen). Krita-target tests prepend a 6–9 s circling lead-in (`serveWithLead`) so the target switch happens before the fixture's hold.

- (F) 2026-10-24 14:56 PDT — `scripts/demo-check.sh P1` (BUILD_PHASE = P0 at the time; tsc/vitest/pytest PASS; Playwright 1 failure). Output:
```
================ definition of done ================
PASS        step: typecheck
PASS        step: vitest
PASS        step: pytest
FAIL        step: playwright  — exit 1

--- P0 ---
PASS        Pointer cursor on Steady's practice canvas (ReplaySource)  — 1 test(s)
PASS        Hold still to start drawing (pen-down dwell)  — 19 test(s)
PASS        Draws a stroke (a word shape) on the practice canvas  — 1 test(s)
PASS        Hold still to stop (pen-up dwell; slow stroke never lifts)  — 7 test(s)
PASS        A resting hand toggles the pen at most once  — 1 test(s)
PASS        The Undo key undoes  — 1 test(s)
PASS        Steadiness slider and its ± tiles change the result  — 5 test(s)
PASS        Calibration steps 1–2 complete  — 1 test(s)
PASS        Each P0 page fits 320×900 at 100 % (Steady, Setup, Timing)  — 3 test(s)
PASS        axe report produced at 100 % and 200 % (hard gate only with AXE_GATE=1)  — 2 test(s)
PASS        Pipeline acceptance targets + every @P0 Vitest  — 52 test(s)
NEEDS HUMAN Real webcam: within 60 s of npm run dev a resting hand moves the cursor (knuckle landmark)  — see NEEDS-HUMAN.md
NEEDS HUMAN Real webcam: a person writes a legible word and the Steadiness change is visible  — see NEEDS-HUMAN.md

--- P1 ---
FAIL        Demo page: Simulate tremor, metrics, Next judge  — playwright:fail:P1 without a helper › @P1 Demo page shows metrics
PASS        Worker sends move/down/up to the helper in order (stroke reaches the helper)  — 1 test(s)
PASS        Covering the camera mid-stroke ends the stroke with no scribble (score-0.5 replay)  — 8 test(s)
PASS        Helper releases the button (watchdog 300 ms, socket close, exception) — fake mouse  — 7 test(s)
PASS        F9 releases everything; helper is the single key source (page ignores F-keys)  — 30 test(s)
PASS        Resume tile reachable by dwell (click inside Chrome's rect, no self-trigger)  — 1 test(s)
PASS        Every @P1 Vitest (mapping, clamp, rect gating, hand lock, protocol round-trip)  — 143 test(s)
PASS        Every @P1 pytest (helper §5)  — 180 test(s)
NEEDS HUMAN Real Krita: the same resting hand paints a stroke in Krita via the helper  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Krita: covering the camera mid-stroke ends the Krita stroke cleanly  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Mac: F9 pauses and the Resume tile works by dwell with Krita focused  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Mac: Chrome strip beside Krita keeps the fps counter running while Krita is focused  — see NEEDS-HUMAN.md

totals (tags ≤ P1): 391 passed, 1 failed, 0 skipped (vitest+pytest+playwright)

demo-check P1: FAIL (2 item(s))
```
  Only FAIL: Demo page — "Simulate tremor"/"Next judge" tiles render disabled because BUILD_PHASE is P0 (their tilePhase is P1); passes once the lead bumps BUILD_PHASE to P1. P2a run separately: typed "blue" → krita color message PASS, keys inert in typed box PASS, P2a pages fit PASS; typed "steadier" FAIL (status shows "Heard: steadier" but Steadiness stays 50: the grammar excludes P2a rows at BUILD_PHASE P0).
  axe: 0 violations at 100 %. At 200 % (160×450 CSS px) axe itself is clean but F's pinned-header check fails on every page: after scrolling to the bottom the page tabs leave the viewport. **B:** make the panel header `position: sticky; top: 0` (or scroll only the page container) so the header stays pinned at 200 % (§0 rule 6). Not gated until AXE_GATE=1.

### P0 gate — 2026-10-24 14:57 PDT
```
================ definition of done ================
PASS        step: typecheck
PASS        step: vitest
PASS        step: pytest
PASS        step: playwright

--- P0 ---
PASS        Pointer cursor on Steady's practice canvas (ReplaySource)  — 1 test(s)
PASS        Hold still to start drawing (pen-down dwell)  — 11 test(s)
PASS        Draws a stroke (a word shape) on the practice canvas  — 1 test(s)
PASS        Hold still to stop (pen-up dwell; slow stroke never lifts)  — 7 test(s)
PASS        A resting hand toggles the pen at most once  — 1 test(s)
PASS        The Undo key undoes  — 1 test(s)
PASS        Steadiness slider and its ± tiles change the result  — 5 test(s)
PASS        Calibration steps 1–2 complete  — 1 test(s)
PASS        Each P0 page fits 320×900 at 100 % (Steady, Setup, Timing)  — 3 test(s)
PASS        axe report produced at 100 % and 200 % (hard gate only with AXE_GATE=1)  — 2 test(s)
PASS        Pipeline acceptance targets + every @P0 Vitest  — 52 test(s)
NEEDS HUMAN Real webcam: within 60 s of npm run dev a resting hand moves the cursor (knuckle landmark)  — see NEEDS-HUMAN.md
NEEDS HUMAN Real webcam: a person writes a legible word and the Steadiness change is visible  — see NEEDS-HUMAN.md

totals (tags ≤ P0): 62 passed, 0 failed, 0 skipped (vitest+pytest+playwright)

demo-check P0: PASS
```

### P1 gate — 2026-10-24 15:00 PDT
```
================ definition of done ================
PASS        step: typecheck
PASS        step: vitest
PASS        step: pytest
PASS        step: playwright

--- P0 ---
PASS        Pointer cursor on Steady's practice canvas (ReplaySource)  — 1 test(s)
PASS        Hold still to start drawing (pen-down dwell)  — 19 test(s)
PASS        Draws a stroke (a word shape) on the practice canvas  — 1 test(s)
PASS        Hold still to stop (pen-up dwell; slow stroke never lifts)  — 7 test(s)
PASS        A resting hand toggles the pen at most once  — 1 test(s)
PASS        The Undo key undoes  — 1 test(s)
PASS        Steadiness slider and its ± tiles change the result  — 5 test(s)
PASS        Calibration steps 1–2 complete  — 1 test(s)
PASS        Each P0 page fits 320×900 at 100 % (Steady, Setup, Timing)  — 3 test(s)
PASS        axe report produced at 100 % and 200 % (hard gate only with AXE_GATE=1)  — 2 test(s)
PASS        Pipeline acceptance targets + every @P0 Vitest  — 52 test(s)
NEEDS HUMAN Real webcam: within 60 s of npm run dev a resting hand moves the cursor (knuckle landmark)  — see NEEDS-HUMAN.md
NEEDS HUMAN Real webcam: a person writes a legible word and the Steadiness change is visible  — see NEEDS-HUMAN.md

--- P1 ---
PASS        Demo page: Simulate tremor, metrics, Next judge  — 2 test(s)
PASS        Worker sends move/down/up to the helper in order (stroke reaches the helper)  — 1 test(s)
PASS        Covering the camera mid-stroke ends the stroke with no scribble (score-0.5 replay)  — 8 test(s)
PASS        Helper releases the button (watchdog 300 ms, socket close, exception) — fake mouse  — 7 test(s)
PASS        F9 releases everything; helper is the single key source (page ignores F-keys)  — 30 test(s)
PASS        Resume tile reachable by dwell (click inside Chrome's rect, no self-trigger)  — 1 test(s)
PASS        Every @P1 Vitest (mapping, clamp, rect gating, hand lock, protocol round-trip)  — 143 test(s)
PASS        Every @P1 pytest (helper §5)  — 180 test(s)
NEEDS HUMAN Real Krita: the same resting hand paints a stroke in Krita via the helper  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Krita: covering the camera mid-stroke ends the Krita stroke cleanly  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Mac: F9 pauses and the Resume tile works by dwell with Krita focused  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Mac: Chrome strip beside Krita keeps the fps counter running while Krita is focused  — see NEEDS-HUMAN.md

totals (tags ≤ P1): 392 passed, 0 failed, 0 skipped (vitest+pytest+playwright)

demo-check P1: PASS
```
- 15:04 lead: P2a check = 560 passed / 1 failed (typed steadier). Added contract: Worker→helper `keymap` (C request 1, P2b) and action row `name_brush` (voice 'call this brush <word>', typed 'alias <word>', arg 'word'). Launching round 2.

### Agent F (round 2)
- 2026-10-24 15:05 PDT — round 2 start: @P2b/@P3 Playwright, demo-check P2b/P3 items, README/demo-video updates.
- **Hook request (F → lead/B):** `SteadyTestHooks.advanceSessionClock(ms: number): void` — advances the session clock the break nudge reads (test-only), so `@P2b break nudge` doesn't wait 20 min. The test fails with "MISSING HOOK" until it exists. The nudge is expected as a non-modal element with a "Later" tile and the elapsed session time (contains "20").
- @P2b alias test expects aliases persisted under `localStorage["steady.aliases.v1"]` (STORAGE_KEYS.aliases), the refusal status text "That word is taken", and typed "fluffy" to send `krita {cmd:"preset"}`. Delete-layer test confirms via `__steady.typed("yes")` (the typed-command path; the focus trap keeps the typed box unreachable while the dialog is open) and expects some `krita`/`keys` message other than the session lookups.
- 15:09 lead: Web Speech fallback is OPT-IN (SteadySettings.webSpeechFallback=false, MicTileProps.allowWebSpeech). Rule-9 first-run text stays verbatim; when the user turns the setting on, the Setup page shows: 'With this on, if Cartesia is unavailable your microphone audio goes to Google (Chrome's speech recognition) while the mic is open.'
- **A → lead (round 2, all optional; worked around):** (1) `PenEvent` middle button for pan: add `button?: "middle"` to `down`/`move`/`up` (today: `panState(p).batchIsPan`). (2) `LiftReason` "repeat" for the end of a Repeat stamp (today "pen_key"). (3) `SteadySettings.dashPauseMs` (100–600, default 200; the pipeline already reads it if present). (4) `ParseResult` nomatch: optional `refused?: {reason:"alias_taken", word}` so `isAliasRefusal` isn't needed. (5) Optional `Pipeline.modeState?(): ModeState` so B gets it typed without the `modeState(p)` helper.
- 15:12 lead: accepted A requests 3 (settings.dashPauseMs) and 4 (ParseResult nomatch.refused); 1, 2, 5 stay as A's helper functions (panState/modeState) — no contract change.

### Agent G (P3: ColorCapSource, self-hosted MediaPipe assets, exposure lock) — 2026-10-24 15:05–15:15 PDT
- **ColorCapSource** (`src/tracking/ColorCapSource.ts`, pure core `colorCap.ts`): drop-in for MediaPipeSource (same `(events)` constructor + optional `{ range, handedness, minArea, solidArea }`; same `attach(readable)` / `pushBitmap(bitmap)` / `fps()` / `cameraFps()`; closes every frame). The browser downsamples each frame into a 160×120 OffscreenCanvas; the detector runs HSV mask → 4-connected components → largest blob. `start()` calls `onDelegate("CPU")` so B's existing `ready` path works unchanged.
- Default target: neon green, H 75–165°, S ≥ 0.45, V ≥ 0.35 (green is rare on desks and skin; red would collide with skin/wood). Ranges with hMin > hMax wrap through 0° for red stickers.
- Confidence: below minArea (6 cells at 160×120 ≈ a 10 px-wide sticker at 640×480) → `0.59 × area/minArea`; otherwise `0.6 + 0.39 × (0.6·size + 0.4·fill) × (0.2 + 0.8·colour)` (size saturates at 30 cells, fill = area/bbox, colour = (meanS − sMin)/0.3). So a vivid solid sticker ≥ 0.75 (Tracking), a washed-out one stays 0.6–0.75 (Weak) at any size, scattered same-colour noise (fill < 0.2) < 0.6.
- Frame: no candidate → `hands: []` (reason "no hand"); a sub-threshold candidate → one hand with score < 0.6 (pipeline ignores it). All 21 landmarks at the centroid so any landmark setting and the wrist-based hand lock work.
- "Pick colour from centre": saturation×value-weighted circular-mean hue ± max(12°, 2.5 × spread) capped ±40°; sMin/vMin = 0.6 × 10th percentile, floored 0.25/0.2; refuses grey/dark centres ("Not a bright colour…").
- **Assets**: `scripts/fetch-mediapipe.sh` copies all six `vision_wasm_*` files (tasks-vision 1.1.1, FilesetResolver picks simd/nosimd × classic/module at runtime) and downloads `hand_landmarker.task` float16 (7,819,105 bytes, sha256 fbc2a300…cde1). public/mediapipe totals 46 MB (wasm ≈ 40 MB: 3 × ~13 MB). `resolveAssets(fetch, origin)` HEAD-checks `/mediapipe/wasm/vision_wasm_internal.wasm` and `/mediapipe/hand_landmarker.task` (3 s timeout; an HTML 200 counts as missing) and falls back per asset to jsDelivr / Google storage.
- **Exposure**: `lockExposure` / `unlockExposure` check `getCapabilities().exposureMode` for "manual"/"continuous", apply via `advanced`, then trust `getSettings().exposureMode` when present (a camera that silently ignores the constraint reports "This camera can't lock exposure"). Never throw.
- Tests: 28 Vitest, all `@P3` (colorCap 17, exposure 5, assets 6 — includes on-disk check of public/mediapipe that skips when not fetched). `npx tsc --noEmit` clean.
- Action-table request (lead): optional rows `lock_exposure` ("lock exposure") and `pick_sticker_colour` ("pick sticker colour"), scope canvas, phase P3 — only if B wires them to tiles.
- 15:13 lead: public/mediapipe/ (46 MB: 40 MB wasm + 7.8 MB model) is gitignored; `npm run assets` fetches it; resolveAssets falls back to the CDN when absent. Added rows pick_sticker_colour, lock_exposure (P3, Setup).
- **B → lead (round 2, optional):** `MicTileProps.aliases?: Record<string,string>` so voice aliases go through the grammar like typed ones (B currently matches a no-match transcript against the alias map). `SteadySettings.trackSource: "hand"|"colorcap"` and a `colorCapRange` field would let the source choice and sticker range persist through the normal settings path (B uses `steady.trackSource.v1` and the page-local action `set_source`).

### P2a gate — 2026-10-24 15:25 PDT (run by agent B, 2nd run; 1st run had 2 flaky failures that passed in isolation — likely concurrent Playwright runs sharing test-results/ and the fake helper)
```
totals (tags ≤ P2a): 564 passed, 0 failed, 0 skipped (vitest+pytest+playwright)
demo-check P2a: PASS
```
- 15:25 lead: BUILD_PHASE → P2b. Added settings.trackingSource, settings.stickerRange, MicTileProps.aliases (B requests).
- 15:26 B: tracking source and sticker range now live in `SteadySettings.trackingSource` / `stickerRange` (page-local `set_source` action and `steady.trackSource.v1` removed). The Worker switches source on a `settings` change and reports a picked range on `BroadcastChannel("steady-worker-events")` (WorkerToPage has no message for it); the page saves it into settings. `aliases` is passed to `<MicTile>`; E's MicTile does not forward it to resolveText yet, so B's page-side alias match after a voice no-match stays as the fallback.
- (F, 15:36) Hook request `advanceSessionClock` withdrawn: the break-nudge test uses Playwright's `page.clock.install()` + `fastForward(20 min)` (page-side Date/timers; the replay Worker is unaffected) and uses the hook only if one appears. Playwright artifacts and the fake helper are now per-run in demo-check.sh (private `PW_OUTPUT_DIR` and free ports), so concurrent runs can't reset each other's fake helper or delete each other's traces.
- (F) 2026-10-24 15:39 PDT — `scripts/demo-check.sh P2a`: **PASS** (564 passed, 0 failed, 0 skipped; axe 0 violations at 100 % and 200 %, header pinned). `scripts/demo-check.sh P2b` (BUILD_PHASE P2b): **PASS** (606 passed, 0 failed, 0 skipped). P2b section:
```
--- P2b ---
PASS        Hatch tile toggles Hatch; status "Hatch: forward passes only"  — 1 test(s)
PASS        Hatch/Dots pipeline (forward passes only, look-ahead buffer, stationary hand never inks)  — 8 test(s)
PASS        Quiet mode turns the mic (and TTS, earcons) off  — 1 test(s)
PASS        Aliases: "alias fluffy" stored; a colliding alias is refused ("That word is taken")  — 13 test(s)
PASS        Destructive confirm: alertdialog, focus on Cancel, Esc cancels, typed "yes" confirms  — 1 test(s)
PASS        Break nudge after 20 min, non-blocking, "Later" dismisses  — 1 test(s)
PASS        Every @P2b Vitest  — 26 test(s)
PASS        Every @P2b Playwright  — 5 test(s)
NEEDS HUMAN Real Krita: Hatch over the parallel ruler inks forward passes only  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Mac: Sonic TTS speaks "Saved"/"New layer" and never while the mic is open  — see NEEDS-HUMAN.md
NEEDS HUMAN Real mic: "call this brush fluffy", then "fluffy" selects that preset in Krita  — see NEEDS-HUMAN.md

totals (tags ≤ P2b): 606 passed, 0 failed, 0 skipped (vitest+pytest+playwright)

demo-check P2b: PASS
```
  @P3 (not in either gate): Sketch/Ink mode/Shade test fails only because those tiles render disabled at BUILD_PHASE P2b.
- 15:40 lead: P2b gate PASS (606/0, run by F at 15:39). BUILD_PHASE → P3.

### P3 gate — 2026-10-24 15:43 PDT
```
================ definition of done ================
PASS        step: typecheck
PASS        step: vitest
PASS        step: pytest
PASS        step: playwright

--- P0 ---
PASS        Pointer cursor on Steady's practice canvas (ReplaySource)  — 1 test(s)
PASS        Hold still to start drawing (pen-down dwell)  — 23 test(s)
PASS        Draws a stroke (a word shape) on the practice canvas  — 1 test(s)
PASS        Hold still to stop (pen-up dwell; slow stroke never lifts)  — 8 test(s)
PASS        A resting hand toggles the pen at most once  — 1 test(s)
PASS        The Undo key undoes  — 1 test(s)
PASS        Steadiness slider and its ± tiles change the result  — 5 test(s)
PASS        Calibration steps 1–2 complete  — 1 test(s)
PASS        Each P0 page fits 320×900 at 100 % (Steady, Setup, Timing)  — 3 test(s)
PASS        axe report produced at 100 % and 200 % (hard gate only with AXE_GATE=1)  — 2 test(s)
PASS        Pipeline acceptance targets + every @P0 Vitest  — 52 test(s)
NEEDS HUMAN Real webcam: within 60 s of npm run dev a resting hand moves the cursor (knuckle landmark)  — see NEEDS-HUMAN.md
NEEDS HUMAN Real webcam: a person writes a legible word and the Steadiness change is visible  — see NEEDS-HUMAN.md

--- P1 ---
PASS        Demo page: Simulate tremor, metrics, Next judge  — 2 test(s)
PASS        Worker sends move/down/up to the helper in order (stroke reaches the helper)  — 1 test(s)
PASS        Covering the camera mid-stroke ends the stroke with no scribble (score-0.5 replay)  — 9 test(s)
PASS        Helper releases the button (watchdog 300 ms, socket close, exception) — fake mouse  — 9 test(s)
PASS        F9 releases everything; helper is the single key source (page ignores F-keys)  — 35 test(s)
PASS        Resume tile reachable by dwell (click inside Chrome's rect, no self-trigger)  — 1 test(s)
PASS        Every @P1 Vitest (mapping, clamp, rect gating, hand lock, protocol round-trip)  — 145 test(s)
PASS        Every @P1 pytest (helper §5)  — 292 test(s)
NEEDS HUMAN Real Krita: the same resting hand paints a stroke in Krita via the helper  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Krita: covering the camera mid-stroke ends the Krita stroke cleanly  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Mac: F9 pauses and the Resume tile works by dwell with Krita focused  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Mac: Chrome strip beside Krita keeps the fps counter running while Krita is focused  — see NEEDS-HUMAN.md

--- P2a ---
PASS        Typed "steadier" moves the slider  — 1 test(s)
PASS        Typed "blue" produces a krita message  — 1 test(s)
PASS        Keys do nothing inside the typed box  — 1 test(s)
PASS        P2a pages fit 320×900 (Paint, Colour, View, Layers)  — 4 test(s)
PASS        Grammar, keyterms, zod, Claude log (every @P2a Vitest)  — 84 test(s)
PASS        Krita plugin dispatcher (every @P2a pytest)  — 292 test(s)
NEEDS HUMAN Real Krita 5.3.x: plugin loads, "blue" changes the colour, F5/F6 no longer open popups  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Krita: dwell-click hits an enlarged toolbox button  — see NEEDS-HUMAN.md
NEEDS HUMAN Real mic + keys: Cartesia Ink 2 hears "blue", "bigger", "undo that"; Claude moment works  — see NEEDS-HUMAN.md

--- P2b ---
PASS        Hatch tile toggles Hatch; status "Hatch: forward passes only"  — 1 test(s)
PASS        Hatch/Dots pipeline (forward passes only, look-ahead buffer, stationary hand never inks)  — 8 test(s)
PASS        Quiet mode turns the mic (and TTS, earcons) off  — 1 test(s)
PASS        Aliases: "alias fluffy" stored; a colliding alias is refused ("That word is taken")  — 13 test(s)
PASS        Destructive confirm: alertdialog, focus on Cancel, Esc cancels, typed "yes" confirms  — 1 test(s)
PASS        Break nudge after 20 min, non-blocking, "Later" dismisses  — 1 test(s)
PASS        Every @P2b Vitest  — 26 test(s)
PASS        Every @P2b Playwright  — 5 test(s)
NEEDS HUMAN Real Krita: Hatch over the parallel ruler inks forward passes only  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Mac: Sonic TTS speaks "Saved"/"New layer" and never while the mic is open  — see NEEDS-HUMAN.md
NEEDS HUMAN Real mic: "call this brush fluffy", then "fluffy" selects that preset in Krita  — see NEEDS-HUMAN.md

--- P3 ---
PASS        Sketch / Ink mode / Shade tiles set Steadiness 25 / 70 / 10  — 1 test(s)
PASS        Dash / Repeat / pan / pick pipeline  — 16 test(s)
PASS        Every @P3 Vitest  — 45 test(s)
PASS        Every @P3 Playwright  — 1 test(s)
PASS        Every @P3 pytest (ring overlay, middle-button pan, keymap)  — 292 test(s)
NEEDS HUMAN Real Mac: ring overlay visible over Krita; Krita's brush outline still shows through it  — see NEEDS-HUMAN.md
NEEDS HUMAN Real hand in a glove/brace: Colour cap sticker is tracked and paints  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Mac: self-hosted MediaPipe assets load with the network off  — see NEEDS-HUMAN.md

totals (tags ≤ P3): 674 passed, 0 failed, 0 skipped (vitest+pytest+playwright)

demo-check P3: PASS
```
- 15:44 lead: strict axe gate (AXE_GATE=1) PASS at 100 %/200 %. P4 contracts added: Worker→helper `numbers`, plugin `list_widgets`, 12 P4 action rows (4 hand presets with exact §2 names, use/save profile, show/hide numbers, click <n>, head mode, eyebrow lift, app profile). Python suites fail on the new examples until C/D implement them (round 3). Launching round 3 (P4) + integration agent H + safety reviewer R.
- (F, 15:47) NEEDS-HUMAN.md restructured once (lead's permission): a single prioritised list (Desk View, Krita from the helper, keys, permissions, conflicts, plugin, Chrome-beside-Krita, then the real-hardware checklist by phase, then submission). Every agent's items were kept and deduplicated; each carries [agent] tags. Snapshot of the previous version: compare with git history.
- **A → lead (round 3, optional; worked around):** (1) add `dwellRadius?`, `tileHoverPx?`, `lockLandmark?`, `dashPauseMs?` to `SteadySettings` (the pipeline already reads them; today B passes them as extra keys). (2) `STORAGE_KEYS.profiles = "steady.profiles.v1"` (exported today as `PROFILES_STORAGE_KEY` from `src/pipeline/profiles.ts`). (3) `LiftReason` "eyebrow" (today `pen_key`). (4) `Calibration.handScale?` so re-baseline can persist its reference across reloads (today it re-measures 2 s after start).
- **C → lead (pytest.ini):** please register the `P4` marker (`P4: phase P4`); the @P4 helper tests run but print PytestUnknownMarkWarning.
- **C → lead (optional, later):** per-message `app` on `keys`/`krita` (or a `set_app {app}` message) would let the page switch apps without restarting the helper; today it is the `--app` flag.

### Agent F (round 3)
- 2026-10-24 15:45 PDT — round 3 start. `tests/e2e/p4.spec.ts` (@P4): hand presets (Steadiness/gain/Latch from `state()`, pen-down dwell from `localStorage["steady.settings.v1"].dwellDownMs`, tip text mentions the pedal), profile save/use round-trip ("save profile evening" / "profile evening"; "Steady day"/"Shaky day" visible on Setup), Show numbers → helper `numbers {items}` and "click 1" → `click` at the item centre (the fake helper answers `list_widgets` through its existing `POST /config {"payloads": {"list_widgets": {"widgets": [...]}}}` — no change to fake_helper.py needed), app profile "photoshop mode" → typed "undo" sends `keys cmd+z` and no `krita action` (Krita target), "krita mode" restores the plugin path. demo-check.sh accepts P4/4 with P4 DoD + NEEDS HUMAN items.
- At BUILD_PHASE P3 all four @P4 tests fail as expected (P4 tiles disabled; "save profile"/"photoshop mode" not in the grammar yet).
- README final pass: `npm run assets`, port 3000 / `--origin` / `STEADY_ORIGIN`, opt-in Web Speech (Setup › "Browser speech fallback", exact status text), P4 features (hand presets, profiles, re-baseline, head mode, eyebrow lift, numbers, app profile) with TODO markers for everything not real-tested. human-setup.md and pitch.md updated to match.
- 15:49 lead: accepted A's P4 requests (settings dwellRadius/tileHoverPx/lockLandmark, STORAGE_KEYS.profiles, LiftReason 'eyebrow', Calibration.handScale).
- 15:50 lead: badge size — accept C's choice (never larger than the widget rect; shrink to fit, min 10 pt); krita-setup.md already says enlarge toolbox icons. P4 pytest marker registered in pytest.ini.

- **B → lead (round 3, optional):** add `headMode`, `eyebrowLift`, `appProfile` to SteadySettings (B stores them as extra keys today). F: page names changed (Modes, Input, Krita added; Gain/Mark corners now on Krita, input toggles + Pointer point on Input, Hatch lag/Dash pause on Modes); Draw in Krita, Use last setup, Hatch, Quiet, Show numbers and the presets stay where p2b/p4 specs look for them.
- 15:53 lead: BUILD_PHASE → P4; SteadySettings gains optional headMode/eyebrowLift/appProfile (B request).

### Agent H (round 3: integration, real helper process) — 2026-10-24 15:45–15:54 PDT
- **What runs for real:** `steadyhelper.main.main` (CLI, Origin check, WebSocket server, KritaRelay, watchdog, Pointer, MacSystem reads) as a subprocess; the plugin's `bridge.py` + `dispatch.py` (FakeAdapter, GUI queue drained by a plain thread); the Next page + Worker + helperClient in Chromium. Files: `tests/integration/**`, `scripts/integration-check.sh`.
- **Sealed launcher instead of `helper/steady_helper.py`:** `tests/integration/safe_helper.py` patches, in its own process only, `Quartz.CGEventPost*`/`CGWarpMouseCursorPosition`, `QuartzKeyPoster`, `MacSystem.activate_krita`, `hotkeys.start_listener` and the permission checks (non-prompting preflights), and refuses to start without `--no-pointer --no-hotkeys --no-overlay`. Reason: `--no-pointer` does NOT stop key posting or Krita activation (safety gap 1 below), and the startup permission checks can open macOS dialogs. Any attempt is logged `INTEGRATION-BLOCKED …`; tests fail on it. Runs so far: 0 attempts.
- **Watchdog observability:** in `--no-pointer` mode `down` is answered `error code:"permission" which:"accessibility"` and nothing is pressed, so the watchdog has nothing to release. The shim's `STEADY_SHIM_FAKE_POINTER=1` enables the Pointer over a stderr-logging fake mouse (still no CGEventPost) to observe `released button (watchdog: no message for 300 ms)`, `(socket closed)` and `(signal 15)` from the real process.
- **Bridge.stop() keeps live connections open** (socketserver `shutdown()` only stops accepting). The harness closes accepted sockets itself to simulate Krita quitting. In real Krita, process exit closes them; but disabling the plugin or closing the window without exiting leaves the helper believing `krita:true` until the next request times out.
- **Safety gaps found (helper; not patched, owner C):**
  1. `--no-pointer` only swaps the mouse backend. `_serve` always builds a real `QuartzKeyPoster()` and `MacSystem()`. So `keys {combo}` and `krita {…, fallback_keys}` with the plugin down still call `activate_krita()` (brings Krita to the front) and post real CGEvent keystrokes whenever Accessibility is granted and Krita is running. Nothing blocks this today except a missing Accessibility grant. Suggested fix: `--no-pointer` (or a new `--no-keys`) → `FakeKeyPoster` + no activation.
  2. `check_permissions()` always calls `AXIsProcessTrustedWithOptions(prompt=True)` and `CGRequestListenEventAccess()`, even with `--no-pointer --no-hotkeys`. Each launch can open macOS permission dialogs. Suggested fix: use preflight-only checks when both flags are set.
  3. Ports: the WebSocket port (`--port`) and the plugin port (`--plugin-port`) can be overridden; the plugin host is fixed at 127.0.0.1, which is fine. The plugin's own port 8766 is a constant in `bridge.py`/`__init__.py`, so a real Krita cannot be moved off 8766.
- **Page finding (not a failure):** with the real pointer-less helper, the page still enters `DRAWING` on dwell even though the helper refused `down`. The connect-time permission status is later overwritten (e.g. "Pen lifted: tracking lost mid-stroke."). If a user has no Accessibility grant, the page shows them drawing while nothing reaches Krita.

### Safety review (R) + integration (H) — lead triage 15:57
Report: .context/review-R.md. Assigned fixes:
- R1 critical (URL params let any site drive the pointer): test-only params (`source=replay`, `target=krita`, `helper=`) honoured only when `NEXT_PUBLIC_STEADY_TEST=1` (Playwright/integration webServer sets it); Worker never connects to the helper before the first-run privacy screen is acknowledged; lead added `X-Frame-Options: DENY` + `frame-ancestors 'none'` in next.config.ts. → B, F, H.
- R2 high (multiple clients share one button): helper accepts one client; newest replaces oldest (old closed → released). → C. PROTOCOL.md updated.
- R3 high (calibration while pen down): setCalibration lifts; pen-down refused while calibrating. → A (+ B Worker).
- R4 (Hatch down outside canvas): Worker sends move to the event's coordinates before every down/middle_down. → B.
- R5 (move coalescing flattens bursts while held): queue moves while a button is held, drain at 120 Hz. → C.
- R6 + H5 (helper pause persists / refused down shows drawing): Worker reconciles hello.paused; on refused down (permission/paused) lift the Worker pen + persistent status. → B.
- R7 (watchdog release invisible to Worker): new helper→Worker `released {reason, button}`. → C sends, B handles (mid-stroke role=alert).
- R8 (Dock clicks): hello.visible_frame; PipelineRects.usable; clicks only inside it (Worker + helper). → C, A, B.
- R9 (page zoom): window_rect carries zoom; Worker scales CSS px → points. → B.
- R10 (plugin keeps reading after non-JSON / runs any action): close connection on first non-JSON-object line; `action` limited to an allowlist (verified ids + runtime-looked-up merge/remove/clear/visibility ids). → D. H4 (Bridge.stop leaves connections open) → D.
- H1/H2 (--no-pointer still posts keys / permission prompts): new `--no-input` (no pointer, no keys, no activation, no permission prompts); `--no-pointer` also blocks key posting. → C.
- R minor: Worker never sends `ring` → B sends ring updates (≤ 30 Hz, hidden on pause). `numbers` handler → C verify.
- **Follow-up (15:55–15:59):**
  - The integration `next dev` now runs with `NEXT_PUBLIC_STEADY_TEST=1` and `reuseExistingServer:false`. The app port must be free; `integration-check.sh` picks the first free port from 3200.
  - `safe_helper.py` accepts `--no-input`: it adds it automatically when the helper supports it and translates it to `--no-pointer` when the helper doesn't. All of the shim's patches stay in place.
  - New test `test_watchdog_release_is_reported_to_the_client_fake_pointer` polls for `released {reason, button}`. It skips with a message until C's change lands.
- (F, 16:02) `scripts/demo-check.sh P4` at BUILD_PHASE P4 (15:54, before the R1 safety fix): 744 passed, 2 failed. FAILs: (1) **product (B): Steady page overflows at 320×900** — `[data-page="steady"]` scrollHeight 417 > clientHeight 412 (5 px) after the preset tiles were added; (2) test (fixed): Sketch/Ink mode/Shade moved to the Modes page — tests now locate tiles on any page (`findTile`). All P4 automated items PASS (hand presets, profiles, numbers + click 1, Photoshop keys, Modes/Input/Krita page fit). Strict `AXE_GATE=1`: 100 % 0 violations; **200 % FAIL on Steady, Modes, Setup, Input: header not pinned** — at 160×450 CSS px the document itself scrolls (`document.scrollingElement.scrollHeight` 496 > clientHeight 450, `window.scrollY` reaches 46), so the page tabs move up 46 px (the panel is `position: sticky` but the document grows past 100vh; likely `.main`/`.panel` heights of 100vh plus padding/border or the horizontal-overflow `.main {min-width: 480px}`). axe rules themselves report 0 violations at 200 %.
- (F) R1 test plumbing: Playwright's dev server runs with `NEXT_PUBLIC_STEADY_TEST=1`; the config reuses only this checkout's dev server whose process env has that flag (checked with `ps eww`), else :3000 if free, else the first free port from 3100 (+ `--origin` for the fake helper). Tests seed `localStorage["steady.privacySeen.v1"]=true` (B_KEYS.privacySeen) and click "Got it" if the privacy screen shows anyway. Every test opens one page per fake helper at a time (one-client helper is fine).
- **Round 3b (16:07–16:12), after C and B landed:**
  - Shim fixes: `permissions._real_checks(prompt)` takes an argument now, and the shim's replacement accepts it (it still never prompts).
  - Fallback assertions now accept `input_disabled`. `--no-input` answers that before `bad_combo`, which is the right order.
  - The Playwright config loads in worker processes too, so the "port in use" check now runs only in the runner (`TEST_WORKER_INDEX` unset). Before this, it tripped on our own dev server.
  - Ports: the Playwright helper and bridge use the first free ports from 28865; pytest uses 28875 and up.
  - Result: `integration-check.sh` PASS. pytest 13/13: `released {reason:"watchdog", button:"left"}` is verified, and the shim confirms `--no-input` is supported and used. Playwright 3/3. 0 INTEGRATION-BLOCKED.
  - The page now shows "Helper needs Accessibility permission…" after a refused `down`, which resolves the earlier page finding.
- (F) 2026-10-24 16:14 PDT — after all safety fixes (A–D): `scripts/demo-check.sh P4`: 793 passed, **1 failed** → FAIL only on 'Each P0 page fits' because of the product bug above (**Steady page 417 > 412 px at 320×900**; everything else, all P0–P4 automated DoD items, PASS). Strict `AXE_GATE=1` a11y spec: **PASS** (0 violations on all 11 pages at 100 % and 200 %, header pinned; the earlier 200 % pin failure is gone after B's zoom-aware fixes). New @P1 test: with `?privacy=pending` nothing reaches the fake helper until 'Got it', then it connects — PASS. Skipped (optional, costly): a test against a dev server without NEXT_PUBLIC_STEADY_TEST (would need a second `next dev` of this checkout on its own port).
- 16:0x B: Steady page overflowed (417 > 412) with the 4 hand presets → new **Presets** tab (2nd tab, tabs now 12 with Demo = exactly 3 rows) holding "Sore joints, steady hand", "Shakes when holding still or reaching", "Slow movements, shakes at rest", "Hard to hold still" + one line of help. Steady keeps the Steadiness slider and Steadier, Looser, Hatch, Dots, Quiet, Clear practice (≈ 224 px).

### P4 gate — 2026-10-24 16:20 PDT (after the safety round)
```
demo-check P4  (2026-10-24 16:15 PDT)  tags: @P0|@P1|@P2a|@P2b|@P3|@P4
PASS        step: typecheck
PASS        step: vitest
PASS        step: pytest
PASS        step: playwright
PASS        Pointer cursor on Steady's practice canvas (ReplaySource)  — 1 test(s)
PASS        Hold still to start drawing (pen-down dwell)  — 26 test(s)
PASS        Draws a stroke (a word shape) on the practice canvas  — 1 test(s)
PASS        Hold still to stop (pen-up dwell; slow stroke never lifts)  — 10 test(s)
PASS        A resting hand toggles the pen at most once  — 1 test(s)
PASS        The Undo key undoes  — 1 test(s)
PASS        Steadiness slider and its ± tiles change the result  — 5 test(s)
PASS        Calibration steps 1–2 complete  — 1 test(s)
PASS        Each P0 page fits 320×900 at 100 % (Steady, Setup, Timing)  — 3 test(s)
PASS        axe report produced at 100 % and 200 % (hard gate only with AXE_GATE=1)  — 2 test(s)
PASS        Pipeline acceptance targets + every @P0 Vitest  — 52 test(s)
NEEDS HUMAN Real webcam: within 60 s of npm run dev a resting hand moves the cursor (knuckle landmark)  — see NEEDS-HUMAN.md
NEEDS HUMAN Real webcam: a person writes a legible word and the Steadiness change is visible  — see NEEDS-HUMAN.md
PASS        Demo page: Simulate tremor, metrics, Next judge  — 2 test(s)
PASS        Worker sends move/down/up to the helper in order (stroke reaches the helper)  — 1 test(s)
PASS        Covering the camera mid-stroke ends the stroke with no scribble (score-0.5 replay)  — 9 test(s)
PASS        Helper releases the button (watchdog 300 ms, socket close, exception) — fake mouse  — 17 test(s)
PASS        F9 releases everything; helper is the single key source (page ignores F-keys)  — 38 test(s)
PASS        Resume tile reachable by dwell (click inside Chrome's rect, no self-trigger)  — 1 test(s)
PASS        Every @P1 Vitest (mapping, clamp, rect gating, hand lock, protocol round-trip)  — 156 test(s)
PASS        Every @P1 pytest (helper §5)  — 365 test(s)
NEEDS HUMAN Real Krita: the same resting hand paints a stroke in Krita via the helper  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Krita: covering the camera mid-stroke ends the Krita stroke cleanly  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Mac: F9 pauses and the Resume tile works by dwell with Krita focused  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Mac: Chrome strip beside Krita keeps the fps counter running while Krita is focused  — see NEEDS-HUMAN.md
PASS        Typed "steadier" moves the slider  — 1 test(s)
PASS        Typed "blue" produces a krita message  — 1 test(s)
PASS        Keys do nothing inside the typed box  — 1 test(s)
PASS        P2a pages fit 320×900 (Paint, Colour, View, Layers)  — 4 test(s)
PASS        Grammar, keyterms, zod, Claude log (every @P2a Vitest)  — 86 test(s)
PASS        Krita plugin dispatcher (every @P2a pytest)  — 365 test(s)
NEEDS HUMAN Real Krita 5.3.x: plugin loads, "blue" changes the colour, F5/F6 no longer open popups  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Krita: dwell-click hits an enlarged toolbox button  — see NEEDS-HUMAN.md
NEEDS HUMAN Real mic + keys: Cartesia Ink 2 hears "blue", "bigger", "undo that"; Claude moment works  — see NEEDS-HUMAN.md
PASS        Hatch tile toggles Hatch; status "Hatch: forward passes only"  — 1 test(s)
PASS        Hatch/Dots pipeline (forward passes only, look-ahead buffer, stationary hand never inks)  — 9 test(s)
PASS        Quiet mode turns the mic (and TTS, earcons) off  — 1 test(s)
PASS        Aliases: "alias fluffy" stored; a colliding alias is refused ("That word is taken")  — 13 test(s)
PASS        Destructive confirm: alertdialog, focus on Cancel, Esc cancels, typed "yes" confirms  — 1 test(s)
PASS        Break nudge after 20 min, non-blocking, "Later" dismisses  — 1 test(s)
PASS        Every @P2b Vitest  — 27 test(s)
PASS        Every @P2b Playwright  — 5 test(s)
NEEDS HUMAN Real Krita: Hatch over the parallel ruler inks forward passes only  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Mac: Sonic TTS speaks "Saved"/"New layer" and never while the mic is open  — see NEEDS-HUMAN.md
NEEDS HUMAN Real mic: "call this brush fluffy", then "fluffy" selects that preset in Krita  — see NEEDS-HUMAN.md
PASS        Sketch / Ink mode / Shade tiles set Steadiness 25 / 70 / 10  — 1 test(s)
PASS        Dash / Repeat / pan / pick pipeline  — 16 test(s)
PASS        Every @P3 Vitest  — 45 test(s)
PASS        Every @P3 Playwright  — 1 test(s)
PASS        Every @P3 pytest (ring overlay, middle-button pan, keymap)  — 365 test(s)
NEEDS HUMAN Real Mac: ring overlay visible over Krita; Krita's brush outline still shows through it  — see NEEDS-HUMAN.md
NEEDS HUMAN Real hand in a glove/brace: Colour cap sticker is tracked and paints  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Mac: self-hosted MediaPipe assets load with the network off  — see NEEDS-HUMAN.md
PASS        Hand preset tiles set the documented Steadiness / gain / dwell / Latch  — 1 test(s)
PASS        Profiles: save and use round-trip; "Steady day" and "Shaky day" exist  — 1 test(s)
PASS        Show numbers → helper `numbers {items}`; "click 1" clicks the item centre  — 1 test(s)
PASS        App profile Photoshop: typed "undo" sends keys cmd+z, not krita  — 1 test(s)
PASS        Presets, profiles, re-baseline, head mode, eyebrow detector (every @P4 Vitest)  — 25 test(s)
PASS        New pages Modes, Input, Krita fit 320×900 at 100 %  — 3 test(s)
PASS        Every @P4 Playwright  — 8 test(s)
PASS        Every pytest ≤ P4 (helper numbers badges, Photoshop map, plugin list_widgets)  — 365 test(s)
NEEDS HUMAN Real face: Head mode moves the pointer with the nose; gain 6× feels usable  — see NEEDS-HUMAN.md
NEEDS HUMAN Real face: an eyebrow lift lifts the pen, and talking or blinking does not  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Krita: numbered badges line up over Krita's widgets; "click 5" clicks the right one  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Photoshop: undo / brush / bigger / smaller shortcuts work through the Photoshop profile  — see NEEDS-HUMAN.md
totals (tags ≤ P4): 795 passed, 0 failed, 0 skipped (vitest+pytest+playwright)
demo-check P4: PASS
```
- strict AXE_GATE=1: 0 violations at 100 % and 200 % (12 pages incl. Presets). integration-check: PASS (13 pytest, 3 Playwright, 0 real input attempted).
- 16:2x B: tile labels never break inside a word (`word-break: keep-all; overflow-wrap: normal; hyphens: none`). To make "Recenter" / "Airbrush" / "Presets" fit at 18 px: side padding of the header and pages 8 → 4 px (4-per-row tiles are now 72 px), tile frame drawn as a 2 px inset box-shadow instead of a border (no width taken), horizontal tile padding 0, letter-spacing −0.02em, weight stays 600. Dev-only guard: `console.warn("[steady] tile labels too wide: …")` when any `.tile-label` has scrollWidth > clientWidth (checked on page change, pause and resize). Not measured in a browser this round (no Playwright).

### Final pre-freeze check — 2026-10-24 16:25 PDT
```
demo-check P4  (2026-10-24 16:22 PDT)  tags: @P0|@P1|@P2a|@P2b|@P3|@P4
PASS        step: typecheck
PASS        step: vitest
PASS        step: pytest
PASS        step: playwright
PASS        Pointer cursor on Steady's practice canvas (ReplaySource)  — 1 test(s)
PASS        Hold still to start drawing (pen-down dwell)  — 26 test(s)
PASS        Draws a stroke (a word shape) on the practice canvas  — 1 test(s)
PASS        Hold still to stop (pen-up dwell; slow stroke never lifts)  — 10 test(s)
PASS        A resting hand toggles the pen at most once  — 1 test(s)
PASS        The Undo key undoes  — 1 test(s)
PASS        Steadiness slider and its ± tiles change the result  — 5 test(s)
PASS        Calibration steps 1–2 complete  — 1 test(s)
PASS        Each P0 page fits 320×900 at 100 % (Steady, Setup, Timing)  — 3 test(s)
PASS        axe report produced at 100 % and 200 % (hard gate only with AXE_GATE=1)  — 2 test(s)
PASS        Pipeline acceptance targets + every @P0 Vitest  — 52 test(s)
NEEDS HUMAN Real webcam: within 60 s of npm run dev a resting hand moves the cursor (knuckle landmark)  — see NEEDS-HUMAN.md
NEEDS HUMAN Real webcam: a person writes a legible word and the Steadiness change is visible  — see NEEDS-HUMAN.md
PASS        Demo page: Simulate tremor, metrics, Next judge  — 2 test(s)
PASS        Worker sends move/down/up to the helper in order (stroke reaches the helper)  — 1 test(s)
PASS        Covering the camera mid-stroke ends the stroke with no scribble (score-0.5 replay)  — 9 test(s)
PASS        Helper releases the button (watchdog 300 ms, socket close, exception) — fake mouse  — 17 test(s)
PASS        F9 releases everything; helper is the single key source (page ignores F-keys)  — 38 test(s)
PASS        Resume tile reachable by dwell (click inside Chrome's rect, no self-trigger)  — 1 test(s)
PASS        Every @P1 Vitest (mapping, clamp, rect gating, hand lock, protocol round-trip)  — 156 test(s)
PASS        Every @P1 pytest (helper §5)  — 365 test(s)
NEEDS HUMAN Real Krita: the same resting hand paints a stroke in Krita via the helper  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Krita: covering the camera mid-stroke ends the Krita stroke cleanly  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Mac: F9 pauses and the Resume tile works by dwell with Krita focused  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Mac: Chrome strip beside Krita keeps the fps counter running while Krita is focused  — see NEEDS-HUMAN.md
PASS        Typed "steadier" moves the slider  — 1 test(s)
PASS        Typed "blue" produces a krita message  — 1 test(s)
PASS        Keys do nothing inside the typed box  — 1 test(s)
PASS        P2a pages fit 320×900 (Paint, Colour, View, Layers)  — 4 test(s)
PASS        Grammar, keyterms, zod, Claude log (every @P2a Vitest)  — 86 test(s)
PASS        Krita plugin dispatcher (every @P2a pytest)  — 365 test(s)
NEEDS HUMAN Real Krita 5.3.x: plugin loads, "blue" changes the colour, F5/F6 no longer open popups  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Krita: dwell-click hits an enlarged toolbox button  — see NEEDS-HUMAN.md
NEEDS HUMAN Real mic + keys: Cartesia Ink 2 hears "blue", "bigger", "undo that"; Claude moment works  — see NEEDS-HUMAN.md
PASS        Hatch tile toggles Hatch; status "Hatch: forward passes only"  — 1 test(s)
PASS        Hatch/Dots pipeline (forward passes only, look-ahead buffer, stationary hand never inks)  — 9 test(s)
PASS        Quiet mode turns the mic (and TTS, earcons) off  — 1 test(s)
PASS        Aliases: "alias fluffy" stored; a colliding alias is refused ("That word is taken")  — 13 test(s)
PASS        Destructive confirm: alertdialog, focus on Cancel, Esc cancels, typed "yes" confirms  — 1 test(s)
PASS        Break nudge after 20 min, non-blocking, "Later" dismisses  — 1 test(s)
PASS        Every @P2b Vitest  — 27 test(s)
PASS        Every @P2b Playwright  — 5 test(s)
NEEDS HUMAN Real Krita: Hatch over the parallel ruler inks forward passes only  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Mac: Sonic TTS speaks "Saved"/"New layer" and never while the mic is open  — see NEEDS-HUMAN.md
NEEDS HUMAN Real mic: "call this brush fluffy", then "fluffy" selects that preset in Krita  — see NEEDS-HUMAN.md
PASS        Sketch / Ink mode / Shade tiles set Steadiness 25 / 70 / 10  — 1 test(s)
PASS        Dash / Repeat / pan / pick pipeline  — 16 test(s)
PASS        Every @P3 Vitest  — 45 test(s)
PASS        Every @P3 Playwright  — 1 test(s)
PASS        Every @P3 pytest (ring overlay, middle-button pan, keymap)  — 365 test(s)
NEEDS HUMAN Real Mac: ring overlay visible over Krita; Krita's brush outline still shows through it  — see NEEDS-HUMAN.md
NEEDS HUMAN Real hand in a glove/brace: Colour cap sticker is tracked and paints  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Mac: self-hosted MediaPipe assets load with the network off  — see NEEDS-HUMAN.md
PASS        Hand preset tiles set the documented Steadiness / gain / dwell / Latch  — 1 test(s)
PASS        Profiles: save and use round-trip; "Steady day" and "Shaky day" exist  — 1 test(s)
PASS        Show numbers → helper `numbers {items}`; "click 1" clicks the item centre  — 1 test(s)
PASS        App profile Photoshop: typed "undo" sends keys cmd+z, not krita  — 1 test(s)
PASS        Presets, profiles, re-baseline, head mode, eyebrow detector (every @P4 Vitest)  — 25 test(s)
PASS        New pages Modes, Input, Krita fit 320×900 at 100 %  — 3 test(s)
PASS        Every @P4 Playwright  — 8 test(s)
PASS        Every pytest ≤ P4 (helper numbers badges, Photoshop map, plugin list_widgets)  — 365 test(s)
NEEDS HUMAN Real face: Head mode moves the pointer with the nose; gain 6× feels usable  — see NEEDS-HUMAN.md
NEEDS HUMAN Real face: an eyebrow lift lifts the pen, and talking or blinking does not  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Krita: numbered badges line up over Krita's widgets; "click 5" clicks the right one  — see NEEDS-HUMAN.md
NEEDS HUMAN Real Photoshop: undo / brush / bigger / smaller shortcuts work through the Photoshop profile  — see NEEDS-HUMAN.md
totals (tags ≤ P4): 795 passed, 0 failed, 0 skipped (vitest+pytest+playwright)
demo-check P4: PASS
```
- strict AXE_GATE=1: 0 violations at 100 %/200 %. integration-check: PASS (16:19). Tile-label overflow check (all 12 pages, 1280 and 320 px): none.
- Remaining before Sun 09:00 is human work only: NEEDS-HUMAN.md items 0–5 first, then record the fallback video (docs/demo-video.md), then the Devpost form. Feature work stopped at P4; nothing real-hardware is claimed.

## PIVOT — Steady as a Krita plugin (2026-10-24 17:04 PDT)
User decision: no website; everything inside Krita (a Steady panel/docker) + a hidden "Steady Tracker.app" for camera work; voice now; no pedal (keyboard F-keys, mouse/touchpad, camera, mic only).
- Why a separate tracker app: Krita.app has no NSCameraUsageDescription / camera entitlement (checked with plutil/codesign), so camera access from Krita or a child it spawns directly is blocked by TCC. Launched via `open`, the tracker app is its own responsible process.
- Reuse: the tested TS pipeline/grammar/dispatch runs as a Node "brain" (esbuild bundle) driven over stdin/stdout by the Python tracker; helper's pointer/watchdog/hotkeys/krita_relay reused; plugin bridge unchanged + new panel.
- Verified availability: mediapipe 1.1.1 (py3-none macOS arm64), opencv-python-headless 4.10 (abi3 arm64), sounddevice 0.5.6 wheels exist for Python 3.12. Krita's PyQt5 has QtNetwork (panel ↔ tracker via QTcpSocket) but no QtMultimedia.
- Contracts: tracker/PROTOCOL.md, tracker/brain/protocol.ts. The website (src/app, src/components, src/tracking) stays in the repo untouched as a fallback demo.

### Agent F (plugin docs) — 2026-10-24 17:07– PDT
- `scripts/install-steady.sh` (new): idempotent, numbered steps, `--dry-run` changes nothing (prereq checks are read-only and still run). Adapts to what exists: `npm run brain:build` only if the script is in package.json; tracker venv via `scripts/run-tracker.sh --check` when that flag exists, else creates `tracker/.venv` + pip installs `tracker/requirements.txt` (sha stamp, same as run-helper.sh); `gen-plugin-actions.mjs` / `build-tracker-app.sh --install` only if present. Missing prerequisites stop a real run (exit 1); a missing component prints WARNING and a real run exits 1 at the end. Tested only with `--dry-run` (exit 0).
- Hand model: the installer checks `public/mediapipe/hand_landmarker.task` (what `fetch-mediapipe.sh` writes) — reconciled against the tracker's model path at the end of this round.
- README: the plugin is the product; website moved to "Fallback: website version". Privacy keeps §0 rule 9 verbatim and adds a note that in the plugin build "our server" = the Steady Tracker process calling Anthropic directly and "the helper" = Steady Tracker (127.0.0.1:8767). Pedals: one optional mention ("any USB pedal sending one of these keys works too"); the pen-state law keeps "pen key" (a pedal sending it counts). Cost bullet drops the pedal price. Head mode, eyebrow, Colour cap, Photoshop profile, Demo page listed as website-only with TODO.
- NEEDS-HUMAN.md: plugin items 0–21 first (item 1 sub-item ticked: user enabled the plugin at 17:00, "listening on 127.0.0.1:8766"); "For the submission" 42–46 (mine) rewritten for the plugin and moved up; every website item kept verbatim with its original number under "Fallback: website version" (headings demoted one level), Agent D and Agent H sections preserved there.

### Agent B (brain) — 2026-10-24 17:05–17:17 PDT
Files: `tracker/brain/core.ts` (`createBrain(send)`: the pure core), `tracker/brain/brain.ts` (stdin/stdout entry), `tracker/brain/build.mjs` (esbuild → `tracker/brain/dist/brain.mjs`, node20 ESM, all deps inlined incl. zod ≈ 0.9 MB unminified for readable stacks), `tracker/brain/brain.test.ts` (25 `@PLUGIN` tests incl. one that builds and spawns the bundle). `package.json` `brain:build`; `vitest.config.ts` include `tracker/brain/**/*.test.ts`.
- **Spawn:** `node tracker/brain/dist/brain.mjs` (cwd anything). stdout = FromBrain lines only (console.* rerouted to stderr, `[brain]` prefix). stdin EOF, SIGTERM, SIGINT = `shutdown` (force lift, exit 0). Bad JSON line → `{t:"error"}`, keeps running. Any exception inside a message → force lift first (pipeline force_lift, then a raw `up`/`middle_up` if the brain still believes a button is held), then `{t:"error"}`.
- **Clock:** the brain has no timers. `frame.frame.t`, `tick.now` and every `now` field must be the tracker's one monotonic ms clock. `tick` every 50 ms drives: the 300 ms loss timer when frames stop (pipeline.tick when the last frame is > 100 ms old, as the Worker did), coalesced undo/redo spacing (50 ms), Krita reply timeouts (3 s → "Krita did not answer."), and the ≤ 15 Hz `state`.
- **`state`:** only on change, ≤ 15 Hz, but sent at once when pen / paused / micOpen / kritaConnected / calibrating-on-off / tracking word change (safety-relevant; the tracker can mirror `paused` to refuse `down`). `rawTrail` ≤ 90 points, canvas-relative, newest kept. `cameraFps` = optional `frame.cameraFps` (number) if the tracker adds it, else the frame rate the brain sees.
- **`pen`:** every `down`/`middle_down` is preceded by a `move` to the same point (rounded 0.1 pt). Pan batches (panState.batchIsPan) use `middle_down`; the matching release is `middle_up` (decided by which button the brain pressed, not by the batch flag). A second down while a button is held is dropped. Clicks (dwell-click, click_number) are sent as `move` + `click` (integer points) and never into the menu bar (top 40 pt of `rects.screen`) or outside `rects.usable`.
- **Rects:** `rects.panel` → pipeline `chrome` (Pause clamps there; dwell-click allowed there); `rects.krita` = Krita main window (dwell-click allowed); `canvas` from `rects` or from the `canvas_rect` reply after connect. Pipeline built with target `krita`, helperConnected `true`.
- **Krita:** `helper_event krita_state {connected}` false→true sends `kritaConnectMessages()` as four `krita` messages; replies come back as `helper_event krita_reply {id, ok, error?, ...}` and are matched by the brain's `id` (`b<n>`). `list_actions` (any reply carrying `actions`) → `buildLookups`; `canvas_rect` → canvas; `smoothing_changed:true` → one-time notice. Krita actions use `kritaMessageFor` (plugin connected → `krita` with `fallback_keys` when the row has keys; down → `krita`+fallback_keys, bare `keys`, or status "That needs the Krita plugin.").
- **Dialogs:** destructive rows send `dialog {dialog_id:"b-dlg-<n>", kind:"confirm", options:[confirm, cancel]}`; the Krita command goes out only on `dialog_answer` confirm (or action `yes`). When a dialog is answered by voice/typed (`yes`/`no`/`cancel` actions), the brain sends `dialog` again with the same id, `text:""`, `options: []` = "close it" (no close message in the contract; see requests). `dialog_answer` for an id not starting with `b-dlg-` is ignored (Python-owned clarify).
- **Mic:** `hotkey ptt_down` → pipeline `ptt` lift, then `mic {open:true, reason:"ptt"}`; `ptt_up` → `mic {open:false}`. Action `mic` toggles (`variant` "on"/"off" force); the Python side reports closes it made itself (silence/cap) with `action mic variant "closed"` (or `"opened"`), which only updates `micOpen`. Quiet mode / `inputs.voice=false` keep the mic shut and close an open one (`reason:"quiet"`).
- **Persistence through `settings_changed` (brain-only keys inside settings):** `aliases: Record<word, presetName>` (→ aliases.json), `profiles: ProfileStore` (→ profiles.json), `skinHex` ("save skin"). The tracker passes them back inside `init.settings` (and may send them in `settings`). `init` also accepts optional `calibrations: {Left?, Right?}` (per-hand store for Other hand); without it only `init.calibration` is known.
- **Calibration:** `calibrate` (or action recalibrate) → pipeline lift + setCalibrating(true) + StepCalibrator; on finish `calibration` message + status "Calibration done. Suggested Steadiness: N (now M). …". Steadiness is never changed automatically (the old page did; the plugin brief says no). Other hand: stored hand → `calibration` re-emitted; else mirrored prior + steps 1–2.
- **Steadier/looser:** voice/claude debounced 1 s (tiles not), ±10, via `settings_changed {steadiness}` (applied by the pipeline at the next pen-up). Smoothing presets: the pipeline sets Steadiness + radius cap; only `{steadiness}` is persisted. Hand presets: `settings_changed` with the preset fields (no `tip`); the tip shows once per brain run.
- **Numbers (P4) in the plugin build:** `show_numbers` → `krita list_widgets` → status "Numbers: 1 Brush, 2 Eraser, … Say click and a number." (no overlay drawn); `click_number N` → pen `move`+`click` at the item centre (refused while paused, outside Krita's window, in the menu bar or outside usable). Numbers are forgotten on pause, Krita disconnect or a Krita window move.
- **Unsupported in the plugin build → status only:** head_mode, eyebrow_lift (also when set via settings), pick_sticker_colour, lock_exposure, clear_practice, app_profile. `later` → status (no break nudge in the brain).
- `parse` merges the brain's stored aliases with `opts.aliases` and sets `dialogOpen` from the brain's own dialog unless `opts.dialogOpen` is given. "Heard:", Claude fallback, clarify and multi-command spacing stay on the Python side; it sends the resulting `action`s back (source voice/typed/claude).
- Not done: `keymap` (remapped keys) — the tracker owns hotkeys and can build its map from `settings.keymap` with the same rules as `keymapMessage()` in src/desktop/krita.ts; the brain only receives hotkey names.

## Contract change requests
- **B (brain) → lead (additive, already implemented as optional fields):** (1) `init.calibrations?: Partial<Record<"Left"|"Right", Calibration>>`; (2) `frame.cameraFps?: number`; (3) brain-only settings keys `aliases`, `profiles`, `skinHex` carried in `SteadySettings`/`settings_changed` — please bless them in protocol.ts (e.g. `settings: SteadySettings & BrainExtras`, exported from tracker/brain/core.ts) or add dedicated messages; (4) a `{t:"dialog_close", dialog_id}` FromBrain message — until then the brain sends `dialog` with `options: []` to mean closed; (5) document `status {text:"", level:"alert"}` = clear the persistent alert (Worker convention, kept); (6) `helper_event` data shapes the brain reads: `released {reason}`, `refused_down {code:"paused"|"permission", which?, message?}`, `krita_state {connected, window_rect?}`, `krita_reply {id, ok, error?, ...reply fields}`.
- 17:17 lead: accepted B's brain contract requests (init.calibrations, frame.cameraFps, settings aliases/profiles/skinHex, dialog_close, alert-clear status, helper_event data shapes) in tracker/brain/protocol.ts. brain dist is gitignored; built at install (npm run brain:build).
