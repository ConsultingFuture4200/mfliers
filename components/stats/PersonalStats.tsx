/**
 * Personal-stats panel (T5.4, card requirement 2) — a small, presentational
 * component: approved count, current tier, $ earned, fliers to next tier,
 * targets remaining. No data fetching of its own (constitution §6, domain
 * logic in `lib/`) — `app/campaigns/[id]/leaderboard/page.tsx` (a Server
 * Component) fetches `lib/leaderboard/rank.ts`'s `PersonalStats` shape and
 * passes it straight in as a prop.
 *
 * Money: `stats.earnedCents` is integer cents (constitution §3) — this is
 * the one, and only, place it's divided by 100 for display; every domain
 * function upstream keeps it as cents.
 */
import type { PersonalStats as PersonalStatsData } from "@/lib/leaderboard/rank";

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export interface PersonalStatsProps {
  stats: PersonalStatsData;
}

export function PersonalStats({ stats }: PersonalStatsProps) {
  return (
    <dl
      className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-input p-4 text-sm"
      data-testid="personal-stats"
    >
      <dt className="text-muted-foreground">Approved</dt>
      <dd data-testid="stat-approved-count">{stats.approvedCount}</dd>

      <dt className="text-muted-foreground">Current tier</dt>
      <dd data-testid="stat-current-tier">
        {stats.currentTier > 0 ? `Tier ${stats.currentTier}` : "Not yet ranked"}
      </dd>

      <dt className="text-muted-foreground">Earned</dt>
      <dd data-testid="stat-earned">{formatCents(stats.earnedCents)}</dd>

      <dt className="text-muted-foreground">Fliers to next tier</dt>
      <dd data-testid="stat-fliers-to-next-tier">
        {stats.fliersToNextTier === null
          ? "Top tier reached"
          : stats.fliersToNextTier}
      </dd>

      <dt className="text-muted-foreground">Targets remaining</dt>
      <dd data-testid="stat-targets-remaining">{stats.targetsRemaining}</dd>
    </dl>
  );
}

export default PersonalStats;
