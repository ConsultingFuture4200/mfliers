/**
 * Targets DAL (T2.1; extended by T3.2 with the claim state-machine writes)
 * — campaign-scoped (constitution §3).
 *
 * Every exported function requires `campaignId: string` as its first,
 * non-optional parameter and includes `eq(targets.campaignId, campaignId)`
 * in its query, per `docs/decisions/0001-tenant-isolation-enforcement.md`.
 * Coordinates are decoded through `lib/db/dal/geo.ts` — callers get typed
 * `{ lat, long }` numbers, never raw EWKB hex.
 *
 * `claimTarget`/`markTargetPendingReview`/`approveTarget`/`rejectTarget`
 * (T3.2) are the sole writers of `targets.state`/`claimed_by`/
 * `claim_expires_at`/`filled_by_submission_id`. Each is a **single
 * conditional `UPDATE ... WHERE ... RETURNING`** — the row-level lock
 * Postgres takes for the duration of an `UPDATE` serializes two concurrent
 * calls racing the same row: the loser's `WHERE` re-evaluates against the
 * winner's already-committed new state and matches zero rows, so it comes
 * back `null` instead of double-writing. This is the "atomic claim" the
 * card requires — never read-then-write across two statements for these
 * transitions (see `lib/target/state-machine.ts`, which is the layer that
 * turns a `null` result into a typed domain error).
 */
