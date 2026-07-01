/**
 * Host review-queue listing (T4.2) — PRD FR-R1/FR-R2:
 * "Per-campaign review queue (flagged + tier-3); host sees only theirs.
 * Each card: photo, target pin + distance-from-target, all check results,
 * canvasser, metadata."
 *
 * Constitution §5: server-side authorization — `listReviewQueue` calls
 * `requireCampaignAccess` before touching the DAL (card anti-requirement
 * 1: a host must never see another campaign's review items). Constitution
 * §6: domain logic in `lib/`; `app/host/campaigns/[id]/review/page.tsx`
 * (a Server Component) is the sole caller, so this module is the queue's
 * whole read-side implementation.
 *
 * "flagged + tier-3" (requirement 1) is already exactly what
 * `decision === "needs_review"` means at this point in the pipeline —
 * `lib/fraud/pipeline.ts` (T3.5) routes every hard-fail-free flag *and*
 * every tier-3 submission into `needs_review` (a dedupe hit is a soft
 * flag, per the Batch-3 review fix noted in `tasks/lessons.md`; only
 * `proximity` auto-rejects). No separate tier-3 filter is needed here.
 *
 * "target pin + distance-from-target" (requirement 2) reuses
 * `lib/db/dal/targets.ts`'s `checkTargetProximity` (T3.4) — the exact
 * `ST_Distance` helper the geo fraud check already uses — rather than
 * decoding lat/long and computing a second distance calculation in app
 * code (constitution §3: PostGIS distance math, never hand-rolled).
 */
import { requireCampaignAccess } from "@/lib/auth/guards";
import type { StaffPrincipal } from "@/lib/auth/staff";
import { getCampaignById } from "@/lib/db/dal/campaigns";
import { checkTargetProximity, getTarget } from "@/lib/db/dal/targets";
import { listSubmissions } from "@/lib/db/dal/submissions";
import { getPlayerById } from "@/lib/db/dal/players";
import { createSignedGetUrl } from "@/lib/storage/r2";
import { TargetNotFoundError } from "@/lib/target/state-machine";
import type { Player, Submission, Target } from "@/types/domain";
import { CampaignNotFoundError } from "./decision";

/** One review-queue card's full view model (card requirement 2). */
export interface ReviewQueueItem {
  submission: Submission;
  target: Target;
  /** Meters between the submission's device GPS and its target, or `null`
   * if it couldn't be computed (should not happen for a persisted
   * submission — the composite FK guarantees the target exists in this
   * campaign). */
  distanceM: number | null;
  /** `null` if the player row was somehow deleted after the submission was
   * filed — never thrown away as a "not found" for the whole card, since
   * the rest of the card (photo, checks, target) is still reviewable. */
  player: Player | null;
  /** Short-lived signed GET URL for the submission's photo
   * (`lib/storage/r2.ts`'s `createSignedGetUrl`) — submission photos are
   * private R2 objects, never a public bucket URL. */
  photoUrl: string;
}

async function buildItem(
  campaignId: string,
  proximityRadiusM: number,
  submission: Submission,
): Promise<ReviewQueueItem> {
  const [target, proximity, player, photoUrl] = await Promise.all([
    getTarget(campaignId, submission.targetId),
    checkTargetProximity(
      campaignId,
      submission.targetId,
      submission.deviceGps,
      proximityRadiusM,
    ),
    getPlayerById(submission.playerId),
    createSignedGetUrl(campaignId, submission.id),
  ]);
  if (!target) {
    // Should be unreachable: submissions.target_id is a composite FK onto
    // targets(campaign_id, id) — a submission can't outlive its target's
    // row within the same campaign. Thrown as a typed error rather than
    // silently dropping the card, per constitution §3 ("no silent
    // catches").
    throw new TargetNotFoundError(campaignId, submission.targetId);
  }
  return {
    submission,
    target,
    distanceM: proximity ? proximity.distanceM : null,
    player,
    photoUrl,
  };
}

/**
 * Lists `campaignId`'s review queue (every `needs_review` submission),
 * scoped to `principal`'s access (card requirement 1). Ordered oldest
 * first (FIFO) — the review queue is a work queue, not a feed.
 */
export async function listReviewQueue(
  principal: StaffPrincipal,
  campaignId: string,
): Promise<ReviewQueueItem[]> {
  requireCampaignAccess(principal, campaignId);
  const campaign = await getCampaignById(campaignId);
  if (!campaign) throw new CampaignNotFoundError(campaignId);

  const pending = (await listSubmissions(campaignId)).filter(
    (s) => s.decision === "needs_review",
  );

  const items = await Promise.all(
    pending.map((submission) =>
      buildItem(campaignId, campaign.proximityRadiusM, submission),
    ),
  );

  items.sort(
    (a, b) =>
      a.submission.receivedAt.getTime() - b.submission.receivedAt.getTime(),
  );
  return items;
}
