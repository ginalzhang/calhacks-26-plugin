// Cartesia Ink 2 smoke test (agent E; for a human with a key). Node 22+ (global WebSocket).
// Usage: CARTESIA_API_KEY=sk_... node scripts/cartesia-smoke.mjs [path/to/16k-mono-s16le.raw]
// Mints an access token exactly like /api/cartesia-token, opens the SAME manual-finalize socket URL
// the browser uses (src/voice/sttClient.ts), sends audio in 100 ms chunks, "finalize", prints the
// transcript at flush_done. Without a file it sends 1 s of silence (expect an empty transcript).
import { readFileSync } from "node:fs";
const key = process.env.CARTESIA_API_KEY; if (!key) { console.error("set CARTESIA_API_KEY"); process.exit(2); }
const V = "2026-08-14";
const tok = await (await fetch("https://api.cartesia.ai/access-token", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Cartesia-Version": V, "Content-Type": "application/json" }, body: JSON.stringify({ grants: { stt: true, tts: true }, expires_in: 3600 }) })).json();
if (!tok.token) { console.error("token mint failed", tok); process.exit(1); }
const terms = ["undo that", "bigger", "new layer", "airbrush"].map((k) => `keyterm=${encodeURIComponent(k)}`).join("&");
const ws = new WebSocket(`wss://api.cartesia.ai/stt/websocket?model=ink-2&encoding=pcm_s16le&sample_rate=16000&cartesia_version=${V}&access_token=${encodeURIComponent(tok.token)}&${terms}`);
const pcm = process.argv[2] ? readFileSync(process.argv[2]) : Buffer.alloc(32000); let text = "";
ws.onopen = () => { for (let i = 0; i < pcm.length; i += 3200) ws.send(pcm.subarray(i, i + 3200)); ws.send("finalize"); };
ws.onmessage = (e) => { const m = JSON.parse(e.data); console.log(m); if (m.type === "transcript" && m.is_final) text += m.text; if (m.type === "flush_done") { console.log("TRANSCRIPT:", JSON.stringify(text)); ws.close(); } };
ws.onerror = (e) => { console.error("socket error", e.message ?? e); process.exit(1); };
