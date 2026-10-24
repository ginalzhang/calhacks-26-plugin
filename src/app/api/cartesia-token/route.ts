/** POST /api/cartesia-token — see docs/API.md and ./handler.ts. Server-only. */
import { handleToken } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const { status, json } = await handleToken({
    apiKey: process.env.CARTESIA_API_KEY || undefined,
    voiceIdEnv: process.env.CARTESIA_VOICE_ID || undefined,
  });
  return Response.json(json, { status, headers: { "Cache-Control": "no-store" } });
}
