/**
 * Submission capture flow — server-side orchestration (T4.1).
 *
 * PRD FR-S1…FR-S5 (quoted in `docs/tasks/batch-4.md`): the player, having
 * claimed a target (T3.2), shoots a rear-camera photo, the client reads
 * device GPS + EXIF GPS/timestamp, compresses the image, uploads it to R2
 * via a signed URL (T2.4), then POSTs this module's input. This module
 * stamps `receivedAt` (constitution §3 — server time is authoritative),
 * persists the submission (`lib/db/dal/submissions.ts`), runs the fraud
 * pipeline (T3.5's `lib/fraud/pipeline.ts`), and dispatches whatever the
 * pipeline decided onto the target state machine (T3.2) — this is the "a
 * route handler (T4.1's capture flow) is the one that actually calls those
 * modules" caller `lib/fraud/pipeline.ts`'s own doc comment names.
 * Constitution §6: this is the domain-logic module; `app/api/campaigns/
 * [id]/submissions/route.ts` stays a thin HTTP <-> this-module translator.
 *
 * ## Idempotency / atomicity (batch-4 carry-forward note, deferred from the
 * T3.5 review — "coordinate the seam with T4.3")
 * `lib/fraud/pipeline.ts`'s own decision-persist and this module's
 * target-flip are two separate statements, not one transaction — a crash
 * between them would otherwise leave `submission.decision = "approved"`
 * with the target still `amber`. This module closes that gap by keying the
 * whole flow off `submissionId` (minted once, at the signed-upload step —
 * `app/api/uploads/sign/route.ts`) as an idempotency token:
 *   - `getOrCreateSubmission` only computes the phash / runs the pipeline
 *     once per `submissionId` (`submission.decision === "pending"` is the
 *     "hasn't been decided yet" signal); a retry that lands after the
 *     decision was already persisted skips straight to re-dispatching
 *     `nextActions` (see `reconstructNextActions`) instead of re-running
 *     fraud checks a second time (some of which, e.g. `travel-speed`,
 *     aren't safe to re-evaluate against a submission that's already
 *     counted as "the previous one").
 *   - `dispatchAction` treats `approve`/`reject` throwing
 *     `IllegalTransitionError` as a **no-op**, not a failure, when the
 *     target has already landed in the exact state this action was trying
 *     to produce (`green` + `filledBySubmissionId` matching this
 *     `submissionId`, or `red`) — so re-running the dispatch loop after a
 *     crash between "approve succeeded" and "response sent" is safe.
 * Net effect: this flow is safe to retry end-to-end by resubmitting the
 * same `submissionId`, which is the "idempotent by (campaignId,
 * submissionId)" half of the carry-forward note's "atomic OR idempotent"
 * requirement.
 *
 * `accrue_ledger` (the third leg of the carry-forward note) is wired to
 * `lib/payout/ledger.ts`'s `accrue` (T4.3) from this same `dispatchAction`
 * switch — the exact seam this module's earlier doc comment (see git
 * history) had reserved for it, keyed by the same `(campaignId,
 * submissionId)` idempotency this module already applies to the
 * target-flip. `accrue` is itself idempotent by that same pair (see
 * `lib/db/dal/payout-ledger.ts`'s `accrueLedgerEntry`), so a retried
 * dispatch loop never double-pays.
 */
