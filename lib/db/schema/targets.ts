/**
 * Targets (map pins). Mirrors `Target` in `types/domain.ts`. Campaign-scoped
 * table (constitution §3, isolation) — `campaign_id` is non-null and
 * indexed. `location` is `geography(Point,4326)` with a GiST index so
 * `ST_DWithin` proximity checks (T3.2/T3.4) hit the spatial index.
 *
 * `filled_by_submission_id` and `submissions.target_id` are mutually
 * referencing (a target points at the submission that filled it; a
 * submission points at the target it was filed against). Both sides use a
 * **composite** FK on `(campaign_id, id)` rather than a plain `id` FK — the
 * `UNIQUE(campaign_id, id)` below makes this table's pairing addressable,
 * and `submissions.ts`'s composite FK against it makes it physically
 * impossible for a submission to point at a target in a different campaign
 * (Liotta review, batch 1: tenant isolation must be structural, not just
 * "every query remembers to filter by campaign_id").
 *
 * The *reverse* direction — `targets.filled_by_submission_id` ->
 * `submissions(campaign_id, id)` — is enforced by the same composite-FK
 * pattern at the DB level (see
 * `lib/db/migrations/0002_colossal_orphan.sql`), but is deliberately NOT
 * declared here via Drizzle's `foreignKey()` builder: `pgTable`'s extra-config
 * callback participates in TypeScript's type inference for this table's
 * exported type (unlike a lazy `.references(() => ...)` single-column ref),
 * so a `foreignKey()` entry here referencing `submissions`'s columns would
 * make this module's and `submissions.ts`'s exported types mutually
 * dependent on each other's inferred type, which `tsc` rejects as a
 * circular "implicitly has type 'any'" error. Because this constraint is
 * absent from both this file and its Drizzle-kit snapshot, `pnpm db:generate`
 * will never try to manage (or drop) it — it's tracked purely by the raw-SQL
 * migration and verified by the isolation tests, the same way the PostGIS
 * extension (`0000_enable_postgis.sql`) and the host/user_campaigns sync
 * trigger (`0003_host_user_campaign_invariant.sql`) are.
 */
import { pgTable, uuid, text, index, unique } from "drizzle-orm/pg-core";
import { geographyPoint, timestamptz } from "./columns";
import { targetStateEnum } from "./enums";
import { campaigns } from "./campaigns";
import { players } from "./players";

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
    /** FK to `submissions(campaign_id, id)` is enforced at the DB level
     * only — see module doc comment above for why it isn't declared here. */
    filledBySubmissionId: uuid("filled_by_submission_id"),
  },
  (table) => [
    index("targets_campaign_id_idx").on(table.campaignId),
    index("targets_location_gist_idx").using("gist", table.location),
    unique("targets_campaign_id_id_key").on(table.campaignId, table.id),
  ],
);
