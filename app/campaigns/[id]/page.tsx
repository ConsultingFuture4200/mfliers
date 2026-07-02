/**
 * Campaign landing page (`/campaigns/[id]`) — the hub for one campaign: the
 * live map on top, then a summary, the payout structure, the prize pool, the
 * list of locations to hit, and the leaderboard. Public config (name, tiers,
 * prize, pool) renders server-side; the location list is fetched client-side
 * (player/staff-scoped); the leaderboard reuses lib/leaderboard/rank.ts.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth/config";
import { getCampaignById } from "@/lib/db/dal/campaigns";
import { getCumulativeCommittedCents } from "@/lib/db/dal/payout-ledger";
import {
  getLeaderboardForCampaign,
  getPersonalStatsForCampaign,
} from "@/lib/leaderboard/rank";
import CampaignMap from "@/components/map/CampaignMap";
import { TargetList } from "@/components/campaign/TargetList";
import { PersonalStats } from "@/components/stats/PersonalStats";
import { StatCard } from "@/components/brand/StatCard";
import { Pill } from "@/components/brand/Pill";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { TierBand } from "@/types/domain";

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function bandRange(band: TierBand): string {
  return band.maxCount == null
    ? `${band.minCount}+`
    : `${band.minCount}–${band.maxCount}`;
}

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function CampaignPage({ params }: PageProps) {
  const { id: campaignId } = await params;

  // A malformed (non-UUID) id makes the query throw rather than return null;
  // treat both "not found" and "invalid id" as a 404, not a 500.
  const campaign = await getCampaignById(campaignId).catch(() => null);
  if (!campaign) notFound();

  const session = await auth();
  const viewerPlayerId =
    session?.principalType === "player" ? (session.playerId ?? null) : null;

  const [committedCents, leaderboard] = await Promise.all([
    getCumulativeCommittedCents(campaignId),
    getLeaderboardForCampaign(campaignId, viewerPlayerId).catch(() => null),
  ]);
  const personalStats = viewerPlayerId
    ? await getPersonalStatsForCampaign(campaignId, viewerPlayerId).catch(
        () => null,
      )
    : null;

  const poolCents = campaign.budgetCapCents;
  const remainingCents = Math.max(0, poolCents - committedCents);

  return (
    <main className="flex w-full flex-1 flex-col">
      {/* Map on top */}
      <section aria-label="Campaign map" className="flex flex-col">
        <CampaignMap campaignId={campaignId} />
      </section>

      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
        {/* Summary header */}
        <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h1 className="font-heading text-2xl font-bold">
                {campaign.name}
              </h1>
              <Pill>{campaign.state}</Pill>
            </div>
            <p className="text-sm text-muted-foreground">
              Claim a target, post the flier, snap a geotagged photo — get paid
              on the tier curve below.
            </p>
          </div>
          <Link
            href={`/campaigns/${campaignId}/leaderboard`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Full leaderboard
          </Link>
        </header>

        {/* Pool / stats */}
        <section aria-label="Prize pool" className="mb-8">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Prize pool" value={usd(poolCents)} />
            <StatCard label="Committed" value={usd(committedCents)} />
            <StatCard label="Remaining" value={usd(remainingCents)} />
            <StatCard label="Grand prize" value={campaign.grandPrize} />
          </div>
        </section>

        <div className="grid gap-8 lg:grid-cols-2">
          {/* Payout structure */}
          <section aria-label="Payout structure">
            <h2 className="mb-3 font-heading text-xl font-bold">
              Payout structure
            </h2>
            <Card className="border-2 border-foreground/15">
              <CardContent className="flex flex-col gap-2 py-4">
                {campaign.tierTable.map((band, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-3 border-b border-foreground/10 pb-2 last:border-0 last:pb-0"
                  >
                    <span className="text-sm">
                      <span className="font-medium">Tier {i + 1}</span>{" "}
                      <span className="text-muted-foreground">
                        · {bandRange(band)} fliers
                      </span>
                    </span>
                    <Pill>{usd(band.payoutCents)} each</Pill>
                  </div>
                ))}
              </CardContent>
            </Card>
            <p className="mt-2 text-xs text-muted-foreground">
              Payout per approved flier rises as you place more. Settlement is
              manual — the platform tracks what&apos;s owed.
            </p>
          </section>

          {/* Leaderboard */}
          <section aria-label="Leaderboard">
            <h2 className="mb-3 font-heading text-xl font-bold">Leaderboard</h2>
            {leaderboard && leaderboard.top.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {leaderboard.top.map((entry) => (
                  <li
                    key={entry.playerId}
                    data-testid="campaign-leaderboard-row"
                    className={`flex items-center justify-between gap-3 rounded-xl border-2 border-foreground/15 bg-card px-4 py-3 ${
                      entry.isViewer ? "border-primary/40 bg-accent" : ""
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <Pill>#{entry.rank}</Pill>
                      {entry.isViewer ? (
                        <span className="text-sm font-medium">(you)</span>
                      ) : null}
                    </span>
                    <span className="font-mono text-sm">
                      {entry.approvedCount} approved
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No approved placements yet — be the first on the board.
              </p>
            )}
            {personalStats ? (
              <div className="mt-4">
                <PersonalStats stats={personalStats} />
              </div>
            ) : null}
          </section>
        </div>

        {/* Locations to hit */}
        <section aria-label="Locations" className="mt-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-heading text-xl font-bold">Locations to hit</h2>
            <Link
              href={`/campaigns/${campaignId}/map`}
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              Full-screen map
            </Link>
          </div>
          <TargetList campaignId={campaignId} />
        </section>
      </div>
    </main>
  );
}
