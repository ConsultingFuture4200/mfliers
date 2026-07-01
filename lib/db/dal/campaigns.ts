/**
 * Campaigns DAL (T2.1).
 *
 * `campaigns` is the tenant table itself, so "scoping by campaignId" here
 * means "look up the one row whose primary key is that id" rather than a
 * `WHERE campaign_id = ...` predicate on a child table — there is no
 * separate campaign-scoping column to filter by. The exported function
 * still takes `campaignId` as its required first parameter (not `id`),
 * both for naming consistency with the rest of the DAL and so the
 * type-level isolation check in `tests/isolation/isolation.test.ts` (every
 * exported DAL function requires a `campaignId`) covers this module too.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { campaigns } from "@/lib/db/schema";
import type { Campaign } from "@/types/domain";
import { assertCampaignId } from "./scope";

function toDomain(row: typeof campaigns.$inferSelect): Campaign {
  return {
    id: row.id,
    name: row.name,
    flierImageUrl: row.flierImageUrl,
    budgetCapCents: row.budgetCap,
    tierTable: row.tierTable,
    grandPrize: row.grandPrize,
    privacySetting: row.privacySetting,
    proximityRadiusM: row.proximityRadiusM,
    settlementMode: row.settlementMode,
    state: row.state,
    hostId: row.hostId,
    startAt: row.startAt,
    endAt: row.endAt,
  };
}

/** Reads a single campaign by id, or `null` if it doesn't exist. */
export async function getCampaignById(
  campaignId: string,
): Promise<Campaign | null> {
  assertCampaignId(campaignId, "getCampaignById");
  const rows = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  return rows[0] ? toDomain(rows[0]) : null;
}
