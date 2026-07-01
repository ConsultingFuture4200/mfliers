/**
 * Host review-queue decision orchestration (T4.2) — PRD FR-R1…FR-R4:
 * "Approve/Reject + reason code. Approve → target green + payout accrual
 * against that campaign's budget. Reject → target red, claim freed.
 * Rejection reason visible to player. Audit-logged manual adjustments."
 *
 * Constitution §6: domain logic lives in `lib/`, never in route handlers —
 * `app/api/host/campaigns/[id]/submissions/[sid]/decision/route.ts` is a
 * thin HTTP <-> this-module translator. Constitution §5: authorization is
 * server-side on every request — every export here takes an
 * already-resolved `StaffPrincipal` (mirrors `lib/campaign/lifecycle.ts`'s
 * shape) and calls `requireCampaignAccess` first, before touching the DAL,
 * so a host can never act on another campaign's submission (card
 * anti-requirement 1).
 *
 * ## Reason storage / player visibility (card requirement 4)
 * There is no dedicated "rejection reason" column on `submissions` (T1.3's
 * schema doesn't have one, and this card's Files list doesn't touch
 * `lib/db/schema/submissions.ts`). Reused the exact pattern T4.1's
 * `forceGalleryReview` already established for exactly this kind of
 * "attach reviewer context onto a decision" need: append a synthetic
 * `FraudCheckResult` (`check: "host-decision"`) onto the submission's
 * existing `fraudChecks` array rather than replacing it — the original
 * pipeline checks stay visible, and the reason code rides along on the
 * same `Submission.fraudChecks` field a future player-facing
 * submission-status view would already read. NEEDS_CLARIFICATION: if a
 * later card adds a dedicated player-facing endpoint, a reviewer may
 * prefer a first-class `review_reason` column instead — flagged here and
 * in `tasks/lessons.md` rather than silently picking a schema change this
 * card's file list doesn't cover.
 *
 * ## Ledger accrual (card requirement 3, PRD FR-R3)
 * `accrueLedgerForApproval` below calls `lib/payout/ledger.ts`'s `accrue`
 * (T4.3) — the second, independent call site (a host manually approving a
 * `needs_review` submission) alongside `lib/capture/submit.ts`'s
 * `dispatchAction`'s `accrue_ledger` case (the auto-approve path), both
 * keyed by the same `(campaignId, submissionId)` idempotency `accrue`
 * itself guarantees. Anti-requirement 3 ("do NOT compute payout amounts
 * here — call the ledger") is honored literally: no amount is computed
 * anywhere in this module.
 *
 * ## Idempotency / atomicity (batch-4 review fix, Liotta)
 * Mirrors `lib/capture/submit.ts`'s idempotency design: `approveSubmission`
 * never re-runs the target transition or re-appends a second
 * `host-decision` fraud-check entry when the submission is already
 * `approved`, and both `approve`/`reject`'s `IllegalTransitionError` are
 * tolerated as retry-safe no-ops when the target has already landed in the
 * exact state this call wanted — same shape as `lib/capture/submit.ts`'s
 * `dispatchAction`.
 *
 * The full "flip target green, record the decision, accrue the ledger,
 * append the audit row" sequence spans four separate statements/
 * transactions, not one: a crash between `recordReviewDecision` and
 * `accrue()` used to permanently strand an approved/green submission with
 * no ledger row and no audit trail, because the already-approved
 * short-circuit above returned early without ever reaching either. Fixed
 * by `ensureApprovalSideEffects`: it re-drives both the ledger accrual
 * (idempotent by `(campaignId, submissionId)`) and the audit append
 * (guarded by `auditEntryExists`, since the audit log is append-only) on
 * *every* call that lands here, whether this is the first approval or a
 * retry of one that already happened.
 */
import { requireCampaignAccess } from "@/lib/auth/guards";
import type { StaffPrincipal } from "@/lib/auth/staff";
import { getCampaignById } from "@/lib/db/dal/campaigns";
import { getTarget } from "@/lib/db/dal/targets";
import { getSubmission, recordReviewDecision } from "@/lib/db/dal/submissions";
import { appendAuditEntry, auditEntryExists } from "@/lib/audit/log";
import { accrue } from "@/lib/payout/ledger";
import {
  approve,
  IllegalTransitionError,
  reject,
  TargetNotFoundError,
} from "@/lib/target/state-machine";
import type { FraudCheckResult, Submission, Target } from "@/types/domain";

