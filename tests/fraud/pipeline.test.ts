/**
 * Pipeline orchestrator suite (T3.5).
 *
 * Exercises `runPipeline` (`lib/fraud/pipeline.ts`) end-to-end against a
 * real PostGIS test database — it composes T3.3's `checkDuplicate` and
 * T3.4's `checkProximity`/`checkGpsAgreement`/`checkTimestamps`/
 * `checkTravelSpeed`, all of which themselves hit the DB, so this suite
 * can't meaningfully run as a pure unit test. Skips (rather than fails)
 * when `DATABASE_URL` isn't configured, matching the repo's established
 * pattern (`tests/isolation/isolation.test.ts`, `tests/fraud/geo.test.ts`,
 * etc). `autoDecisionRate` (pure, no DB) gets its own unit-only `describe`
 * block below.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { closeTestDb, getTestDb, hasTestDatabase, resetTestDb } from "../setup";
import { seedTwoCampaigns } from "../fixtures/seed-two-campaigns";
import { getSubmission } from "@/lib/db/dal/submissions";
import {
  autoDecisionRate,
  runPipeline,
  type PipelineAction,
} from "@/lib/fraud/pipeline";
import type { Campaign, Coordinate, Player, TierTable } from "@/types/domain";

/** Approximate meters-per-degree-latitude — matches `tests/fraud/geo.test.ts`
 * (fixture geometry only, not the app's own distance math). */
const METERS_PER_DEGREE_LAT = 111_320;

function offsetNorth(coord: Coordinate, meters: number): Coordinate {
  return { lat: coord.lat + meters / METERS_PER_DEGREE_LAT, long: coord.long };
}

/** Mycofest's real tier curve (`docs/tasks/batch-4.md` §3: T1 1-10 $1.25,
 * T2 11-25 $1.75, T3 26+ $2.25) — used so the tier-3 threshold this suite
 * asserts against (26) matches PRD FR-F7's literal number, while still
 * proving `runPipeline` derives it from `campaign.tierTable` rather than a
 * hard-coded constant (module doc comment). */
const MYCOFEST_TIER_TABLE: TierTable = [
  { minCount: 0, maxCount: 10, payoutCents: 125 },
  { minCount: 11, maxCount: 25, payoutCents: 175 },
  { minCount: 26, maxCount: null, payoutCents: 225 },
];

/** Builds a minimal in-memory `Campaign` carrying only the fields
 * `runPipeline`'s composed checks actually read (`id`, `proximityRadiusM`,
 * `tierTable`) — mirrors `tests/fraud/geo.test.ts`'s `buildCampaign`. */
function buildCampaign(
  campaignId: string,
  overrides: Partial<Pick<Campaign, "proximityRadiusM" | "tierTable">> = {},
): Campaign {
  return {
    id: campaignId,
    name: "Test Campaign",
    flierImageUrl: "https://example.com/flier.png",
    budgetCapCents: 100_000,
    tierTable: overrides.tierTable ?? MYCOFEST_TIER_TABLE,
    grandPrize: "Test prize",
    privacySetting: "admin_only",
    proximityRadiusM: overrides.proximityRadiusM ?? 40,
    settlementMode: "manual",
    state: "live",
    hostId: randomUUID(),
    startAt: new Date("2026-01-01T00:00:00Z"),
    endAt: new Date("2026-12-31T00:00:00Z"),
  };
}

function buildPlayer(playerId: string): Player {
  return { id: playerId, phone: "+15559990000" };
}

