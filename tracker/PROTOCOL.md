# Steady as a Krita plugin — architecture and protocols

SHARED CONTRACT (lead). Pivot at 17:05 Sat: **no browser, no website.** Everything the user sees and touches is a
**Steady panel inside Krita**. Krita has no camera permission on macOS (no `NSCameraUsageDescription`), and a
process Krita spawns directly inherits that, so the camera work runs in a small separate app bundle,
**Steady Tracker.app**, that the panel launches with `open` (LaunchServices parent → the tracker app is the
"responsible process" for camera, microphone, Accessibility and Input Monitoring).

Input hardware assumed: **camera, microphone, keyboard, mouse/touchpad.** No pedal. Every action is reachable
by a panel tile (click or dwell), an F-key for the §4 core actions, voice, and the typed box.

```
Krita
 ├─ Steady panel (docker, PyQt5)  ──tcp 127.0.0.1:8767 (JSON lines)──►  Steady Tracker.app (Python 3.12)
 │    tiles, sliders, status, preview, mic, typed box                  ├─ camera (OpenCV AVFoundation) → MediaPipe HandLandmarker (Python)
 │                                                                     ├─ brain: `node tracker/brain/dist/brain.mjs` (stdin/stdout JSON lines)
 └─ Steady bridge (existing, tcp 127.0.0.1:8766) ◄──────────────────── │     = src/pipeline (One Euro, dwell, pen law, calibration, Hatch…)
      action/color/size/preset/layers/canvas_rect/list_widgets…        │       + grammar + action dispatch (pure TS, the tested code, bundled)
                                                                       ├─ pointer + watchdog + hotkeys (reuses helper/steadyhelper)
                                                                       ├─ voice: mic (sounddevice) → Cartesia Ink 2 STT; Sonic TTS; Claude fallback
                                                                       └─ Krita relay → bridge 8766 (reuses helper/steadyhelper/krita_relay)
```

Ownership: **B** `tracker/brain/**` (Node brain; reuses `src/pipeline/**`, `src/desktop/krita.ts`, `src/actions.ts`);
**C** `tracker/steadytracker/**` except `voice/`, `tracker/tests/**`, `scripts/build-tracker-app.sh`,
`scripts/run-tracker.sh`; **D** `krita-plugin/**` (panel + existing bridge); **E** `tracker/steadytracker/voice/**`
+ its tests; **A** `src/pipeline/**` (changes the brain needs); **F** `scripts/install-steady.sh`, README, docs,
NEEDS-HUMAN, `tests/e2e-plugin/**`. The lead owns this file and `tracker/brain/protocol.ts`.

## Coordinates
Pointer events are **Quartz global screen points** (top-left origin). The panel reports its own global rect; the
bridge reports Krita's canvas rect (`canvas_rect`) and main window (`window_rect`). The brain's target is always
`"krita"` (screen points); there is no practice canvas in the plugin build (the panel shows a small live trace instead).

## 1. Panel ↔ tracker: TCP 127.0.0.1:8767, newline-delimited JSON
The tracker is the **server** (binds 127.0.0.1 only, one client at a time, newest wins). The panel connects with
`QTcpSocket` (GUI thread, non-blocking) and reconnects every 1 s while "Start" is on. Every message has `t`;
requests from the panel carry `id` and get `{t:"ack", id, ok, error?}`.

Panel → tracker
| t | fields | meaning |
|---|---|---|
| `hello` | `plugin_version, krita_version` | first message after connect |
| `action` | `id, action, variant?, arg?, source: "tile"\|"typed"` | run an action from `src/actions.ts` (tile press / typed result) |
| `typed` | `id, text` | typed command box → brain grammar → (Claude fallback) → actions |
| `settings` | `id, settings: Partial<SteadySettings>` | slider/toggle changes |
| `calibrate` | `id, steps: [1,2,3]` | start calibration |
| `camera` | `id, index` | choose camera (index into `cameras.list`) |
| `mic` | `id, on: boolean` | Mic tile (tap toggles); push-to-talk is F10 via the tracker's hotkeys |
| `panel_rect` | `rect` | the panel's global rect (screen points): dwell-click allowed there; **Pause clamps the pointer to it** |
| `dialog_answer` | `id, dialog_id, answer: "confirm"\|"cancel"\|<option id>` | destructive confirm / clarify choice |
| `quit` | `id` | stop the tracker process (button released first) |

Tracker → panel
| t | fields | when |
|---|---|---|
| `state` | `MirrorState` subset (see `PanelState` in `tracker/brain/protocol.ts`) | ≤ 15 Hz, only on change |
| `status` | `text, level: "status"\|"alert"` | status line (alerts persist until cleared) |
| `preview` | `jpeg_b64, w, h` | ≤ 5 fps, 160×120 camera thumbnail with the tracked point drawn; only while the panel's preview is visible (`settings.preview`) |
| `cameras` | `list: [{index, name}]`, `selected` | on connect and on change; "Desk View" preferred by default |
| `heard` | `text, via: "grammar"\|"claude"` | "Heard: …" |
| `dialog` | `dialog_id, kind: "confirm"\|"clarify", text, options: [{id,label}]` | destructive confirm (Delete/Clear layer) or Claude clarify |
| `permissions` | `camera, microphone, accessibility, input_monitoring: boolean` | on connect and on change; the panel shows exactly what to grant and to which app ("Steady Tracker") |
| `ack` | `id, ok, error?` | reply |

## 2. Tracker ↔ brain: `node tracker/brain/dist/brain.mjs`, stdin/stdout, one JSON object per line
The brain is the pure decision-maker (the old Worker + page dispatcher, minus I/O). It never touches the OS.
stderr is a log. Types: `tracker/brain/protocol.ts`.

Tracker → brain: `init`, `frame` (LandmarkFrame, already mirrored/rotated per settings? **No**: raw; the brain applies
mirror/rotate), `tick` (every 50 ms with the monotonic clock), `action`, `settings`, `rects` (canvas/krita window/panel/
screen/usable), `calibrate`, `parse` (text → ParseResult), `helper_event` (released/refused/krita_state/krita_reply),
`hotkey`.

Brain → tracker: `pen` (PenEvent[] in screen points, already in order; the tracker forwards to the pointer exactly),
`krita` (a KritaCommand + optional fallback_keys to relay to the bridge), `keys` (combo), `state` (PanelState),
`status`, `calibration` (finished Calibration → tracker persists it), `parsed` (reply to `parse`, echoes id),
`dialog`, `speak` (TTS text, ≤ 5 words + heard), `mic` (open/close request: e.g. PTT, quiet mode), `settings_changed`
(brain-side changes such as steadier/looser/presets → tracker persists + mirrors to panel).

## 3. Tracker ↔ Krita bridge: unchanged (`docs/PROTOCOL.md`, helper ↔ plugin section)

## Persistence
`~/Library/Application Support/Steady/` : `settings.json`, `calibration.json` (per hand), `profiles.json`,
`aliases.json`, `claude-log.jsonl`. Keys: the tracker reads `CARTESIA_API_KEY`, `ANTHROPIC_API_KEY`,
`CARTESIA_VOICE_ID` from `<repo>/.env.local` (path baked into the app bundle by the build script), then the environment.

## Safety (unchanged laws)
Pen-state law, 300 ms watchdog, release on every exit path, one controller at a time, tracking loss release,
Pause = button released + pointer clamped to the **panel's** rect + helper refuses `down`, clicks never in the menu
bar/Dock/other apps (only inside Krita's main window, which contains the panel when docked; a floating panel's rect is
also allowed), `--no-input` for tests. Brain crash → tracker releases the button and restarts the brain once.
