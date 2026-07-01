/**
 * Targets DAL (T2.1) — campaign-scoped (constitution §3).
 *
 * Every exported function requires `campaignId: string` as its first,
 * non-optional parameter and includes `eq(targets.campaignId, campaignId)`
 * in its query, per `docs/decisions/0001-tenant-isolation-enforcement.md`.
 * Coordinates are decoded through `lib/db/dal/geo.ts` — callers get typed
 * `{ lat, long }` numbers, never raw EWKB hex.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { targets } from "@/lib/db/schema";
import type { Target } from "@/types/domain";
import { assertCampaignId } from "./scope";
import { latOf, longOf } from "./geo";

const targetSelection = {
  id: targets.id,
  campaignId: targets.campaignId,
  label: targets.label,
  lat: latOf(targets.location),
  long: longOf(targets.location),
  state: targets.state,
  claimedBy: targets.claimedBy,
  claimExpiresAt: targets.claimExpiresAt,
  filledBySubmissionId: targets.filledBySubmissionId,
} as const;

/** Lists every target belonging to `campaignId`. Never returns another
 * campaign's rows. */
export async function listTargets(campaignId: string): Promise<Target[]> {
  assertCampaignId(campaignId, "listTargets");
  const rows = await db
    .select(targetSelection)
    .from(targets)
    .where(eq(targets.campaignId, campaignId));
  return rows;
}

/** Reads a single target scoped to `campaignId`. Returns `null` if the
 * target doesn't exist *or* belongs to a different campaign — a caller can
 * never distinguish "not found" from "found, but not yours." */
export async function getTarget(
  campaignId: string,
  targetId: string,
): Promise<Target | null> {
  assertCampaignId(campaignId, "getTarget");
  const rows = await db
    .select(targetSelection)
    .from(targets)
    .where(and(eq(targets.campaignId, campaignId), eq(targets.id, targetId)))
    .limit(1);
  return rows[0] ?? null;
}
