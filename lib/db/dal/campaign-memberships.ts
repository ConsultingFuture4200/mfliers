/**
 * Campaign-memberships DAL (T2.1) — campaign-scoped (constitution §3).
 *
 * Every exported function requires `campaignId: string` as its first,
 * non-optional parameter and includes `eq(campaignMemberships.campaignId,
 * campaignId)` in its query, per
 * `docs/decisions/0001-tenant-isolation-enforcement.md`.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { campaignMemberships } from "@/lib/db/schema";
import type { CampaignMembership } from "@/types/domain";
import { assertCampaignId } from "./scope";

function toDomain(
  row: typeof campaignMemberships.$inferSelect,
): CampaignMembership {
  return {
    playerId: row.playerId,
    campaignId: row.campaignId,
    approvedCount: row.approvedCount,
    currentTier: row.currentTier,
    balanceOwedCents: row.balanceOwed,
    rank: row.rank,
  };
}

/** Lists every membership row for `campaignId`. Never returns another
 * campaign's rows. */
export async function listMemberships(
  campaignId: string,
): Promise<CampaignMembership[]> {
  assertCampaignId(campaignId, "listMemberships");
  const rows = await db
    .select()
    .from(campaignMemberships)
    .where(eq(campaignMemberships.campaignId, campaignId));
  return rows.map(toDomain);
}

/** Reads a single player's membership, scoped to `campaignId`. Returns
 * `null` if the player has no membership in this campaign — a caller can
 * never learn about a membership in a different campaign. */
export async function getMembership(
  campaignId: string,
  playerId: string,
): Promise<CampaignMembership | null> {
  assertCampaignId(campaignId, "getMembership");
  const rows = await db
    .select()
    .from(campaignMemberships)
    .where(
      and(
        eq(campaignMemberships.campaignId, campaignId),
        eq(campaignMemberships.playerId, playerId),
      ),
    )
    .limit(1);
  return rows[0] ? toDomain(rows[0]) : null;
}
