/**
 * Payout ledger. Mirrors `PayoutLedgerEntry` in `types/domain.ts`. An
 * immutable, append-only record of payout obligations (constitution §5,
 * audit logging). Campaign-scoped table (constitution §3, isolation) —
 * `campaign_id` is non-null and indexed. Monetary columns are integer
 * cents, never numeric/float.
 *
 * `unpayable` (T4.3, PRD FR-P3 "at-cap" behavior): true when accruing this
 * entry would have pushed the campaign's payable total past `budget_cap`.
 * An unpayable row's `amount` is always persisted as `0` — never a
 * nonzero-then-excluded value — so `lib/db/dal/payout-ledger.ts`'s
 * `getCumulativeCommittedCents` (a plain unfiltered `SUM(amount)`) stays
 * correct without needing a `WHERE NOT unpayable` filter anywhere. The band
 * the submission would have earned is still recorded in `tier_at_time` for
 * host/audit visibility even though no money accrued.
 *
 * The unique `(campaign_id, submission_id)` constraint is the idempotency
 * guard the batch-4 carry-forward note requires: a retried approval (T4.1's
 * auto-approve dispatch, or T4.2's host manual approve) can never insert a
 * second ledger row for the same submission — see
 * `lib/db/dal/payout-ledger.ts`'s `accrueLedgerEntry` for the
 * `ON CONFLICT ... DO NOTHING` write that relies on it.
 */
import {
  pgTable,
  uuid,
  integer,
  boolean,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { timestamptz } from "./columns";
import { campaigns } from "./campaigns";
import { submissions } from "./submissions";
import { players } from "./players";

export const payoutLedger = pgTable(
  "payout_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    /** Amount of this ledger entry, in integer cents. Always `0` when
     * `unpayable` is true. */
    amount: integer("amount").notNull(),
    tierAtTime: integer("tier_at_time").notNull(),
    /** Running total of *payable* committed payouts for the campaign at
     * this entry, in integer cents. */
    cumulativeCommitted: integer("cumulative_committed").notNull(),
    unpayable: boolean("unpayable").notNull().default(false),
    settled: boolean("settled").notNull().default(false),
    settledAt: timestamptz("settled_at"),
  },
  (table) => [
    index("payout_ledger_campaign_id_idx").on(table.campaignId),
    unique("payout_ledger_campaign_submission_key").on(
      table.campaignId,
      table.submissionId,
    ),
  ],
);
