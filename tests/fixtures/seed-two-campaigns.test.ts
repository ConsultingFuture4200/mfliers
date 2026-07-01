/**
 * Fixture self-test (T1.4 acceptance criterion: "the fixture creates
 * exactly two campaigns with disjoint targets, verifiable by a fixture
 * self-test"). Runs against a real local/CI Postgres+PostGIS database.
 *
 * Skips (rather than fails) when `DATABASE_URL` isn't configured, so
 * `pnpm test` stays green in environments where a test DB hasn't been wired
 * up yet — CI (T1.5) provides a `postgis/postgis` service container and
 * sets `DATABASE_URL` for this job.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { closeTestDb, getTestDb, hasTestDatabase, resetTestDb } from "../setup";
import { seedTwoCampaigns } from "./seed-two-campaigns";

describe.skipIf(!hasTestDatabase())("seedTwoCampaigns fixture", () => {
  const db = hasTestDatabase() ? getTestDb() : undefined;

  beforeEach(async () => {
    await resetTestDb(db!);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("creates exactly two campaigns", async () => {
    await seedTwoCampaigns(db!);
    const campaigns = await db!.select().from(schema.campaigns);
    expect(campaigns).toHaveLength(2);
    expect(campaigns.map((c) => c.name).sort()).toEqual([
      "Campaign A",
      "Campaign B",
    ]);
  });

  it("gives each campaign its own host, player, and disjoint targets", async () => {
    const { campaignA, campaignB } = await seedTwoCampaigns(db!);

    expect(campaignA.campaignId).not.toBe(campaignB.campaignId);
    expect(campaignA.hostId).not.toBe(campaignB.hostId);
    expect(campaignA.playerId).not.toBe(campaignB.playerId);

    expect(campaignA.targetIds.length).toBeGreaterThanOrEqual(3);
    expect(campaignB.targetIds.length).toBeGreaterThanOrEqual(3);

    // Disjoint: no target ID appears in both campaigns' target lists.
    const overlap = campaignA.targetIds.filter((id) =>
      campaignB.targetIds.includes(id),
    );
    expect(overlap).toHaveLength(0);

    // Every target row is scoped to the campaign it was created for.
    const targetsA = await db!
      .select()
      .from(schema.targets)
      .where(eq(schema.targets.campaignId, campaignA.campaignId));
    expect(targetsA).toHaveLength(campaignA.targetIds.length);
    expect(targetsA.every((t) => t.campaignId === campaignA.campaignId)).toBe(
      true,
    );

    const targetsB = await db!
      .select()
      .from(schema.targets)
      .where(eq(schema.targets.campaignId, campaignB.campaignId));
    expect(targetsB).toHaveLength(campaignB.targetIds.length);
    expect(targetsB.every((t) => t.campaignId === campaignB.campaignId)).toBe(
      true,
    );
  });

  it("does not leak state across test runs (reset works)", async () => {
    await seedTwoCampaigns(db!);
    const before = await db!.select().from(schema.campaigns);
    expect(before).toHaveLength(2);

    await resetTestDb(db!);
    const after = await db!.select().from(schema.campaigns);
    expect(after).toHaveLength(0);
  });
});
