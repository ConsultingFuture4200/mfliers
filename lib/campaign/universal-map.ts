/**
 * Universal (cross-campaign) map domain logic (T5.2) — PRD FR-L2/FR-L3/
 * FR-L4, EC-4: "Universal Mapbox map aggregating target pins across all
 * live campaigns... Tapping a pin shows campaign name + state... Mapbox
 * clustering at low zoom."
 *
 * Constitution §6: domain logic lives in `lib/`, never in route handlers
 * — `app/api/public/pins/route.ts` is a thin caller into
 * `getUniversalMapPins` below.
 *
 * Constitution §1/§7, ADR-0001/ADR-0002: this is a *consumer* of the one
 * sanctioned cross-campaign read (`lib/db/dal/universal-map.ts`'s
 * `getPublicPinsAcrossLiveCampaigns`), not a new exception — it does not
 * touch `targets`/`submissions`/`campaigns` directly, only that DAL
 * function plus the ordinary, campaign-scoped `getCampaignById` (looked up
 * once per distinct campaign id, in parallel, exactly the shape
 * `lib/campaign/directory.ts` (T5.1) already established for the same
 * cross-campaign-read-plus-per-campaign-name pattern). Card
 * anti-requirement 1 ("do NOT query campaigns individually and merge
 * client-side") is about keeping this merge server-side, in `lib/` — it
 * is not a ban on calling `getCampaignById` at all, which `directory.ts`'s
 * own doc comment already establishes as the compliant way to attach a
 * campaign's name to a cross-campaign-read row.
 *
 * ## Why no username field
 * The universal read's public shape (`campaignId`, target `id`, `state`,
 * coordinates, `photoUrl`) was fixed by T2.1/ADR-0001 and deliberately
 * excludes any player/host identity — "username resolution happens at a
 * higher layer per privacy" (docs/tasks/batch-2.md T2.1 requirement 3).
 * This module is *not* that higher layer: it never resolves or exposes a
 * username, for any campaign, under any `privacySetting`. The "higher
 * layer" that *does* resolve a username per campaign privacy setting
 * already exists — `lib/campaign/map.ts`'s `getTargetDetail`, reached by
 * following a pin's "open this campaign's map" link (card requirement 3)
 * into `app/campaigns/[id]/map` (T4.4). Card requirement 4 ("green-pin
 * detail respects each campaign's privacy setting") is satisfied by this
 * split: the universal map's own tap-through never shows a username
 * (trivially compliant with every privacy setting, since it shows none),
 * and the *real* privacy-gated username reveal happens exactly once,
 * inside the per-campaign view this pin already routes into.
 */
import { getCampaignById } from "@/lib/db/dal/campaigns";
import {
  getPublicPinsAcrossLiveCampaigns,
  type PublicPin,
} from "@/lib/db/dal/universal-map";

/** One pin on the universal map: `PublicPin` (T2.1) plus the campaign's
 * name, for card requirement 3 ("tapping a pin shows campaign name +
 * state"). Never a username, budget, or ledger field — see module doc
 * comment. */
export interface UniversalMapPin extends PublicPin {
  campaignName: string;
}

/**
 * Returns every target pin across every currently-`live` campaign, each
 * annotated with its campaign's name, for the public universal map (no
 * auth required — same public reach as the landing page's directory).
 */
export async function getUniversalMapPins(): Promise<UniversalMapPin[]> {
  const pins = await getPublicPinsAcrossLiveCampaigns();

  const byCampaign = new Map<string, PublicPin[]>();
  for (const pin of pins) {
    const bucket = byCampaign.get(pin.campaignId) ?? [];
    bucket.push(pin);
    byCampaign.set(pin.campaignId, bucket);
  }

  const groups = await Promise.all(
    Array.from(byCampaign.entries()).map(async ([campaignId, campaignPins]) => {
      const campaign = await getCampaignById(campaignId);
      // TOCTOU, same reasoning as lib/campaign/directory.ts: a campaign
      // can close in the gap between the universal read and this
      // per-campaign re-check — re-verify rather than trust the
      // earlier snapshot, so a just-closed campaign's pins never
      // linger on the public map.
      if (!campaign || campaign.state !== "live") return [];
      return campaignPins.map((pin): UniversalMapPin => ({
        ...pin,
        campaignName: campaign.name,
      }));
    }),
  );

  return groups.flat();
}
