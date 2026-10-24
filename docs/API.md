# Steady server API (Next.js route handlers)

Only two server routes exist. `@anthropic-ai/sdk` and `CARTESIA_API_KEY` are never imported client-side.
If a key is missing, the route returns realistic **mock** data with `"mock": true` and the status bar shows
"key missing" (never stall on a key).

## `POST /api/cartesia-token`
Mints a short-lived Cartesia access token for the browser (STT + TTS).

Upstream: `POST https://api.cartesia.ai/access-token`, headers `Authorization: Bearer $CARTESIA_API_KEY`,
`Cartesia-Version: 2026-08-14`, body `{"grants":{"stt":true,"tts":true},"expires_in":3600}`.

Request body: `{}`

Response 200:
```json
{ "token": "eyJ...", "expiresAt": 1761345600000, "voiceId": "a0e99841-...", "mock": false }
```
Mock (no key): `{ "token": "mock", "expiresAt": <now+3600s>, "voiceId": null, "mock": true, "reason": "key_missing" }`.
Errors: 502 `{ "error": "upstream", "status": 401 }`.

The client re-mints at 45 min and reconnects on the next push-to-talk release, never mid-utterance.

## `POST /api/command`
Resolves text the local grammar could not match. Calls `claude-haiku-5-5` via `client.messages.parse`
with a cached byte-identical `SYSTEM_BLOCK`, `thinking: {type:"disabled"}`,
`output_config: {effort:"low", format: zodOutputFormat(ActionsSchema)}`, `max_tokens: 512`,
`{timeout: 2500, maxRetries: 0}`. Never forced `tool_choice`.

Request body (exactly the privacy-rule list; never audio):
```json
{
  "text": "make it thinner and a bit softer",
  "context": {
    "tool": "brush",
    "preset": "b) Basic-5 Size",
    "size": 40,
    "opacity": 100,
    "color": "#1d4ed8",
    "steadiness": 50,
    "lastActions": ["blue", "bigger", "new_layer"]
  }
}
```
Pre-warm (once at app start; same SYSTEM_BLOCK, timeout 30 s): `{ "prewarm": true }` → `{ "kind": "noop", "prewarm": true, ... }`.

Response 200 (one of):
```json
{ "kind": "actions", "first": "smaller", "second": "airbrush", "arg": null, "latencyMs": 640, "mock": false }
{ "kind": "clarify", "options": ["fade", "airbrush"], "latencyMs": 700, "mock": false }
{ "kind": "noop", "latencyMs": 380, "mock": false }
{ "kind": "error", "reason": "timeout" | "invalid" | "key_missing" | "upstream", "latencyMs": 2500, "mock": false }
```
`first`/`second`/`options` are action ids from `src/actions.ts` (compared case-insensitively).
`response.parsed_output === null` → `{kind:"error", reason:"invalid"}` → the client shows "Didn't catch that"
with the two closest grammar matches as tiles. Mock mode (no key) uses a small keyword matcher and returns
`"mock": true`.
