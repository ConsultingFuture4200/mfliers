/**
 * Player "join campaign" flow (T5.1 carry-forward) — PRD FR-L5: "browse
 * live campaigns, see coverage %, join." `lib/target/state-machine.ts`'s
 * `claim` and `lib/capture/submit.ts`'s `submitCapture` both already
 * assume a `campaign_memberships` row exists for the calling player
 * (`getMembership` returning `null` is treated as "not a member" and
 * rejected), but nothing before this card created that row outside a seed
 * script (`tests/fixtures/seed-two-campaigns.ts` inserts it directly).
 * This module is that missing write path.
 *
 * Domain logic lives here (constitution §6); `app/api/campaigns/[id]/join/
 * route.ts` is a thin caller that resolves the player's session and
 * translates the typed errors below to HTTP status codes, mirroring
 * `app/api/campaigns/[id]/targets/[targetId]/claim/route.ts` (T3.2).
 */
import { assertCampaignLive, CampaignNotFoundError } from "./lifecycle";
import { getCampaignById } from "@/lib/db/dal/campaigns";
import { insertMembership } from "@/lib/db/dal/campaign-memberships";
import type { CampaignMembership } from "@/types/domain";

/**
 * Joins `playerId` to `campaignId`, creating the `campaign_memberships`
 * row if one doesn't already exist. Only a `live` campaign is joinable
 * (anti-requirement / card requirement: "Only live campaigns are
 * joinable") — a `draft` campaign hasn't been announced yet and a
 * `closed` one is frozen, so joining either is rejected the same way
 * `assertCampaignLive` already rejects a claim/submission against a
 * non-live campaign (constitution §2: server-side, not just a hidden
 * "Join" button).
 *
 * Idempotent: joining a campaign the player already belongs to returns
 * the existing membership unchanged (`insertMembership`'s `ON CONFLICT DO
 * NOTHING`), never a duplicate-row error and never a reset of the
 * player's progress.
 *
 * Throws `CampaignNotFoundError` if `campaignId` doesn't exist, or
 * `CampaignNotLiveError` (from `assertCampaignLive`) if it isn't `live`.
 */
export async function joinCampaign(
  campaignId: string,
  playerId: string,
): Promise<CampaignMembership> {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) throw new CampaignNotFoundError(campaignId);
  assertCampaignLive(campaign);
  return insertMembership(campaignId, playerId);
}
