/**
 * Payout-ledger DAL (T2.1; extended by T4.3 with atomic accrual + cap
 * enforcement + settlement) — campaign-scoped (constitution §3).
 *
 * Every exported function requires `campaignId: string` as its first,
 * non-optional parameter and includes `eq(payoutLedger.campaignId,
 * campaignId)` in its query, per
 * `docs/decisions/0001-tenant-isolation-enforcement.md`.
 *
 * `getCumulativeCommittedCents` is the budget helper the card requires: it
 * computes the running committed total **strictly from that campaign's own
 * ledger rows** (a fresh `SUM(amount)` over rows filtered to `campaignId`),
 * not by trusting any single row's stored `cumulative_committed` snapshot —
 * so a bug or gap in how that per-row snapshot was written at insert time
 * can never let one campaign's budget math read as affected by another
 * campaign's spend. It never needs a `WHERE NOT unpayable` filter — see
 * `lib/db/schema/payout-ledger.ts`'s doc comment (an unpayable row's
 * `amount` is always persisted as `0`).
 *
 * ## `accrueLedgerEntry` — atomicity + idempotency (T4.3, batch-4
 * carry-forward note)
 * The full "read committed total, look up tier, check the cap, write the
 * ledger row, bump the player's membership counters" sequence runs inside a
 * single `db.transaction`, with the campaign's own row locked
 * `FOR UPDATE` first. Constitution §6's DAL boundary (enforced by the
 * ESLint `no-restricted-imports` rule — only `lib/db/dal/**` may import the
 * raw db client/schema) is *why* this whole transaction lives here rather
 * than in `lib/payout/ledger.ts` (T4.3's public, typed-error-throwing
 * surface): the transaction touches `campaigns`, `campaign_memberships`,
 * *and* `payout_ledger` in one atomic unit, so it can't be split across
 * DAL modules without losing atomicity.
 *
 * The campaign-row lock is deliberately **campaign-wide**, not
 * per-player: two concurrent approvals for the *same* campaign (even for
 * different players) serialize through this one lock, which is what makes
 * "cumulative committed never exceeds budget_cap" (card acceptance
 * criterion) hold even under a real race — see
 * `tests/payout/ledger.test.ts`'s concurrent-accrual test. This trades
 * per-campaign accrual throughput for correctness; acceptable at the
 * platform's stated scale (PRD §9 — accruals are approval-driven, not a
 * high-frequency hot path).
 *
 * Idempotency (by `(campaignId, submissionId)`): a fast-path check before
 * the lock returns the existing row for a retried call without contending
 * for the lock at all; the `payout_ledger` table also carries a real
 * `UNIQUE (campaign_id, submission_id)` constraint (see the schema's doc
 * comment) that `ON CONFLICT DO NOTHING` relies on as a second, physical
 * guard — belt-and-suspenders against a caller that somehow reaches this
 * function without a prior existing-row check (the fast path above) ever
 * running. `campaign_memberships` is only ever incremented when the insert
 * actually happened (`inserted.length > 0`), never on the conflict branch,
 * so a lost race can never double-count a player's `approved_count`/
 * `balance_owed`.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { payoutLedger, campaigns, campaignMemberships } from "@/lib/db/schema";
import type { PayoutLedgerEntry } from "@/types/domain";
import { isCapWarning, lookupTierBand } from "@/lib/payout/tiers";
import { assertCampaignId } from "./scope";

function toDomain(row: typeof payoutLedger.$inferSelect): PayoutLedgerEntry {
  return {
    id: row.id,
    campaignId: row.campaignId,
    submissionId: row.submissionId,
    playerId: row.playerId,
    amountCents: row.amount,
    tierAtTime: row.tierAtTime,
    cumulativeCommittedCents: row.cumulativeCommitted,
    unpayable: row.unpayable,
    settled: row.settled,
    settledAt: row.settledAt,
  };
}

/** Lists every ledger entry for `campaignId`. Never returns another
 * campaign's rows. */
export async function listLedgerEntries(
  campaignId: string,
): Promise<PayoutLedgerEntry[]> {
  assertCampaignId(campaignId, "listLedgerEntries");
  const rows = await db
    .select()
    .from(payoutLedger)
    .where(eq(payoutLedger.campaignId, campaignId));
  return rows.map(toDomain);
}

/**
 * Budget helper (card requirement 4): total committed payouts for
 * `campaignId`, in integer cents, computed strictly from that campaign's
 * own ledger rows. Callers (T4.3's cap enforcement) compare this against
 * `campaigns.budget_cap` — never against another campaign's total.
 */
