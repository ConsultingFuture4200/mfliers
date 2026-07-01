/**
 * Geo fraud-check suite (T3.4).
 *
 * Exercises `checkProximity`/`checkGpsAgreement` (`lib/fraud/geo.ts`)
 * against a real PostGIS test database (via `lib/db/dal/targets.ts`'s
 * `checkTargetProximity` and `lib/db/dal/geo.ts`'s `distanceMeters`) —
 * covers the card's acceptance criteria: 18m passes / 80m fails proximity
 * at the 40m default, 22m passes / 120m fails GPS agreement at 50m, and a
 * per-campaign proximity override being honored. Skips (rather than
 * fails) when `DATABASE_URL` isn't configured, matching the repo's
 * established pattern (`tests/isolation/isolation.test.ts`, etc).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { closeTestDb, getTestDb, hasTestDatabase, resetTestDb } from "../setup";
import { seedTwoCampaigns } from "../fixtures/seed-two-campaigns";
import { checkProximity, checkGpsAgreement } from "@/lib/fraud/geo";
import type { Campaign, Coordinate, Submission } from "@/types/domain";

/** Approximate meters-per-degree-latitude — fine for these tests since
 * every acceptance-criteria distance has a wide pass/fail margin (18m vs a
 * 40m threshold, 80m vs 40m, 22m vs 50m, 120m vs 50m); this is test-fixture
 * geometry, not the app's own distance math (that's PostGIS, per
 * `lib/fraud/geo.ts`). */
const METERS_PER_DEGREE_LAT = 111_320;

function offsetNorth(coord: Coordinate, meters: number): Coordinate {
  return { lat: coord.lat + meters / METERS_PER_DEGREE_LAT, long: coord.long };
}

/** Builds a minimal in-memory `Campaign` carrying only the fields
 * `checkProximity` actually reads (`id`, `proximityRadiusM`) — the DAL call
 * it makes looks the target up by `campaign.id` directly, not by
 * re-reading the campaign row, so the other fields are irrelevant filler. */
function buildCampaign(campaignId: string, proximityRadiusM: number): Campaign {
  return {
    id: campaignId,
    name: "Test Campaign",
    flierImageUrl: "https://example.com/flier.png",
    budgetCapCents: 100_000,
    tierTable: [{ minCount: 0, maxCount: null, payoutCents: 500 }],
    grandPrize: "Test prize",
    privacySetting: "admin_only",
    proximityRadiusM,
    settlementMode: "manual",
    state: "live",
    hostId: randomUUID(),
    startAt: new Date("2026-01-01T00:00:00Z"),
    endAt: new Date("2026-12-31T00:00:00Z"),
  };
}

