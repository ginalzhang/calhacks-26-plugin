# Steady protocol

Three processes on one Mac. Types: `src/desktop/protocol.ts` (zod). Examples: `docs/protocol-examples.json`
(one per message; Vitest and pytest both load it). Change all three together.

```
Chrome page ──postMessage──► Worker ──ws://127.0.0.1:8765──► helper (Python) ──tcp 127.0.0.1:8766──► Krita plugin
                               (owns the socket)              (WebSocket server)   (TCP client,         (TCP server,
                                                                                    retries every 2 s)   newline JSON)
```

## Conventions
- Every message is one JSON object with `t` (type) and `id` (uuid string). Replies echo the request `id`.
- Coordinates are **Quartz global screen points**, top-left origin, no Retina scaling.
- The helper **rejects any WebSocket whose `Origin` header is not `http://localhost:3000`** (close code 4003).
  Another local port (e.g. 3100): `npm run helper -- --origin http://localhost:3100` (repeatable) or `STEADY_ORIGIN=a,b`; only `http(s)://localhost|127.0.0.1[:port]`, never `*` (refused at startup).
  Tests run a fake helper on `ws://127.0.0.1:18765` (`?helper=ws://127.0.0.1:18765`).
- The page never opens a socket. It posts `{type:"send", msg}` to the Worker; the Worker routes the
  reply back as `{type:"reply", id, msg}`.

## Pen-state law (the helper's half)
Anything lifts; only dwell, the pen key, a pedal or voice "down" lowers. The helper releases the left
button when: no message for **300 ms** (every `move` counts; the Worker sends `ping` every 100 ms when no
`move` was sent in the last 100 ms), `up`, `pause`, socket close, process exit, Ctrl-C, or any exception.
While paused the helper refuses `down` (error `paused`) and honours `click` only inside the last
`chrome_rect` (error `outside_chrome`).

## Worker → helper
| t | fields | effect / reply |
|---|---|---|
| `move` | `x, y` | `kCGEventMouseMoved` (up) or `kCGEventLeftMouseDragged` (down); coalesced to ≤ 120 Hz. No reply. |
| `down` | — | left button down at the current position. Refused while paused (`error code:"paused"`). |
| `up` | `reason?` | left button up. Idempotent. |
| `click` | `x, y, reactivate_krita?` | one left click (never a drag). While paused only inside `chrome_rect`. Reply `ack`. If `reactivate_krita`, Krita is activated after the click. |
| `middle_down` / `middle_up` † | — | pan (P3). |
| `keys` | `combo` | Activate Krita (≤ 150 ms wait), post the combo. Reply `ack` or `ack ok:false error:"krita_not_running"`. |
| `krita` | `cmd, ...` (a Krita command), `fallback_keys?` | Relayed to the plugin with the same `id`; reply `krita_reply`. Plugin down → post `fallback_keys` (`via:"keys"`) or `ok:false error:"plugin_down"`. |
| `ring` † | `state, progress, x, y` | ring overlay (P3). |
| `ping` | — | reply `pong` (same id). Feeds the watchdog and the round-trip metric. |
| `pause` / `resume` | — | see pen-state law. Reply `ack`. |
| `chrome_rect` | `rect` | Chrome window rect for pause clamping and click gating. |
| `numbers` (P4) | `items: [{n,label,rect}] \| null` | Draw numbered badges over Krita widgets in the overlay (null hides). Reply `ack`. |
| `keymap` | `map: {combo: hotkeyName}` | Remapped global keys (Settings). Replaces the default F3–F10 map; `ptt_down` names the push-to-talk key (release sends `ptt_up`). Sent on connect and on change. Reply `ack`. |

## helper → Worker
| t | fields | when |
|---|---|---|
| `hello` | `version, screen{w,h,scale}, accessibility, input_monitoring, krita, krita_running, krita_window_rect, paused` | on connect |
| `krita_window_rect` | `rect \| null, frontmost` | every 1 s while Krita runs |
| `hotkey` | `key: pen\|pause\|ptt_down\|ptt_up\|undo\|redo\|recenter\|other_hand\|latch` | global key pressed (consumed only while Krita or Chrome is frontmost) |
| `krita_reply` | `ok, error?, via?, ...payload` | reply to `krita`; helper-side errors `plugin_down`, `timeout`, `internal: …` |
| `error` | `code, which?, message?` | permission missing (`which: accessibility\|input_monitoring`), bad message, refused action |
| `krita_state` | `connected` | plugin socket up/down |
| `pong` | — | reply to `ping` |
| `ack` | `ok, error?` | reply to `keys`, `click`, `pause`, `resume`. `keys` errors: `krita_not_running`, `krita_not_frontmost` (posted nothing), `bad_combo`, `permission` |
| `warning` | `code, message` | once after `hello` per active warning: `dwell_control`, `head_pointer`, `voice_control`, `tablet`, `overlay_disabled`; shown in Steady's status line |

