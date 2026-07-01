/**
 * Campaign lifecycle + configuration (T3.1).
 *
 * PRD FR-C1/FR-C2/FR-C4: site admin creates a campaign (name, flier image,
 * budget cap, tier table, grand prize, privacy setting, proximity radius,
 * start/end); lifecycle is `draft -> live -> closed`; only `live`
 * campaigns accept submissions/appear on the universal map; closing
 * freezes the ledger, finalizes the leaderboard, and determines a grand-
 * prize winner.
 *
 * Constitution §6: domain logic lives in `lib/`, never in route handlers —
 * this module is the whole implementation; `app/api/admin/campaigns/*`
 * routes are thin translators of HTTP <-> these functions. Constitution
 * §5: only a `site_admin` creates/configures a campaign in v1 — every
 * exported action here calls `requireSiteAdmin` first, before touching the
 * DAL.
 *
 * NEEDS_CLARIFICATION: FR-C1's field list for "site admin creates a
 * campaign" doesn't mention a host, but `campaigns.host_id` (T1.3 schema)
 * is `NOT NULL` and constitution §5 defines a host's authorization as
 * scoped to specific campaigns via that same relationship. Treated
 * `hostId` as a required creation input (the site admin assigns a host at
 * creation time; the existing `sync_campaign_host_to_user_campaigns` DB
 * trigger then grants that host access) rather than inventing a separate
 * host-assignment flow this card doesn't describe. Flag for review if a
 * later card (host-invite/reassignment) expects something different.
 */
import { randomUUID } from "node:crypto";
import { requireSiteAdmin } from "@/lib/auth/guards";
import type { StaffPrincipal } from "@/lib/auth/staff";
import {
  getCampaignById,
  insertCampaign,
  setCampaignState,
  updateCampaignFields,
  type CampaignFieldsPatch,
} from "@/lib/db/dal/campaigns";
import {
  listMemberships,
  setMembershipRanks,
} from "@/lib/db/dal/campaign-memberships";
import { listSubmissions } from "@/lib/db/dal/submissions";
import { listTargets } from "@/lib/db/dal/targets";
import type {
  Campaign,
  CampaignMembership,
  CampaignState,
  PrivacySetting,
  Submission,
  TierTable,
} from "@/types/domain";
import { validateTierTable } from "./tier-validation";

// ---------------------------------------------------------------------------
// Typed errors (constitution §3: "server logic ... throws typed errors;
// route handlers translate to HTTP status + JSON error" — no silent catches)
// ---------------------------------------------------------------------------

/** Thrown when a create/update input fails a basic shape/value check that
 * isn't already covered by `InvalidTierTableError`. */
export class InvalidCampaignInputError extends Error {
  readonly status = 400 as const;
  readonly code = "invalid_campaign_input" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidCampaignInputError";
  }
}

/** Thrown when `campaignId` doesn't resolve to an existing campaign. */
export class CampaignNotFoundError extends Error {
  readonly status = 404 as const;
  readonly code = "campaign_not_found" as const;

  constructor(campaignId: string) {
    super(`campaign ${campaignId} not found`);
    this.name = "CampaignNotFoundError";
  }
}

/** Thrown when a requested state transition isn't one of the legal
 * forward steps (`draft -> live`, `live -> closed`). Card requirement 3:
 * "Reject illegal transitions." */
export class IllegalTransitionError extends Error {
  readonly status = 409 as const;
  readonly code = "illegal_transition" as const;

  constructor(from: CampaignState, to: CampaignState) {
    super(
      `cannot transition campaign from "${from}" to "${to}" — the only ` +
        'legal transitions are "draft" -> "live" and "live" -> "closed".',
    );
    this.name = "IllegalTransitionError";
  }
}

/** Thrown when `draft -> live` is attempted before the readiness
 * preconditions (flier image set, >=1 target) are met. */
export class CampaignNotReadyError extends Error {
  readonly status = 422 as const;
  readonly code = "campaign_not_ready" as const;

  constructor(message: string) {
    super(message);
    this.name = "CampaignNotReadyError";
  }
}

/** Thrown by `assertCampaignAccrualAllowed` (and by `updateCampaign`) once
 * a campaign is `closed` — card requirement 4: closing "freezes the
 * ledger (a subsequent accrual attempt is rejected)." Future ledger-write
 * code (T4.3) must call `assertCampaignAccrualAllowed` before creating a
 * `payout_ledger` row. */
export class CampaignFrozenError extends Error {
  readonly status = 409 as const;
  readonly code = "campaign_frozen" as const;

