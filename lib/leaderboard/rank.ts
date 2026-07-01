/**
 * Leaderboard + personal stats (T5.4) — PRD FR-G1/FR-G2 / §3 grand prize:
 * "Per-campaign leaderboard (top N + viewer's rank). Per-campaign personal
 * stats: approved count, current tier, $ earned, fliers to next tier,
 * targets remaining. Grand prize awarded to #1 at close; tie-break = most
 * approved placements, then earliest to reach that count."
 *
 * Constitution §6: domain logic lives in `lib/`, never route handlers —
 * `app/campaigns/[id]/leaderboard/page.tsx` (a Server Component, mirroring
 * `app/host/campaigns/[id]/review/page.tsx`'s T4.2 precedent: no e2e spec
 * is in this card's Files list, so there's no need for the client-
 * component-plus-fetch shape T4.1/T4.4/T5.1's *player*-facing pages use
 * purely to stay mockable by Playwright's `page.route`) calls the two
 * DB-backed functions below directly.
 *
 * ## Two ordering sources — why this module never "re-derives the grand
 * prize winner" (card anti-requirement 2)
 * `lib/campaign/lifecycle.ts`'s `closeCampaign` (T3.1) is the ONE place
 * that computes the tie-break ("most approved placements, then earliest to
 * reach that count") to decide a winner — it does so once, at close, and
 * snapshots the result onto every membership's `campaign_memberships.rank`
 * column (`setMembershipRanks`). For a **closed** campaign, this module
 * only ever *reads* that persisted `rank` column back — it never
 * re-invokes the tie-break algorithm to decide who's #1 a second time.
 * For a **still-open** campaign (`draft`/`live`), there is no finalize
 * snapshot yet to read, but requirement 1 still asks for a live "top N +
 * viewer rank" ordered by approved count with the same tie-break applied —
 * so this module reuses (imports, does not duplicate)
 * `lib/campaign/lifecycle.ts`'s already-tested, exported-for-reuse
 * `computeFinalLeaderboard` pure function for that provisional ordering.
 * This is ordinary "who's currently leading" standings math, not a second
 * definition of the grand prize: `grandPrizeWinnerPlayerId` below is
 * always `null` until the campaign is actually closed, and even then is
 * read from `campaign_memberships.rank`, never from this module's own
 * live-ordering computation.
 *
 * ## Anti-requirements honored
 * - No cross-campaign leaderboard: every DB-backed function below takes
 *   `campaignId` and calls only campaign-scoped DAL reads
 *   (`listMemberships`/`listSubmissions`/`listTargets`, all already
 *   required-`campaignId`-first-parameter exports covered by
 *   `tests/isolation/isolation.test.ts`'s closed-world scan) — no new DAL
 *   function, no cross-campaign read.
 * - Money is never displayed as a float: `earnedCents`/every ledger-derived
 *   amount stays integer cents; formatting to a dollar string is a
 *   presentation concern left to the UI layer, not baked into this module.
 */
import { getCampaignById } from "@/lib/db/dal/campaigns";
import {
  getMembership,
  listMemberships,
} from "@/lib/db/dal/campaign-memberships";
import { listSubmissions } from "@/lib/db/dal/submissions";
import { listTargets } from "@/lib/db/dal/targets";
import { lookupTierBand } from "@/lib/payout/tiers";
import { computeFinalLeaderboard } from "@/lib/campaign/lifecycle";
import type { CampaignMembership, Submission, TierTable } from "@/types/domain";

/** Thrown when `campaignId` doesn't resolve to an existing campaign —
 * mirrors every other domain module's own locally-defined not-found error
 * (`lib/payout/ledger.ts`, `lib/campaign/map.ts`, `lib/campaign/
 * lifecycle.ts` each define their own rather than sharing one class). */
export class CampaignNotFoundError extends Error {
  readonly status = 404 as const;
  readonly code = "campaign_not_found" as const;

  constructor(campaignId: string) {
    super(`campaign ${campaignId} not found`);
    this.name = "CampaignNotFoundError";
  }
}

