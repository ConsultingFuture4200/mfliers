/**
 * Per-campaign leaderboard + personal-stats page (T5.4) — PRD FR-G1/FR-G2.
 * Server Component: reads directly from `lib/leaderboard/rank.ts`
 * (constitution §6), mirroring `app/host/campaigns/[id]/review/page.tsx`'s
 * (T4.2) precedent — this card's own Files list has no e2e spec, unlike
 * the player-facing pages (T4.1/T4.4/T5.1) that need the client-component-
 * plus-fetch shape purely to stay mockable by Playwright's `page.route`.
 *
 * Auth: an anonymous visitor still sees the leaderboard (viewer is `null` —
 * no membership/rank highlighted, no personal-stats panel); a signed-in
 * player sees their own rank highlighted and their personal-stats panel.
 * `lib/leaderboard/rank.ts`'s functions themselves take `campaignId` as
 * their scoping argument and touch only campaign-scoped DAL reads — there
 * is no host/admin-only data here to further gate server-side (constitution
 * §2 is about authorization, not about hiding a public leaderboard).
 */
import { auth } from "@/lib/auth/config";
import {
  CampaignNotFoundError,
  getLeaderboardForCampaign,
  getPersonalStatsForCampaign,
  type LeaderboardEntry,
} from "@/lib/leaderboard/rank";
import { PersonalStats } from "@/components/stats/PersonalStats";

interface PageParams {
  id: string;
}

interface PageProps {
  params: Promise<PageParams>;
}

function LeaderboardRow({ entry }: { entry: LeaderboardEntry }) {
  return (
    <li
      className="flex items-center justify-between rounded-md border border-input px-3 py-2 text-sm"
      data-testid="leaderboard-row"
      data-player-id={entry.playerId}
      data-rank={entry.rank}
    >
      <span>
        #{entry.rank}
        {entry.isViewer ? (
          <span data-testid="leaderboard-row-you"> (you)</span>
        ) : null}
      </span>
      <span data-testid="leaderboard-row-approved-count">
        {entry.approvedCount} approved
      </span>
    </li>
  );
}

export default async function LeaderboardPage({ params }: PageProps) {
  const { id: campaignId } = await params;

  const session = await auth();
  const viewerPlayerId =
    session?.principalType === "player" && session.playerId
      ? session.playerId
      : null;

  let leaderboard;
  try {
    leaderboard = await getLeaderboardForCampaign(campaignId, viewerPlayerId);
  } catch (err) {
    if (err instanceof CampaignNotFoundError) {
      return (
        <main className="mx-auto max-w-2xl p-6">
          <p
            className="text-sm text-destructive"
            data-testid="leaderboard-not-found"
          >
            This campaign could not be found.
          </p>
        </main>
      );
    }
    throw err;
  }

  const stats = viewerPlayerId
    ? await getPersonalStatsForCampaign(campaignId, viewerPlayerId)
    : null;

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <h1 className="text-lg font-semibold">Leaderboard</h1>

      {leaderboard.campaignClosed && leaderboard.grandPrizeWinnerPlayerId ? (
        <p
          className="rounded-md bg-secondary p-3 text-sm font-medium"
          data-testid="grand-prize-winner"
          data-player-id={leaderboard.grandPrizeWinnerPlayerId}
        >
          Grand prize winner: player {leaderboard.grandPrizeWinnerPlayerId}
        </p>
      ) : null}

      <ul className="flex flex-col gap-2" data-testid="leaderboard-top">
        {leaderboard.top.map((entry) => (
          <LeaderboardRow key={entry.playerId} entry={entry} />
        ))}
      </ul>

      {leaderboard.viewer &&
      !leaderboard.top.some(
        (e) => e.playerId === leaderboard.viewer!.playerId,
      ) ? (
        <div data-testid="leaderboard-viewer-rank">
          <LeaderboardRow entry={leaderboard.viewer} />
        </div>
      ) : null}

      {stats ? (
        <PersonalStats stats={stats} />
      ) : (
        <p
          className="text-sm text-muted-foreground"
          data-testid="stats-signed-out"
        >
          Sign in as a player to see your personal stats.
        </p>
      )}
    </main>
  );
}
