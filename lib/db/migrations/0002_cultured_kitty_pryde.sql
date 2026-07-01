-- Composite unique keys must exist before the composite FK below can
-- reference `targets(campaign_id, id)`.
ALTER TABLE "targets" ADD CONSTRAINT "targets_campaign_id_id_key" UNIQUE("campaign_id","id");--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_campaign_id_id_key" UNIQUE("campaign_id","id");--> statement-breakpoint
ALTER TABLE "targets" DROP CONSTRAINT "targets_filled_by_submission_id_submissions_id_fk";
--> statement-breakpoint
ALTER TABLE "submissions" DROP CONSTRAINT "submissions_target_id_targets_id_fk";
--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_campaign_target_fk" FOREIGN KEY ("campaign_id","target_id") REFERENCES "public"."targets"("campaign_id","id") ON DELETE no action ON UPDATE no action;