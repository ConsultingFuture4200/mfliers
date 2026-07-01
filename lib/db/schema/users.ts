/**
 * Staff accounts (site admins and hosts). Mirrors `User` in
 * `types/domain.ts`. `scopedCampaignIds` is modeled as the `user_campaigns`
 * join table (below) rather than an array column, for FK integrity — per
 * T1.3's card: "prefer a join table for FK integrity."
 *
 * Authorization invariant (Liotta review, batch 1): `campaigns.host_id` is
 * the single ownership fact for a campaign; `user_campaigns` is the
 * authorization set Batch 2's Auth.js scoping reads from (constitution §5,
 * `scoped_campaign_ids`), and is an **additive grant list** — it can hold
 * co-host rows beyond the owning host. These two must never drift apart: a
 * DB trigger (`0003_host_user_campaign_invariant.sql`,
 * `sync_campaign_host_to_user_campaigns`) guarantees a campaign's host
 * always has a matching `user_campaigns` row, created/kept in sync on
 * `campaigns` INSERT and on `host_id` UPDATE. Callers (seed fixtures, DAL
 * helpers, admin tooling) must NOT also insert that row by hand — the
 * trigger owns it, and a duplicate manual insert will violate the
 * `(user_id, campaign_id)` primary key.
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
