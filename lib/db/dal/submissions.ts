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
import { and, desc, eq, lt, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { submissions } from "@/lib/db/schema";
import type {
  Coordinate,
  FraudCheckResult,
  Submission,
  SubmissionDecision,
} from "@/types/domain";
import { assertCampaignId } from "./scope";
import { latOf, longOf } from "./geo";

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
