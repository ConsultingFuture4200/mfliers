/**
 * Universal aggregate map suite (T5.2) — PRD FR-L2/FR-L3/FR-L4, EC-4.
 * Exercises `lib/campaign/universal-map.ts` against a real PostGIS test
 * database, same pattern as `tests/campaign/directory.test.ts` (T5.1):
 * pins from at least two live campaigns come back annotated with their
 * campaign's name, draft/closed campaigns' pins never appear, and no
 * username/ledger/budget field is ever present on a returned pin.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import {
  closeTestDb,
  getTestDb,
  hasTestDatabase,
  resetTestDb,
  type TestDb,
} from "../setup";
import {
  seedTwoCampaigns,
  type SeedTwoCampaignsResult,
} from "../fixtures/seed-two-campaigns";
import { getUniversalMapPins } from "@/lib/campaign/universal-map";
import { getLiveCampaignCoverageCounts } from "@/lib/db/dal/universal-map";

async function fillTarget(
  db: TestDb,
  campaignId: string,
  playerId: string,
  targetId: string,
): Promise<void> {
  const [submission] = await db
    .insert(schema.submissions)
    .values({
      campaignId,
      playerId,
      targetId,
      photoUrl: `https://example.com/photos/${targetId}.jpg`,
      deviceGps: "POINT(-123.8 46.9)",
      phash: "a".repeat(16),
    })
    .returning({ id: schema.submissions.id });

  await db
    .update(schema.targets)
    .set({ state: "green", filledBySubmissionId: submission.id })
    .where(eq(schema.targets.id, targetId));
}

describe.skipIf(!hasTestDatabase())("universal map pins (T5.2)", () => {
  const db = hasTestDatabase() ? getTestDb() : undefined;
  let seed: SeedTwoCampaignsResult;

  beforeEach(async () => {
    await resetTestDb(db!);
    seed = await seedTwoCampaigns(db!);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("returns pins from both live campaigns, each annotated with its campaign name (EC-4)", async () => {
    await fillTarget(
      db!,
      seed.campaignA.campaignId,
      seed.campaignA.playerId,
      seed.campaignA.targetIds[0],
    );

    const pins = await getUniversalMapPins();

    const aPins = pins.filter(
      (p) => p.campaignId === seed.campaignA.campaignId,
    );
    const bPins = pins.filter(
      (p) => p.campaignId === seed.campaignB.campaignId,
    );
    expect(aPins.length).toBe(3);
    expect(bPins.length).toBe(3);
    expect(aPins.every((p) => p.campaignName === "Campaign A")).toBe(true);
    expect(bPins.every((p) => p.campaignName === "Campaign B")).toBe(true);

    const filled = aPins.find((p) => p.id === seed.campaignA.targetIds[0]);
    expect(filled?.state).toBe("green");
    expect(filled?.photoUrl).toBe(
      `https://example.com/photos/${seed.campaignA.targetIds[0]}.jpg`,
    );
  });

  it("excludes draft and closed campaigns' pins (anti-requirement)", async () => {
    await db!
      .update(schema.campaigns)
      .set({ state: "draft" })
      .where(eq(schema.campaigns.id, seed.campaignA.campaignId));
    await db!
      .update(schema.campaigns)
      .set({ state: "closed" })
      .where(eq(schema.campaigns.id, seed.campaignB.campaignId));

    const pins = await getUniversalMapPins();

    expect(pins.some((p) => p.campaignId === seed.campaignA.campaignId)).toBe(
      false,
    );
    expect(pins.some((p) => p.campaignId === seed.campaignB.campaignId)).toBe(
      false,
    );
    expect(pins).toEqual([]);
  });

  it("never exposes a username/ledger/budget field — only public-safe pin fields (anti-requirement)", async () => {
    const pins = await getUniversalMapPins();
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) {
      expect(Object.keys(pin).sort()).toEqual(
        [
          "campaignId",
          "campaignName",
          "id",
          "lat",
          "long",
          "photoUrl",
          "state",
        ].sort(),
      );
    }
  });

  // getLiveCampaignCoverageCounts (T5.1 / Liotta batch-5 review): the same
  // sanctioned cross-campaign exception's second entry point — a `GROUP BY`
  // aggregate variant of getUniversalMapPins/getPublicPinsAcrossLiveCampaigns
  // that the public landing directory (`lib/campaign/directory.ts`) uses
  // instead of tallying a full pin payload in application memory. Kept in
  // this same describe block (not a second one) so it shares this file's
  // single `getTestDb`/`closeTestDb` lifecycle rather than racing it.
  describe("getLiveCampaignCoverageCounts", () => {
    it("aggregates green/total per live campaign in SQL, without returning per-pin rows", async () => {
      await fillTarget(
        db!,
        seed.campaignA.campaignId,
        seed.campaignA.playerId,
        seed.campaignA.targetIds[0],
      );
      await fillTarget(
        db!,
        seed.campaignB.campaignId,
        seed.campaignB.playerId,
        seed.campaignB.targetIds[0],
      );
      await fillTarget(
        db!,
        seed.campaignB.campaignId,
        seed.campaignB.playerId,
        seed.campaignB.targetIds[1],
      );

      const counts = await getLiveCampaignCoverageCounts();
      // One row per campaign, not one row per pin.
      expect(counts.length).toBe(2);

      const byId = new Map(counts.map((c) => [c.campaignId, c]));
      expect(byId.get(seed.campaignA.campaignId)).toEqual({
        campaignId: seed.campaignA.campaignId,
        total: 3,
        green: 1,
      });
      expect(byId.get(seed.campaignB.campaignId)).toEqual({
        campaignId: seed.campaignB.campaignId,
        total: 3,
        green: 2,
      });
    });

    it("excludes draft and closed campaigns (anti-requirement)", async () => {
      await db!
        .update(schema.campaigns)
        .set({ state: "draft" })
        .where(eq(schema.campaigns.id, seed.campaignA.campaignId));
      await db!
        .update(schema.campaigns)
        .set({ state: "closed" })
        .where(eq(schema.campaigns.id, seed.campaignB.campaignId));

      const counts = await getLiveCampaignCoverageCounts();

      expect(
        counts.some((c) => c.campaignId === seed.campaignA.campaignId),
      ).toBe(false);
      expect(
        counts.some((c) => c.campaignId === seed.campaignB.campaignId),
      ).toBe(false);
    });
  });
});