// ---------------------------------------------------------------------------
// Typed errors (constitution §3: "server logic ... throws typed errors" —
// no silent catches)
// ---------------------------------------------------------------------------

export class CampaignNotFoundError extends Error {
  readonly status = 404 as const;
  readonly code = "campaign_not_found" as const;

  constructor(campaignId: string) {
    super(`campaign ${campaignId} not found`);
    this.name = "CampaignNotFoundError";
  }
}

/** Thrown when `submissionId` doesn't resolve within `campaignId` — mirrors
 * every scoped DAL's not-found/not-yours conflation (never distinguishes
 * "doesn't exist" from "belongs to another campaign," so a host can't
 * probe for another campaign's submission ids). */
export class SubmissionNotFoundError extends Error {
  readonly status = 404 as const;
  readonly code = "submission_not_found" as const;

  constructor(campaignId: string, submissionId: string) {
    super(`submission ${submissionId} not found in campaign ${campaignId}`);
    this.name = "SubmissionNotFoundError";
  }
}

/** Thrown when a decision is requested against a submission that isn't
 * currently `needs_review` and isn't already decided the same way this
 * call would decide it (see module doc comment's idempotency section). */
export class SubmissionNotUnderReviewError extends Error {
  readonly status = 409 as const;
  readonly code = "submission_not_under_review" as const;

  constructor(campaignId: string, submissionId: string, decision: string) {
    super(
      `submission ${submissionId} in campaign ${campaignId} is "${decision}", ` +
        'not "needs_review" — it cannot be approved/rejected again.',
    );
    this.name = "SubmissionNotUnderReviewError";
  }
}

/** Thrown when a reject/manual-adjustment call is missing its required
 * reason code (PRD FR-R2: "Approve/Reject + reason code"). */
export class ReasonRequiredError extends Error {
  readonly status = 400 as const;
  readonly code = "reason_required" as const;

  constructor(message: string) {
    super(message);
    this.name = "ReasonRequiredError";
  }
}

export interface ReviewDecisionResult {
  submission: Submission;
  target: Target;
}

/** Appends the reviewer's decision + reason code onto the submission's
 * existing `fraudChecks` — see module doc comment's "reason storage"
 * section. Never replaces the array; the pipeline's original checks stay
 * visible on the card (card requirement 2). */
function appendHostDecisionCheck(
  existing: FraudCheckResult[],
  action: "approve" | "reject",
  reasonCode: string | null,
): FraudCheckResult[] {
  const check: FraudCheckResult = {
    check: "host-decision",
    passed: action === "approve",
    detail: reasonCode ? `${action}: ${reasonCode}` : action,
  };
  return [...existing, check];
}

/** Applies `approve` (T3.2's state machine), tolerating a retry that lands
 * after a prior attempt already flipped the target green for this exact
 * submission — see module doc comment's idempotency section. */
async function approveTargetRetrySafe(
  campaignId: string,
  targetId: string,
  submissionId: string,
): Promise<Target> {
  try {
    return await approve(campaignId, targetId, submissionId);
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      const current = await getTarget(campaignId, targetId);
      if (
        current?.state === "green" &&
        current.filledBySubmissionId === submissionId
      ) {
        return current;
      }
    }
    throw err;
  }
}

/** Applies `reject` (T3.2's state machine), tolerating a retry that lands
 * after a prior attempt already reopened the target — see module doc
 * comment's idempotency section. */
async function rejectTargetRetrySafe(
  campaignId: string,
  targetId: string,
): Promise<Target> {
  try {
    return await reject(campaignId, targetId);
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      const current = await getTarget(campaignId, targetId);
      if (current?.state === "red") return current;
    }
    throw err;
  }
}

