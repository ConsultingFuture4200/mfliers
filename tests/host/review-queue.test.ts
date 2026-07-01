/**
 * Host review queue suite (T4.2) — PRD FR-R1…FR-R4.
 *
 * Exercises `lib/review/queue.ts`/`lib/review/decision.ts` against a real
 * PostGIS test database, same pattern as `tests/isolation/isolation.test.ts`
 * and `tests/campaign/lifecycle.test.ts`. Skips (rather than fails) when
 * `DATABASE_URL` isn't configured.
 *
 * `lib/storage/r2.ts`'s `createSignedGetUrl` is mocked (same pattern
 * `tests/capture/submit.test.ts` uses for `getObjectBytes`) — this suite
 * doesn't need a live R2/MinIO endpoint to prove the review queue's own
 * logic (authorization, distance/canvasser/check-result assembly,
 * approve/reject state transitions, audit logging); the storage
 * integration itself is `tests/storage/r2.test.ts`'s job.
 *
 * `lib/payout/ledger.ts` (T4.3) now exists, so `approveSubmission`'s
 * ledger accrual is exercised for real below (see the "approve" describe
 * block); the module's original doc comment here (written before T4.3
 * landed) is stale/updated as part of the batch-4 review fix that also
 * added the "recovers a partial-failure retry" test asserting the ledger
 * row + audit row are both re-driven when a prior attempt crashed between
 * them (Liotta's atomicity finding on `lib/review/decision.ts`).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  type SeededCampaign,
  type SeedTwoCampaignsResult,
} from "../fixtures/seed-two-campaigns";

vi.mock("@/lib/storage/r2", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/storage/r2")>(
      "@/lib/storage/r2",
    );
  return {
    ...actual,
    createSignedGetUrl: vi
      .fn()
      .mockResolvedValue("https://example.com/signed-get"),
  };
});

import { ForbiddenError } from "@/lib/auth/guards";
import type { StaffPrincipal } from "@/lib/auth/staff";
import { listReviewQueue } from "@/lib/review/queue";
import {
  approveSubmission,
  rejectSubmission,
  ReasonRequiredError,
  recordManualAdjustmentForSubmission,
  SubmissionNotUnderReviewError,
} from "@/lib/review/decision";
import { listAuditLog } from "@/lib/audit/log";
import { getTarget } from "@/lib/db/dal/targets";
import { getSubmission } from "@/lib/db/dal/submissions";
import { listLedger } from "@/lib/payout/ledger";
import type { FraudCheckResult } from "@/types/domain";

const DEFAULT_CHECKS: FraudCheckResult[] = [
  { check: "dedupe", passed: false, detail: "possible duplicate" },
  { check: "proximity", passed: true, detail: "18m" },
];

async function insertNeedsReviewSubmission(
  db: TestDb,
  campaign: SeededCampaign,
  targetIndex: number,
  fraudChecks: FraudCheckResult[] = DEFAULT_CHECKS,
): Promise<string> {
  const [row] = await db
    .insert(schema.submissions)
    .values({
      campaignId: campaign.campaignId,
      playerId: campaign.playerId,
      targetId: campaign.targetIds[targetIndex],
      photoUrl: `${campaign.campaignId}/${campaign.targetIds[targetIndex]}.jpg`,
      deviceGps: "POINT(-123.8 46.9)",
      phash: "a".repeat(16),
      decision: "needs_review",
      fraudChecks,
    })
    .returning({ id: schema.submissions.id });
  return row.id;
}

/** Simulates the claim-then-post state T3.2's flow would have left the
 * target in by the time a submission reaches `needs_review`: `amber`,
 * claimed by the submitting player, with the claim frozen (no expiry) per
 * `markTargetPendingReview`'s contract — `approve`/`reject` (T3.2) only
 * transition out of `amber`. */
async function setTargetAmber(
  db: TestDb,
  targetId: string,
  playerId: string,
): Promise<void> {
  await db
    .update(schema.targets)
    .set({ state: "amber", claimedBy: playerId, claimExpiresAt: null })
    .where(eq(schema.targets.id, targetId));
}

function hostPrincipalFor(campaign: SeededCampaign): StaffPrincipal {
  return {
    userId: campaign.hostId,
    type: "host",
    scopedCampaignIds: [campaign.campaignId],
  };
}