import {
  and,
  eq,
  inArray,
  isNotNull,
  lt,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/lib/db/client";
import { submissions, targets } from "@/lib/db/schema";
import type { Coordinate, Target } from "@/types/domain";
import { assertCampaignId } from "./scope";
import { latOf, longOf, toGeography } from "./geo";

/** Claim hold duration (PRD FR-M2/FR-M5): 3 hours from a successful claim. */
export const CLAIM_HOLD_HOURS = 3;

/** Submission decisions that count as "still under review" for the
 * purposes of freezing a claim — see `markTargetPendingReview` and the
 * `NOT EXISTS` guard in `claimTarget`. Decided submissions (`approved` /
 * `rejected`) never block a claim from lapsing. */
const UNDECIDED_DECISIONS = ["pending", "needs_review"] as const;

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

/**
 * Target-proximity distance/within check (T3.4, PRD FR-F1) for the
 * claimed-target fraud check (`lib/fraud/geo.ts`'s `checkProximity`):
 * `ST_DWithin`/`ST_Distance` of `deviceGps` against `targetId`'s `location`
 * column, scoped to `campaignId`. Runs directly against the indexed
 * `location` column (rather than decoding it to lat/long first and
 * comparing in JS) so the check both stays PostGIS-native (constitution
 * §3 — no hand-rolled haversine) and can use `targets_location_gist_idx`.
 *
 * Returns `null` if the target doesn't exist or belongs to a different
 * campaign — same not-found/not-yours conflation as `getTarget`.
 */
export async function checkTargetProximity(
  campaignId: string,
  targetId: string,
  deviceGps: Coordinate,
  radiusM: number,
): Promise<{ withinRadius: boolean; distanceM: number } | null> {
  assertCampaignId(campaignId, "checkTargetProximity");
  const point = toGeography(deviceGps);
  const rows = await db
    .select({
      withinRadius: sql<boolean>`ST_DWithin(${targets.location}, ${point}, ${radiusM})`,
      distanceM: sql<number>`ST_Distance(${targets.location}, ${point})`,
    })
    .from(targets)
    .where(and(eq(targets.campaignId, campaignId), eq(targets.id, targetId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { withinRadius: row.withinRadius, distanceM: Number(row.distanceM) };
}

/**
 * Atomically claims a target for `playerId`: `red -> amber`, or a lapsed
 * `amber` (`claim_expires_at` in the past **and** no undecided submission
 * attached — lazy expiry, card requirement 5) back to a fresh `amber` for
 * the new claimant. Sets `claimed_by` and `claim_expires_at = now() + 3h`.
 *
 * Returns the updated `Target` on success, `null` if the row didn't match
 * (already actively claimed, `green`, or doesn't exist/belong to
 * `campaignId`) — exactly one of two concurrent callers racing the same
 * `targetId` gets a non-null result (see module doc comment). Callers that
 * need to distinguish "not found" from "claim conflict" for a better error
 * message re-read with `getTarget` (see `lib/target/state-machine.ts`).
 */
export async function claimTarget(
  campaignId: string,
  targetId: string,
  playerId: string,
): Promise<Target | null> {
  assertCampaignId(campaignId, "claimTarget");
  const claimExpiresAt = new Date(
    Date.now() + CLAIM_HOLD_HOURS * 60 * 60 * 1000,
  );
  const rows = await db
    .update(targets)
    .set({ state: "amber", claimedBy: playerId, claimExpiresAt })
    .where(
      and(
        eq(targets.campaignId, campaignId),
        eq(targets.id, targetId),
        or(
          eq(targets.state, "red"),
          and(
            eq(targets.state, "amber"),
            isNotNull(targets.claimExpiresAt),
            lt(targets.claimExpiresAt, sql`now()`),
            notExists(
              db
                .select({ one: sql`1` })
                .from(submissions)
                .where(
                  and(
                    eq(submissions.targetId, targets.id),
                    eq(submissions.campaignId, targets.campaignId),
                    inArray(submissions.decision, UNDECIDED_DECISIONS),
                  ),
                ),
            ),
          ),
        ),
      ),
    )
    .returning(targetSelection);
  return rows[0] ?? null;
}

/**
 * Freezes an actively-claimed target's expiry while a submission is under
 * review (card requirement 2): sets `claim_expires_at` to `null` — the
 * lazy-expiry branch in `claimTarget` treats a `null` expiry as "not
 * expired," so the claim can never lapse out from under a pending
 * submission — only `approve`/`reject` (T3.5's pipeline, via `approve`/
 * `reject` below) can move the target out of `amber` after this.
 *
 * Only takes effect while the target is `amber`; returns `null` (a no-op)
 * for `red`/`green` or a nonexistent/foreign target.
 */
export async function markTargetPendingReview(
  campaignId: string,
  targetId: string,
): Promise<Target | null> {
  assertCampaignId(campaignId, "markTargetPendingReview");
  const rows = await db
    .update(targets)
    .set({ claimExpiresAt: null })
    .where(
      and(
        eq(targets.campaignId, campaignId),
        eq(targets.id, targetId),
        eq(targets.state, "amber"),
      ),
    )
    .returning(targetSelection);
  return rows[0] ?? null;
}

/**
 * `amber -> green`: records the approved `submissionId` as the target's
 * `filled_by_submission_id`. A `green` target is never re-claimable (it
 * fails every branch of `claimTarget`'s `WHERE`) — this is the
 * one-claim-per-target invariant (card requirement 6).
 *
 * Only takes effect from `amber`; returns `null` for any other current
 * state or a nonexistent/foreign target — an already-`green` target stays
 * `green` (does not get its `filled_by_submission_id` overwritten by a
 * second call).
 */
export async function approveTarget(
  campaignId: string,
  targetId: string,
  submissionId: string,
): Promise<Target | null> {
  assertCampaignId(campaignId, "approveTarget");
  const rows = await db
    .update(targets)
    .set({ state: "green", filledBySubmissionId: submissionId })
    .where(
      and(
        eq(targets.campaignId, campaignId),
        eq(targets.id, targetId),
        eq(targets.state, "amber"),
      ),
    )
    .returning(targetSelection);
  return rows[0] ?? null;
}

/**
 * `amber -> red`: reopens the target (rejection frees the claim, card
 * context) by clearing `claimed_by`/`claim_expires_at`.
 *
 * Only takes effect from `amber`; returns `null` for any other current
 * state or a nonexistent/foreign target.
 */
export async function rejectTarget(
  campaignId: string,
  targetId: string,
): Promise<Target | null> {
  assertCampaignId(campaignId, "rejectTarget");
  const rows = await db
    .update(targets)
    .set({ state: "red", claimedBy: null, claimExpiresAt: null })
    .where(
      and(
        eq(targets.campaignId, campaignId),
        eq(targets.id, targetId),
        eq(targets.state, "amber"),
      ),
    )
    .returning(targetSelection);
  return rows[0] ?? null;
}
