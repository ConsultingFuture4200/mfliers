/**
 * GET /api/public/pins — the public (no-auth) universal aggregate map's
 * pin feed (T5.2, PRD FR-L2/FR-L3/FR-L4, EC-4). No session required; same
 * public reach as `/api/public/campaigns` (T5.1) and the landing page
 * itself.
 *
 * Thin route handler only (constitution §6) — pin assembly (the sanctioned
 * cross-campaign read plus per-campaign name lookup) lives in
 * `lib/campaign/universal-map.ts`.
 */
import { NextResponse } from "next/server";
import { getUniversalMapPins } from "@/lib/campaign/universal-map";

export async function GET(): Promise<Response> {
  const pins = await getUniversalMapPins();
  return NextResponse.json({ pins });
}