describe.skipIf(!hasTestDatabase())(
  "geo fraud checks against a live database (T3.4 acceptance criteria)",
  () => {
    const db = hasTestDatabase() ? getTestDb() : undefined;

    beforeEach(async () => {
      await resetTestDb(db!);
    });

    afterAll(async () => {
      await closeTestDb();
    });

    async function insertSubmission(params: {
      campaignId: string;
      playerId: string;
      targetId: string;
      deviceGps: Coordinate;
      exifGps?: Coordinate;
    }): Promise<Submission> {
      const [row] = await db!
        .insert(schema.submissions)
        .values({
          campaignId: params.campaignId,
          playerId: params.playerId,
          targetId: params.targetId,
          photoUrl: `https://example.com/photos/${randomUUID()}.jpg`,
          deviceGps: `POINT(${params.deviceGps.long} ${params.deviceGps.lat})`,
          exifGps: params.exifGps
            ? `POINT(${params.exifGps.long} ${params.exifGps.lat})`
            : undefined,
          phash: "0".repeat(16),
        })
        .returning({ id: schema.submissions.id });

      const { getSubmission } = await import("@/lib/db/dal/submissions");
      const submission = await getSubmission(params.campaignId, row.id);
      if (!submission)
        throw new Error("failed to read back inserted submission");
      return submission;
    }

    describe("checkProximity", () => {
      it("passes at 18m from the target (default 40m radius)", async () => {
        const seed = await seedTwoCampaigns(db!);
        const targetCenter = { lat: 46.9, long: -123.8 }; // campaignA target 0
        const submission = await insertSubmission({
          campaignId: seed.campaignA.campaignId,
          playerId: seed.campaignA.playerId,
          targetId: seed.campaignA.targetIds[0],
          deviceGps: offsetNorth(targetCenter, 18),
        });
        const campaign = buildCampaign(seed.campaignA.campaignId, 40);

        const result = await checkProximity(submission, campaign);

        expect(result.check).toBe("proximity");
        expect(result.passed).toBe(true);
      });

      it("fails at 80m from the target (default 40m radius)", async () => {
        const seed = await seedTwoCampaigns(db!);
        const targetCenter = { lat: 46.9, long: -123.8 };
        const submission = await insertSubmission({
          campaignId: seed.campaignA.campaignId,
          playerId: seed.campaignA.playerId,
          targetId: seed.campaignA.targetIds[0],
          deviceGps: offsetNorth(targetCenter, 80),
        });
        const campaign = buildCampaign(seed.campaignA.campaignId, 40);

        const result = await checkProximity(submission, campaign);

        expect(result.check).toBe("proximity");
        expect(result.passed).toBe(false);
      });

      it("honors a per-campaign override: 80m passes when the campaign's radius is raised to 100m", async () => {
        const seed = await seedTwoCampaigns(db!);
        const targetCenter = { lat: 46.9, long: -123.8 };
        const submission = await insertSubmission({
          campaignId: seed.campaignA.campaignId,
          playerId: seed.campaignA.playerId,
          targetId: seed.campaignA.targetIds[0],
          deviceGps: offsetNorth(targetCenter, 80),
        });
        const overriddenCampaign = buildCampaign(
          seed.campaignA.campaignId,
          100,
        );

        const result = await checkProximity(submission, overriddenCampaign);

        expect(result.passed).toBe(true);
      });

      it("fails (does not throw) when the submission's targetId doesn't resolve in the campaign", async () => {
        const seed = await seedTwoCampaigns(db!);
        const submission = await insertSubmission({
          campaignId: seed.campaignA.campaignId,
          playerId: seed.campaignA.playerId,
          targetId: seed.campaignA.targetIds[0],
          deviceGps: { lat: 46.9, long: -123.8 },
        });
        // Simulate a foreign/stale targetId without violating the real FK.
        const tampered: Submission = { ...submission, targetId: randomUUID() };
        const campaign = buildCampaign(seed.campaignA.campaignId, 40);

        const result = await checkProximity(tampered, campaign);

        expect(result.passed).toBe(false);
        expect(result.detail).toMatch(/not found/i);
      });
    });

    describe("checkGpsAgreement", () => {
      it("passes at 22m apart (50m threshold)", async () => {
        const seed = await seedTwoCampaigns(db!);
        const deviceGps = { lat: 46.9, long: -123.8 };
        const submission = await insertSubmission({
          campaignId: seed.campaignA.campaignId,
          playerId: seed.campaignA.playerId,
          targetId: seed.campaignA.targetIds[0],
          deviceGps,
          exifGps: offsetNorth(deviceGps, 22),
        });

        const result = await checkGpsAgreement(submission);

        expect(result.check).toBe("gps-agreement");
        expect(result.passed).toBe(true);
      });

      it("fails at 120m apart (50m threshold)", async () => {
        const seed = await seedTwoCampaigns(db!);
        const deviceGps = { lat: 46.9, long: -123.8 };
        const submission = await insertSubmission({
          campaignId: seed.campaignA.campaignId,
          playerId: seed.campaignA.playerId,
          targetId: seed.campaignA.targetIds[0],
          deviceGps,
          exifGps: offsetNorth(deviceGps, 120),
        });

        const result = await checkGpsAgreement(submission);

        expect(result.passed).toBe(false);
      });

      it("passes (skips) when the submission has no EXIF GPS", async () => {
        const seed = await seedTwoCampaigns(db!);
        const submission = await insertSubmission({
          campaignId: seed.campaignA.campaignId,
          playerId: seed.campaignA.playerId,
          targetId: seed.campaignA.targetIds[0],
          deviceGps: { lat: 46.9, long: -123.8 },
        });

        const result = await checkGpsAgreement(submission);

        expect(result.passed).toBe(true);
        expect(result.detail).toMatch(/no EXIF GPS/i);
      });
    });
  },
);
