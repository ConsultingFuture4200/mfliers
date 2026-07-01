/**
 * Targets (map pins). Mirrors `Target` in `types/domain.ts`. Campaign-scoped
 * table (constitution §3, isolation) — `campaign_id` is non-null and
 * indexed. `location` is `geography(Point,4326)` with a GiST index so
 * `ST_DWithin` proximity checks (T3.2/T3.4) hit the spatial index.
 *
 * `filled_by_submission_id` and `submissions.target_id` are mutually
 * referencing (a target points at the submission that filled it; a
 * submission points at the target it was filed against). Drizzle resolves
 * this circular FK via the lazy `() => table.column` reference callback —
 * see `submissions.ts`.
 */
import {
  pgTable,
  uuid,
  text,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { geographyPoint, timestamptz } from "./columns";
import { targetStateEnum } from "./enums";
import { campaigns } from "./campaigns";
import { players } from "./players";
import { submissions } from "./submissions";

export const targets = pgTable(
  "targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    location: geographyPoint("location").notNull(),
    state: targetStateEnum("state").notNull().default("red"),
    claimedBy: uuid("claimed_by").references(() => players.id),
    claimExpiresAt: timestamptz("claim_expires_at"),
    filledBySubmissionId: uuid("filled_by_submission_id").references(
      (): AnyPgColumn => submissions.id,
    ),
  },
  (table) => [
    index("targets_campaign_id_idx").on(table.campaignId),
    index("targets_location_gist_idx").using("gist", table.location),
  ],
);
