/**
 * Time fraud checks (T3.4).
 *
 * PRD FR-F5/FR-F6 (quoted in `docs/tasks/batch-3.md`):
 * > Timestamp sanity: EXIF capture, client, and server times internally
 * > consistent (within minutes); stale photos flag. Travel-speed anomaly:
 * > impossible distance/time between a player's consecutive posts flags.
 *
 * Constitution §3 (time): server `received_at` is authoritative for any
 * payout or fraud logic — never the client clock. Both checks below anchor
 * to `submission.receivedAt` (server-stamped, per `lib/db/schema/
 * submissions.ts`'s doc comment) as ground truth; a client-reported time is
 * only ever used as a secondary sanity input, never trusted on its own.
 *
 * NEEDS_CLARIFICATION: the card's design intent says timestamp sanity
 * compares "EXIF capture, client, and server times," but no `clientTs`
 * field exists on `Submission` (`types/domain.ts`) or the `submissions`
 * table (`lib/db/schema/submissions.ts`) — only `exifTs` and `receivedAt`
 * are persisted. `docs/tasks/batch-4.md`'s capture-flow card (T4.4) is the
 * first place a client-reported timestamp is even collected, and it isn't
 * listed as a column T4.4 adds either. `checkTimestamps` below accepts the
 * client timestamp as an optional, non-persisted parameter (so a future
 * caller — T3.5's orchestrator, or T4.4's submit handler — can pass one
 * through without a schema change) rather than guessing at a field name
 * that doesn't exist in the DAL this card depends on (T2.1). Flagged for
 * the reviewer rather than silently adding a column outside this card's
 * `Files to Create/Modify` list.
 */
import type { FraudCheckResult, Player, Submission } from "@/types/domain";
import { distanceMeters } from "@/lib/db/dal/geo";
import { getPreviousSubmission } from "@/lib/db/dal/submissions";

/** Default "internally consistent" window (minutes) for timestamp sanity
 * (PRD FR-F5's "within minutes," card requirement 3's "configurable
 * minutes window"). A photo whose EXIF capture time (or, if supplied, a
 * client-reported submit time) differs from server `received_at` by more
 * than this is flagged as stale/inconsistent. */
export const DEFAULT_TIMESTAMP_SKEW_MINUTES = 15;

/** Max plausible travel speed (m/s) between a player's consecutive
 * submissions (PRD FR-F6). ~30 m/s (~108 km/h) comfortably covers legit
 * car travel between targets while still flagging the card's own example
 * (5km / 2min implies ~41.7 m/s). Not per-campaign configurable — the card
 * only calls out proximity as having a per-campaign override. */
export const MAX_PLAUSIBLE_SPEED_MPS = 30;

export interface CheckTimestampsOptions {
  /** Client-reported capture/submit time, if the caller has one (see
   * module doc comment's NEEDS_CLARIFICATION — not a persisted field).
   * Never treated as authoritative; only compared against `receivedAt` for
   * sanity, same as `exifTs`. */
  clientTs?: Date;
  /** Overrides `DEFAULT_TIMESTAMP_SKEW_MINUTES`. */
  maxSkewMinutes?: number;
}

/**
 * Flags a submission whose EXIF capture time (and, if supplied, client
 * time) isn't internally consistent with server `received_at` within
 * `maxSkewMinutes` (default `DEFAULT_TIMESTAMP_SKEW_MINUTES`) — this is
 * how "a photo captured hours before submit" (card acceptance criterion)
 * gets caught. A submission with no EXIF timestamp has nothing to compare
 * (aside from an optional client time), so it passes rather than flags —
 * EXIF-timestamp-absence itself is not this check's concern.
 */
export function checkTimestamps(
  submission: Submission,
  options: CheckTimestampsOptions = {},
): FraudCheckResult {
  const maxSkewMinutes =
    options.maxSkewMinutes ?? DEFAULT_TIMESTAMP_SKEW_MINUTES;
  const maxSkewMs = maxSkewMinutes * 60 * 1000;

  const candidates: { label: string; ts: Date }[] = [];
  if (submission.exifTs)
    candidates.push({ label: "EXIF capture", ts: submission.exifTs });
  if (options.clientTs)
    candidates.push({ label: "client", ts: options.clientTs });

  if (candidates.length === 0) {
    return {
      check: "timestamp-sanity",
      passed: true,
      detail: "no EXIF or client timestamp present; sanity check skipped",
    };
  }

  let worst: { label: string; skewMs: number } | null = null;
  for (const candidate of candidates) {
    const skewMs = Math.abs(
      submission.receivedAt.getTime() - candidate.ts.getTime(),
    );
    if (!worst || skewMs > worst.skewMs) {
      worst = { label: candidate.label, skewMs };
    }
  }
  // `candidates.length > 0` guarantees `worst` is assigned above.
  const { label, skewMs } = worst as { label: string; skewMs: number };
  const skewMinutes = skewMs / 60_000;
  const passed = skewMs <= maxSkewMs;

  return {
    check: "timestamp-sanity",
    passed,
    detail:
      `${label} time is ${skewMinutes.toFixed(1)} minutes from server ` +
      `received_at (max ${maxSkewMinutes}m)`,
    score: skewMinutes,
  };
}

/**
 * Flags a submission that implies an impossible travel speed from
 * `player`'s previous submission in the same campaign (PRD FR-F6):
 * distance (PostGIS `ST_Distance`, never haversine) divided by elapsed
 * server `received_at` time (never client clock, constitution §3) exceeds
 * `MAX_PLAUSIBLE_SPEED_MPS`. Scoped to `submission.campaignId` — a
 * player's posts in a different campaign are not this check's concern
 * (constitution §3, tenant isolation).
 *
 * A player with no prior submission (first post, in this campaign) has
 * nothing to compare against, so this passes rather than flags.
 */
export async function checkTravelSpeed(
  submission: Submission,
  player: Player,
): Promise<FraudCheckResult> {
  const previous = await getPreviousSubmission(
    submission.campaignId,
    player.id,
    submission.receivedAt,
    submission.id,
  );

  if (!previous) {
    return {
      check: "travel-speed",
      passed: true,
      detail: "no prior submission from this player to compare against",
    };
  }

  const elapsedSeconds =
    (submission.receivedAt.getTime() - previous.receivedAt.getTime()) / 1000;
  if (elapsedSeconds <= 0) {
    // Shouldn't happen — `getPreviousSubmission` only returns rows strictly
    // before `submission.receivedAt` — but guard against a zero/negative
    // divisor rather than returning Infinity/NaN.
    return {
      check: "travel-speed",
      passed: false,
      detail:
        "previous submission has a non-earlier received_at; cannot compute speed",
    };
  }

  const distanceM = await distanceMeters(
    previous.deviceGps,
    submission.deviceGps,
  );
  const speedMps = distanceM / elapsedSeconds;
  const passed = speedMps <= MAX_PLAUSIBLE_SPEED_MPS;

  return {
    check: "travel-speed",
    passed,
    detail:
      `implied speed ${speedMps.toFixed(1)} m/s (${distanceM.toFixed(0)}m ` +
      `over ${elapsedSeconds.toFixed(0)}s since the previous submission; ` +
      `max plausible ${MAX_PLAUSIBLE_SPEED_MPS} m/s)`,
    score: speedMps,
  };
}
