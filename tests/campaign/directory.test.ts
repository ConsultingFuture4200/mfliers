/**
 * Live-campaign directory suite (T5.1) — PRD FR-L1/FR-L5's "browse live
 * campaigns, see coverage %." Exercises `lib/campaign/directory.ts`
 * against a real PostGIS test database, same pattern as
 * `tests/campaign/lifecycle.test.ts`: only `live` campaigns appear, and
 * each entry's coverage % is `green targets / total targets` computed
 * through the one sanctioned cross-campaign read
 * (`getLiveCampaignCoverageCounts`, a `GROUP BY` aggregate variant of
 * `getPublicPinsAcrossLiveCampaigns` added per the Liotta batch-5 review),
 * not a second ad hoc cross-campaign query. Skips (rather than fails)
 * when `DATABASE_URL` isn't configured.
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
import { getLiveCampaignDirectory } from "@/lib/campaign/directory";

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

describe.skipIf(!hasTestDatabase())("live campaign directory (T5.1)", () => {
  const db = hasTestDatabase() ? getTestDb() : undefined;
  let seed: SeedTwoCampaignsResult;

  beforeEach(async () => {
    await resetTestDb(db!);
    seed = await seedTwoCampaigns(db!);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("lists only live campaigns with correct name and coverage %", async () => {
    // Campaign A: fill 1 of its 3 seeded targets -> 33% coverage.
    await fillTarget(
      db!,
      seed.campaignA.campaignId,
      seed.campaignA.playerId,
      seed.campaignA.targetIds[0],
    );
    // Campaign B: fill 2 of its 3 seeded targets -> 67% coverage.
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

    const directory = await getLiveCampaignDirectory();
    const byId = new Map(directory.map((entry) => [entry.id, entry]));

    const a = byId.get(seed.campaignA.campaignId);
    expect(a).toBeDefined();
    expect(a?.name).toBe("Campaign A");
    expect(a?.totalTargets).toBe(3);
    expect(a?.greenTargets).toBe(1);
    expect(a?.coveragePercent).toBe(33);

    const b = byId.get(seed.campaignB.campaignId);
    expect(b).toBeDefined();
    expect(b?.name).toBe("Campaign B");
    expect(b?.totalTargets).toBe(3);
    expect(b?.greenTargets).toBe(2);
    expect(b?.coveragePercent).toBe(67);
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

    const directory = await getLiveCampaignDirectory();

    expect(
      directory.find((entry) => entry.id === seed.campaignA.campaignId),
    ).toBeUndefined();
    expect(
      directory.find((entry) => entry.id === seed.campaignB.campaignId),
    ).toBeUndefined();
    expect(directory).toEqual([]);
  });

  it("never exposes budget/ledger fields — only id, name, blurb, and target counts", async () => {
    const directory = await getLiveCampaignDirectory();
    expect(directory.length).toBeGreaterThan(0);
    for (const entry of directory) {
      expect(Object.keys(entry).sort()).toEqual(
        [
          "blurb",
          "coveragePercent",
          "greenTargets",
          "id",
          "name",
          "totalTargets",
        ].sort(),
      );
    }
  });
});
