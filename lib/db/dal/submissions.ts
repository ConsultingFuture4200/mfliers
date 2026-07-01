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
import { and, eq } from "drizzle-orm";
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
