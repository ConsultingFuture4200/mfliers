-- Liotta review (batch 1): campaigns.host_id (ownership) and the
-- user_campaigns join table (constitution §5's scoped_campaign_ids
-- authorization set) are two encodings of "which campaigns can this host
-- touch" with no enforced link between them. Decision: host_id remains the
-- single ownership fact; user_campaigns is an additive grant list, and this
-- trigger guarantees a campaign's host always has a matching user_campaigns
-- row the moment the campaign exists (or the host changes) — the DB makes
-- the invariant true by construction instead of relying on every future
-- caller (seed fixtures, Batch 2's Auth.js scoping, admin tooling) to
-- remember to double-write both.
--
-- It is intentionally additive only (ON CONFLICT DO NOTHING, no DELETE):
-- reassigning host_id does not revoke the previous host's grant, since
-- user_campaigns may also carry co-host grants unrelated to ownership.
CREATE OR REPLACE FUNCTION sync_campaign_host_to_user_campaigns()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_campaigns (user_id, campaign_id)
  VALUES (NEW.host_id, NEW.id)
  ON CONFLICT (user_id, campaign_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER campaigns_host_user_campaign_insert
AFTER INSERT ON campaigns
FOR EACH ROW
EXECUTE FUNCTION sync_campaign_host_to_user_campaigns();
--> statement-breakpoint
CREATE TRIGGER campaigns_host_user_campaign_update
AFTER UPDATE OF host_id ON campaigns
FOR EACH ROW
WHEN (NEW.host_id IS DISTINCT FROM OLD.host_id)
EXECUTE FUNCTION sync_campaign_host_to_user_campaigns();
--> statement-breakpoint
-- Backfill: any campaign already in the table (none expected pre-launch,
-- but this keeps the migration correct if run against a seeded database)
-- gets its host's grant row created retroactively.
INSERT INTO user_campaigns (user_id, campaign_id)
SELECT host_id, id FROM campaigns
ON CONFLICT (user_id, campaign_id) DO NOTHING;