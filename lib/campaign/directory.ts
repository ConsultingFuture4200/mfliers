/**
 * Live-campaign directory (T5.1) — PRD FR-L1/FR-L5: "Campaign
 * directory/list beside the map — browse live campaigns, see coverage %,
 * join." Domain logic lives here (constitution §6); `app/api/public/
 * campaigns/route.ts` is a thin caller.
 *
 * Coverage % (green targets / total targets) is computed across *every*
 * live campaign, which is a cross-campaign read of `targets`. Rather than
 * introduce a third sanctioned cross-campaign DAL exception
 * (`docs/decisions/0001-tenant-isolation-enforcement.md`,
 * `docs/decisions/0002-dedupe-hash-cross-campaign-exception.md`), this
 * reuses the one that already exists for exactly this purpose:
 * `lib/db/dal/universal-map.ts`'s `getLiveCampaignCoverageCounts()`
 * (T2.1/T5.2, added alongside `getPublicPinsAcrossLiveCampaigns` per the
 * Liotta batch-5 review) returns `{campaignId, total, green}` — the
 * green/total tally computed in Postgres via `GROUP BY` / `count(*)
 * filter (...)`, not a full pin payload (coords, photo URLs) tallied in
 * application memory. That keeps this, the highest-traffic auth-free
 * route, from coupling its latency to the size of the `targets` table just
 * to render a percentage. Each campaign's *name* is then looked up one at
 * a time via the ordinary, campaign-scoped `getCampaignById(campaignId)`
 * (T2.1/T3.1) — never a second bulk cross-campaign read.
 */
import { getCampaignById } from "@/lib/db/dal/campaigns";
import { getLiveCampaignCoverageCounts } from "@/lib/db/dal/universal-map";

/** A single live campaign's public-facing directory entry. */
export interface LiveCampaignDirectoryEntry {
  id: string;
  name: string;
  /**
   * NEEDS_CLARIFICATION: the card (docs/tasks/batch-5.md, T5.1 requirement
   * 3) asks for a "blurb," but `campaigns` (lib/db/schema/campaigns.ts)
   * has no dedicated blurb/description column, and this card's own Files
   * list doesn't touch the schema. Using the campaign's `grandPrize` as a
   * stand-in teaser line until a reviewer confirms whether a real editable
   * blurb field belongs on the campaign schema (a later card, not this
   * one, would own that migration).
   */
  blurb: string;
  totalTargets: number;
  greenTargets: number;
  /** Integer percent, 0-100, rounded to the nearest whole number. */
  coveragePercent: number;
}

/**
 * Returns every currently-`live` campaign with its name, a blurb, and its
 * coverage % (green/total targets), for the public landing page. Never
 * includes a `draft` or `closed` campaign (anti-requirement) and never
 * exposes budget/ledger/host/player-identity fields — only what
 * `getLiveCampaignCoverageCounts` and `getCampaignById` already expose
 * publicly elsewhere on this platform.
 */
export async function getLiveCampaignDirectory(): Promise<
  LiveCampaignDirectoryEntry[]
> {
  const counts = await getLiveCampaignCoverageCounts();

  const entries = await Promise.all(
    counts.map(async ({ campaignId, total, green }) => {
      const campaign = await getCampaignById(campaignId);
      // getLiveCampaignCoverageCounts only returns rows for campaigns that
      // were `live` at query time, but a campaign can close in the gap
      // between that read and this one (TOCTOU) — re-check rather than
      // trust the earlier snapshot, so a just-closed campaign never
      // lingers in the public directory.
      if (!campaign || campaign.state !== "live") return null;

      const entry: LiveCampaignDirectoryEntry = {
        id: campaignId,
        name: campaign.name,
        blurb: `Grand prize: ${campaign.grandPrize}`,
        totalTargets: total,
        greenTargets: green,
        coveragePercent: total === 0 ? 0 : Math.round((green / total) * 100),
      };
      return entry;
    }),
  );

  return entries.filter(
    (entry): entry is LiveCampaignDirectoryEntry => entry !== null,
  );
}
