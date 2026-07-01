/**
 * Target claim state machine (T3.2).
 *
 * PRD FR-M2/FR-M3/FR-M5: `red -> amber -> green`, with `amber -> red` on a
 * 3-hour claim expiry or a rejection. Claim-then-post: a player taps a red
 * pin to claim it (reserving it 3h, anchoring their next submission to
 * that target's coordinates). One-claim-per-target: a filled (`green`)
 * target never accepts a second claim/submission unless an admin reopens
 * it. Rejection reopens the target.
 *
 * Constitution §6: domain logic lives in `lib/`, never in route handlers —
 * this module is the whole implementation; the atomic reads/writes
 * themselves live in `lib/db/dal/targets.ts` (constitution §1: every
 * campaign-scoped write goes through the DAL). This module's job is to
 * turn a DAL `null` (the conditional `UPDATE` matched no row) into a
 * specific, typed reason a route handler can translate to the right HTTP
 * status, and to expose the pure "is this claim still good" predicate the
 * carry-forward note in this batch's task card asks for (T4.1's capture
 * flow needs to query claim state without necessarily re-deriving it from
 * scratch).
 */
import {
  approveTarget,
  claimTarget,
  getTarget,
  markTargetPendingReview,
  rejectTarget,
} from "@/lib/db/dal/targets";
import type { Target } from "@/types/domain";

// ---------------------------------------------------------------------------
// Typed errors (constitution §3: "server logic ... throws typed errors;
// route handlers translate to HTTP status + JSON error" — no silent catches)
// ---------------------------------------------------------------------------

/** Thrown when `targetId` doesn't resolve to a target in `campaignId`. */
export class TargetNotFoundError extends Error {
  readonly status = 404 as const;
  readonly code = "target_not_found" as const;

  constructor(campaignId: string, targetId: string) {
    super(`target ${targetId} not found in campaign ${campaignId}`);
    this.name = "TargetNotFoundError";
  }
}

/** Thrown when a claim attempt loses the race, or targets an already
 * `green` (filled) pin. */
export class ClaimConflictError extends Error {
  readonly status = 409 as const;
  readonly code = "claim_conflict" as const;

  constructor(campaignId: string, targetId: string) {
    super(
      `target ${targetId} in campaign ${campaignId} is not claimable ` +
        "(already actively claimed, or filled)",
    );
    this.name = "ClaimConflictError";
  }
}

/** Thrown when `markPendingReview`/`approve`/`reject` is called against a
 * target that isn't currently `amber` — these are only ever legal
 * transitions out of an active claim. */
export class IllegalTransitionError extends Error {
  readonly status = 409 as const;
  readonly code = "illegal_target_transition" as const;

  constructor(campaignId: string, targetId: string, attempted: string) {
    super(
      `target ${targetId} in campaign ${campaignId} cannot ${attempted} ` +
        "(not currently amber)",
    );
    this.name = "IllegalTransitionError";
  }
}

/**
 * Claims `targetId` for `playerId` (requirement 1). Atomic at the DAL
 * layer (`claimTarget`): of two concurrent callers racing the same
 * target, exactly one gets a `Target` back and the other gets a thrown
 * `ClaimConflictError` — never a double-assign.
 *
 * On a `null` DAL result, re-reads the target (a plain scoped `getTarget`,
 * not part of the atomic write) purely to pick the more specific error —
 * this second read is inherently racy against concurrent writers, but
 * that's fine here: it only affects which *error* is thrown, never whether
 * the write itself succeeded exactly once.
 */
export async function claim(
  campaignId: string,
  targetId: string,
  playerId: string,
): Promise<Target> {
  const claimed = await claimTarget(campaignId, targetId, playerId);
  if (claimed) return claimed;

  const existing = await getTarget(campaignId, targetId);
  if (!existing) throw new TargetNotFoundError(campaignId, targetId);
  throw new ClaimConflictError(campaignId, targetId);
}

/**
 * Freezes the claim's expiry while a submission is under review
 * (requirement 2) — call this when a submission is filed against a
 * claimed target, before the fraud pipeline (T3.5) starts its review, so
 * the 3-hour hold can never lapse while a decision is pending.
 */
export async function markPendingReview(
  campaignId: string,
  targetId: string,
): Promise<Target> {
  const updated = await markTargetPendingReview(campaignId, targetId);
  if (updated) return updated;

  const existing = await getTarget(campaignId, targetId);
  if (!existing) throw new TargetNotFoundError(campaignId, targetId);
  throw new IllegalTransitionError(campaignId, targetId, "mark pending review");
}

/**
 * Approves the claim (requirement 3): `amber -> green`, recording
 * `submissionId` as the target's `filled_by_submission_id`.
 */
export async function approve(
  campaignId: string,
  targetId: string,
  submissionId: string,
): Promise<Target> {
  const updated = await approveTarget(campaignId, targetId, submissionId);
  if (updated) return updated;

  const existing = await getTarget(campaignId, targetId);
  if (!existing) throw new TargetNotFoundError(campaignId, targetId);
  throw new IllegalTransitionError(campaignId, targetId, "approve");
}

/**
 * Rejects the claim (requirement 4): `amber -> red`, clearing the claim
 * fields so the target reopens for any player.
 */
export async function reject(
  campaignId: string,
  targetId: string,
): Promise<Target> {
  const updated = await rejectTarget(campaignId, targetId);
  if (updated) return updated;

  const existing = await getTarget(campaignId, targetId);
  if (!existing) throw new TargetNotFoundError(campaignId, targetId);
  throw new IllegalTransitionError(campaignId, targetId, "reject");
}

/**
 * Pure predicate: is `target` currently an active claim held by
 * `playerId`, per lazy-expiry rules (requirement 5)? Does **not** touch
 * the database or account for an attached-but-undecided submission (only
 * `claimTarget`'s atomic `WHERE` is the authoritative source for that,
 * since it needs a live join against `submissions`) — this is a
 * lightweight, synchronous check over an already-fetched `Target` for
 * call sites that just need "would a *fresh* claim attempt still see this
 * as mine right now."
 *
 * Carry-forward note (this batch's task card, from the Batch-2 review
 * deferral parked on `app/api/uploads/sign/route.ts`): T4.1's capture flow
 * should call this (after `getTarget`) before minting a signed upload URL,
 * so a signed URL is only obtainable for a target the requesting player
 * has actually claimed.
 */
export function isActivelyClaimedBy(
  target: Target,
  playerId: string,
  now: Date = new Date(),
): boolean {
  if (target.state !== "amber" || target.claimedBy !== playerId) {
    return false;
  }
  return (
    target.claimExpiresAt === null ||
    target.claimExpiresAt.getTime() > now.getTime()
  );
}