describe.skipIf(!hasTestDatabase())(
  "runPipeline against a live database (T3.5 acceptance criteria)",
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
      phash?: string;
    }) {
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
          phash: params.phash ?? randomUUID().replace(/-/g, "").slice(0, 16),
        })
        .returning({ id: schema.submissions.id });

      const submission = await getSubmission(params.campaignId, row.id);
      if (!submission)
        throw new Error("failed to read back inserted submission");
      return submission;
    }

    async function setApprovedCount(
      campaignId: string,
      playerId: string,
      approvedCount: number,
    ): Promise<void> {
      await db!
        .update(schema.campaignMemberships)
        .set({ approvedCount })
        .where(
          and(
            eq(schema.campaignMemberships.campaignId, campaignId),
            eq(schema.campaignMemberships.playerId, playerId),
          ),
        );
    }

    it("all-pass + tier-1 player -> auto-approve", async () => {
      const seed = await seedTwoCampaigns(db!);
      const targetCenter = { lat: 46.9, long: -123.8 }; // campaignA target 0
      const submission = await insertSubmission({
        campaignId: seed.campaignA.campaignId,
        playerId: seed.campaignA.playerId,
        targetId: seed.campaignA.targetIds[0],
        deviceGps: targetCenter,
      });
      const campaign = buildCampaign(seed.campaignA.campaignId);
      const player = buildPlayer(seed.campaignA.playerId);

      const result = await runPipeline(submission, campaign, player);

      expect(result.decision).toBe("approved");
      expect(result.isTier3).toBe(false);
      expect(result.fraudChecks).toHaveLength(5);
      expect(result.fraudChecks.every((check) => check.passed)).toBe(true);
      expect(result.nextActions).toEqual<PipelineAction[]>([
        {
          type: "approve_target",
          campaignId: campaign.id,
          targetId: submission.targetId,
          submissionId: submission.id,
        },
        {
          type: "accrue_ledger",
          campaignId: campaign.id,
          submissionId: submission.id,
          playerId: player.id,
        },
      ]);
    });

    it("persists every FraudCheckResult and the final decision on the submission row", async () => {
      const seed = await seedTwoCampaigns(db!);
      const submission = await insertSubmission({
        campaignId: seed.campaignA.campaignId,
        playerId: seed.campaignA.playerId,
        targetId: seed.campaignA.targetIds[0],
        deviceGps: { lat: 46.9, long: -123.8 },
      });
      const campaign = buildCampaign(seed.campaignA.campaignId);
      const player = buildPlayer(seed.campaignA.playerId);

      await runPipeline(submission, campaign, player);

      const persisted = await getSubmission(
        seed.campaignA.campaignId,
        submission.id,
      );
      expect(persisted?.decision).toBe("approved");
      expect(persisted?.fraudChecks).toHaveLength(5);
      expect(persisted?.fraudChecks.map((c) => c.check).sort()).toEqual(
        [
          "duplicate",
          "proximity",
          "gps-agreement",
          "timestamp-sanity",
          "travel-speed",
        ].sort(),
      );
    });

    it("a tier-3 player (>=26 approved) with all-pass -> needs_review, not auto-approve", async () => {
      const seed = await seedTwoCampaigns(db!);
      await setApprovedCount(
        seed.campaignA.campaignId,
        seed.campaignA.playerId,
        26,
      );
      const submission = await insertSubmission({
        campaignId: seed.campaignA.campaignId,
        playerId: seed.campaignA.playerId,
        targetId: seed.campaignA.targetIds[0],
        deviceGps: { lat: 46.9, long: -123.8 },
      });
      const campaign = buildCampaign(seed.campaignA.campaignId);
      const player = buildPlayer(seed.campaignA.playerId);

      const result = await runPipeline(submission, campaign, player);

      expect(result.isTier3).toBe(true);
      expect(result.decision).toBe("needs_review");
      expect(result.fraudChecks.every((check) => check.passed)).toBe(true);
      expect(result.nextActions).toEqual([]);
    });

    it("a dedupe hit (same phash, different target) -> needs_review, not auto-reject", async () => {
      const seed = await seedTwoCampaigns(db!);
      const reusedPhash = "abcdef0123456789";
      // Prior submission on a *different* target, same hash.
      await insertSubmission({
        campaignId: seed.campaignA.campaignId,
        playerId: seed.campaignA.playerId,
        targetId: seed.campaignA.targetIds[1],
        deviceGps: { lat: 46.901, long: -123.799 },
        phash: reusedPhash,
      });
      const submission = await insertSubmission({
        campaignId: seed.campaignA.campaignId,
        playerId: seed.campaignA.playerId,
        targetId: seed.campaignA.targetIds[0],
        deviceGps: { lat: 46.9, long: -123.8 }, // clean on every other check
        phash: reusedPhash,
      });
      const campaign = buildCampaign(seed.campaignA.campaignId);
      const player = buildPlayer(seed.campaignA.playerId);

      const result = await runPipeline(submission, campaign, player);

      const duplicateCheck = result.fraudChecks.find(
        (c) => c.check === "duplicate",
      );
      expect(duplicateCheck?.passed).toBe(false);
      // A dedupe hit is a soft flag (Liotta review, Batch 3): the
      // synthetic-set false-positive rate isn't validated against
      // real-world photos yet, so it routes to human review rather than
      // auto-rejecting a possibly-legitimate player.
      expect(result.decision).toBe("needs_review");
      expect(result.nextActions).toEqual<PipelineAction[]>([]);
    });

    it("a proximity fail (80m from target, 40m radius) -> reject", async () => {
      const seed = await seedTwoCampaigns(db!);
      const targetCenter = { lat: 46.9, long: -123.8 };
      const submission = await insertSubmission({
        campaignId: seed.campaignA.campaignId,
        playerId: seed.campaignA.playerId,
        targetId: seed.campaignA.targetIds[0],
        deviceGps: offsetNorth(targetCenter, 80),
      });
      const campaign = buildCampaign(seed.campaignA.campaignId, {
        proximityRadiusM: 40,
      });
      const player = buildPlayer(seed.campaignA.playerId);

      const result = await runPipeline(submission, campaign, player);

      const proximityCheck = result.fraudChecks.find(
        (c) => c.check === "proximity",
      );
      expect(proximityCheck?.passed).toBe(false);
      expect(result.decision).toBe("rejected");
    });

    it("a soft/ambiguous flag alone (GPS disagreement) -> needs_review, not reject", async () => {
      const seed = await seedTwoCampaigns(db!);
      const deviceGps = { lat: 46.9, long: -123.8 };
      const submission = await insertSubmission({
        campaignId: seed.campaignA.campaignId,
        playerId: seed.campaignA.playerId,
        targetId: seed.campaignA.targetIds[0],
        deviceGps,
        exifGps: offsetNorth(deviceGps, 120), // 120m apart, 50m threshold
      });
      const campaign = buildCampaign(seed.campaignA.campaignId);
      const player = buildPlayer(seed.campaignA.playerId);

      const result = await runPipeline(submission, campaign, player);

      const agreementCheck = result.fraudChecks.find(
        (c) => c.check === "gps-agreement",
      );
      expect(agreementCheck?.passed).toBe(false);
      expect(result.decision).toBe("needs_review");
      expect(result.nextActions).toEqual([]);
    });
  },
);

describe("autoDecisionRate (unit, PRD G-3)", () => {
  it("is the fraction of decided submissions auto-decided (approved/rejected) rather than sent to review", () => {
    expect(
      autoDecisionRate([
        "approved",
        "rejected",
        "needs_review",
        "needs_review",
      ]),
    ).toBe(0.5);
  });

  it("excludes still-pending submissions from the denominator", () => {
    expect(autoDecisionRate(["pending", "approved"])).toBe(1);
  });

  it("is 0 for an empty or all-pending batch", () => {
    expect(autoDecisionRate([])).toBe(0);
    expect(autoDecisionRate(["pending", "pending"])).toBe(0);
  });
});
