/**
 * Geo fraud checks (T3.4).
 *
 * PRD FR-F1/FR-F2 (quoted in `docs/tasks/batch-3.md`):
 * > Target proximity: device GPS within 40m of the claimed target
 * > (platform default; per-campaign override). GPS agreement: device GPS
 * > vs EXIF GPS within 50m; disagreement flags.
 *
 * Both checks compute distance via PostGIS (constitution §3 — no
 * hand-rolled haversine in app code): `checkProximity` goes through
 * `lib/db/dal/targets.ts`'s `checkTargetProximity` (`ST_DWithin`/
 * `ST_Distance` against the claimed target's actual, indexed `location`
 * column); `checkGpsAgreement` compares two literal points already present
 * on the submission (no table lookup needed) via `lib/db/dal/geo.ts`'s
 * `distanceMeters` (`ST_Distance` on ad-hoc geography values). Neither
 * check composes into a pass/fail decision here — that's T3.5's pipeline
 * orchestrator; this module only reports each check's own
 * `FraudCheckResult`.
 */
import { checkTargetProximity } from "@/lib/db/dal/targets";
import { distanceMeters } from "@/lib/db/dal/geo";
import type { Campaign, FraudCheckResult, Submission } from "@/types/domain";

/**
 * Platform-default proximity radius (meters) referenced by PRD FR-F1 and
 * `lib/campaign/lifecycle.ts`'s `CreateCampaignInput.proximityRadiusM` doc
 * comment. Every `Campaign` always carries a concrete
 * `proximityRadiusM` (it's a required field, set at creation — see
 * `lib/campaign/lifecycle.ts`'s `createCampaign`), so `checkProximity`
 * itself never falls back to this constant; it exists so campaign-creation
 * callers (host UI, seed scripts) have one canonical place to read the
 * platform default from, per the card's "platform default; per-campaign
 * override" requirement.
 */
export const DEFAULT_PROXIMITY_RADIUS_M = 40;

/** GPS-agreement threshold (meters) — PRD FR-F2. Not per-campaign
 * configurable per the card (only proximity has an override). */
export const GPS_AGREEMENT_THRESHOLD_M = 50;

/**
 * Flags a submission whose device GPS falls outside `campaign`'s
 * `proximityRadiusM` of the target it claims to be at (`submission.targetId`).
 * Honors a per-campaign override — always reads `campaign.proximityRadiusM`,
 * never the platform default directly (card requirement: "per-campaign
 * proximity override is honored").
 *
 * A `targetId` that doesn't resolve to a row in `campaign.id` (shouldn't
 * happen in practice — `submissions.target_id` has a composite FK into
 * `targets(campaign_id, id)` — but the DAL call can still return `null` for
 * a stale/foreign id) fails the check rather than throwing, since a fraud
 * check's job is to report, not to crash the pipeline.
 */
export async function checkProximity(
  submission: Submission,
  campaign: Campaign,
): Promise<FraudCheckResult> {
  const result = await checkTargetProximity(
    campaign.id,
    submission.targetId,
    submission.deviceGps,
    campaign.proximityRadiusM,
  );

  if (!result) {
    return {
      check: "proximity",
      passed: false,
      detail: `target ${submission.targetId} not found in campaign ${campaign.id}`,
    };
  }

  return {
    check: "proximity",
    passed: result.withinRadius,
    detail:
      `device GPS is ${result.distanceM.toFixed(1)}m from the claimed ` +
      `target (radius ${campaign.proximityRadiusM}m)`,
    score: result.distanceM,
  };
}

/**
 * Flags a submission whose device GPS and EXIF GPS disagree by more than
 * `GPS_AGREEMENT_THRESHOLD_M` (PRD FR-F2). A submission with no EXIF GPS
 * (the photo carried no location metadata) has nothing to compare against,
 * so this passes rather than flags — EXIF-absence itself is not this
 * check's concern.
 */
export async function checkGpsAgreement(
  submission: Submission,
): Promise<FraudCheckResult> {
  if (!submission.exifGps) {
    return {
      check: "gps-agreement",
      passed: true,
      detail: "no EXIF GPS present on the photo; agreement check skipped",
    };
  }

  const distanceM = await distanceMeters(
    submission.deviceGps,
    submission.exifGps,
  );
  const passed = distanceM <= GPS_AGREEMENT_THRESHOLD_M;

  return {
    check: "gps-agreement",
    passed,
    detail:
      `device and EXIF GPS are ${distanceM.toFixed(1)}m apart ` +
      `(threshold ${GPS_AGREEMENT_THRESHOLD_M}m)`,
    score: distanceM,
  };
}
