/**
 * Campaign-memberships DAL (T2.1; extended by T3.1 with the leaderboard
 * snapshot write) — campaign-scoped (constitution §3).
 *
 * Every exported function requires `campaignId: string` as its first,
 * non-optional parameter and includes `eq(campaignMemberships.campaignId,
 * campaignId)` in its query, per
 * `docs/decisions/0001-tenant-isolation-enforcement.md`.
 */
import { and, eq, sql } from "drizzle-orm";
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

/**
 * Writes a final leaderboard-position `rank` onto each named player's
 * membership row (T3.1 requirement 4: campaign close "snapshots final
 * leaderboard ordering"). `lib/campaign/lifecycle.ts` computes `rank`
 * (highest `approvedCount` first, tie-broken by earliest time reaching that
 * count) and is the only caller — this function performs the write only,
 * still scoped to `campaignId`.
 *
 * A single bulk `UPDATE ... FROM (VALUES ...)` in one round trip, not one
 * sequential awaited `UPDATE` per player: at the platform's stated scale
 * ceiling (~2,000 players/campaign, PRD §9), a per-row loop would do up to
 * 2,000 sequential DB round-trips inside `closeCampaign`'s request/response
 * cycle — a real timeout risk on a serverless function invocation.
 */
export async function setMembershipRanks(
  campaignId: string,
  rankings: { playerId: string; rank: number }[],
): Promise<void> {
  assertCampaignId(campaignId, "setMembershipRanks");
  if (rankings.length === 0) return;

  const values = sql.join(
    rankings.map(
      ({ playerId, rank }) => sql`(${playerId}::uuid, ${rank}::integer)`,
    ),
    sql`, `,
  );

  await db.execute(sql`
    UPDATE campaign_memberships AS cm
    SET rank = v.rank
    FROM (VALUES ${values}) AS v(player_id, rank)
    WHERE cm.campaign_id = ${campaignId}
      AND cm.player_id = v.player_id
  `);
}