/** No "top N" number is specified anywhere in the PRD/card text quoted
 * above ("top N" is left as a variable) — 10 is a reasonable, documented
 * default for a leaderboard panel; callers (the page) can override it. */
export const DEFAULT_LEADERBOARD_TOP_N = 10;

// ---------------------------------------------------------------------------
// Leaderboard (card requirement 1 + 3)
// ---------------------------------------------------------------------------

/** One row of the leaderboard (top-N list, or the viewer's own position). */
export interface LeaderboardEntry {
  playerId: string;
  /** 1-based rank; 1 is the leader / grand-prize winner once closed. */
  rank: number;
  approvedCount: number;
  /** True for the entry belonging to the viewing player (lets the UI
   * highlight "you" without a second identity check). */
  isViewer: boolean;
}

/** The full leaderboard view for one campaign, from one player's (or no
 * player's) point of view. */
export interface LeaderboardView {
  /** Top-N entries, sorted by rank ascending. */
  top: LeaderboardEntry[];
  /** The viewing player's own entry (present even when it falls outside
   * the top N), or `null` when there is no viewer or the viewer has no
   * membership in this campaign. */
  viewer: LeaderboardEntry | null;
  /** True once the campaign has been closed (T3.1's `closeCampaign` has
   * run) — `grandPrizeWinnerPlayerId` is only ever non-null in this
   * state (card requirement 3). */
  campaignClosed: boolean;
  /** The rank-1 player at close, read directly from the persisted
   * finalize-time snapshot — see module doc comment. `null` before close,
   * or if the campaign closed with no memberships at all. */
  grandPrizeWinnerPlayerId: string | null;
}

/** Ordering for a still-open campaign — reuses T3.1's tie-break (see
 * module doc comment); never called for a closed campaign. */
function computeLiveOrder(
  memberships: CampaignMembership[],
  submissions: Submission[],
): { playerId: string; rank: number; approvedCount: number }[] {
  return computeFinalLeaderboard(memberships, submissions);
}

/** Ordering for a closed campaign — a plain read of the persisted `rank`
 * column T3.1's `closeCampaign` already wrote; no algorithm re-run here
 * (card anti-requirement 2). Memberships with no rank assigned (`rank`'s
 * schema default is `0` — shouldn't happen for a genuinely-closed
 * campaign, since `closeCampaign` ranks every membership it fetched, but
 * defensively excluded rather than assumed) are left out. */
function readFinalizedOrder(
  memberships: CampaignMembership[],
): { playerId: string; rank: number; approvedCount: number }[] {
  return memberships
    .filter((m) => m.rank > 0)
    .sort((a, b) => a.rank - b.rank)
    .map((m) => ({
      playerId: m.playerId,
      rank: m.rank,
      approvedCount: m.approvedCount,
    }));
}

/**
 * Pure view-builder (unit-testable without the DB — this card's own
 * `tests/leaderboard/rank.test.ts`). Given already-fetched
 * memberships/submissions for one campaign, builds the top-N list plus the
 * viewer's own entry and (once closed) the grand-prize winner.
 */
export function buildLeaderboardView(
  memberships: CampaignMembership[],
  submissions: Submission[],
  viewerPlayerId: string | null,
  campaignClosed: boolean,
  topN: number = DEFAULT_LEADERBOARD_TOP_N,
): LeaderboardView {
  const ordered = campaignClosed
    ? readFinalizedOrder(memberships)
    : computeLiveOrder(memberships, submissions);

  const entries: LeaderboardEntry[] = ordered.map((row) => ({
    ...row,
    isViewer: viewerPlayerId !== null && row.playerId === viewerPlayerId,
  }));

  const top = entries.slice(0, topN);
  const viewer =
    viewerPlayerId === null
      ? null
      : (entries.find((entry) => entry.playerId === viewerPlayerId) ?? null);

  const grandPrizeWinnerPlayerId = campaignClosed
    ? (memberships.find((m) => m.rank === 1)?.playerId ?? null)
    : null;

  return { top, viewer, campaignClosed, grandPrizeWinnerPlayerId };
}