  constructor(campaignId: string) {
    super(
      `campaign ${campaignId} is closed; no further accruals or ` +
        "configuration edits are allowed.",
    );
    this.name = "CampaignFrozenError";
  }
}

// ---------------------------------------------------------------------------
// Create / update (card requirements 1, 5)
// ---------------------------------------------------------------------------

/** Input for `createCampaign` (PRD FR-C1). `flierImageUrl` is optional at
 * creation (defaults to `""`) — the `draft -> live` transition (card
 * requirement 3) is what actually enforces it must be set, matching the
 * card's phrasing that readiness is checked at the transition, not
 * necessarily at creation time. */
export interface CreateCampaignInput {
  name: string;
  flierImageUrl?: string;
  /** Total campaign budget, in integer cents. Never a float. */
  budgetCapCents: number;
  tierTable: TierTable;
  grandPrize: string;
  privacySetting: PrivacySetting;
  /** Meters. Platform default is 40m (T3.4) but is per-campaign
   * configuration (PRD FR-F1). */
  proximityRadiusM: number;
  hostId: string;
  startAt: Date;
  endAt: Date;
}

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidCampaignInputError(`${field} is required.`);
  }
}

/** Card requirement 5 ("Budget/tier amounts persisted as integer cents"):
 * rejects any non-integer or negative amount before it ever reaches the
 * DAL/database. */
function assertIntegerCents(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InvalidCampaignInputError(
      `${field} must be a non-negative integer number of cents.`,
    );
  }
}

function assertDateOrder(startAt: Date, endAt: Date): void {
  if (!(endAt.getTime() > startAt.getTime())) {
    throw new InvalidCampaignInputError("endAt must be after startAt.");
  }
}

/**
 * Creates a campaign (card requirement 1). Site-admin only. Always starts
 * in `draft` state (PRD FR-C2). Validates the tier table (card requirement
 * 2) and that money fields are integer cents before writing.
 */
export async function createCampaign(
  principal: StaffPrincipal,
  input: CreateCampaignInput,
): Promise<Campaign> {
  requireSiteAdmin(principal);

  assertNonEmptyString(input.name, "name");
  assertNonEmptyString(input.grandPrize, "grandPrize");
  assertNonEmptyString(input.hostId, "hostId");
  assertIntegerCents(input.budgetCapCents, "budgetCapCents");
  validateTierTable(input.tierTable);
  if (
    !Number.isInteger(input.proximityRadiusM) ||
    input.proximityRadiusM <= 0
  ) {
    throw new InvalidCampaignInputError(
      "proximityRadiusM must be a positive integer (meters).",
    );
  }
  assertDateOrder(input.startAt, input.endAt);

  const campaignId = randomUUID();
  return insertCampaign(campaignId, {
    name: input.name,
    flierImageUrl: input.flierImageUrl ?? "",
    budgetCapCents: input.budgetCapCents,
    tierTable: input.tierTable,
    grandPrize: input.grandPrize,
    privacySetting: input.privacySetting,
    proximityRadiusM: input.proximityRadiusM,
    hostId: input.hostId,
    startAt: input.startAt,
    endAt: input.endAt,
  });
}

/** Input for `updateCampaign` — every field optional; only supplied keys
 * are changed. Never includes `state` (use `activateCampaign`/
 * `closeCampaign`) or `hostId` (host reassignment is out of this card's
 * scope). */
export type UpdateCampaignInput = Partial<Omit<CreateCampaignInput, "hostId">>;

/**
 * Updates a campaign's configuration fields (card requirement 5,
 * "update/configure"). Site-admin only. Rejected outright once the
 * campaign is `closed` (frozen — same guarantee as
 * `assertCampaignAccrualAllowed`, applied to configuration edits too).
 */
export async function updateCampaign(
  principal: StaffPrincipal,
  campaignId: string,
  input: UpdateCampaignInput,
): Promise<Campaign> {
  requireSiteAdmin(principal);

  const existing = await getCampaignById(campaignId);
  if (!existing) throw new CampaignNotFoundError(campaignId);
  if (existing.state === "closed") throw new CampaignFrozenError(campaignId);

  if (input.name !== undefined) assertNonEmptyString(input.name, "name");
  if (input.grandPrize !== undefined) {
    assertNonEmptyString(input.grandPrize, "grandPrize");
  }
  if (input.budgetCapCents !== undefined) {
    assertIntegerCents(input.budgetCapCents, "budgetCapCents");
  }
  if (input.tierTable !== undefined) validateTierTable(input.tierTable);
  if (input.proximityRadiusM !== undefined) {
    if (
      !Number.isInteger(input.proximityRadiusM) ||
      input.proximityRadiusM <= 0
    ) {
      throw new InvalidCampaignInputError(
        "proximityRadiusM must be a positive integer (meters).",
      );
    }
  }
  const nextStart = input.startAt ?? existing.startAt;
  const nextEnd = input.endAt ?? existing.endAt;
  assertDateOrder(nextStart, nextEnd);

  const patch: CampaignFieldsPatch = { ...input };
  return updateCampaignFields(campaignId, patch);
}

