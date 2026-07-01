/**
 * Submissions DAL (T2.1) — campaign-scoped (constitution §3).
 *
 * Every exported function requires `campaignId: string` as its first,
 * non-optional parameter and includes `eq(submissions.campaignId,
 * campaignId)` in its query, per
 * `docs/decisions/0001-tenant-isolation-enforcement.md`. `deviceGps`/
 * `exifGps` are decoded through `lib/db/dal/geo.ts`; `receivedAt` is read
 * as stored (server-stamped at insert time — constitution §3, time — never
 * recomputed here).
 */
import { and, desc, eq, lt, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { submissions } from "@/lib/db/schema";
import type {
  Coordinate,
  FraudCheckResult,
  Submission,
  SubmissionDecision,
} from "@/types/domain";
import { assertCampaignId } from "./scope";
import { latOf, longOf, toGeography } from "./geo";

const submissionSelection = {
  id: submissions.id,
  campaignId: submissions.campaignId,
  playerId: submissions.playerId,
  targetId: submissions.targetId,
  photoUrl: submissions.photoUrl,
  deviceLat: latOf(submissions.deviceGps),
  deviceLong: longOf(submissions.deviceGps),
  exifLat: latOf(submissions.exifGps),
  exifLong: longOf(submissions.exifGps),
  exifTs: submissions.exifTs,
  receivedAt: submissions.receivedAt,
  phash: submissions.phash,
  fraudChecks: submissions.fraudChecks,
  decision: submissions.decision,
  decidedBy: submissions.decidedBy,
  decidedAt: submissions.decidedAt,
} as const;

interface SubmissionRow {
  id: string;
  campaignId: string;
  playerId: string;
  targetId: string;
  photoUrl: string;
  deviceLat: number;
  deviceLong: number;
  exifLat: number | null;
  exifLong: number | null;
  exifTs: Date | null;
  receivedAt: Date;
  phash: string;
  fraudChecks: FraudCheckResult[];
  decision: SubmissionDecision;
  decidedBy: string | null;
  decidedAt: Date | null;
}

function toDomain(row: SubmissionRow): Submission {
  const exifGps: Coordinate | null =
    row.exifLat !== null && row.exifLong !== null
      ? { lat: row.exifLat, long: row.exifLong }
      : null;

  return {
    id: row.id,
    campaignId: row.campaignId,
    playerId: row.playerId,
    targetId: row.targetId,
    photoUrl: row.photoUrl,
    deviceGps: { lat: row.deviceLat, long: row.deviceLong },
    exifGps,
    exifTs: row.exifTs,
    receivedAt: row.receivedAt,
    phash: row.phash,
    fraudChecks: row.fraudChecks,
    decision: row.decision,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
  };
}

/** Lists every submission belonging to `campaignId`. Never returns another
 * campaign's rows. */
export async function listSubmissions(
  campaignId: string,
): Promise<Submission[]> {
  assertCampaignId(campaignId, "listSubmissions");
  const rows = await db
    .select(submissionSelection)
    .from(submissions)
    .where(eq(submissions.campaignId, campaignId));
  return rows.map(toDomain);
}

/** Reads a single submission scoped to `campaignId`. Returns `null` if the
 * submission doesn't exist *or* belongs to a different campaign. */
export async function getSubmission(
  campaignId: string,
  submissionId: string,
): Promise<Submission | null> {
  assertCampaignId(campaignId, "getSubmission");
  const rows = await db
    .select(submissionSelection)
    .from(submissions)
    .where(
      and(
        eq(submissions.campaignId, campaignId),
        eq(submissions.id, submissionId),
      ),
    )
    .limit(1);
  return rows[0] ? toDomain(rows[0]) : null;
}

/**
 * Finds `playerId`'s most recent submission within `campaignId` that was
 * `received_at` strictly before `beforeReceivedAt` (optionally excluding
 * `excludeSubmissionId`, so re-checking an already-persisted submission
 * never matches itself) — the travel-speed anomaly check's (T3.4, PRD
 * FR-F6, `lib/fraud/time.ts`'s `checkTravelSpeed`) "player's previous
 * submission" lookup. Scoped to `campaignId` per constitution §3
 * (campaign-scoped tables are never queried without a `campaign_id`
 * predicate) — a player's posts in a *different* campaign are not this
 * check's concern. Returns `null` when there is no such prior submission
 * (nothing to compare against, e.g. the player's first post).
 */
export async function getPreviousSubmission(
  campaignId: string,
  playerId: string,
  beforeReceivedAt: Date,
  excludeSubmissionId?: string,
): Promise<{ deviceGps: Coordinate; receivedAt: Date } | null> {
  assertCampaignId(campaignId, "getPreviousSubmission");
  const conditions = [
    eq(submissions.campaignId, campaignId),
    eq(submissions.playerId, playerId),
    lt(submissions.receivedAt, beforeReceivedAt),
  ];
  if (excludeSubmissionId) {
    conditions.push(ne(submissions.id, excludeSubmissionId));
  }
  const rows = await db
    .select({
      deviceLat: latOf(submissions.deviceGps),
      deviceLong: longOf(submissions.deviceGps),
      receivedAt: submissions.receivedAt,
    })
    .from(submissions)
    .where(and(...conditions))
    .orderBy(desc(submissions.receivedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    deviceGps: { lat: row.deviceLat, long: row.deviceLong },
    receivedAt: row.receivedAt,
  };
}

/** Input for `insertSubmission` (T4.1's capture flow, card requirement 5:
 * "persists the submission" with a server-stamped `receivedAt`). Every
 * field the schema requires except `campaignId`/`id`, which are the
 * function's own explicit parameters. */
export interface NewSubmissionInput {
  playerId: string;
  targetId: string;
  /** The R2 object key (`lib/storage/r2.ts`'s `submissionPhotoKey`), never
   * a full URL — matches this DAL's existing `photoUrl` naming even though
   * it stores a key, not a URL (pre-existing naming from T1.3's schema). */
  photoUrl: string;
  deviceGps: Coordinate;
  exifGps: Coordinate | null;
  exifTs: Date | null;
  phash: string;
  /** Server-stamped receipt time (constitution §3 — never a client value).
   * Passed in rather than defaulted here so the caller's "when did the
   * server receive this" decision is visible at the call site. */
  receivedAt: Date;
}

/**
 * Inserts a new submission row (card requirement 5). `submissionId` is
 * minted by the caller (mirrors `app/api/uploads/sign/route.ts`'s
 * `randomUUID()` — the same id a signed-upload URL was already issued for,
 * so the object this submission's `photoUrl` key points at was written by
 * that earlier call) rather than left to the schema's `defaultRandom()`, so
 * a retried POST (same `submissionId`, e.g. a client retry after a network
 * blip) can be idempotent: `onConflictDoNothing` + re-read means a second
 * insert attempt for an id that already exists returns the *existing* row
 * instead of erroring or creating a duplicate — the caller
 * (`lib/capture/submit.ts`) relies on this to make the whole submit flow
 * safe to retry.
 */
export async function insertSubmission(
  campaignId: string,
  submissionId: string,
  input: NewSubmissionInput,
): Promise<Submission> {
  assertCampaignId(campaignId, "insertSubmission");
  await db
    .insert(submissions)
    .values({
      id: submissionId,
      campaignId,
      playerId: input.playerId,
      targetId: input.targetId,
      photoUrl: input.photoUrl,
      deviceGps: toGeography(input.deviceGps),
      exifGps: input.exifGps ? toGeography(input.exifGps) : null,
      exifTs: input.exifTs,
      phash: input.phash,
      receivedAt: input.receivedAt,
    })
    .onConflictDoNothing({ target: submissions.id });

  const row = await getSubmission(campaignId, submissionId);
  if (!row) {
    // Unreachable in practice: the insert only no-ops on a conflicting id,
    // which means a row with this id must already exist (and, since
    // `submissions.id` is a plain uuid primary key with no campaign-scoped
    // uniqueness twist, it must be this campaign's row given the caller
    // always mints a fresh id per campaign).
    throw new Error(
      `insertSubmission: no row found for ${submissionId} in campaign ` +
        `${campaignId} after insert/conflict`,
    );
  }
  return row;
}

/**
 * Counts `playerId`'s `approved` submissions within `campaignId` — the
 * capture flow's (T4.1) "running approved total" confirmation-screen
 * figure (card requirement 6). Derived directly from `submissions` rather
 * than `campaign_memberships.approved_count` (T4.3 owns incrementing that
 * counter as part of ledger accrual, which doesn't exist yet as of this
 * card) — a fresh `COUNT(*)` over already-decided rows is available the
 * moment `recordSubmissionDecision` persists an `approved` decision, with
 * no dependency on T4.3 landing first.
 */
export async function countApprovedSubmissions(
  campaignId: string,
  playerId: string,
): Promise<number> {
  assertCampaignId(campaignId, "countApprovedSubmissions");
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(submissions)
    .where(
      and(
        eq(submissions.campaignId, campaignId),
        eq(submissions.playerId, playerId),
        eq(submissions.decision, "approved"),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Persists the fraud pipeline's (T3.5, `lib/fraud/pipeline.ts`) full set of
 * `FraudCheckResult`s and its final `decision` onto a submission (card
 * requirement 4: "persist every FraudCheckResult and the final decision on
 * the submission" — the review queue, T4.2, reads these columns off the
 * row rather than re-running the checks). Overwrites the whole
 * `fraudChecks` array each call — the pipeline always passes the complete
 * set from a single run, never a partial/incremental one.
 *
 * Scoped to `campaignId` like every other write in this file. Returns the
 * updated `Submission`, or `null` if `submissionId` doesn't exist *or*
 * belongs to a different campaign (mirrors `getSubmission`'s
 * not-found/not-yours conflation) — the pipeline treats a `null` as
 * "nothing to persist," not as license to proceed silently.
 */
export async function recordSubmissionDecision(
  campaignId: string,
  submissionId: string,
  fraudChecks: FraudCheckResult[],
  decision: SubmissionDecision,
): Promise<Submission | null> {
  assertCampaignId(campaignId, "recordSubmissionDecision");
  const rows = await db
    .update(submissions)
    .set({ fraudChecks, decision })
    .where(
      and(
        eq(submissions.campaignId, campaignId),
        eq(submissions.id, submissionId),
      ),
    )
    .returning(submissionSelection);
  return rows[0] ? toDomain(rows[0]) : null;
}

/**
 * Persists a **human** review decision (T4.2's host review queue —
 * `lib/review/decision.ts`'s `approveSubmission`/`rejectSubmission`), as
 * opposed to `recordSubmissionDecision` above, which the automated fraud
 * pipeline (T3.5) and gallery-fallback forcing (T4.1) use for a decision
 * with no human decider. This is the one write path that stamps
 * `decided_by`/`decided_at` (both columns existed on the schema since
 * T1.3 but were unused until this card — the automated paths never had an
 * actor to attribute a decision to). Overwrites the whole `fraudChecks`
 * array like `recordSubmissionDecision` does — callers pass the full,
 * already-appended array (see `lib/review/decision.ts`'s
 * `appendHostDecisionCheck`), never a partial one.
 *
 * Scoped to `campaignId`; returns `null` if `submissionId` doesn't exist
 * *or* belongs to a different campaign (mirrors every other not-found/
 * not-yours conflation in this file).
 */
export async function recordReviewDecision(
  campaignId: string,
  submissionId: string,
  decision: SubmissionDecision,
  fraudChecks: FraudCheckResult[],
  decidedBy: string,
): Promise<Submission | null> {
  assertCampaignId(campaignId, "recordReviewDecision");
  const rows = await db
    .update(submissions)
    .set({ decision, fraudChecks, decidedBy, decidedAt: new Date() })
    .where(
      and(
        eq(submissions.campaignId, campaignId),
        eq(submissions.id, submissionId),
      ),
    )
    .returning(submissionSelection);
  return rows[0] ? toDomain(rows[0]) : null;
}
