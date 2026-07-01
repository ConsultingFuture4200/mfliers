/**
 * Payout-ledger DAL (T2.1) — campaign-scoped (constitution §3).
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
 * campaign's spend.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { payoutLedger } from "@/lib/db/schema";
import type { PayoutLedgerEntry } from "@/types/domain";
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
