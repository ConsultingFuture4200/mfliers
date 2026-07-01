/**
 * Universal map DAL (T2.1) — the ONE sanctioned cross-campaign read.
 *
 * Constitution §1/§5 and the T2.1 card: "Cross-campaign data access by a
 * host or player is a critical vulnerability... There is exactly one
 * sanctioned cross-campaign read (the universal map) and it exposes no
 * private fields." PRD FR-L2. Every other DAL module in `lib/db/dal/`
 * requires a `campaignId`; this module is the deliberate, explicitly-named
 * exception, so its exceptional status is obvious at every call site and
 * in a `grep` for "cross-campaign" — there is no other function like it.
 *
 * Per the card: "in v1 return campaign id + pin state + coords + photo url
 * only." The target's own database id is included too — it carries no PII
 * (it is not a username, location label, or ledger figure) and a map UI
 * needs a stable per-pin identity for interaction/keys; everything else
 * genuinely private (host identity, player identity, ledger/budget data,
 * claim ownership) is intentionally omitted.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { campaigns, submissions, targets } from "@/lib/db/schema";
import type { TargetState } from "@/types/domain";
import { latOf, longOf } from "./geo";

/** A single public-safe pin on the universal (cross-campaign) map. */
export interface PublicPin {
  campaignId: string;
  id: string;
  state: TargetState;
  lat: number;
  long: number;
  /** The flier photo for a filled (green) pin, if any. Never a player or
   * host identifier. */
  photoUrl: string | null;
}

/**
 * Returns every target across every currently-`live` campaign, as
 * public-safe pins only. No usernames, no player/host identity, no
 * ledger/budget data — see module doc comment.
 */
export async function getPublicPinsAcrossLiveCampaigns(): Promise<PublicPin[]> {
  const rows = await db
    .select({
      campaignId: targets.campaignId,
      id: targets.id,
      state: targets.state,
      lat: latOf(targets.location),
      long: longOf(targets.location),
      photoUrl: submissions.photoUrl,
    })
    .from(targets)
    .innerJoin(campaigns, eq(targets.campaignId, campaigns.id))
    .leftJoin(
      submissions,
      and(
        eq(submissions.id, targets.filledBySubmissionId),
        // Belt-and-suspenders: even though the DB-level composite FK
        // (see lib/db/schema/targets.ts) already guarantees a target's
        // filling submission belongs to the same campaign, this join
        // condition doesn't rely on that alone.
        eq(submissions.campaignId, targets.campaignId),
      ),
    )
    .where(eq(campaigns.state, "live"));

  return rows.map((row) => ({
    campaignId: row.campaignId,
    id: row.id,
    state: row.state,
    lat: row.lat,
    long: row.long,
    photoUrl: row.photoUrl ?? null,
  }));
}