import type {
  Campaign,
  Coordinate,
  FraudCheckResult,
  Player,
  Submission,
  SubmissionDecision,
  Target,
  TargetState,
} from "@/types/domain";
import { getCampaignById } from "@/lib/db/dal/campaigns";
import { getTarget } from "@/lib/db/dal/targets";
import {
  countApprovedSubmissions,
  getSubmission,
  insertSubmission,
  recordSubmissionDecision,
} from "@/lib/db/dal/submissions";
import { computePhash } from "@/lib/fraud/dedupe";
import {
  runPipeline,
  type PipelineAction,
  type PipelineResult,
} from "@/lib/fraud/pipeline";
import {
  assertCampaignLive,
  CampaignNotFoundError,
} from "@/lib/campaign/lifecycle";
import {
  approve,
  IllegalTransitionError,
  isActivelyClaimedBy,
  markPendingReview,
  reject,
  TargetNotFoundError,
} from "@/lib/target/state-machine";
import { getObjectBytes, submissionPhotoKey } from "@/lib/storage/r2";
import { accrue } from "@/lib/payout/ledger";
import { appendAuditEntry, auditEntryExists } from "@/lib/audit/log";

// ---------------------------------------------------------------------------
// Typed errors (constitution §3: "server logic ... throws typed errors" —
// no silent catches). Mirrors the shape every other `lib/` module in this
// repo uses (`status`/`code` on the error itself).
// ---------------------------------------------------------------------------

export class InvalidSubmissionInputError extends Error {
  readonly status = 400 as const;
  readonly code = "invalid_submission_input" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidSubmissionInputError";
  }
}

/** Thrown when the client-supplied `photoKey` doesn't match the
 * deterministic key `createSignedUploadUrl` (T2.4) issued for this
 * `(campaignId, submissionId)` pair — a caller can never point this
 * submission at an arbitrary object in the bucket. */
export class PhotoKeyMismatchError extends Error {
  readonly status = 400 as const;
  readonly code = "photo_key_mismatch" as const;

  constructor(campaignId: string, submissionId: string) {
    super(
      `photoKey for submission ${submissionId} in campaign ${campaignId} ` +
        "does not match the key issued at upload time.",
    );
    this.name = "PhotoKeyMismatchError";
  }
}

/** Thrown when `targetId` isn't currently an active claim held by this
 * player (PRD FR-S1's "submission tied to a claimed target," constitution
 * §2 — server-side, not just a hidden button). */
export class TargetNotClaimedError extends Error {
  readonly status = 409 as const;
  readonly code = "target_not_claimed" as const;

  constructor(campaignId: string, targetId: string) {
    super(
      `target ${targetId} in campaign ${campaignId} is not actively ` +
        "claimed by this player.",
    );
    this.name = "TargetNotClaimedError";
  }
}

/** Thrown when the uploaded photo can't be read back from R2 — the
 * client's signed-PUT upload hasn't landed (or never happened) yet. */
export class PhotoNotUploadedError extends Error {
  readonly status = 422 as const;
  readonly code = "photo_not_uploaded" as const;

  constructor(campaignId: string, submissionId: string, cause?: unknown) {
    super(
      `could not read the uploaded photo for submission ${submissionId} ` +
        `in campaign ${campaignId}; has the upload finished?`,
      { cause },
    );
    this.name = "PhotoNotUploadedError";
  }
}

// ---------------------------------------------------------------------------
// Input parsing/validation (kept in `lib/`, not the route handler —
// constitution §6)
// ---------------------------------------------------------------------------

/** Parsed, validated input to `submitCapture`. */
export interface SubmitCaptureInput {
  targetId: string;
  /** Minted at the signed-upload step (`app/api/uploads/sign/route.ts`) —
   * the idempotency key this whole flow is keyed off of (see module doc
   * comment). */
  submissionId: string;
  /** The R2 object key the client uploaded to; validated against the
   * deterministic key this `(campaignId, submissionId)` pair should have
   * (`PhotoKeyMismatchError` otherwise). */
  photoKey: string;
  deviceGps: Coordinate;
  exifGps: Coordinate | null;
  exifTs: Date | null;
  /** Client-reported capture/submit time — see `lib/fraud/time.ts`'s
   * `CheckTimestampsOptions.clientTs` doc comment (NEEDS_CLARIFICATION: not
   * a persisted field). Threaded straight through, never persisted. */
  clientTs: Date | null;
  /** True when the photo came from the gallery-fallback path rather than
   * the default rear-camera capture (card requirement 1: "gallery fallback
   * path sets an auto-flag"). */
  isGalleryFallback: boolean;
}

