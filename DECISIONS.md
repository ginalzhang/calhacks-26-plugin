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

## Phase logs