async function loadForDecision(
  principal: StaffPrincipal,
  campaignId: string,
  submissionId: string,
): Promise<Submission> {
  requireCampaignAccess(principal, campaignId);
  const campaign = await getCampaignById(campaignId);
  if (!campaign) throw new CampaignNotFoundError(campaignId);
  const submission = await getSubmission(campaignId, submissionId);
  if (!submission) throw new SubmissionNotFoundError(campaignId, submissionId);
  return submission;
}

/**
 * Ledger accrual seam (card requirement 3, PRD FR-R3). Calls
 * `lib/payout/ledger.ts`'s `accrue` (T4.3), idempotent by
 * `(campaignId, submissionId)` — a retried/double-clicked approve never
 * double-pays, per `lib/capture/submit.ts`'s established convention for
 * the sibling auto-approve seam.
 */
async function accrueLedgerForApproval(
  campaignId: string,
  submissionId: string,
  playerId: string,
): Promise<void> {
  await accrue(campaignId, submissionId, playerId);
}

/**
 * Re-drives approval's two side effects (ledger accrual + audit row):
 * both idempotent, so this is safe to call every time `approveSubmission`
 * is asked to approve a submission that's already `approved`, not just on
 * the first, fresh approval (batch-4 review fix, Liotta).
 *
 * Without this, a partial failure between `recordReviewDecision` (which
 * flips `submission.decision` to `"approved"`) and `accrue()` permanently
 * left an approved/green submission with no ledger row and no audit
 * entry: the prior code's already-approved early-return short-circuited
 * before ever reaching either. `accrue` is idempotent by
 * `(campaignId, submissionId)` (`lib/db/dal/payout-ledger.ts`'s
 * `accrueLedgerEntry`); the audit append is guarded by `auditEntryExists`
 * so a retry never writes a second `approve` row for the same submission
 * (the audit log is append-only, not "insert on every call").
 */
async function ensureApprovalSideEffects(
  principal: StaffPrincipal,
  campaignId: string,
  submissionId: string,
  playerId: string,
  reasonCode: string | null,
): Promise<void> {
  await accrueLedgerForApproval(campaignId, submissionId, playerId);

  const alreadyLogged = await auditEntryExists(
    campaignId,
    submissionId,
    "approve",
  );
  if (!alreadyLogged) {
    await appendAuditEntry(campaignId, {
      submissionId,
      playerId,
      actorUserId: principal.userId,
      action: "approve",
      reason: reasonCode,
    });
  }
}

/**
 * Approves a `needs_review` submission (card requirement 3): flips its
 * target to `green` (T3.2), stamps the decision + reviewer + reason
 * (requirement 4/5's audit trail), and accrues the ledger (T4.3). Never
 * computes a payout amount itself (anti-requirement 3).
 */
export async function approveSubmission(
  principal: StaffPrincipal,
  campaignId: string,
  submissionId: string,
  reasonCode?: string | null,
): Promise<ReviewDecisionResult> {
  const submission = await loadForDecision(principal, campaignId, submissionId);

  if (submission.decision === "approved") {
    // Idempotent retry: already approved by a prior attempt at this exact
    // decision. Never re-append a second host-decision check (the
    // submission's fraudChecks array already has one from the fresh
    // approval), but DO re-drive the ledger accrual + audit append: a
    // prior attempt may have flipped `decision` to "approved" and then
    // crashed before either of those ran (see `ensureApprovalSideEffects`
    // doc comment). Both are idempotent, so this is safe even when the
    // prior attempt fully succeeded.
    const target = await getTarget(campaignId, submission.targetId);
    if (!target) throw new TargetNotFoundError(campaignId, submission.targetId);
    await ensureApprovalSideEffects(
      principal,
      campaignId,
      submissionId,
      submission.playerId,
      reasonCode ?? null,
    );
    return { submission, target };
  }
  if (submission.decision !== "needs_review") {
    throw new SubmissionNotUnderReviewError(
      campaignId,
      submissionId,
      submission.decision,
    );
  }

  const target = await approveTargetRetrySafe(
    campaignId,
    submission.targetId,
    submissionId,
  );

  const fraudChecks = appendHostDecisionCheck(
    submission.fraudChecks,
    "approve",
    reasonCode ?? null,
  );
  const updated = await recordReviewDecision(
    campaignId,
    submissionId,
    "approved",
    fraudChecks,
    principal.userId,
  );
  if (!updated) throw new SubmissionNotFoundError(campaignId, submissionId);

  await ensureApprovalSideEffects(
    principal,
    campaignId,
    submissionId,
    submission.playerId,
    reasonCode ?? null,
  );

  return { submission: updated, target };
}