function parseCoordinate(value: unknown, field: string): Coordinate {
  if (typeof value !== "object" || value === null) {
    throw new InvalidSubmissionInputError(
      `${field} must be a { lat, long } object.`,
    );
  }
  const { lat, long } = value as Record<string, unknown>;
  if (
    typeof lat !== "number" ||
    typeof long !== "number" ||
    Number.isNaN(lat) ||
    Number.isNaN(long)
  ) {
    throw new InvalidSubmissionInputError(
      `${field}.lat and ${field}.long must be numbers.`,
    );
  }
  if (lat < -90 || lat > 90 || long < -180 || long > 180) {
    throw new InvalidSubmissionInputError(`${field} is out of range.`);
  }
  return { lat, long };
}

function parseOptionalDate(value: unknown, field: string): Date | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new InvalidSubmissionInputError(
      `${field} must be an ISO date string.`,
    );
  }
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) {
    throw new InvalidSubmissionInputError(`${field} is not a valid date.`);
  }
  return new Date(ts);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidSubmissionInputError(`${field} is required.`);
  }
  return value;
}

/** Parses and validates a submit request body into `SubmitCaptureInput`.
 * Throws `InvalidSubmissionInputError` on any shape/range problem — never
 * guesses at a default for a required field. */
export function parseSubmitCaptureInput(body: unknown): SubmitCaptureInput {
  if (typeof body !== "object" || body === null) {
    throw new InvalidSubmissionInputError(
      "request body must be a JSON object.",
    );
  }
  const b = body as Record<string, unknown>;

  const targetId = requireNonEmptyString(b.targetId, "targetId");
  const submissionId = requireNonEmptyString(b.submissionId, "submissionId");
  const photoKey = requireNonEmptyString(b.photoKey, "photoKey");
  const deviceGps = parseCoordinate(b.deviceGps, "deviceGps");
  const exifGps =
    b.exifGps === undefined || b.exifGps === null
      ? null
      : parseCoordinate(b.exifGps, "exifGps");
  const exifTs = parseOptionalDate(b.exifTs, "exifTs");
  const clientTs = parseOptionalDate(b.clientTs, "clientTs");
  const isGalleryFallback = b.isGalleryFallback === true;

  return {
    targetId,
    submissionId,
    photoKey,
    deviceGps,
    exifGps,
    exifTs,
    clientTs,
    isGalleryFallback,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface SubmitCaptureResult {
  submissionId: string;
  targetId: string;
  decision: SubmissionDecision;
  fraudChecks: FraudCheckResult[];
  isTier3: boolean;
  /** Confirmation-screen "running total" (card requirement 6). See
   * `countApprovedSubmissions`'s doc comment for why this is derived live
   * rather than read off `campaign_memberships.approved_count`. */
  runningApprovedTotal: number;
  targetState: TargetState;
}

/** Appended to `fraudChecks` when the gallery-fallback path forces a
 * would-have-been-approved submission to `needs_review` (card requirement
 * 1). Not one of `lib/fraud/pipeline.ts`'s five checks — this module adds
 * it itself, since "was this the gallery fallback" is capture-flow
 * context the fraud pipeline never sees. */
function galleryFallbackCheck(): FraudCheckResult {
  return {
    check: "gallery-fallback",
    passed: false,
    detail:
      "submitted via the gallery-upload fallback, not the default rear-" +
      "camera capture; auto-flagged for human review.",
  };
}

/**
 * Forces a `needs_review` outcome for a gallery-sourced submission that the
 * pipeline would otherwise have auto-approved (card requirement 1: gallery
 * upload is a fallback that auto-flags, never a default-path auto-approve).
 * Only touches an `approved` decision — a hard-fail `rejected` or an
 * already-`needs_review` outcome is left as-is; the gallery flag doesn't
 * relax an existing fraud signal, it only removes an auto-approve.
 */
async function forceGalleryReview(
  campaign: Campaign,
  submission: Submission,
  pipelineResult: PipelineResult,
): Promise<PipelineResult> {
  if (pipelineResult.decision !== "approved") return pipelineResult;

  const fraudChecks = [...pipelineResult.fraudChecks, galleryFallbackCheck()];
  await recordSubmissionDecision(
    campaign.id,
    submission.id,
    fraudChecks,
    "needs_review",
  );
  return {
    ...pipelineResult,
    decision: "needs_review",
    fraudChecks,
    nextActions: [],
  };
}

/**
 * Rebuilds the `PipelineAction[]` a retry should dispatch from an
 * already-decided submission, without re-running any fraud check —
 * deliberately mirrors `lib/fraud/pipeline.ts`'s own `nextActions`
 * derivation (see that module for the canonical version); duplicated here
 * rather than re-running `runPipeline` because some checks (`travel-speed`)
 * aren't safe to re-evaluate against a submission that's already persisted
 * as "the previous one."
 */
function reconstructNextActions(
  campaign: Campaign,
  submission: Submission,
): PipelineAction[] {
  if (submission.decision === "approved") {
    return [
      {
        type: "approve_target",
        campaignId: campaign.id,
        targetId: submission.targetId,
        submissionId: submission.id,
      },
      {
        type: "accrue_ledger",
        campaignId: campaign.id,
        submissionId: submission.id,
        playerId: submission.playerId,
      },
    ];
  }
  if (submission.decision === "rejected") {
    return [
      {
        type: "reject_target",
        campaignId: campaign.id,
        targetId: submission.targetId,
      },
    ];
  }
  return [];
}

/** Applies one `PipelineAction` to the target state machine, tolerating a
 * retry that lands after a prior attempt already applied it (see module
 * doc comment's idempotency section). `accrue_ledger` calls
 * `lib/payout/ledger.ts`'s `accrue` (T4.3), itself idempotent by
 * `(campaignId, submissionId)` — see module doc comment. */
async function dispatchAction(action: PipelineAction): Promise<void> {
  switch (action.type) {
    case "approve_target": {
      try {
        await approve(action.campaignId, action.targetId, action.submissionId);
      } catch (err) {
        if (err instanceof IllegalTransitionError) {
          const current = await getTarget(action.campaignId, action.targetId);
          if (
            current?.state === "green" &&
            current.filledBySubmissionId === action.submissionId
          ) {
            return; // already applied by a prior attempt — retry-safe no-op
          }
        }
        throw err;
      }
      return;
    }
    case "reject_target": {
      try {
        await reject(action.campaignId, action.targetId);
      } catch (err) {
        if (err instanceof IllegalTransitionError) {
          const current = await getTarget(action.campaignId, action.targetId);
          if (current?.state === "red") return; // already reopened
        }
        throw err;
      }
      return;
    }
    case "accrue_ledger": {
      // T4.3: real ledger accrual, idempotent by (campaignId, submissionId)
      // — see lib/payout/ledger.ts's accrue and lib/db/dal/payout-ledger.ts's
      // accrueLedgerEntry for the atomicity/idempotency design.
      await accrue(action.campaignId, action.submissionId, action.playerId);
      // Batch-4 review fix (Liotta): auto-approval is the majority
      // decision path but previously wrote no audit row, leaving most
      // payout obligations with no "who/when approved" trail (constitution
      // §5's "immutable, append-only log of all approvals"). `actorUserId:
      // null` marks this as a system/pipeline decision, not a human one,
      // see lib/db/schema/audit-log.ts's doc comment. Guarded by an
      // existence check (not just relying on a fresh insert) since
      // `dispatchAction` can be re-driven on retry for the exact same
      // action.
      const alreadyLogged = await auditEntryExists(
        action.campaignId,
        action.submissionId,
        "approve",
      );
      if (!alreadyLogged) {
        await appendAuditEntry(action.campaignId, {
          submissionId: action.submissionId,
          playerId: action.playerId,
          actorUserId: null,
          action: "approve",
          reason: "auto-approved by fraud pipeline",
        });
      }
      return;
    }
  }
}

/**
 * Runs the full capture-submission flow for an already-authenticated
 * `player` (card requirements 5–6): loads the campaign/target, verifies the
 * claim, computes the server-side phash + stamps `receivedAt`, persists the
 * submission, runs the fraud pipeline, dispatches the resulting target-state
 * action(s), and returns the confirmation payload.
 *
 * Idempotent by `input.submissionId` — see module doc comment.
 */
export async function submitCapture(
  campaignId: string,
  player: Player,
  input: SubmitCaptureInput,
): Promise<SubmitCaptureResult> {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) throw new CampaignNotFoundError(campaignId);
  // Server-side, not just a hidden button (constitution §2): a submission
  // against a draft/closed campaign is rejected even via a direct API call.
  assertCampaignLive(campaign);

  const expectedKey = submissionPhotoKey(campaignId, input.submissionId);
  if (input.photoKey !== expectedKey) {
    throw new PhotoKeyMismatchError(campaignId, input.submissionId);
  }

  const target = await getTarget(campaignId, input.targetId);
  if (!target) throw new TargetNotFoundError(campaignId, input.targetId);

  let submission = await getSubmission(campaignId, input.submissionId);

  if (!submission) {
    if (!isActivelyClaimedBy(target, player.id)) {
      throw new TargetNotClaimedError(campaignId, input.targetId);
    }

    let photoBytes: Buffer;
    try {
      photoBytes = await getObjectBytes(campaignId, input.submissionId);
    } catch (err) {
      throw new PhotoNotUploadedError(campaignId, input.submissionId, err);
    }
    const phash = await computePhash(photoBytes);

    // Freeze the 3h claim hold before the pipeline runs (state-machine.ts's
    // own doc comment: "call this when a submission is filed ... before the
    // fraud pipeline starts its review, so the hold can never lapse while a
    // decision is pending").
    await markPendingReview(campaignId, input.targetId);

    submission = await insertSubmission(campaignId, input.submissionId, {
      playerId: player.id,
      targetId: input.targetId,
      photoUrl: expectedKey,
      deviceGps: input.deviceGps,
      exifGps: input.exifGps,
      exifTs: input.exifTs,
      phash,
      receivedAt: new Date(),
    });
  }

  let pipelineResult: PipelineResult;
  if (submission.decision === "pending") {
    pipelineResult = await runPipeline(submission, campaign, player, {
      clientTs: input.clientTs ?? undefined,
    });
    if (input.isGalleryFallback) {
      pipelineResult = await forceGalleryReview(
        campaign,
        submission,
        pipelineResult,
      );
    }
  } else {
    // Retry after the decision was already persisted — don't re-run fraud
    // checks (see module doc comment); just re-derive what to dispatch.
    pipelineResult = {
      decision: submission.decision,
      fraudChecks: submission.fraudChecks,
      isTier3: false,
      nextActions: reconstructNextActions(campaign, submission),
    };
  }

  for (const action of pipelineResult.nextActions) {
    await dispatchAction(action);
  }

  const [finalTarget, runningApprovedTotal] = await Promise.all([
    getTarget(campaignId, input.targetId) as Promise<Target | null>,
    countApprovedSubmissions(campaignId, player.id),
  ]);

  return {
    submissionId: submission.id,
    targetId: input.targetId,
    decision: pipelineResult.decision,
    fraudChecks: pipelineResult.fraudChecks,
    isTier3: pipelineResult.isTier3,
    runningApprovedTotal,
    targetState: finalTarget?.state ?? target.state,
  };
}
