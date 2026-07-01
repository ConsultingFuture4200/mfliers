/**
 * Payout ledger — domain module (T4.3). PRD FR-P1…FR-P3 / §3 / EC-7:
 * "Bundled payout computed on the campaign's tier curve; print baked in.
 * Per-campaign hard cap + 80% warning; a campaign's spend never draws on
 * another's budget. Only approved placements are payable. At-cap: new
 * submissions accepted and still flip pins green, but marked
 * over-cap/unpayable."
 *
 * Constitution §6: domain logic lives in `lib/`, never route handlers.
 * The actual atomic transaction (campaign row lock, tier lookup, cap
 * check, ledger insert, membership counters) lives in
 * `lib/db/dal/payout-ledger.ts`'s `accrueLedgerEntry` — the ESLint
 * `no-restricted-imports` DAL boundary (docs/decisions/0001) requires that
 * multi-table transaction body live inside `lib/db/dal/**`, so this module
 * is the public, typed-error-throwing surface over it, not the transaction
 * owner itself. See that DAL function's doc comment for the atomicity/
 * idempotency design in full.
 *
 * ## Wiring into the two approval seams (batch-4 carry-forward note)
 * Both `lib/capture/submit.ts` (T4.1, auto-approve path) and
 * `lib/review/decision.ts` (T4.2, host manual-approve path) left a
 * documented no-op exactly where this module's `accrue` should be called,
 * both keyed by `(campaignId, submissionId)` for idempotency. This card
 * wires both seams to `accrue` below — see the two files' updated
 * doc comments.
 *
 * ## Anti-requirements honored
 * - No Mycofest tier numbers are hard-coded anywhere in this module or
 *   `lib/payout/tiers.ts` — every lookup reads `campaign.tierTable`.
 * - `accrue` never exceeds `budgetCap` in the payable total (see the DAL
 *   function's cap-enforcement branch).
 * - No function here accepts a caller-supplied payout amount — `accrue`'s
 *   only inputs are ids; the amount is always derived server-side from the
 *   campaign's own tier table.
 * - No payment rail: `markSettled` only flips a boolean/timestamp on an
 *   existing row — no money moves anywhere (v1 settlement is manual,
 *   constitution §1).
 */
import { getCampaignById } from "@/lib/db/dal/campaigns";
import { getMembership } from "@/lib/db/dal/campaign-memberships";
import {
  accrueLedgerEntry,
  getCumulativeCommittedCents,
  listLedgerEntries,
  markLedgerEntrySettled,
} from "@/lib/db/dal/payout-ledger";
import { appendAuditEntry } from "@/lib/audit/log";
import { requireCampaignAccess } from "@/lib/auth/guards";
import type { StaffPrincipal } from "@/lib/auth/staff";
import { isCapWarning } from "@/lib/payout/tiers";
import type { PayoutLedgerEntry } from "@/types/domain";

export class CampaignNotFoundError extends Error {
  readonly status = 404 as const;
  readonly code = "campaign_not_found" as const;

  constructor(campaignId: string) {
    super(`campaign ${campaignId} not found`);
    this.name = "CampaignNotFoundError";
  }
}

/** Thrown by `markSettled` when `ledgerEntryId` doesn't resolve within
 * `campaignId` — mirrors every other scoped DAL's not-found/not-yours
 * conflation (see `lib/review/decision.ts`'s `SubmissionNotFoundError`). */
export class LedgerEntryNotFoundError extends Error {
  readonly status = 404 as const;
  readonly code = "ledger_entry_not_found" as const;

  constructor(campaignId: string, ledgerEntryId: string) {
    super(`ledger entry ${ledgerEntryId} not found in campaign ${campaignId}`);
    this.name = "LedgerEntryNotFoundError";
  }
}

export interface AccrualOutcome {
  entry: PayoutLedgerEntry;
  /** True when this call found an existing entry for
   * `(campaignId, submissionId)` instead of creating a new one — a
   * retried approval never double-pays. */
  alreadyAccrued: boolean;
  /** 80%-of-budget-cap warning flag (card requirement 4) the host UI
   * surfaces. */
  capWarning: boolean;
}

/**
 * Accrues a payout-ledger entry for an approved submission (card
 * requirement 1). Idempotent by `(campaignId, submissionId)` — safe to
 * call from a retried approval dispatch. Never trusts (or even accepts) a
 * client-supplied amount; the payout is always looked up from the
 * campaign's own `tierTable` against the player's ordinal approval count
 * (see `lib/payout/tiers.ts`).
 */
