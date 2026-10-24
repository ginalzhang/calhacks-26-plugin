/** POST /api/command — see docs/API.md and ./handler.ts. Server-only. */
import { handleCommand } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const { status, json } = await handleCommand(body, { apiKey: process.env.ANTHROPIC_API_KEY || undefined });
  return Response.json(json, { status, headers: { "Cache-Control": "no-store" } });
}
