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
import { StatCard } from "@/components/brand/StatCard";

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export interface PersonalStatsProps {
  stats: PersonalStatsData;
}

export function PersonalStats({ stats }: PersonalStatsProps) {
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:grid-cols-3"
      data-testid="personal-stats"
    >
      <StatCard
        label="Approved"
        value={
          <span data-testid="stat-approved-count">{stats.approvedCount}</span>
        }
      />
      <StatCard
        label="Current tier"
        value={
          <span data-testid="stat-current-tier">
            {stats.currentTier > 0
              ? `Tier ${stats.currentTier}`
              : "Not yet ranked"}
          </span>
        }
      />
      <StatCard
        label="Earned"
        value={
          <span data-testid="stat-earned">
            {formatCents(stats.earnedCents)}
          </span>
        }
      />
      <StatCard
        label="Fliers to next tier"
        value={
          <span data-testid="stat-fliers-to-next-tier">
            {stats.fliersToNextTier === null
              ? "Top tier reached"
              : stats.fliersToNextTier}
          </span>
        }
      />
      <StatCard
        label="Targets remaining"
        value={
          <span data-testid="stat-targets-remaining">
            {stats.targetsRemaining}
          </span>
        }
      />
    </div>
  );
}

export default PersonalStats;