export async function accrue(
  campaignId: string,
  submissionId: string,
  playerId: string,
): Promise<AccrualOutcome> {
  const result = await accrueLedgerEntry(campaignId, submissionId, playerId);
  if (!result) throw new CampaignNotFoundError(campaignId);
  return result;
}

/** Lists every ledger entry for `campaignId` (host visibility, card's
 * `app/api/host/campaigns/[id]/ledger/route.ts`). */
export async function listLedger(
  campaignId: string,
): Promise<PayoutLedgerEntry[]> {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) throw new CampaignNotFoundError(campaignId);
  return listLedgerEntries(campaignId);
}

/** Total *payable* committed spend for `campaignId`, in integer cents
 * (card requirement 3's budget helper, surfaced to the host). */
export async function committedTotal(campaignId: string): Promise<number> {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) throw new CampaignNotFoundError(campaignId);
  return getCumulativeCommittedCents(campaignId);
}

/** Balance owed to a single player within `campaignId`, in integer cents
 * (card requirement 5). `0` for a player with no membership yet — never
 * throws, mirroring `getMembership`'s null-safe contract. */
export async function balanceOwed(
  campaignId: string,
  playerId: string,
): Promise<number> {
  const membership = await getMembership(campaignId, playerId);
  return membership?.balanceOwedCents ?? 0;
}

/**
 * Marks a ledger entry settled (card requirement 5: "a function to mark
 * entries settled" — manual settlement only, constitution §1: this
 * platform tracks what's owed and moves no money itself). Audit-logged
 * (constitution §5: "... settlements ... logged").
 */
export async function markSettled(
  campaignId: string,
  ledgerEntryId: string,
  actorUserId: string,
): Promise<PayoutLedgerEntry> {
  const entry = await markLedgerEntrySettled(campaignId, ledgerEntryId);
  if (!entry) throw new LedgerEntryNotFoundError(campaignId, ledgerEntryId);
  await appendAuditEntry(campaignId, {
    submissionId: entry.submissionId,
    playerId: entry.playerId,
    actorUserId,
    action: "settle",
    reason: null,
  });
  return entry;
}

// ---------------------------------------------------------------------------
// Host-facing surface (constitution §2/§5: authorization is server-side on
// every host/admin route — never a hidden button). Mirrors
// `lib/review/queue.ts`'s `listReviewQueue` shape: the function itself
// takes an already-resolved `StaffPrincipal` and calls
// `requireCampaignAccess` before touching the DAL, so
// `app/api/host/campaigns/[id]/ledger/route.ts` stays a thin HTTP
// translator. `accrue` above is deliberately NOT gated this way — it's an
// internal seam called from the player-driven auto-approve path
// (`lib/capture/submit.ts`) and from `lib/review/decision.ts`'s
// `approveSubmission`, which has already checked access itself before
// calling it.
// ---------------------------------------------------------------------------

export interface LedgerSummary {
  entries: PayoutLedgerEntry[];
  committedTotalCents: number;
  budgetCapCents: number;
  /** 80%-of-budget-cap warning (card requirement 4) for the campaign as a
   * whole, evaluated against the current payable committed total. */
  capWarning: boolean;
}

/** The host-facing ledger view (card's `app/api/host/campaigns/[id]/ledger/
 * route.ts` GET): every entry plus the campaign-wide committed/cap summary. */
export async function getLedgerSummaryForHost(
  principal: StaffPrincipal,
  campaignId: string,
): Promise<LedgerSummary> {
  requireCampaignAccess(principal, campaignId);
  const campaign = await getCampaignById(campaignId);
  if (!campaign) throw new CampaignNotFoundError(campaignId);

  const [entries, committedTotalCents] = await Promise.all([
    listLedgerEntries(campaignId),
    getCumulativeCommittedCents(campaignId),
  ]);

  return {
    entries,
    committedTotalCents,
    budgetCapCents: campaign.budgetCapCents,
    capWarning: isCapWarning(committedTotalCents, campaign.budgetCapCents),
  };
}

/** Marks a ledger entry settled on behalf of a host/site-admin (card's
 * `app/api/host/campaigns/[id]/ledger/route.ts` POST). Authorization +
 * audit logging both happen here, before/via `markSettled`. */
export async function markSettledForHost(
  principal: StaffPrincipal,
  campaignId: string,
  ledgerEntryId: string,
): Promise<PayoutLedgerEntry> {
  requireCampaignAccess(principal, campaignId);
  return markSettled(campaignId, ledgerEntryId, principal.userId);
}
