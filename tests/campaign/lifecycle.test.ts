/**
 * Campaign lifecycle + configuration suite (T3.1).
 *
 * Exercises `lib/campaign/lifecycle.ts`/`lib/campaign/tier-validation.ts`
 * against a real PostGIS test database — same pattern as
 * `tests/isolation/isolation.test.ts` — for every card acceptance
 * criterion: admin-only create/update, the draft->live readiness gate,
 * tier-table shape validation, and the close-time freeze/finalize
 * routine's tie-break rule. Skips (rather than fails) when `DATABASE_URL`
 * isn't configured.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { closeTestDb, getTestDb, hasTestDatabase, resetTestDb } from "../setup";
import { ForbiddenError } from "@/lib/auth/guards";
import type { StaffPrincipal } from "@/lib/auth/staff";
import { listMemberships } from "@/lib/db/dal/campaign-memberships";
import {
  activateCampaign,
  assertCampaignAccrualAllowed,
  CampaignFrozenError,
  CampaignNotFoundError,
  CampaignNotReadyError,
  closeCampaign,
  computeFinalLeaderboard,
  createCampaign,
  IllegalTransitionError,
  InvalidCampaignInputError,
  updateCampaign,
  type CreateCampaignInput,
} from "@/lib/campaign/lifecycle";
import {
  InvalidTierTableError,
  validateTierTable,
} from "@/lib/campaign/tier-validation";
import type { CampaignMembership, Submission, TierTable } from "@/types/domain";

const VALID_TIER_TABLE: TierTable = [
  { minCount: 0, maxCount: 5, payoutCents: 500 },
  { minCount: 6, maxCount: 15, payoutCents: 750 },
  { minCount: 16, maxCount: null, payoutCents: 1000 },
];

function adminPrincipal(): StaffPrincipal {
  return {
    userId: "00000000-0000-0000-0000-0000000000aa",
    type: "site_admin",
    scopedCampaignIds: [],
  };
}

function hostPrincipal(): StaffPrincipal {
  return {
    userId: "00000000-0000-0000-0000-0000000000bb",
    type: "host",
    scopedCampaignIds: [],
  };
}

describe.skipIf(!hasTestDatabase())("campaign lifecycle (T3.1)", () => {
  const db = hasTestDatabase() ? getTestDb() : undefined;

  beforeEach(async () => {
    await resetTestDb(db!);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  async function insertHostUser(): Promise<string> {
    const [row] = await db!
      .insert(schema.users)
      .values({ type: "host" })
      .returning({ id: schema.users.id });
    return row.id;
  }

  function baseInput(hostId: string): CreateCampaignInput {
    return {
      name: "Mycofest 2026",
      budgetCapCents: 100_000,
      tierTable: VALID_TIER_TABLE,
      grandPrize: "A year of mushroom coffee",
      privacySetting: "admin_only",
      proximityRadiusM: 40,
      hostId,
      startAt: new Date("2026-07-01T00:00:00Z"),
      endAt: new Date("2026-08-01T00:00:00Z"),
    };
  }

  // -------------------------------------------------------------------
  // Acceptance: non-admin principal is denied create/update (403)
  // -------------------------------------------------------------------
  describe("site-admin-only authorization", () => {
    it("denies a host principal creating a campaign", async () => {
      const hostId = await insertHostUser();
      let thrown: unknown;
      try {
        await createCampaign(hostPrincipal(), baseInput(hostId));
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ForbiddenError);
      expect((thrown as ForbiddenError).status).toBe(403);
    });

    it("allows a site_admin principal to create a campaign", async () => {
      const hostId = await insertHostUser();
      const campaign = await createCampaign(
        adminPrincipal(),
        baseInput(hostId),
      );
      expect(campaign.state).toBe("draft");
      expect(campaign.hostId).toBe(hostId);
    });

    it("denies a host principal updating a campaign", async () => {
      const hostId = await insertHostUser();
      const campaign = await createCampaign(
        adminPrincipal(),
        baseInput(hostId),
      );

      let thrown: unknown;
      try {
        await updateCampaign(hostPrincipal(), campaign.id, {
          name: "Renamed by a host (should be denied)",
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ForbiddenError);
      expect((thrown as ForbiddenError).status).toBe(403);
    });
  });

  // -------------------------------------------------------------------
  // Acceptance: budget/tier amounts persisted as integer cents
  // -------------------------------------------------------------------
  describe("money is integer cents", () => {
    it("persists budgetCapCents and tier payoutCents as integers", async () => {
      const hostId = await insertHostUser();
      const campaign = await createCampaign(
        adminPrincipal(),
        baseInput(hostId),
      );

      expect(Number.isInteger(campaign.budgetCapCents)).toBe(true);
      expect(campaign.budgetCapCents).toBe(100_000);
      for (const band of campaign.tierTable) {
        expect(Number.isInteger(band.payoutCents)).toBe(true);
      }
    });

    it("rejects a non-integer budgetCapCents", async () => {
      const hostId = await insertHostUser();
      const input = { ...baseInput(hostId), budgetCapCents: 1000.5 };

      await expect(createCampaign(adminPrincipal(), input)).rejects.toThrow(
        InvalidCampaignInputError,
      );
    });
  });

  // -------------------------------------------------------------------
  // Acceptance: invalid tier table (overlap/gap/closed-top) rejected
  // -------------------------------------------------------------------
  describe("tier table validation", () => {
    it("accepts an ordered, contiguous table with an open top band", () => {
      expect(() => validateTierTable(VALID_TIER_TABLE)).not.toThrow();
    });

    it("rejects a table with a gap between bands", () => {
      const gapped: TierTable = [
        { minCount: 0, maxCount: 5, payoutCents: 500 },
        { minCount: 7, maxCount: null, payoutCents: 1000 }, // gap at 6
      ];
      expect(() => validateTierTable(gapped)).toThrow(InvalidTierTableError);
    });

    it("rejects a table with overlapping bands", () => {
      const overlapping: TierTable = [
        { minCount: 0, maxCount: 5, payoutCents: 500 },
        { minCount: 4, maxCount: null, payoutCents: 1000 }, // overlaps 4-5
      ];
      expect(() => validateTierTable(overlapping)).toThrow(
        InvalidTierTableError,
      );
    });

    it("rejects a table whose last band is closed (not open-ended)", () => {
      const closedTop: TierTable = [
        { minCount: 0, maxCount: 5, payoutCents: 500 },
        { minCount: 6, maxCount: 15, payoutCents: 1000 }, // no open top band
      ];
      expect(() => validateTierTable(closedTop)).toThrow(InvalidTierTableError);
    });

    it("createCampaign propagates tier-table validation failures", async () => {
      const hostId = await insertHostUser();
      const input = {
        ...baseInput(hostId),
        tierTable: [
          { minCount: 0, maxCount: 5, payoutCents: 500 },
          { minCount: 6, maxCount: 15, payoutCents: 1000 },
        ] as TierTable, // closed top — invalid
      };
      await expect(createCampaign(adminPrincipal(), input)).rejects.toThrow(
        InvalidTierTableError,
      );
    });
  });

  // -------------------------------------------------------------------
  // Acceptance: draft->live blocked without flier image / targets;
  // allowed otherwise. Illegal transitions rejected.
  // -------------------------------------------------------------------
  describe("draft -> live readiness gate", () => {
    it("blocks activation with no flier image and no targets", async () => {
      const hostId = await insertHostUser();
      const campaign = await createCampaign(
        adminPrincipal(),
        baseInput(hostId),
      );
      expect(campaign.flierImageUrl).toBe("");

      await expect(
        activateCampaign(adminPrincipal(), campaign.id),
      ).rejects.toThrow(CampaignNotReadyError);
    });

    it("blocks activation with a flier image but zero targets", async () => {
      const hostId = await insertHostUser();
      const campaign = await createCampaign(
        adminPrincipal(),
        baseInput(hostId),
      );
      await updateCampaign(adminPrincipal(), campaign.id, {
        flierImageUrl: "https://example.com/flier.png",
      });

      await expect(
        activateCampaign(adminPrincipal(), campaign.id),
      ).rejects.toThrow(CampaignNotReadyError);
    });

    it("allows activation once a flier image is set and >=1 target exists", async () => {
      const hostId = await insertHostUser();
      const campaign = await createCampaign(
        adminPrincipal(),
        baseInput(hostId),
      );
      await updateCampaign(adminPrincipal(), campaign.id, {
        flierImageUrl: "https://example.com/flier.png",
      });
      await db!.insert(schema.targets).values({
        campaignId: campaign.id,
        label: "Target 1",
        location: "POINT(-123.8 46.9)",
        state: "red",
      });

      const live = await activateCampaign(adminPrincipal(), campaign.id);
      expect(live.state).toBe("live");
    });

    it("rejects an illegal transition (live -> live)", async () => {
      const hostId = await insertHostUser();
      const campaign = await createCampaign(
        adminPrincipal(),
        baseInput(hostId),
      );
      await updateCampaign(adminPrincipal(), campaign.id, {
        flierImageUrl: "https://example.com/flier.png",
      });
      await db!.insert(schema.targets).values({
        campaignId: campaign.id,
        label: "Target 1",
        location: "POINT(-123.8 46.9)",
        state: "red",
      });
      await activateCampaign(adminPrincipal(), campaign.id);

      await expect(
        activateCampaign(adminPrincipal(), campaign.id),
      ).rejects.toThrow(IllegalTransitionError);
    });

    it("rejects an illegal transition (draft -> closed, skipping live)", async () => {
      const hostId = await insertHostUser();
      const campaign = await createCampaign(
        adminPrincipal(),
        baseInput(hostId),
      );

      await expect(
        closeCampaign(adminPrincipal(), campaign.id),
      ).rejects.toThrow(IllegalTransitionError);
    });

    it("404s a transition against an unknown campaign id", async () => {
      await expect(
        activateCampaign(
          adminPrincipal(),
          "00000000-0000-0000-0000-000000000000",
        ),
      ).rejects.toThrow(CampaignNotFoundError);
    });
  });

  // -------------------------------------------------------------------
  // Acceptance: closing freezes the ledger and records a grand-prize
  // winner using the tie-break rule (most approved, then earliest to
  // reach that count).
  // -------------------------------------------------------------------
  describe("close-time freeze + finalize", () => {
    async function liveCampaignWithTarget(hostId: string) {
      const campaign = await createCampaign(
        adminPrincipal(),
        baseInput(hostId),
      );
      await updateCampaign(adminPrincipal(), campaign.id, {
        flierImageUrl: "https://example.com/flier.png",
      });
      const [target] = await db!
        .insert(schema.targets)
        .values({
          campaignId: campaign.id,
          label: "Target 1",
          location: "POINT(-123.8 46.9)",
          state: "red",
        })
        .returning({ id: schema.targets.id });
      const live = await activateCampaign(adminPrincipal(), campaign.id);
      return { campaign: live, targetId: target.id };
    }

    async function insertPlayerWithApprovedSubmissions(
      campaignId: string,
      targetId: string,
      phone: string,
      approvedTimestamps: Date[],
    ): Promise<string> {
      const [player] = await db!
        .insert(schema.players)
        .values({ phone })
        .returning({ id: schema.players.id });

      await db!.insert(schema.campaignMemberships).values({
        campaignId,
        playerId: player.id,
        approvedCount: approvedTimestamps.length,
      });

      for (const receivedAt of approvedTimestamps) {
        await db!.insert(schema.submissions).values({
          campaignId,
          playerId: player.id,
          targetId,
          photoUrl: `https://example.com/photos/${player.id}-${receivedAt.getTime()}.jpg`,
          deviceGps: "POINT(-123.8 46.9)",
          phash: "a".repeat(16),
          decision: "approved",
          receivedAt,
        });
      }

      return player.id;
    }

    it("freezes the ledger: assertCampaignAccrualAllowed rejects after close", async () => {
      const hostId = await insertHostUser();
      const { campaign } = await liveCampaignWithTarget(hostId);

      // Accruals are allowed while live.
      expect(() => assertCampaignAccrualAllowed(campaign)).not.toThrow();

      const result = await closeCampaign(adminPrincipal(), campaign.id);
      expect(result.campaign.state).toBe("closed");

      expect(() => assertCampaignAccrualAllowed(result.campaign)).toThrow(
        CampaignFrozenError,
      );
    });

    it("rejects a second close attempt (already closed)", async () => {
      const hostId = await insertHostUser();
      const { campaign } = await liveCampaignWithTarget(hostId);
      await closeCampaign(adminPrincipal(), campaign.id);

      await expect(
        closeCampaign(adminPrincipal(), campaign.id),
      ).rejects.toThrow(IllegalTransitionError);
    });

    it("two concurrent close attempts: exactly one succeeds, the other gets IllegalTransitionError (Linus review finding)", async () => {
      // `setCampaignState`'s atomic `WHERE state = fromState` guard (mirrors
      // `targets.ts`'s conditional-claim pattern) must prevent both
      // concurrent callers from reading the same stale `live` row and both
      // "succeeding" — exactly one write should land.
      const hostId = await insertHostUser();
      const { campaign } = await liveCampaignWithTarget(hostId);

      const results = await Promise.allSettled([
        closeCampaign(adminPrincipal(), campaign.id),
        closeCampaign(adminPrincipal(), campaign.id),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        IllegalTransitionError,
      );
    });

    it("picks the grand-prize winner by approvedCount, tie-broken by earliest to reach it", async () => {
      const hostId = await insertHostUser();
      const { campaign, targetId } = await liveCampaignWithTarget(hostId);

      // Both players tie at 2 approved submissions; Earlybird reaches
      // their 2nd approval before Latecomer reaches theirs — Earlybird
      // must win the tie-break.
      const earlybirdId = await insertPlayerWithApprovedSubmissions(
        campaign.id,
        targetId,
        "+15559990001",
        [new Date("2026-07-05T10:00:00Z"), new Date("2026-07-06T10:00:00Z")],
      );
      const latecomerId = await insertPlayerWithApprovedSubmissions(
        campaign.id,
        targetId,
        "+15559990002",
        [new Date("2026-07-05T09:00:00Z"), new Date("2026-07-07T10:00:00Z")],
      );
      // A third player with fewer approvals must rank below both.
      const stragglerId = await insertPlayerWithApprovedSubmissions(
        campaign.id,
        targetId,
        "+15559990003",
        [new Date("2026-07-05T08:00:00Z")],
      );

      const result = await closeCampaign(adminPrincipal(), campaign.id);

      expect(result.grandPrizeWinnerPlayerId).toBe(earlybirdId);
      expect(result.leaderboard[0]).toMatchObject({
        playerId: earlybirdId,
        rank: 1,
        approvedCount: 2,
      });
      expect(result.leaderboard[1]).toMatchObject({
        playerId: latecomerId,
        rank: 2,
        approvedCount: 2,
      });
      expect(result.leaderboard[2]).toMatchObject({
        playerId: stragglerId,
        rank: 3,
        approvedCount: 1,
      });

      // The snapshot is actually persisted on campaign_memberships, not
      // just returned in-memory.
      const memberships = await listMemberships(campaign.id);
      const byPlayer = new Map<string, CampaignMembership>(
        memberships.map((m) => [m.playerId, m]),
      );
      expect(byPlayer.get(earlybirdId)?.rank).toBe(1);
      expect(byPlayer.get(latecomerId)?.rank).toBe(2);
      expect(byPlayer.get(stragglerId)?.rank).toBe(3);
    });

    it("updateCampaign rejects edits once a campaign is closed", async () => {
      const hostId = await insertHostUser();
      const { campaign } = await liveCampaignWithTarget(hostId);
      await closeCampaign(adminPrincipal(), campaign.id);

      await expect(
        updateCampaign(adminPrincipal(), campaign.id, { name: "Too late" }),
      ).rejects.toThrow(CampaignFrozenError);
    });
  });

  // -------------------------------------------------------------------
  // Pure tie-break logic, unit-tested directly (no DB) for a fast,
  // isolated proof of the ordering rule itself.
  // -------------------------------------------------------------------
  describe("computeFinalLeaderboard (pure)", () => {
    it("ranks by approvedCount desc, then earliest reach time asc", () => {
      const memberships: CampaignMembership[] = [
        {
          playerId: "p-tied-late",
          campaignId: "c1",
          approvedCount: 3,
          currentTier: 0,
          balanceOwedCents: 0,
          rank: 0,
        },
        {
          playerId: "p-tied-early",
          campaignId: "c1",
          approvedCount: 3,
          currentTier: 0,
          balanceOwedCents: 0,
          rank: 0,
        },
        {
          playerId: "p-fewer",
          campaignId: "c1",
          approvedCount: 1,
          currentTier: 0,
          balanceOwedCents: 0,
          rank: 0,
        },
      ];

      function approvedSubmission(
        playerId: string,
        receivedAt: string,
      ): Submission {
        return {
          id: `${playerId}-${receivedAt}`,
          campaignId: "c1",
          playerId,
          targetId: "t1",
          photoUrl: "https://example.com/x.jpg",
          deviceGps: { lat: 0, long: 0 },
          exifGps: null,
          exifTs: null,
          receivedAt: new Date(receivedAt),
          phash: "0".repeat(16),
          fraudChecks: [],
          decision: "approved",
          decidedBy: null,
          decidedAt: null,
        };
      }

      const submissions: Submission[] = [
        approvedSubmission("p-tied-early", "2026-01-01T00:00:00Z"),
        approvedSubmission("p-tied-early", "2026-01-02T00:00:00Z"),
        approvedSubmission("p-tied-early", "2026-01-03T00:00:00Z"),
        approvedSubmission("p-tied-late", "2026-01-01T00:00:00Z"),
        approvedSubmission("p-tied-late", "2026-01-02T00:00:00Z"),
        approvedSubmission("p-tied-late", "2026-01-05T00:00:00Z"),
        approvedSubmission("p-fewer", "2026-01-01T00:00:00Z"),
      ];

      const leaderboard = computeFinalLeaderboard(memberships, submissions);
      expect(leaderboard.map((e) => e.playerId)).toEqual([
        "p-tied-early",
        "p-tied-late",
        "p-fewer",
      ]);
      expect(leaderboard.map((e) => e.rank)).toEqual([1, 2, 3]);
    });
  });
});