export async function getCumulativeCommittedCents(
  campaignId: string,
): Promise<number> {
  assertCampaignId(campaignId, "getCumulativeCommittedCents");
  const [row] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${payoutLedger.amount}), 0)::int`,
    })
    .from(payoutLedger)
    .where(eq(payoutLedger.campaignId, campaignId));
  return row?.total ?? 0;
}

/** Result of `accrueLedgerEntry`. */
export interface AccrualResult {
  entry: PayoutLedgerEntry;
  /** True when a ledger entry for `(campaignId, submissionId)` already
   * existed — this call was a no-op idempotent retry, not a fresh
   * accrual (batch-4 carry-forward note). */
  alreadyAccrued: boolean;
  /** 80%-of-budget-cap warning (card requirement 4), evaluated against the
   * entry's own `cumulativeCommittedCents`. */
  capWarning: boolean;
}

/**
 * Atomically accrues a payout-ledger entry for an approved submission (card
 * requirement 1): looks up the payout from the campaign's own `tierTable`
 * against the player's ordinal approval count, enforces the per-campaign
 * `budgetCap` (marking the entry `unpayable`/over-cap rather than exceeding
 * it), and keeps `campaign_memberships` (`approved_count`, `current_tier`,
 * `balance_owed`) in sync in the same transaction. Idempotent by
 * `(campaignId, submissionId)` — see module doc comment.
 *
 * Returns `null` if `campaignId` doesn't resolve to a real campaign — the
 * caller (`lib/payout/ledger.ts`) is responsible for turning that into a
 * typed `CampaignNotFoundError`.
 */
export async function accrueLedgerEntry(
  campaignId: string,
  submissionId: string,
  playerId: string,
): Promise<AccrualResult | null> {
  assertCampaignId(campaignId, "accrueLedgerEntry");

  return db.transaction(async (tx) => {
    // Fast path: already accrued (idempotent retry) — no lock contention.
    const [existing] = await tx
      .select()
      .from(payoutLedger)
      .where(
        and(
          eq(payoutLedger.campaignId, campaignId),
          eq(payoutLedger.submissionId, submissionId),
        ),
      )
      .limit(1);
    if (existing) {
      const [campaignRow] = await tx
        .select({ budgetCap: campaigns.budgetCap })
        .from(campaigns)
        .where(eq(campaigns.id, campaignId))
        .limit(1);
      if (!campaignRow) return null;
      return {
        entry: toDomain(existing),
        alreadyAccrued: true,
        capWarning: isCapWarning(
          existing.cumulativeCommitted,
          campaignRow.budgetCap,
        ),
      };
    }

    // Lock the campaign row: serializes every accrual for this campaign
    // (see module doc comment) so two concurrent approvals near the cap
    // can't both read the same "committed so far" total.
    const [campaignRow] = await tx
      .select({
        tierTable: campaigns.tierTable,
        budgetCap: campaigns.budgetCap,
      })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .for("update");
    if (!campaignRow) return null;

    const [membershipRow] = await tx
      .select({ approvedCount: campaignMemberships.approvedCount })
      .from(campaignMemberships)
      .where(
        and(
          eq(campaignMemberships.campaignId, campaignId),
          eq(campaignMemberships.playerId, playerId),
        ),
      )
      .for("update");
    // The "count" a payout is looked up against is this approval's ordinal
    // number (prior approved count + 1) — see lib/payout/tiers.ts's doc
    // comment for why, and how this differs from lib/fraud/pipeline.ts's
    // (T3.5) unrelated tier-3-routing use of the raw prior count.
    const newApprovedCount = (membershipRow?.approvedCount ?? 0) + 1;

    const { band, tierNumber } = lookupTierBand(
      campaignRow.tierTable,
      newApprovedCount,
    );

    const [{ committed: committedBefore }] = await tx
      .select({
        committed: sql<number>`COALESCE(SUM(${payoutLedger.amount}), 0)::int`,
      })
      .from(payoutLedger)
      .where(eq(payoutLedger.campaignId, campaignId));

    const unpayable =
      committedBefore + band.payoutCents > campaignRow.budgetCap;
    const payableAmount = unpayable ? 0 : band.payoutCents;
    const cumulativeCommitted = committedBefore + payableAmount;

    const inserted = await tx
      .insert(payoutLedger)
      .values({
        campaignId,
        submissionId,
        playerId,
        amount: payableAmount,
        tierAtTime: tierNumber,
        cumulativeCommitted,
        unpayable,
      })
      .onConflictDoNothing({
        target: [payoutLedger.campaignId, payoutLedger.submissionId],
      })
      .returning();

    if (inserted.length === 0) {
      // Lost a race with a concurrent duplicate call for this exact
      // submission despite the fast-path check above — the winner already
      // updated campaign_memberships; re-read its row rather than
      // double-apply (see module doc comment).
      const [row] = await tx
        .select()
        .from(payoutLedger)
        .where(
          and(
            eq(payoutLedger.campaignId, campaignId),
            eq(payoutLedger.submissionId, submissionId),
          ),
        )
        .limit(1);
      return {
        entry: toDomain(row),
        alreadyAccrued: true,
        capWarning: isCapWarning(
          row.cumulativeCommitted,
          campaignRow.budgetCap,
        ),
      };
    }

    await tx
      .insert(campaignMemberships)
      .values({
        campaignId,
        playerId,
        approvedCount: 1,
        currentTier: tierNumber,
        balanceOwed: payableAmount,
      })
      .onConflictDoUpdate({
        target: [campaignMemberships.campaignId, campaignMemberships.playerId],
        set: {
          approvedCount: sql`${campaignMemberships.approvedCount} + 1`,
          currentTier: tierNumber,
          balanceOwed: sql`${campaignMemberships.balanceOwed} + ${payableAmount}`,
        },
      });

    return {
      entry: toDomain(inserted[0]),
      alreadyAccrued: false,
      capWarning: isCapWarning(cumulativeCommitted, campaignRow.budgetCap),
    };
  });
}

/**
 * Marks a ledger entry settled (card requirement 5: manual settlement —
 * constitution §1, the platform tracks what's owed and moves no money
 * itself). Returns `null` if `ledgerEntryId` doesn't resolve within
 * `campaignId` (never distinguishes "doesn't exist" from "belongs to
 * another campaign," matching every other scoped DAL's not-found/not-yours
 * conflation).
 */
export async function markLedgerEntrySettled(
  campaignId: string,
  ledgerEntryId: string,
): Promise<PayoutLedgerEntry | null> {
  assertCampaignId(campaignId, "markLedgerEntrySettled");
  const [row] = await db
    .update(payoutLedger)
    .set({ settled: true, settledAt: new Date() })
    .where(
      and(
        eq(payoutLedger.campaignId, campaignId),
        eq(payoutLedger.id, ledgerEntryId),
      ),
    )
    .returning();
  return row ? toDomain(row) : null;
}