/**
 * DB-backed leaderboard read (card requirement 1/3/4 — "all reads
 * campaign-scoped"). Throws `CampaignNotFoundError` if `campaignId`
 * doesn't resolve.
 */
export async function getLeaderboardForCampaign(
  campaignId: string,
  viewerPlayerId: string | null,
  topN: number = DEFAULT_LEADERBOARD_TOP_N,
): Promise<LeaderboardView> {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) throw new CampaignNotFoundError(campaignId);

  const [memberships, submissions] = await Promise.all([
    listMemberships(campaignId),
    listSubmissions(campaignId),
  ]);

  return buildLeaderboardView(
    memberships,
    submissions,
    viewerPlayerId,
    campaign.state === "closed",
    topN,
  );
}

// ---------------------------------------------------------------------------
// Personal stats (card requirement 2)
// ---------------------------------------------------------------------------

/** One player's personal stats panel for one campaign. */
export interface PersonalStats {
  approvedCount: number;
  /** 1-based tier number (0 before any submission has been approved —
   * mirrors `campaign_memberships.currentTier`'s schema default). */
  currentTier: number;
  /** Total amount accrued for this player in this campaign so far, in
   * integer cents (constitution §3 — never a float). Mirrors `lib/payout/
   * ledger.ts`'s `balanceOwed`: accrual, not settlement, drives this
   * figure — it does not decrease once a ledger entry is marked settled
   * (v1 settlement is off-platform / manual, constitution §1). */
  earnedCents: number;
  /** Additional approved submissions needed to reach the next tier band,
   * or `null` once the player is already in the top, open-ended band
   * (there is no "next" — card requirement 2). */
  fliersToNextTier: number | null;
  /** Targets in this campaign not yet filled (red or amber) — a
   * campaign-wide figure, not specific to this player (card requirement
   * 2's "targets remaining"). */
  targetsRemaining: number;
}

/**
 * Pure stats computation (unit-testable without the DB). `membership` is
 * `null` for a player who hasn't had any submission approved yet (or
 * hasn't joined at all) — returns all-zero stats rather than throwing,
 * mirroring `lib/payout/ledger.ts`'s `balanceOwed`'s null-safe contract.
 * Reuses `lib/payout/tiers.ts`'s `lookupTierBand` (not re-implemented here)
 * against the *current* (non-ordinal) `approvedCount` — the band that
 * covers "N submissions approved so far" is, by construction, the exact
 * band the player's Nth (most recent) approval landed in, since
 * `lib/db/dal/payout-ledger.ts`'s `accrueLedgerEntry` looks up every
 * accrual by its own ordinal count.
 */
export function computePersonalStats(
  membership: CampaignMembership | null,
  tierTable: TierTable,
  targetsRemaining: number,
): PersonalStats {
  const approvedCount = membership?.approvedCount ?? 0;
  const currentTier = membership?.currentTier ?? 0;
  const earnedCents = membership?.balanceOwedCents ?? 0;

  const { band } = lookupTierBand(tierTable, approvedCount);
  const fliersToNextTier =
    band.maxCount === null ? null : band.maxCount + 1 - approvedCount;

  return {
    approvedCount,
    currentTier,
    earnedCents,
    fliersToNextTier,
    targetsRemaining,
  };
}

/**
 * DB-backed personal-stats read (card requirement 2/4). Throws
 * `CampaignNotFoundError` if `campaignId` doesn't resolve; never throws
 * for a player with no membership yet (see `computePersonalStats`).
 */
export async function getPersonalStatsForCampaign(
  campaignId: string,
  playerId: string,
): Promise<PersonalStats> {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) throw new CampaignNotFoundError(campaignId);

  const [membership, targets] = await Promise.all([
    getMembership(campaignId, playerId),
    listTargets(campaignId),
  ]);
  const targetsRemaining = targets.filter((t) => t.state !== "green").length;

  return computePersonalStats(membership, campaign.tierTable, targetsRemaining);
}