The **Worker** handles `hotkey` `pen`, `pause`, `latch`, `recenter`, `ptt_down` (lifts the pen) itself and
also forwards every helper message to the page (`{type:"helper", msg}`) for UI, undo/redo and the mic.
When the helper is connected it is the **single key source**: the page's `keydown` handler ignores F-keys.

On `krita_state {connected:true}` the Worker sends `krita {cmd:"session_init", keys:[...]}`,
`krita {cmd:"list_actions"}`, `krita {cmd:"list_presets"}`, `krita {cmd:"canvas_rect"}` and builds its maps
from the replies. The plugin never pushes unsolicited messages.

## helper ↔ Krita plugin (TCP 127.0.0.1:8766, newline-delimited JSON)
Request: `{id, cmd, ...}` (the `krita` message minus `t` and `fallback_keys`). Reply: `{id, ok:true, ...}` or
`{id, ok:false, error}`. Every Krita API call runs on the GUI thread (queue drained by a 20 ms QTimer).

| cmd | fields | reply payload |
|---|---|---|
| `action` | `action` (a verified Krita action id) | — ; `error:"unknown_action"` |
| `color` | `hex` `#rrggbb` | — ; `error:"bad_hex"` |
| `color_adjust` | `dv` (HSV value delta, −1..1) | `color` |
| `size` | `value` or `delta` (px) | `size` |
| `opacity` | `value` (0–100) | `opacity` |
| `preset` | `name` (family keyword: basic, pencil, ink, airbrush, eraser; or an alias's stored preset name) | `preset` (the matched resource name); also clears the erase toggle |
| `new_layer` | `name?` | `layer` |
| `layer_nav` | `dir: up\|down` | `layer` |
| `layer_visible` | `visible` | `layer` |
| `canvas_rect` | — | `rect` or `error:"no_canvas_rect"` (browser falls back to corner marking) |
| `window_rect` | — | `rect` |
| `list_actions` | — | `actions: [{id, text}]` |
| `list_presets` | — | `presets: string[]` |
| `smoothing` | `mode: none\|simple\|weighted\|stabilizer` | — |
| `clear_shortcuts` | `keys` | `cleared: [{key, action}]` |
| `session_init` | `keys` | `smoothing_changed, cleared, krita_version` (smoothing → None once per Krita process; never re-applied) |
| `get_state` | — | `preset, size, opacity, color, eraser, layer` |
| `list_widgets` (P4) | `max?` | `widgets: [{n, label, rect}]` visible clickable widgets in reading order, global screen points |
| `ping` | — | — |

Common errors: `no_view` (no document open), `unknown_cmd`, `bad_args`, `internal`, `unknown_action`, `action_disabled`, `no_preset`, `no_layer`, `no_window`, `timeout`; `canvas_rect` with no document answers `no_canvas_rect`.

Replies may carry extra fields that the helper passes through unchanged in `krita_reply`: `checked` (state of a checkable action such as `erase_action`, drives the Eraser tile's `aria-pressed`), `eraser_cleared`, `widget_class` (canvas_rect), `smoothing_changed` (**any** reply may carry it: smoothing switches to None on the first command that has a view; the Worker shows the one-time notice whenever it sees `smoothing_changed: true`), `smoothing_pending`, `warning`.

## Fake helper (tests)
`scripts/fake_helper.py --ws-port 18765 --http-port 18767` speaks the helper side of this protocol without
touching the pointer: sends `hello` on connect, replies `pong`/`ack`/`krita_reply ok:true via:"plugin"`, and
records every received message. `--origin` / `STEADY_ORIGIN` work as for the helper (a missing Origin is always accepted by the fake). HTTP control (for Playwright):
- `GET /messages` → `[msg, ...]` received so far
- `POST /reset` → clears the record
- `POST /send` body = a helper→Worker message (e.g. a `hotkey` or `krita_state`) → pushed to every client
- `POST /config` body `{"krita": false}` → subsequent `krita` messages reply `ok:false error:"plugin_down"`
