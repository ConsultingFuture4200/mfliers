/**
 * Player "join campaign" suite (T5.1 carry-forward) — exercises
 * `lib/campaign/membership.ts`'s `joinCampaign` against a real PostGIS
 * test database, same pattern as `tests/campaign/lifecycle.test.ts`.
 * Covers: creates a membership row for a new player, idempotent repeat
 * join (`ON CONFLICT DO NOTHING` — never resets progress), only a `live`
 * campaign is joinable, and a nonexistent campaign is rejected. Skips
 * (rather than fails) when `DATABASE_URL` isn't configured.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { closeTestDb, getTestDb, hasTestDatabase, resetTestDb } from "../setup";
import {
  seedTwoCampaigns,
  type SeedTwoCampaignsResult,
} from "../fixtures/seed-two-campaigns";
import {
  CampaignNotFoundError,
  CampaignNotLiveError,
} from "@/lib/campaign/lifecycle";
import { joinCampaign } from "@/lib/campaign/membership";
import { getMembership } from "@/lib/db/dal/campaign-memberships";

describe.skipIf(!hasTestDatabase())(
  "player join-campaign flow (T5.1 carry-forward)",
  () => {
    const db = hasTestDatabase() ? getTestDb() : undefined;
    let seed: SeedTwoCampaignsResult;
    let newPlayerId: string;

    beforeEach(async () => {
      await resetTestDb(db!);
      seed = await seedTwoCampaigns(db!);
      const [player] = await db!
        .insert(schema.players)
        .values({ email: "join-newplayer@example.com" })
        .returning({ id: schema.players.id });
      newPlayerId = player.id;
    });

    afterAll(async () => {
      await closeTestDb();
    });

    it("creates a membership row for a player who hasn't joined yet", async () => {
      const before = await getMembership(
        seed.campaignA.campaignId,
        newPlayerId,
      );
      expect(before).toBeNull();

      const membership = await joinCampaign(
        seed.campaignA.campaignId,
        newPlayerId,
      );

      expect(membership.campaignId).toBe(seed.campaignA.campaignId);
      expect(membership.playerId).toBe(newPlayerId);
      expect(membership.approvedCount).toBe(0);
      expect(membership.balanceOwedCents).toBe(0);

      const after = await getMembership(seed.campaignA.campaignId, newPlayerId);
      expect(after).not.toBeNull();
    });

    it("is idempotent — a repeat join never errors and never resets progress", async () => {
      await joinCampaign(seed.campaignA.campaignId, newPlayerId);

      // Simulate progress the naive "insert" would wipe out if it weren't
      // ON CONFLICT DO NOTHING.
      await db!
        .update(schema.campaignMemberships)
        .set({ approvedCount: 4, balanceOwed: 1200 })
        .where(eq(schema.campaignMemberships.playerId, newPlayerId));

      const second = await joinCampaign(seed.campaignA.campaignId, newPlayerId);
      expect(second.approvedCount).toBe(4);
      expect(second.balanceOwedCents).toBe(1200);

      const rows = await db!
        .select()
        .from(schema.campaignMemberships)
        .where(eq(schema.campaignMemberships.playerId, newPlayerId));
      expect(rows.length).toBe(1);
    });

    it("rejects joining a draft campaign", async () => {
      await db!
        .update(schema.campaigns)
        .set({ state: "draft" })
        .where(eq(schema.campaigns.id, seed.campaignA.campaignId));

      await expect(
        joinCampaign(seed.campaignA.campaignId, newPlayerId),
      ).rejects.toThrow(CampaignNotLiveError);

      const membership = await getMembership(
        seed.campaignA.campaignId,
        newPlayerId,
      );
      expect(membership).toBeNull();
    });

    it("rejects joining a closed campaign", async () => {
      await db!
        .update(schema.campaigns)
        .set({ state: "closed" })
        .where(eq(schema.campaigns.id, seed.campaignA.campaignId));

      await expect(
        joinCampaign(seed.campaignA.campaignId, newPlayerId),
      ).rejects.toThrow(CampaignNotLiveError);
    });

    it("rejects a nonexistent campaign", async () => {
      await expect(
        joinCampaign("00000000-0000-0000-0000-000000000000", newPlayerId),
      ).rejects.toThrow(CampaignNotFoundError);
    });
  },
);
