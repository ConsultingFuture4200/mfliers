-- Reverse half of the composite tenant-isolation FK pair (Liotta review,
-- batch 1). `submissions.target_id` -> `targets(campaign_id, id)` is
-- declared in the Drizzle schema (lib/db/schema/submissions.ts) and applied
-- in 0002_cultured_kitty_pryde.sql. This is the other direction —
-- `targets.filled_by_submission_id` -> `submissions(campaign_id, id)` — a
-- target can never be marked filled by a submission from a different
-- campaign.
--
-- This is a raw/custom migration, NOT reflected in lib/db/schema/targets.ts,
-- because Drizzle's `foreignKey()` builder participates in TypeScript's
-- type inference for a table's exported type; declaring it in both
-- targets.ts and submissions.ts would make the two modules' exported types
-- mutually dependent on each other's still-being-inferred type, which tsc
-- rejects as a circular "implicitly has type 'any'" error. See the doc
-- comment atop lib/db/schema/targets.ts for the full explanation. Because
-- this constraint is absent from the tracked schema/snapshot, `pnpm
-- db:generate` will never try to manage or drop it.
ALTER TABLE "targets" ADD CONSTRAINT "targets_campaign_filled_by_submission_fk"
  FOREIGN KEY ("campaign_id", "filled_by_submission_id")
  REFERENCES "public"."submissions"("campaign_id", "id")
  ON DELETE no action ON UPDATE no action;