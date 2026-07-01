/**
 * Campaign memberships (a player's participation record within a single
 * campaign). Mirrors `CampaignMembership` in `types/domain.ts`.
 * Campaign-scoped table (constitution §3, isolation) — `campaign_id` is
 * non-null. The composite primary key `(campaign_id, player_id)` leads with
 * `campaign_id`, which Postgres can use as an index for campaign-scoped
 * lookups (equality on a leading composite-key column).
 */
import { pgTable, uuid, integer, primaryKey, index } from "drizzle-orm/pg-core";
import { campaigns } from "./campaigns";
import { players } from "./players";

export const campaignMemberships = pgTable(
  "campaign_memberships",
  {
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    approvedCount: integer("approved_count").notNull().default(0),
    currentTier: integer("current_tier").notNull().default(0),
    /** Amount owed to the player for this campaign, in integer cents. */
    balanceOwed: integer("balance_owed").notNull().default(0),
    rank: integer("rank").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.campaignId, table.playerId] }),
    index("campaign_memberships_campaign_id_idx").on(table.campaignId),
  ],
);
