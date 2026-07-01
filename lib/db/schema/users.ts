/**
 * Staff accounts (site admins and hosts). Mirrors `User` in
 * `types/domain.ts`. `scopedCampaignIds` is modeled as the `user_campaigns`
 * join table (below) rather than an array column, for FK integrity — per
 * T1.3's card: "prefer a join table for FK integrity."
 */
import { pgTable, uuid, index, primaryKey } from "drizzle-orm/pg-core";
import { userTypeEnum } from "./enums";
import { campaigns } from "./campaigns";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: userTypeEnum("type").notNull(),
});

/**
 * Join table for `users.scoped_campaign_ids`. Ignored/empty for
 * `site_admin` users, who are platform-wide (constitution §5).
 */
export const userCampaigns = pgTable(
  "user_campaigns",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.campaignId] }),
    index("user_campaigns_campaign_id_idx").on(table.campaignId),
  ],
);