// ---------------------------------------------------------------------------
// State machine (card requirement 3)
// ---------------------------------------------------------------------------

const LEGAL_TRANSITIONS: Record<CampaignState, CampaignState[]> = {
  draft: ["live"],
  live: ["closed"],
  closed: [],
};

function assertTransitionLegal(from: CampaignState, to: CampaignState): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new IllegalTransitionError(from, to);
  }
}

/**
 * `draft -> live` (card requirement 3). Site-admin only. Requires a flier
 * image is set and at least one target exists; rejects the transition
 * otherwise (`CampaignNotReadyError`). Rejects any other current state
 * (`IllegalTransitionError`).
 */
export async function activateCampaign(
  principal: StaffPrincipal,
  campaignId: string,
): Promise<Campaign> {
  requireSiteAdmin(principal);

  const campaign = await getCampaignById(campaignId);
  if (!campaign) throw new CampaignNotFoundError(campaignId);
  assertTransitionLegal(campaign.state, "live");

  if (campaign.flierImageUrl.trim().length === 0) {
    throw new CampaignNotReadyError(
      "a flier image must be set before a campaign can go live.",
    );
  }
  const targets = await listTargets(campaignId);
  if (targets.length === 0) {
    throw new CampaignNotReadyError(
      "at least one target must exist before a campaign can go live.",
    );
  }

  const updated = await setCampaignState(campaignId, campaign.state, "live");
  // A `null` result means the row's state moved on between the read above
  // and this atomic conditional `UPDATE` (e.g. a concurrent transition) —
  // treat it the same as any other illegal transition rather than silently
  // returning a stale `Campaign` object.
  if (!updated) throw new IllegalTransitionError(campaign.state, "live");
  return updated;
}

/** One player's position in the finalized leaderboard snapshot (card
 * requirement 4). `rank` 1 is the grand-prize winner. */
export interface LeaderboardEntry {
  playerId: string;
  rank: number;
  approvedCount: number;
}

/** Result of closing a campaign (card requirement 4). */
export interface CloseCampaignResult {
  campaign: Campaign;
  leaderboard: LeaderboardEntry[];
  /** `null` only when the campaign has no memberships at all (nothing to
   * rank). */
  grandPrizeWinnerPlayerId: string | null;
}

/**
 * The timestamp a player reached their final `approvedCount`, for the
 * §3 tie-break ("most approved placements, then earliest to reach that
 * count"). Derived from the campaign's own `approved` submissions
 * (`receivedAt` — server-stamped, constitution §3 authoritative time),
 * never from a separate "reached tier N at" column the schema doesn't
 * have. A player with `approvedCount` 0, or fewer recorded approved
 * submissions than their own `approvedCount` (shouldn't happen, but this
 * module doesn't assume the membership counter and the submissions table
 * can never drift), sorts last within their count via `+Infinity`.
 */
function reachedFinalCountAt(
  approvedTimestampsByPlayer: Map<string, number[]>,
  playerId: string,
  approvedCount: number,
): number {
  if (approvedCount <= 0) return Number.POSITIVE_INFINITY;
  const timestamps = approvedTimestampsByPlayer.get(playerId);
  const ts = timestamps?.[approvedCount - 1];
  return ts ?? Number.POSITIVE_INFINITY;
}

/** Pure computation (unit-testable without the DB) of the final
 * leaderboard ordering + grand-prize winner from already-fetched
 * memberships/submissions. Exported for direct testing of the tie-break
 * rule. */