/**
 * Rejects a `needs_review` submission (card requirement 3): reopens its
 * target to `red` and frees the claim (T3.2), stamps the decision +
 * reviewer + a **required** reason code (PRD FR-R2/FR-R4, card requirement
 * 4 — "rejection reason visible to player"), and audit-logs the action.
 */
export async function rejectSubmission(
  principal: StaffPrincipal,
  campaignId: string,
  submissionId: string,
  reasonCode: string,
): Promise<ReviewDecisionResult> {
  if (!reasonCode || reasonCode.trim().length === 0) {
    throw new ReasonRequiredError(
      `a reason code is required to reject submission ${submissionId}.`,
    );
  }

  const submission = await loadForDecision(principal, campaignId, submissionId);

  if (submission.decision === "rejected") {
    // Idempotent retry — see approveSubmission's matching branch.
    const target = await getTarget(campaignId, submission.targetId);
    if (!target) throw new TargetNotFoundError(campaignId, submission.targetId);
    return { submission, target };
  }
  if (submission.decision !== "needs_review") {
    throw new SubmissionNotUnderReviewError(
      campaignId,
      submissionId,
      submission.decision,
    );
  }

  const target = await rejectTargetRetrySafe(campaignId, submission.targetId);

  const fraudChecks = appendHostDecisionCheck(
    submission.fraudChecks,
    "reject",
    reasonCode,
  );
  const updated = await recordReviewDecision(
    campaignId,
    submissionId,
    "rejected",
    fraudChecks,
    principal.userId,
  );
  if (!updated) throw new SubmissionNotFoundError(campaignId, submissionId);

  await appendAuditEntry(campaignId, {
    submissionId,
    playerId: submission.playerId,
    actorUserId: principal.userId,
    action: "reject",
    reason: reasonCode,
  });

  return { submission: updated, target };
}

/**
 * Manual point/payout adjustment (card requirement 6, PRD FR-R4) —
 * audit-logged only. This card's anti-requirement 3 ("do NOT compute
 * payout amounts here — call the ledger") means this deliberately does
 * NOT move any money or touch `campaign_memberships`/`payout_ledger` — it
 * records a host's adjustment *decision* (a reason a reviewer can attach
 * to a player's record) as an immutable audit row. T4.3, once it exists,
 * is where an actual ledger-amount adjustment entry point should live;
 * this function is the audit-trail half FR-R4 asks for today.
 */
export async function recordManualAdjustment(
  principal: StaffPrincipal,
  campaignId: string,
  playerId: string,
  reasonCode: string,
): Promise<void> {
  if (!reasonCode || reasonCode.trim().length === 0) {
    throw new ReasonRequiredError(
      `a reason code is required to adjust player ${playerId}'s record.`,
    );
  }
  requireCampaignAccess(principal, campaignId);
  const campaign = await getCampaignById(campaignId);
  if (!campaign) throw new CampaignNotFoundError(campaignId);

  await appendAuditEntry(campaignId, {
    submissionId: null,
    playerId,
    actorUserId: principal.userId,
    action: "adjust",
    reason: reasonCode,
  });
}

/**
 * Convenience wrapper for the review-queue route (`.../submissions/[sid]/
 * decision`): resolves `submissionId`'s player and delegates to
 * `recordManualAdjustment`. A review card already knows which submission
 * (and therefore which player) it's adjusting; this lets the same route
 * that handles approve/reject also handle FR-R4's manual adjustment
 * without the client needing to independently know/send a `playerId`.
 */
export async function recordManualAdjustmentForSubmission(
  principal: StaffPrincipal,
  campaignId: string,
  submissionId: string,
  reasonCode: string,
): Promise<void> {
  const submission = await loadForDecision(principal, campaignId, submissionId);
  await recordManualAdjustment(
    principal,
    campaignId,
    submission.playerId,
    reasonCode,
  );
}
