/**
 * Payout ledger. Mirrors `PayoutLedgerEntry` in `types/domain.ts`. An
 * immutable, append-only record of payout obligations (constitution §5,
 * audit logging). Campaign-scoped table (constitution §3, isolation) —
 * `campaign_id` is non-null and indexed. Monetary columns are integer
 * cents, never numeric/float.
 */
import { pgTable, uuid, integer, boolean, index } from "drizzle-orm/pg-core";
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
    /** Amount of this ledger entry, in integer cents. */
    amount: integer("amount").notNull(),
    tierAtTime: integer("tier_at_time").notNull(),
    /** Running total of committed payouts for the campaign at this entry,
     * in integer cents. */
    cumulativeCommitted: integer("cumulative_committed").notNull(),
    settled: boolean("settled").notNull().default(false),
    settledAt: timestamptz("settled_at"),
  },
  (table) => [index("payout_ledger_campaign_id_idx").on(table.campaignId)],
);
