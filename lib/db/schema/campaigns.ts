/**
 * Campaigns (tenants). Mirrors `Campaign` in `types/domain.ts`.
 *
 * Money fields (`budget_cap`) are integer cents (constitution §3) — see
 * `tasks/lessons.md` for why the DB column name doesn't carry a `_cents`
 * suffix even though the TS domain field does (`budgetCapCents`): T1.3 maps
 * back to the PRD's literal snake_case column names.
 */
import { pgTable, uuid, text, integer, jsonb } from "drizzle-orm/pg-core";
import type { TierTable } from "@/types/domain";
import { timestamptz } from "./columns";
import {
  campaignStateEnum,
  privacySettingEnum,
  settlementModeEnum,
} from "./enums";
import { users } from "./users";

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  flierImageUrl: text("flier_image_url").notNull(),
  /** Total campaign budget, in integer cents. Never float/numeric. */
  budgetCap: integer("budget_cap").notNull(),
  tierTable: jsonb("tier_table").$type<TierTable>().notNull(),
  grandPrize: text("grand_prize").notNull(),
  privacySetting: privacySettingEnum("privacy_setting")
    .notNull()
    .default("admin_only"),
  proximityRadiusM: integer("proximity_radius_m").notNull(),
  settlementMode: settlementModeEnum("settlement_mode")
    .notNull()
    .default("manual"),
  state: campaignStateEnum("state").notNull().default("draft"),
  hostId: uuid("host_id")
    .notNull()
    .references(() => users.id),
  startAt: timestamptz("start_at").notNull(),
  endAt: timestamptz("end_at").notNull(),
});