export function computeFinalLeaderboard(
  memberships: CampaignMembership[],
  submissions: Submission[],
): LeaderboardEntry[] {
  const approvedTimestampsByPlayer = new Map<string, number[]>();
  for (const submission of submissions) {
    if (submission.decision !== "approved") continue;
    const list = approvedTimestampsByPlayer.get(submission.playerId) ?? [];
    list.push(submission.receivedAt.getTime());
    approvedTimestampsByPlayer.set(submission.playerId, list);
  }
  for (const list of approvedTimestampsByPlayer.values()) {
    list.sort((a, b) => a - b);
  }

  const sorted = [...memberships].sort((a, b) => {
    if (b.approvedCount !== a.approvedCount) {
      return b.approvedCount - a.approvedCount;
    }
    const aReachedAt = reachedFinalCountAt(
      approvedTimestampsByPlayer,
      a.playerId,
      a.approvedCount,
    );
    const bReachedAt = reachedFinalCountAt(
      approvedTimestampsByPlayer,
      b.playerId,
      b.approvedCount,
    );
    if (aReachedAt !== bReachedAt) return aReachedAt - bReachedAt;
    // Fully-tied (including "both have 0 approved and no submissions") —
    // fall back to a stable, deterministic order rather than leaving
    // Array#sort's tie behavior to chance.
    return a.playerId.localeCompare(b.playerId);
  });

  return sorted.map((membership, index) => ({
    playerId: membership.playerId,
    rank: index + 1,
    approvedCount: membership.approvedCount,
  }));
}

/**
 * `live -> closed` (card requirement 3/4). Site-admin only. Runs the
 * finalize routine: snapshots the final leaderboard ordering onto each
 * membership's `rank` and determines the grand-prize winner (top of the
 * leaderboard, per the §3 tie-break). Anti-requirement: does NOT compute
 * payouts (T4.3's job) — only ordering.
 *
 * Rejects any current state other than `live` (`IllegalTransitionError`).
 * After this returns, `assertCampaignAccrualAllowed` throws for this
 * campaign — the ledger is frozen (card requirement 4).
 */
export async function closeCampaign(
  principal: StaffPrincipal,
  campaignId: string,
): Promise<CloseCampaignResult> {
  requireSiteAdmin(principal);

  const campaign = await getCampaignById(campaignId);
  if (!campaign) throw new CampaignNotFoundError(campaignId);
  assertTransitionLegal(campaign.state, "closed");

  const [memberships, submissions] = await Promise.all([
    listMemberships(campaignId),
    listSubmissions(campaignId),
  ]);
  const leaderboard = computeFinalLeaderboard(memberships, submissions);

  if (leaderboard.length > 0) {
    await setMembershipRanks(
      campaignId,
      leaderboard.map(({ playerId, rank }) => ({ playerId, rank })),
    );
  }

  const closed = await setCampaignState(campaignId, campaign.state, "closed");
  // Same concurrent-transition guard as `activateCampaign` — a `null`
  // result means another caller already moved this campaign out of `live`
  // between the read above and this atomic write.
  if (!closed) throw new IllegalTransitionError(campaign.state, "closed");

  return {
    campaign: closed,
    leaderboard,
    grandPrizeWinnerPlayerId: leaderboard[0]?.playerId ?? null,
  };
}

/**
 * Guard future ledger-accrual code (T4.3) must call before writing a
 * `payout_ledger` row: a `closed` campaign's ledger is frozen (card
 * requirement 4) — no new accruals, regardless of how "correct" the
 * amount would otherwise be. Also rejects a `draft` campaign (a campaign
 * that was never live never had submissions to accrue against). Throws
 * `CampaignFrozenError` on denial; returns normally (`void`) for a `live`
 * campaign.
 */
export function assertCampaignAccrualAllowed(campaign: Campaign): void {
  if (campaign.state !== "live") {
    throw new CampaignFrozenError(campaign.id);
  }
}

/** Thrown by `assertCampaignLive` when a player-facing write (claim,
 * submission) targets a campaign that isn't currently `live`. */
export class CampaignNotLiveError extends Error {
  readonly status = 409 as const;
  readonly code = "campaign_not_live" as const;

  constructor(campaignId: string) {
    super(
      `campaign ${campaignId} is not live; only live campaigns accept ` +
        "claims or submissions.",
    );
    this.name = "CampaignNotLiveError";
  }
}

/**
 * Guards a player-facing write against a campaign that isn't currently
 * `live` (PRD FR-C4: "Only live campaigns ... accept submissions"; the
 * claim mechanic anchors a future submission to a target's coordinates, so
 * the same rule applies to claiming — a target in a `draft` or `closed`
 * campaign must not become claimable via a direct API call just because
 * the UI hides the button). Constitution §2: "hiding a button is not
 * security" — this must be checked server-side on the write path, not left
 * to the client. Call this from the route handler (or the domain function
 * it calls) *before* any target-state-machine write. Throws
 * `CampaignNotLiveError` for `draft`/`closed`; returns normally for `live`.
 */
export function assertCampaignLive(campaign: Campaign): void {
  if (campaign.state !== "live") {
    throw new CampaignNotLiveError(campaign.id);
  }
}
