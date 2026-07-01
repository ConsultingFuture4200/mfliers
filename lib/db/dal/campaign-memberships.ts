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
 * Creates the membership row for `playerId` joining `campaignId` (T5.1's
 * "join campaign" action — PRD FR-L5's "join"; also the carry-forward gap
 * flagged since T3.2/T4.1: `claim`/`submitCapture` both require an
 * existing `campaign_memberships` row, but nothing before this card
 * created one outside a seed script). Idempotent via `ON CONFLICT DO
 * NOTHING` on the composite `(campaign_id, player_id)` primary key, so a
 * repeated join (double-tap, retried request) never errors and never
 * resets an existing member's `approvedCount`/`balanceOwed`/`rank` back to
 * their defaults. `lib/campaign/membership.ts` is the only intended
 * caller and is responsible for checking the campaign exists and is
 * `live` before calling this — this function performs the write only.
 */
export async function insertMembership(
  campaignId: string,
  playerId: string,
): Promise<CampaignMembership> {
  assertCampaignId(campaignId, "insertMembership");
  const [inserted] = await db
    .insert(campaignMemberships)
    .values({ campaignId, playerId })
    .onConflictDoNothing({
      target: [campaignMemberships.campaignId, campaignMemberships.playerId],
    })
    .returning();
  if (inserted) return toDomain(inserted);

  // Lost the race (or this is a genuine repeat join) — the row already
  // exists. Re-read and return it rather than treating the conflict as an
  // error, per the idempotency contract above.
  const existing = await getMembership(campaignId, playerId);
  if (!existing) {
    throw new Error(
      `insertMembership: conflict on (${campaignId}, ${playerId}) but no ` +
        "row found on re-read.",
    );
  }
  return existing;
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
