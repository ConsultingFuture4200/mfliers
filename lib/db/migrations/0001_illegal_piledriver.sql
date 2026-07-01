CREATE TYPE "public"."campaign_state" AS ENUM('draft', 'live', 'closed');--> statement-breakpoint
CREATE TYPE "public"."privacy_setting" AS ENUM('public_username', 'admin_only');--> statement-breakpoint
CREATE TYPE "public"."settlement_mode" AS ENUM('manual');--> statement-breakpoint
CREATE TYPE "public"."submission_decision" AS ENUM('pending', 'approved', 'rejected', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."target_state" AS ENUM('red', 'amber', 'green');--> statement-breakpoint
CREATE TYPE "public"."user_type" AS ENUM('site_admin', 'host');--> statement-breakpoint
CREATE TABLE "user_campaigns" (
	"user_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	CONSTRAINT "user_campaigns_user_id_campaign_id_pk" PRIMARY KEY("user_id","campaign_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "user_type" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"flier_image_url" text NOT NULL,
	"budget_cap" integer NOT NULL,
	"tier_table" jsonb NOT NULL,
	"grand_prize" text NOT NULL,
	"privacy_setting" "privacy_setting" DEFAULT 'admin_only' NOT NULL,
	"proximity_radius_m" integer NOT NULL,
	"settlement_mode" "settlement_mode" DEFAULT 'manual' NOT NULL,
	"state" "campaign_state" DEFAULT 'draft' NOT NULL,
	"host_id" uuid NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	CONSTRAINT "players_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"label" text NOT NULL,
	"location" geography(Point,4326) NOT NULL,
	"state" "target_state" DEFAULT 'red' NOT NULL,
	"claimed_by" uuid,
	"claim_expires_at" timestamp with time zone,
	"filled_by_submission_id" uuid
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"photo_url" text NOT NULL,
	"device_gps" geography(Point,4326) NOT NULL,
	"exif_gps" geography(Point,4326),
	"exif_ts" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"phash" text NOT NULL,
	"fraud_checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision" "submission_decision" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "campaign_memberships" (
	"campaign_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"approved_count" integer DEFAULT 0 NOT NULL,
	"current_tier" integer DEFAULT 0 NOT NULL,
	"balance_owed" integer DEFAULT 0 NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "campaign_memberships_campaign_id_player_id_pk" PRIMARY KEY("campaign_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "payout_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"tier_at_time" integer NOT NULL,
	"cumulative_committed" integer NOT NULL,
	"settled" boolean DEFAULT false NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user_campaigns" ADD CONSTRAINT "user_campaigns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_campaigns" ADD CONSTRAINT "user_campaigns_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_claimed_by_players_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_filled_by_submission_id_submissions_id_fk" FOREIGN KEY ("filled_by_submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_memberships" ADD CONSTRAINT "campaign_memberships_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_memberships" ADD CONSTRAINT "campaign_memberships_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_ledger" ADD CONSTRAINT "payout_ledger_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_ledger" ADD CONSTRAINT "payout_ledger_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_ledger" ADD CONSTRAINT "payout_ledger_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_campaigns_campaign_id_idx" ON "user_campaigns" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "targets_campaign_id_idx" ON "targets" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "targets_location_gist_idx" ON "targets" USING gist ("location");--> statement-breakpoint
CREATE INDEX "submissions_campaign_id_idx" ON "submissions" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "campaign_memberships_campaign_id_idx" ON "campaign_memberships" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "payout_ledger_campaign_id_idx" ON "payout_ledger" USING btree ("campaign_id");