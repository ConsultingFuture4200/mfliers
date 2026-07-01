/**
 * Submissions (geotagged photo submissions against a claimed target).
 * Mirrors `Submission` in `types/domain.ts`. Campaign-scoped table
 * (constitution §3, isolation) — `campaign_id` is non-null and indexed.
 *
 * `device_gps`/`exif_gps` are `geography(Point,4326)` (constitution §3,
 * geospatial — no hand-rolled haversine). `received_at` is server-stamped
 * and authoritative for payout/fraud logic (constitution §3, time) — the
 * DAL/handler layer (not this schema) is responsible for never accepting a
 * client-supplied value for it.
 */
import {
  pgTable,
  uuid,
  text,
  jsonb,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { FraudCheckResult } from "@/types/domain";
import { geographyPoint, timestamptz } from "./columns";
import { submissionDecisionEnum } from "./enums";
import { campaigns } from "./campaigns";
import { players } from "./players";
import { targets } from "./targets";
import { users } from "./users";

export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    targetId: uuid("target_id")
      .notNull()
      .references((): AnyPgColumn => targets.id),
    photoUrl: text("photo_url").notNull(),
    deviceGps: geographyPoint("device_gps").notNull(),
    exifGps: geographyPoint("exif_gps"),
    exifTs: timestamptz("exif_ts"),
    /** Server-stamped receipt time; authoritative for payout/fraud logic. */
    receivedAt: timestamptz("received_at").notNull().defaultNow(),
    phash: text("phash").notNull(),
    fraudChecks: jsonb("fraud_checks")
      .$type<FraudCheckResult[]>()
      .notNull()
      .default([]),
    decision: submissionDecisionEnum("decision").notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamptz("decided_at"),
  },
  (table) => [index("submissions_campaign_id_idx").on(table.campaignId)],
);
