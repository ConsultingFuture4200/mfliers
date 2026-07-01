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
import { pgTable, uuid, text, index, primaryKey } from "drizzle-orm/pg-core";
import { userTypeEnum } from "./enums";
import { campaigns } from "./campaigns";

/**
 * `email`/`passwordHash` (T2.3 — PRD FR-A2, constitution §2 "email +
 * password, role-scoped"): T1.3 didn't add these when it created this
 * table (only `type`), so T2.3 extends it here rather than duplicating a
 * parallel staff-credentials table. Both are nullable: `tests/fixtures/
 * seed-two-campaigns.ts` (T1.4) and the isolation suite (T2.1) insert bare
 * `{ type: "host" }` rows with no login credentials, and that fixture is
 * out of this card's file list to edit — making these columns NOT NULL
 * would break every existing DB-backed test in `tests/isolation/` and
 * `tests/fixtures/`. A user with a null `passwordHash` simply can't
 * authenticate via `authenticateStaff` (`lib/auth/staff.ts`); it does not
 * weaken authorization, since `requireCampaignAccess`/`requireSiteAdmin`
 * (`lib/auth/guards.ts`) operate on an already-authenticated principal,
 * never on a raw user row.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: userTypeEnum("type").notNull(),
  email: text("email").unique(),
  passwordHash: text("password_hash"),
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
