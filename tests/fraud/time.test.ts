/**
 * Time fraud-check suite (T3.4).
 *
 * `checkTimestamps` (`lib/fraud/time.ts`) is pure/synchronous (no DB) and
 * is unit-tested directly. `checkTravelSpeed` needs the player's previous
 * submission (`lib/db/dal/submissions.ts`'s `getPreviousSubmission`), so
 * its suite runs against a real PostGIS test database — skips (rather than
 * fails) when `DATABASE_URL` isn't configured, matching the repo's
 * established pattern (`tests/isolation/isolation.test.ts`, etc).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { closeTestDb, getTestDb, hasTestDatabase, resetTestDb } from "../setup";
import { seedTwoCampaigns } from "../fixtures/seed-two-campaigns";
import {
  checkTimestamps,
  checkTravelSpeed,
  DEFAULT_TIMESTAMP_SKEW_MINUTES,
  MAX_PLAUSIBLE_SPEED_MPS,
} from "@/lib/fraud/time";
import type { Coordinate, Player, Submission } from "@/types/domain";

/** A fully-populated `Submission` with sane defaults, so each test only
 * overrides the fields it cares about. */
function buildSubmission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: randomUUID(),
    campaignId: randomUUID(),
    playerId: randomUUID(),
    targetId: randomUUID(),
    photoUrl: "https://example.com/photo.jpg",
    deviceGps: { lat: 46.9, long: -123.8 },
    exifGps: null,
    exifTs: null,
    receivedAt: new Date("2026-06-30T12:00:00Z"),
    phash: "0".repeat(16),
    fraudChecks: [],
    decision: "pending",
    decidedBy: null,
    decidedAt: null,
    ...overrides,
  };
}

describe("checkTimestamps (unit)", () => {
  it("flags a photo captured hours before submit", () => {
    const receivedAt = new Date("2026-06-30T12:00:00Z");
    const exifTs = new Date(receivedAt.getTime() - 3 * 60 * 60 * 1000); // 3h earlier
    const submission = buildSubmission({ receivedAt, exifTs });

    const result = checkTimestamps(submission);

    expect(result.check).toBe("timestamp-sanity");
    expect(result.passed).toBe(false);
  });

  it("passes when EXIF capture time is a couple minutes before submit", () => {
    const receivedAt = new Date("2026-06-30T12:00:00Z");
    const exifTs = new Date(receivedAt.getTime() - 2 * 60 * 1000); // 2m earlier
    const submission = buildSubmission({ receivedAt, exifTs });

    const result = checkTimestamps(submission);

    expect(result.passed).toBe(true);
  });

  it("passes (skips) when there is no EXIF or client timestamp", () => {
    const submission = buildSubmission({ exifTs: null });

    const result = checkTimestamps(submission);

    expect(result.passed).toBe(true);
    expect(result.detail).toMatch(/no EXIF or client timestamp/i);
  });

  it("flags on client time skew even when EXIF is absent", () => {
    const receivedAt = new Date("2026-06-30T12:00:00Z");
    const clientTs = new Date(receivedAt.getTime() - 4 * 60 * 60 * 1000); // 4h earlier
    const submission = buildSubmission({ receivedAt, exifTs: null });

    const result = checkTimestamps(submission, { clientTs });

    expect(result.passed).toBe(false);
  });

  it("honors a custom maxSkewMinutes window", () => {
    const receivedAt = new Date("2026-06-30T12:00:00Z");
    const exifTs = new Date(receivedAt.getTime() - 10 * 60 * 1000); // 10m earlier
    const submission = buildSubmission({ receivedAt, exifTs });

    // Default window (15m) would pass; a tighter 5m window should flag it.
    expect(checkTimestamps(submission).passed).toBe(true);
    expect(checkTimestamps(submission, { maxSkewMinutes: 5 }).passed).toBe(
      false,
    );
  });

  it("exports the default skew window used above", () => {
    expect(DEFAULT_TIMESTAMP_SKEW_MINUTES).toBeGreaterThan(0);
  });
});

/** Approximate meters-per-degree-latitude — fine here since every
 * acceptance-criteria distance has a wide pass/fail margin against
 * `MAX_PLAUSIBLE_SPEED_MPS`. Test-fixture geometry only; the app's own
 * distance math is PostGIS (`lib/fraud/time.ts`). */
const METERS_PER_DEGREE_LAT = 111_320;

function offsetNorth(coord: Coordinate, meters: number): Coordinate {
  return { lat: coord.lat + meters / METERS_PER_DEGREE_LAT, long: coord.long };
}

