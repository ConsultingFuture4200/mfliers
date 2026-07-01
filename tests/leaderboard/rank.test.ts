/**
 * Leaderboard + personal-stats suite (T5.4) — PRD FR-G1/FR-G2 / §3 grand
 * prize. Pure-function tests (`buildLeaderboardView`/`computePersonalStats`)
 * run with no DB. The DB-backed acceptance criteria (live vs. closed
 * ordering, campaign scoping, personal stats sourced from a real
 * `accrue()`d ledger) are exercised against a real PostGIS test database,
 * same pattern as `tests/campaign/lifecycle.test.ts`/`tests/payout/
 * ledger.test.ts`. Skips (rather than fails) when `DATABASE_URL` isn't
 * configured.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { closeTestDb, getTestDb, hasTestDatabase, resetTestDb } from "../setup";
import type { StaffPrincipal } from "@/lib/auth/staff";
import { activateCampaign, closeCampaign } from "@/lib/campaign/lifecycle";
import { accrue } from "@/lib/payout/ledger";
import {
  buildLeaderboardView,
  CampaignNotFoundError,
  computePersonalStats,
  getLeaderboardForCampaign,
  getPersonalStatsForCampaign,
} from "@/lib/leaderboard/rank";
import type { CampaignMembership, Submission, TierTable } from "@/types/domain";

const MYCOFEST_TIER_TABLE: TierTable = [
  { minCount: 0, maxCount: 10, payoutCents: 125 },
  { minCount: 11, maxCount: 25, payoutCents: 175 },
  { minCount: 26, maxCount: null, payoutCents: 225 },
];

function membership(
  overrides: Partial<CampaignMembership> & { playerId: string },
): CampaignMembership {
  return {
    campaignId: "campaign-1",
    approvedCount: 0,
    currentTier: 0,
    balanceOwedCents: 0,
    rank: 0,
    ...overrides,
  };
}

function approvedSubmission(
  overrides: Partial<Submission> & { playerId: string; receivedAt: Date },
): Submission {
  return {
    id: `sub-${Math.random()}`,
    campaignId: "campaign-1",
    targetId: "target-1",
    photoUrl: "https://example.com/x.jpg",
    deviceGps: { lat: 0, long: 0 },
    exifGps: null,
    exifTs: null,
    phash: "a".repeat(16),
    fraudChecks: [],
    decision: "approved",
    decidedBy: null,
    decidedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure unit tests — lib/leaderboard/rank.ts. No DB.
// ---------------------------------------------------------------------------

describe("buildLeaderboardView (T5.4)", () => {
  it("acceptance criterion: orders by approved count, tie-broken by earliest to reach it, while still open", () => {
    const memberships = [
      membership({ playerId: "earlybird", approvedCount: 2 }),
      membership({ playerId: "latecomer", approvedCount: 2 }),
      membership({ playerId: "straggler", approvedCount: 1 }),
    ];
    const submissions = [
      approvedSubmission({
        playerId: "earlybird",
        receivedAt: new Date("2026-07-05T10:00:00Z"),
      }),
      approvedSubmission({
        playerId: "earlybird",
        receivedAt: new Date("2026-07-06T10:00:00Z"),
      }),
      approvedSubmission({
        playerId: "latecomer",
        receivedAt: new Date("2026-07-05T09:00:00Z"),
      }),
      approvedSubmission({
        playerId: "latecomer",
        receivedAt: new Date("2026-07-07T10:00:00Z"),
      }),
      approvedSubmission({
        playerId: "straggler",
        receivedAt: new Date("2026-07-05T08:00:00Z"),
      }),
    ];

    const view = buildLeaderboardView(memberships, submissions, null, false);

    expect(view.top.map((e) => e.playerId)).toEqual([
      "earlybird",
      "latecomer",
      "straggler",
    ]);
    expect(view.top[0]).toMatchObject({ rank: 1, approvedCount: 2 });
    expect(view.campaignClosed).toBe(false);
    // Anti-requirement: never a grand-prize winner before close, even
    // though the live ordering already knows who's currently #1.
    expect(view.grandPrizeWinnerPlayerId).toBeNull();
  });

  it("once closed, reads the persisted `rank` column rather than re-deriving it", () => {
    const memberships = [
      membership({ playerId: "p1", approvedCount: 5, rank: 2 }),
      membership({ playerId: "p2", approvedCount: 9, rank: 1 }),
    ];
    // Deliberately empty/irrelevant submissions — a closed-campaign read
    // must not need to recompute anything from them.
    const view = buildLeaderboardView(memberships, [], null, true);

    expect(view.top.map((e) => e.playerId)).toEqual(["p2", "p1"]);
    expect(view.grandPrizeWinnerPlayerId).toBe("p2");
  });

  it("surfaces the viewer's own rank even when outside the top N", () => {
    const memberships = Array.from({ length: 12 }, (_, i) =>
      membership({ playerId: `p${i}`, approvedCount: 12 - i }),
    );
    const view = buildLeaderboardView(memberships, [], "p11", false, 10);

    expect(view.top).toHaveLength(10);
    expect(view.top.some((e) => e.playerId === "p11")).toBe(false);
    expect(view.viewer).toMatchObject({ playerId: "p11", rank: 12 });
    expect(view.viewer?.isViewer).toBe(true);
  });

  it("viewer is null when no viewerPlayerId is supplied", () => {
    const memberships = [membership({ playerId: "p1", approvedCount: 1 })];
    const view = buildLeaderboardView(memberships, [], null, false);
    expect(view.viewer).toBeNull();
  });
});

describe("computePersonalStats (T5.4)", () => {
  it("acceptance criterion: fliers-to-next-tier and $ earned at the 10/11 and 25/26 boundaries", () => {
    expect(
      computePersonalStats(
        membership({
          playerId: "p1",
          approvedCount: 8,
          balanceOwedCents: 1000,
        }),
        MYCOFEST_TIER_TABLE,
        3,
      ),
    ).toMatchObject({ earnedCents: 1000, fliersToNextTier: 3 });

    expect(
      computePersonalStats(
        membership({ playerId: "p1", approvedCount: 10 }),
        MYCOFEST_TIER_TABLE,
        0,
      ),
    ).toMatchObject({ fliersToNextTier: 1 });

    expect(
      computePersonalStats(
        membership({ playerId: "p1", approvedCount: 11 }),
        MYCOFEST_TIER_TABLE,
        0,
      ),
    ).toMatchObject({ fliersToNextTier: 15 });

    expect(
      computePersonalStats(
        membership({ playerId: "p1", approvedCount: 25 }),
        MYCOFEST_TIER_TABLE,
        0,
      ),
    ).toMatchObject({ fliersToNextTier: 1 });
  });

  it("returns null fliersToNextTier once in the top, open-ended band", () => {
    const stats = computePersonalStats(
      membership({ playerId: "p1", approvedCount: 30 }),
      MYCOFEST_TIER_TABLE,
      0,
    );
    expect(stats.fliersToNextTier).toBeNull();
  });

  it("is null-safe for a player with no membership yet (all-zero stats, no throw)", () => {
    const stats = computePersonalStats(null, MYCOFEST_TIER_TABLE, 4);
    expect(stats).toMatchObject({
      approvedCount: 0,
      currentTier: 0,
      earnedCents: 0,
      fliersToNextTier: 11,
      targetsRemaining: 4,
    });
  });
});

// ---------------------------------------------------------------------------
// DB-backed integration tests.
// ---------------------------------------------------------------------------

function adminPrincipal(): StaffPrincipal {
  return {
    userId: "00000000-0000-0000-0000-0000000000aa",
    type: "site_admin",
    scopedCampaignIds: [],
  };
}

describe.skipIf(!hasTestDatabase())(
  "leaderboard + personal stats (T5.4, DB)",
  () => {
    const db = hasTestDatabase() ? getTestDb() : undefined;

    beforeEach(async () => {
      await resetTestDb(db!);
    });

    afterAll(async () => {
      await closeTestDb();
    });

    async function insertHost(): Promise<string> {
      const [row] = await db!
        .insert(schema.users)
        .values({ type: "host" })
        .returning({ id: schema.users.id });
      return row.id;
    }

    async function insertLiveCampaignWithTarget(
      hostId: string,
      name: string,
    ): Promise<{ campaignId: string; targetId: string }> {
      const [campaign] = await db!
        .insert(schema.campaigns)
        .values({
          name,
          flierImageUrl: "https://example.com/fliers/test.png",
          budgetCap: 100_000_00,
          tierTable: MYCOFEST_TIER_TABLE,
          grandPrize: "Two festival tickets",
          privacySetting: "admin_only",
          proximityRadiusM: 40,
          settlementMode: "manual",
          state: "draft",
          hostId,
          startAt: new Date("2026-01-01T00:00:00Z"),
          endAt: new Date("2026-12-31T00:00:00Z"),
        })
        .returning({ id: schema.campaigns.id });

      const [target] = await db!
        .insert(schema.targets)
        .values({
          campaignId: campaign.id,
          label: "Target 1",
          location: "POINT(-123.8 46.9)",
          state: "red",
        })
        .returning({ id: schema.targets.id });

      await activateCampaign(adminPrincipal(), campaign.id);
      return { campaignId: campaign.id, targetId: target.id };
    }

    async function insertPlayer(phone: string): Promise<string> {
      const [row] = await db!
        .insert(schema.players)
        .values({ phone })
        .returning({ id: schema.players.id });
      return row.id;
    }

    async function insertApprovedSubmission(
      campaignId: string,
      playerId: string,
      targetId: string,
    ): Promise<string> {
      const [row] = await db!
        .insert(schema.submissions)
        .values({
          campaignId,
          playerId,
          targetId,
          photoUrl: `${campaignId}/${targetId}-${Math.random()}.jpg`,
          deviceGps: "POINT(-123.8 46.9)",
          phash: "a".repeat(16),
          decision: "approved",
        })
        .returning({ id: schema.submissions.id });
      return row.id;
    }

    it("acceptance criterion: personal stats compute $ earned and fliers-to-next-tier from real ledger accruals", async () => {
      const hostId = await insertHost();
      const { campaignId, targetId } = await insertLiveCampaignWithTarget(
        hostId,
        "Ledger-backed stats",
      );
      const playerId = await insertPlayer("+15550001111");

      // Ten approvals (tier 1, $1.25 each) — one flier short of tier 2.
      // `accrue()` only writes the ledger/membership counters (T4.3); it
      // does not itself flip a target's state (that's `lib/target/
      // state-machine.ts`'s `approve`/`approveTarget`, T4.2's job) — so the
      // single seeded target stays `red` throughout this test.
      for (let i = 0; i < 10; i++) {
        const submissionId = await insertApprovedSubmission(
          campaignId,
          playerId,
          targetId,
        );
        await accrue(campaignId, submissionId, playerId);
      }

      const stats = await getPersonalStatsForCampaign(campaignId, playerId);
      expect(stats).toMatchObject({
        approvedCount: 10,
        currentTier: 1,
        earnedCents: 1250,
        fliersToNextTier: 1,
        targetsRemaining: 1, // the seeded target is still `red`
      });

      // Manually flip it to `green` (simulating T4.2's approve step) to
      // exercise "targets remaining" actually excluding a filled pin.
      await db!
        .update(schema.targets)
        .set({ state: "green" })
        .where(eq(schema.targets.id, targetId));
      const statsAfterFill = await getPersonalStatsForCampaign(
        campaignId,
        playerId,
      );
      expect(statsAfterFill.targetsRemaining).toBe(0);
    });

    it("acceptance criterion: leaderboard ordering + viewer rank while the campaign is still live", async () => {
      const hostId = await insertHost();
      const { campaignId } = await insertLiveCampaignWithTarget(
        hostId,
        "Live leaderboard",
      );

      const leaderId = await insertPlayer("+15550002222");
      const runnerUpId = await insertPlayer("+15550003333");

      for (let i = 0; i < 3; i++) {
        const [target] = await db!
          .insert(schema.targets)
          .values({
            campaignId,
            label: `Leader target ${i}`,
            location: "POINT(-123.8 46.9)",
            state: "red",
          })
          .returning({ id: schema.targets.id });
        const submissionId = await insertApprovedSubmission(
          campaignId,
          leaderId,
          target.id,
        );
        await accrue(campaignId, submissionId, leaderId);
      }

      const [runnerUpTarget] = await db!
        .insert(schema.targets)
        .values({
          campaignId,
          label: "Runner-up target",
          location: "POINT(-123.8 46.9)",
          state: "red",
        })
        .returning({ id: schema.targets.id });
      const runnerUpSubmissionId = await insertApprovedSubmission(
        campaignId,
        runnerUpId,
        runnerUpTarget.id,
      );
      await accrue(campaignId, runnerUpSubmissionId, runnerUpId);

      const view = await getLeaderboardForCampaign(campaignId, runnerUpId);
      expect(view.campaignClosed).toBe(false);
      expect(view.grandPrizeWinnerPlayerId).toBeNull();
      expect(view.top.map((e) => e.playerId)).toEqual([leaderId, runnerUpId]);
      expect(view.viewer).toMatchObject({
        playerId: runnerUpId,
        isViewer: true,
      });
    });

    it("acceptance criterion: after close, the grand-prize winner matches closeCampaign's own finalize result", async () => {
      const hostId = await insertHost();
      const { campaignId, targetId } = await insertLiveCampaignWithTarget(
        hostId,
        "Closing campaign",
      );
      const winnerId = await insertPlayer("+15550004444");
      const runnerUpId = await insertPlayer("+15550005555");

      const winnerSubmissionId = await insertApprovedSubmission(
        campaignId,
        winnerId,
        targetId,
      );
      await accrue(campaignId, winnerSubmissionId, winnerId);

      const [secondTarget] = await db!
        .insert(schema.targets)
        .values({
          campaignId,
          label: "Second target",
          location: "POINT(-123.8 46.9)",
          state: "red",
        })
        .returning({ id: schema.targets.id });
      const runnerUpSubmissionId = await insertApprovedSubmission(
        campaignId,
        runnerUpId,
        secondTarget.id,
      );
      await accrue(campaignId, runnerUpSubmissionId, runnerUpId);

      const closeResult = await closeCampaign(adminPrincipal(), campaignId);

      const view = await getLeaderboardForCampaign(campaignId, null);
      expect(view.campaignClosed).toBe(true);
      expect(view.grandPrizeWinnerPlayerId).toBe(
        closeResult.grandPrizeWinnerPlayerId,
      );
      expect(view.grandPrizeWinnerPlayerId).toBe(winnerId);
      expect(view.top.map((e) => e.playerId)).toEqual([winnerId, runnerUpId]);
    });

    it("acceptance criterion: all reads are campaign-scoped — no cross-campaign rank bleed", async () => {
      const hostId = await insertHost();
      const { campaignId: campaignA, targetId: targetA } =
        await insertLiveCampaignWithTarget(hostId, "Campaign A");
      const { campaignId: campaignB, targetId: targetB } =
        await insertLiveCampaignWithTarget(hostId, "Campaign B");

      const playerAId = await insertPlayer("+15550006666");
      const playerBId = await insertPlayer("+15550007777");

      const subA = await insertApprovedSubmission(
        campaignA,
        playerAId,
        targetA,
      );
      await accrue(campaignA, subA, playerAId);
      const subB = await insertApprovedSubmission(
        campaignB,
        playerBId,
        targetB,
      );
      await accrue(campaignB, subB, playerBId);

      const viewA = await getLeaderboardForCampaign(campaignA, null);
      const viewB = await getLeaderboardForCampaign(campaignB, null);

      expect(viewA.top.map((e) => e.playerId)).toEqual([playerAId]);
      expect(viewB.top.map((e) => e.playerId)).toEqual([playerBId]);

      const statsAForB = await getPersonalStatsForCampaign(
        campaignA,
        playerBId,
      );
      expect(statsAForB.approvedCount).toBe(0);
    });

    it("throws CampaignNotFoundError for an unknown campaign id", async () => {
      await expect(
        getLeaderboardForCampaign("00000000-0000-0000-0000-000000000000", null),
      ).rejects.toThrow(CampaignNotFoundError);
      await expect(
        getPersonalStatsForCampaign(
          "00000000-0000-0000-0000-000000000000",
          "00000000-0000-0000-0000-000000000000",
        ),
      ).rejects.toThrow(CampaignNotFoundError);
    });
  },
);
