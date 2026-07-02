CREATE TABLE "player_email_otp" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "players" DROP CONSTRAINT "players_phone_unique";--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "email" text NOT NULL;--> statement-breakpoint
CREATE INDEX "player_email_otp_email_idx" ON "player_email_otp" USING btree ("email");--> statement-breakpoint
ALTER TABLE "players" DROP COLUMN "phone";--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_email_unique" UNIQUE("email");