describe.skipIf(!hasTestDatabase())(
  "checkTravelSpeed against a live database (T3.4 acceptance criteria)",
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
      receivedAt: Date;
    }): Promise<string> {
      const [row] = await db!
        .insert(schema.submissions)
        .values({
          campaignId: params.campaignId,
          playerId: params.playerId,
          targetId: params.targetId,
          photoUrl: `https://example.com/photos/${randomUUID()}.jpg`,
          deviceGps: `POINT(${params.deviceGps.long} ${params.deviceGps.lat})`,
          receivedAt: params.receivedAt,
          phash: "0".repeat(16),
        })
        .returning({ id: schema.submissions.id });
      return row.id;
    }

    it("flags: 5km between consecutive posts 2 minutes apart", async () => {
      const seed = await seedTwoCampaigns(db!);
      const player: Player = {
        id: seed.campaignA.playerId,
        email: "canvasser-a@example.com",
      };
      const firstPost = { lat: 46.9, long: -123.8 };
      const firstReceivedAt = new Date("2026-06-30T12:00:00Z");

      await insertSubmission({
        campaignId: seed.campaignA.campaignId,
        playerId: player.id,
        targetId: seed.campaignA.targetIds[0],
        deviceGps: firstPost,
        receivedAt: firstReceivedAt,
      });

      const secondSubmission: Submission = buildSubmission({
        campaignId: seed.campaignA.campaignId,
        playerId: player.id,
        targetId: seed.campaignA.targetIds[1],
        deviceGps: offsetNorth(firstPost, 5000), // 5km away
        receivedAt: new Date(firstReceivedAt.getTime() + 2 * 60 * 1000), // 2 min later
      });

      const result = await checkTravelSpeed(secondSubmission, player);

      expect(result.check).toBe("travel-speed");
      expect(result.passed).toBe(false);
    });

    it("passes for a plausible walking distance/time between posts", async () => {
      const seed = await seedTwoCampaigns(db!);
      const player: Player = {
        id: seed.campaignA.playerId,
        email: "canvasser-a@example.com",
      };
      const firstPost = { lat: 46.9, long: -123.8 };
      const firstReceivedAt = new Date("2026-06-30T12:00:00Z");

      await insertSubmission({
        campaignId: seed.campaignA.campaignId,
        playerId: player.id,
        targetId: seed.campaignA.targetIds[0],
        deviceGps: firstPost,
        receivedAt: firstReceivedAt,
      });

      const secondSubmission: Submission = buildSubmission({
        campaignId: seed.campaignA.campaignId,
        playerId: player.id,
        targetId: seed.campaignA.targetIds[1],
        deviceGps: offsetNorth(firstPost, 100), // 100m away
        receivedAt: new Date(firstReceivedAt.getTime() + 5 * 60 * 1000), // 5 min later
      });

      const result = await checkTravelSpeed(secondSubmission, player);

      expect(result.passed).toBe(true);
    });

    it("passes when the player has no prior submission", async () => {
      const seed = await seedTwoCampaigns(db!);
      const player: Player = {
        id: seed.campaignA.playerId,
        email: "canvasser-a@example.com",
      };

      const submission: Submission = buildSubmission({
        campaignId: seed.campaignA.campaignId,
        playerId: player.id,
        targetId: seed.campaignA.targetIds[0],
      });

      const result = await checkTravelSpeed(submission, player);

      expect(result.passed).toBe(true);
      expect(result.detail).toMatch(/no prior submission/i);
    });

    it("does not compare against a submission in a different campaign", async () => {
      const seed = await seedTwoCampaigns(db!);
      // Same email (global player identity) would need two separate
      // players in reality, but here we reuse campaignA's playerId under
      // campaignB's *own* membership scoping is irrelevant to this check —
      // the point is campaignId scoping, so post a real prior submission
      // under campaignB with a wildly incompatible location/time and
      // confirm campaignA's check ignores it.
      const firstReceivedAt = new Date("2026-06-30T12:00:00Z");
      await insertSubmission({
        campaignId: seed.campaignB.campaignId,
        playerId: seed.campaignB.playerId,
        targetId: seed.campaignB.targetIds[0],
        deviceGps: { lat: 40.7, long: -74.0 }, // NYC — campaign B's area
        receivedAt: firstReceivedAt,
      });

      const submission: Submission = buildSubmission({
        campaignId: seed.campaignA.campaignId,
        playerId: seed.campaignA.playerId,
        targetId: seed.campaignA.targetIds[0],
        deviceGps: { lat: 46.9, long: -123.8 }, // Pacific County — campaign A's area
        receivedAt: new Date(firstReceivedAt.getTime() + 2 * 60 * 1000),
      });
      const player: Player = {
        id: seed.campaignA.playerId,
        email: "canvasser-a@example.com",
      };

      const result = await checkTravelSpeed(submission, player);

      // If this incorrectly compared against campaign B's submission
      // (cross-country in 2 minutes), it would fail; scoped correctly to
      // campaign A (no prior submission there), it passes.
      expect(result.passed).toBe(true);
      expect(result.detail).toMatch(/no prior submission/i);
    });

    it("exports the max plausible speed used above", () => {
      expect(MAX_PLAUSIBLE_SPEED_MPS).toBeGreaterThan(0);
    });
  },
);
