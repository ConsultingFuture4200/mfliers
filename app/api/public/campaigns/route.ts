/**
 * GET /api/public/campaigns — the public (no-auth) live-campaign directory
 * for the landing page (T5.1, PRD FR-L1/FR-L5). No session required; this
 * endpoint is intentionally reachable by anyone, same as the landing page
 * itself.
 *
 * Thin route handler only — the directory assembly (grouping the
 * sanctioned universal-map read by campaign, computing coverage %) lives
 * in `lib/campaign/directory.ts` (constitution §6).
 */
import { NextResponse } from "next/server";
import { getLiveCampaignDirectory } from "@/lib/campaign/directory";

export async function GET(): Promise<Response> {
  const campaigns = await getLiveCampaignDirectory();
  return NextResponse.json({ campaigns });
}