function adminPrincipal(): StaffPrincipal {
  return {
    userId: "00000000-0000-0000-0000-0000000000aa",
    type: "site_admin",
    scopedCampaignIds: [],
  };
}

describe.skipIf(!hasTestDatabase())("host review queue (T4.2)", () => {
  const db = hasTestDatabase() ? getTestDb() : undefined;
  let seed: SeedTwoCampaignsResult;

  beforeEach(async () => {
    await resetTestDb(db!);
    seed = await seedTwoCampaigns(db!);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  describe("scoping (card acceptance criterion 1 / anti-requirement 1)", () => {
    it("a host sees only their own campaign's needs_review items", async () => {
      const subA = await insertNeedsReviewSubmission(db!, seed.campaignA, 0);
      await setTargetAmber(
        db!,
        seed.campaignA.targetIds[0],
        seed.campaignA.playerId,
      );
      await insertNeedsReviewSubmission(db!, seed.campaignB, 0);
      await setTargetAmber(
        db!,
        seed.campaignB.targetIds[0],
        seed.campaignB.playerId,
      );

      const itemsA = await listReviewQueue(
        hostPrincipalFor(seed.campaignA),
        seed.campaignA.campaignId,
      );
      expect(itemsA).toHaveLength(1);
      expect(itemsA[0].submission.id).toBe(subA);
    });

    it("a host is denied (403-equivalent) reading another campaign's queue", async () => {
      await insertNeedsReviewSubmission(db!, seed.campaignB, 0);
      await setTargetAmber(
        db!,
        seed.campaignB.targetIds[0],
        seed.campaignB.playerId,
      );

      await expect(
        listReviewQueue(
          hostPrincipalFor(seed.campaignA),
          seed.campaignB.campaignId,
        ),
      ).rejects.toThrow(ForbiddenError);
    });

    it("a host is denied acting on another campaign's submission (approve)", async () => {
      const subB = await insertNeedsReviewSubmission(db!, seed.campaignB, 0);
      await setTargetAmber(
        db!,
        seed.campaignB.targetIds[0],
        seed.campaignB.playerId,
      );

      await expect(
        approveSubmission(
          hostPrincipalFor(seed.campaignA),
          seed.campaignB.campaignId,
          subB,
        ),
      ).rejects.toThrow(ForbiddenError);
    });

    it("a site admin can read any campaign's queue", async () => {
      await insertNeedsReviewSubmission(db!, seed.campaignA, 0);
      await setTargetAmber(
        db!,
        seed.campaignA.targetIds[0],
        seed.campaignA.playerId,
      );

      const items = await listReviewQueue(
        adminPrincipal(),
        seed.campaignA.campaignId,
      );
      expect(items).toHaveLength(1);
    });
  });

  describe("review card contents (card requirement 2)", () => {
    it("includes photo url, target, distance, canvasser, and every fraud check", async () => {
      const subId = await insertNeedsReviewSubmission(
        db!,
        seed.campaignA,
        0,
        DEFAULT_CHECKS,
      );
      await setTargetAmber(
        db!,
        seed.campaignA.targetIds[0],
        seed.campaignA.playerId,
      );

      const items = await listReviewQueue(
        hostPrincipalFor(seed.campaignA),
        seed.campaignA.campaignId,
      );
      expect(items).toHaveLength(1);
      const item = items[0];
      expect(item.submission.id).toBe(subId);
      expect(item.target.id).toBe(seed.campaignA.targetIds[0]);
      expect(item.photoUrl).toBe("https://example.com/signed-get");
      expect(item.player?.id).toBe(seed.campaignA.playerId);
      // The submission's deviceGps was seeded at the target's exact
      // coordinate, so distance should be ~0m.
      expect(item.distanceM).not.toBeNull();
      expect(item.distanceM!).toBeLessThan(1);
      expect(item.submission.fraudChecks).toEqual(DEFAULT_CHECKS);
    });
  });

  describe("approve (card requirement 3)", () => {
    it("flips the target to green and audit-logs the action", async () => {
      const subId = await insertNeedsReviewSubmission(db!, seed.campaignA, 0);
      await setTargetAmber(
        db!,
        seed.campaignA.targetIds[0],
        seed.campaignA.playerId,
      );

      const { submission, target } = await approveSubmission(
        hostPrincipalFor(seed.campaignA),
        seed.campaignA.campaignId,
        subId,
        "looks legit",
      );

      expect(target.state).toBe("green");
      expect(target.filledBySubmissionId).toBe(subId);
      expect(submission.decision).toBe("approved");

      const persistedTarget = await getTarget(
        seed.campaignA.campaignId,
        seed.campaignA.targetIds[0],
      );
      expect(persistedTarget?.state).toBe("green");

      const persistedSubmission = await getSubmission(
        seed.campaignA.campaignId,
        subId,
      );
      expect(persistedSubmission?.decision).toBe("approved");
      expect(persistedSubmission?.decidedBy).toBe(seed.campaignA.hostId);
      expect(persistedSubmission?.decidedAt).not.toBeNull();

      const audit = await listAuditLog(seed.campaignA.campaignId);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        campaignId: seed.campaignA.campaignId,
        submissionId: subId,
        playerId: seed.campaignA.playerId,
        actorUserId: seed.campaignA.hostId,
        action: "approve",
        reason: "looks legit",
      });
    });

    it("rejects acting on a submission that isn't needs_review", async () => {
      const subId = await insertNeedsReviewSubmission(db!, seed.campaignA, 0);
      await setTargetAmber(
        db!,
        seed.campaignA.targetIds[0],
        seed.campaignA.playerId,
      );
      await approveSubmission(
        hostPrincipalFor(seed.campaignA),
        seed.campaignA.campaignId,
        subId,
      );

      // A second, different decision against an already-decided submission
      // is a real conflict (not the same idempotent retry case).
      await expect(
        rejectSubmission(
          hostPrincipalFor(seed.campaignA),
          seed.campaignA.campaignId,
          subId,
          "changed my mind",
        ),
      ).rejects.toThrow(SubmissionNotUnderReviewError);
    });

    it("is idempotent: re-approving an already-approved submission is a no-op, not a duplicate audit row", async () => {
      const subId = await insertNeedsReviewSubmission(db!, seed.campaignA, 0);
      await setTargetAmber(
        db!,
        seed.campaignA.targetIds[0],
        seed.campaignA.playerId,
      );

      await approveSubmission(
        hostPrincipalFor(seed.campaignA),
        seed.campaignA.campaignId,
        subId,
        "first pass",
      );
      const second = await approveSubmission(
        hostPrincipalFor(seed.campaignA),
        seed.campaignA.campaignId,
        subId,
        "first pass",
      );

      expect(second.target.state).toBe("green");
      const audit = await listAuditLog(seed.campaignA.campaignId);
      expect(audit).toHaveLength(1);
    });

    it("recovers a partial failure between recordReviewDecision and accrue: a retry against an already-approved submission still accrues the ledger and writes the audit row (batch-4 review fix, Liotta)", async () => {
      const subId = await insertNeedsReviewSubmission(db!, seed.campaignA, 0);

      // Simulate a crash after `recordReviewDecision`/the target-flip
      // committed, but before `accrue()`/the audit append ran: the
      // submission is already `approved` and the target already `green`,
      // yet there is no ledger row and no audit row for it: exactly the
      // stranded state the prior code's already-approved early return
      // could never recover from.
      await db!
        .update(schema.submissions)
        .set({ decision: "approved", decidedBy: seed.campaignA.hostId })
        .where(eq(schema.submissions.id, subId));
      await db!
        .update(schema.targets)
        .set({ state: "green", filledBySubmissionId: subId })
        .where(eq(schema.targets.id, seed.campaignA.targetIds[0]));

      expect(
        (await listLedger(seed.campaignA.campaignId)).filter(
          (entry) => entry.submissionId === subId,
        ),
      ).toHaveLength(0);
      expect(await listAuditLog(seed.campaignA.campaignId)).toHaveLength(0);

      const { submission, target } = await approveSubmission(
        hostPrincipalFor(seed.campaignA),
        seed.campaignA.campaignId,
        subId,
        "recovered on retry",
      );

      expect(submission.decision).toBe("approved");
      expect(target.state).toBe("green");

      const ledgerEntries = (
        await listLedger(seed.campaignA.campaignId)
      ).filter((entry) => entry.submissionId === subId);
      expect(ledgerEntries).toHaveLength(1);
      expect(ledgerEntries[0].playerId).toBe(seed.campaignA.playerId);

      const audit = await listAuditLog(seed.campaignA.campaignId);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        submissionId: subId,
        playerId: seed.campaignA.playerId,
        actorUserId: seed.campaignA.hostId,
        action: "approve",
      });

      // A further retry (both side effects already present) stays a
      // strict no-op: no double-pay, no duplicate audit row.
      await approveSubmission(
        hostPrincipalFor(seed.campaignA),
        seed.campaignA.campaignId,
        subId,
        "recovered on retry",
      );
      expect(
        (await listLedger(seed.campaignA.campaignId)).filter(
          (entry) => entry.submissionId === subId,
        ),
      ).toHaveLength(1);
      expect(await listAuditLog(seed.campaignA.campaignId)).toHaveLength(1);
    });
  });

  describe("reject (card requirement 3/4)", () => {
    it("reopens the target to red, frees the claim, and persists a player-visible reason", async () => {
      const subId = await insertNeedsReviewSubmission(db!, seed.campaignA, 0);
      await setTargetAmber(
        db!,
        seed.campaignA.targetIds[0],
        seed.campaignA.playerId,
      );

      const { submission, target } = await rejectSubmission(
        hostPrincipalFor(seed.campaignA),
        seed.campaignA.campaignId,
        subId,
        "flier not visible in photo",
      );

      expect(target.state).toBe("red");
      expect(target.claimedBy).toBeNull();
      expect(target.claimExpiresAt).toBeNull();
      expect(submission.decision).toBe("rejected");
      // The rejection reason rides on the submission's own fraudChecks
      // (see lib/review/decision.ts's module doc comment) — this is the
      // "exposed to the player" half of card requirement 4: it's a field
      // on the same Submission a player-facing view would read.
      expect(
        submission.fraudChecks.some(
          (c) =>
            c.check === "host-decision" &&
            c.detail.includes("flier not visible"),
        ),
      ).toBe(true);

      const audit = await listAuditLog(seed.campaignA.campaignId);
      expect(audit).toHaveLength(1);
      expect(audit[0].action).toBe("reject");
      expect(audit[0].reason).toBe("flier not visible in photo");
    });

    it("requires a reason code", async () => {
      const subId = await insertNeedsReviewSubmission(db!, seed.campaignA, 0);
      await setTargetAmber(
        db!,
        seed.campaignA.targetIds[0],
        seed.campaignA.playerId,
      );

      await expect(
        rejectSubmission(
          hostPrincipalFor(seed.campaignA),
          seed.campaignA.campaignId,
          subId,
          "",
        ),
      ).rejects.toThrow(ReasonRequiredError);
    });
  });

  describe("manual adjustment (card requirement 6, FR-R4)", () => {
    it("audit-logs an adjustment without touching the target or submission decision", async () => {
      const subId = await insertNeedsReviewSubmission(db!, seed.campaignA, 0);
      await setTargetAmber(
        db!,
        seed.campaignA.targetIds[0],
        seed.campaignA.playerId,
      );

      await recordManualAdjustmentForSubmission(
        hostPrincipalFor(seed.campaignA),
        seed.campaignA.campaignId,
        subId,
        "goodwill bonus point",
      );

      const audit = await listAuditLog(seed.campaignA.campaignId);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: "adjust",
        playerId: seed.campaignA.playerId,
        submissionId: null,
        reason: "goodwill bonus point",
      });

      // Still needs_review — an adjustment is not a decision.
      const persisted = await getSubmission(seed.campaignA.campaignId, subId);
      expect(persisted?.decision).toBe("needs_review");
    });
  });

  describe("immutable audit log (card requirement 5)", () => {
    it("accumulates one row per action, across approve/reject on different submissions", async () => {
      const subA = await insertNeedsReviewSubmission(db!, seed.campaignA, 0);
      await setTargetAmber(
        db!,
        seed.campaignA.targetIds[0],
        seed.campaignA.playerId,
      );
      const subA2 = await insertNeedsReviewSubmission(db!, seed.campaignA, 1);
      await setTargetAmber(
        db!,
        seed.campaignA.targetIds[1],
        seed.campaignA.playerId,
      );

      await approveSubmission(
        hostPrincipalFor(seed.campaignA),
        seed.campaignA.campaignId,
        subA,
      );
      await rejectSubmission(
        hostPrincipalFor(seed.campaignA),
        seed.campaignA.campaignId,
        subA2,
        "bad angle",
      );

      const audit = await listAuditLog(seed.campaignA.campaignId);
      expect(audit).toHaveLength(2);
      const actions = audit.map((a) => a.action).sort();
      expect(actions).toEqual(["approve", "reject"]);
    });
  });
});
