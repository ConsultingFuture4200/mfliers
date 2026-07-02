/**
 * Target claim state-machine suite (T3.2).
 *
 * Exercises `lib/target/state-machine.ts` (and, through it,
 * `lib/db/dal/targets.ts`'s atomic conditional-`UPDATE` writes) against a
 * real PostGIS test database — same pattern as
 * `tests/campaign/lifecycle.test.ts` / `tests/isolation/isolation.test.ts`
 * — for every card acceptance criterion: atomic claim under concurrency,
 * the 3-hour lazy-expiry window, approve/reject transitions, and the
 * pending-submission freeze. Skips (rather than fails) when
 * `DATABASE_URL` isn't configured.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { closeTestDb, getTestDb, hasTestDatabase, resetTestDb } from "../setup";
import { seedTwoCampaigns } from "../fixtures/seed-two-campaigns";
import {
  approve,
  claim,
  ClaimConflictError,
  IllegalTransitionError,
  isActivelyClaimedBy,
  markPendingReview,
  reject,
  TargetNotFoundError,
} from "@/lib/target/state-machine";
import { getTarget } from "@/lib/db/dal/targets";
import type { SubmissionDecision } from "@/types/domain";

describe.skipIf(!hasTestDatabase())("target claim state machine (T3.2)", () => {
  const db = hasTestDatabase() ? getTestDb() : undefined;

  beforeEach(async () => {
    await resetTestDb(db!);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  /** Inserts a second player into the same campaign the fixture already
   * seeded one player into — needed for the two-claimants race test. */
  async function insertSecondPlayer(): Promise<string> {
    const [row] = await db!
      .insert(schema.players)
      .values({
        email: `player-${Math.floor(Math.random() * 1000000)}@example.com`,
      })
      .returning({ id: schema.players.id });
    return row.id;
  }

  /** Inserts a submission row against `targetId` — the minimal shape
   * `submissions` requires (mirrors `tests/isolation/isolation.test.ts`'s
   * helper). `decision` defaults to `"pending"` (undecided) unless
   * overridden. */
  async function insertSubmission(
    campaignId: string,
    playerId: string,
    targetId: string,
    decision: SubmissionDecision = "pending",
  ): Promise<string> {
    const [row] = await db!
      .insert(schema.submissions)
      .values({
        campaignId,
        playerId,
        targetId,
        photoUrl: `https://example.com/photos/${randomUUID()}.jpg`,
        deviceGps: "POINT(-123.8 46.9)",
        phash: "f".repeat(16),
        decision,
      })
      .returning({ id: schema.submissions.id });
    return row.id;
  }

  /** Directly back-dates a target's `claim_expires_at` (bypassing the DAL)
   * to simulate the 3-hour hold having already lapsed, without waiting. */
  async function backdateClaimExpiry(targetId: string): Promise<void> {
    await db!
      .update(schema.targets)
      .set({ claimExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.targets.id, targetId));
  }

  // -------------------------------------------------------------------
  // Acceptance: two concurrent claims on the same red target -> exactly
  // one succeeds (the atomic-claim race-safety core).
  // -------------------------------------------------------------------
  it("exactly one of two concurrent claims on the same red target succeeds", async () => {
    const seed = await seedTwoCampaigns(db!);
    const targetId = seed.campaignA.targetIds[0];
    const playerA = seed.campaignA.playerId;
    const playerB = await insertSecondPlayer();

    const results = await Promise.allSettled([
      claim(seed.campaignA.campaignId, targetId, playerA),
      claim(seed.campaignA.campaignId, targetId, playerB),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ClaimConflictError,
    );

    const winner = (
      fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof claim>>>
    ).value;
    expect(winner.state).toBe("amber");
    expect([playerA, playerB]).toContain(winner.claimedBy);

    // The DB's own state agrees with whichever claim call actually won —
    // no double-write happened.
    const persisted = await getTarget(seed.campaignA.campaignId, targetId);
    expect(persisted?.claimedBy).toBe(winner.claimedBy);
  });

  it("claiming an already-actively-claimed target throws ClaimConflictError", async () => {
    const seed = await seedTwoCampaigns(db!);
    const targetId = seed.campaignA.targetIds[0];
    const playerB = await insertSecondPlayer();

    await claim(seed.campaignA.campaignId, targetId, seed.campaignA.playerId);

    await expect(
      claim(seed.campaignA.campaignId, targetId, playerB),
    ).rejects.toThrow(ClaimConflictError);
  });

  it("claiming a nonexistent target throws TargetNotFoundError", async () => {
    const seed = await seedTwoCampaigns(db!);
    await expect(
      claim(seed.campaignA.campaignId, randomUUID(), seed.campaignA.playerId),
    ).rejects.toThrow(TargetNotFoundError);
  });

  // -------------------------------------------------------------------
  // Acceptance: claim sets claim_expires_at ~3h out; an expired amber (no
  // pending submission) is re-claimable.
  // -------------------------------------------------------------------
  it("sets claim_expires_at ~3 hours out", async () => {
    const seed = await seedTwoCampaigns(db!);
    const targetId = seed.campaignA.targetIds[0];
    const before = Date.now();

    const target = await claim(
      seed.campaignA.campaignId,
      targetId,
      seed.campaignA.playerId,
    );

    expect(target.claimExpiresAt).not.toBeNull();
    const deltaMs = target.claimExpiresAt!.getTime() - before;
    const threeHoursMs = 3 * 60 * 60 * 1000;
    // Allow generous slack for test/DB round-trip time, not for correctness.
    expect(deltaMs).toBeGreaterThan(threeHoursMs - 60_000);
    expect(deltaMs).toBeLessThan(threeHoursMs + 60_000);
  });

  it("an expired amber claim with no pending submission is re-claimable", async () => {
    const seed = await seedTwoCampaigns(db!);
    const targetId = seed.campaignA.targetIds[0];
    const playerB = await insertSecondPlayer();

    await claim(seed.campaignA.campaignId, targetId, seed.campaignA.playerId);
    await backdateClaimExpiry(targetId);

    const reclaimed = await claim(seed.campaignA.campaignId, targetId, playerB);
    expect(reclaimed.state).toBe("amber");
    expect(reclaimed.claimedBy).toBe(playerB);
  });

  // -------------------------------------------------------------------
  // Acceptance: a pending submission prevents the claim from silently
  // expiring, even past its claim_expires_at.
  // -------------------------------------------------------------------
  it("a pending submission blocks reclaim even after the hold time has lapsed", async () => {
    const seed = await seedTwoCampaigns(db!);
    const targetId = seed.campaignA.targetIds[0];
    const playerA = seed.campaignA.playerId;
    const playerB = await insertSecondPlayer();

    await claim(seed.campaignA.campaignId, targetId, playerA);
    await insertSubmission(seed.campaignA.campaignId, playerA, targetId);
    await backdateClaimExpiry(targetId);

    await expect(
      claim(seed.campaignA.campaignId, targetId, playerB),
    ).rejects.toThrow(ClaimConflictError);
  });

  it("markPendingReview freezes claim_expires_at to null while amber", async () => {
    const seed = await seedTwoCampaigns(db!);
    const targetId = seed.campaignA.targetIds[0];
    const playerA = seed.campaignA.playerId;

    await claim(seed.campaignA.campaignId, targetId, playerA);
    await insertSubmission(seed.campaignA.campaignId, playerA, targetId);

    const frozen = await markPendingReview(seed.campaignA.campaignId, targetId);
    expect(frozen.claimExpiresAt).toBeNull();
    expect(frozen.state).toBe("amber");

    const persisted = await getTarget(seed.campaignA.campaignId, targetId);
    expect(persisted?.claimExpiresAt).toBeNull();
  });

  it("markPendingReview on a non-amber target throws IllegalTransitionError", async () => {
    const seed = await seedTwoCampaigns(db!);
    const targetId = seed.campaignA.targetIds[0]; // still red, never claimed
    await expect(
      markPendingReview(seed.campaignA.campaignId, targetId),
    ).rejects.toThrow(IllegalTransitionError);
  });

  // -------------------------------------------------------------------
  // Acceptance: approve moves amber -> green and sets
  // filled_by_submission_id; green is not re-claimable.
  // -------------------------------------------------------------------
  it("approve moves amber -> green, sets filled_by_submission_id, and blocks re-claim", async () => {
    const seed = await seedTwoCampaigns(db!);
    const targetId = seed.campaignA.targetIds[0];
    const playerA = seed.campaignA.playerId;
    const playerB = await insertSecondPlayer();

    await claim(seed.campaignA.campaignId, targetId, playerA);
    const submissionId = await insertSubmission(
      seed.campaignA.campaignId,
      playerA,
      targetId,
      "approved",
    );

    const approved = await approve(
      seed.campaignA.campaignId,
      targetId,
      submissionId,
    );
    expect(approved.state).toBe("green");
    expect(approved.filledBySubmissionId).toBe(submissionId);

    await expect(
      claim(seed.campaignA.campaignId, targetId, playerB),
    ).rejects.toThrow(ClaimConflictError);
  });

  it("approve on a non-amber target throws IllegalTransitionError", async () => {
    const seed = await seedTwoCampaigns(db!);
    const targetId = seed.campaignA.targetIds[0]; // still red
    await expect(
      approve(seed.campaignA.campaignId, targetId, randomUUID()),
    ).rejects.toThrow(IllegalTransitionError);
  });

  // -------------------------------------------------------------------
  // Acceptance: reject moves amber -> red and clears claim fields.
  // -------------------------------------------------------------------
  it("reject moves amber -> red and clears claim fields", async () => {
    const seed = await seedTwoCampaigns(db!);
    const targetId = seed.campaignA.targetIds[0];
    const playerA = seed.campaignA.playerId;

    await claim(seed.campaignA.campaignId, targetId, playerA);
    const reopened = await reject(seed.campaignA.campaignId, targetId);

    expect(reopened.state).toBe("red");
    expect(reopened.claimedBy).toBeNull();
    expect(reopened.claimExpiresAt).toBeNull();

    // Reopened target is claimable again, by anyone.
    const playerB = await insertSecondPlayer();
    const reclaimed = await claim(seed.campaignA.campaignId, targetId, playerB);
    expect(reclaimed.claimedBy).toBe(playerB);
  });

  // -------------------------------------------------------------------
  // Acceptance (pure predicate, no DB): isActivelyClaimedBy
  // -------------------------------------------------------------------
  describe("isActivelyClaimedBy", () => {
    it("is true for the claimant while amber and unexpired", async () => {
      const seed = await seedTwoCampaigns(db!);
      const targetId = seed.campaignA.targetIds[0];
      const target = await claim(
        seed.campaignA.campaignId,
        targetId,
        seed.campaignA.playerId,
      );
      expect(isActivelyClaimedBy(target, seed.campaignA.playerId)).toBe(true);
    });

    it("is false for a different player", async () => {
      const seed = await seedTwoCampaigns(db!);
      const targetId = seed.campaignA.targetIds[0];
      const target = await claim(
        seed.campaignA.campaignId,
        targetId,
        seed.campaignA.playerId,
      );
      expect(isActivelyClaimedBy(target, randomUUID())).toBe(false);
    });

    it("is false once the checked time is past claim_expires_at", async () => {
      const seed = await seedTwoCampaigns(db!);
      const targetId = seed.campaignA.targetIds[0];
      const target = await claim(
        seed.campaignA.campaignId,
        targetId,
        seed.campaignA.playerId,
      );
      const wayLater = new Date(target.claimExpiresAt!.getTime() + 1);
      expect(
        isActivelyClaimedBy(target, seed.campaignA.playerId, wayLater),
      ).toBe(false);
    });

    it("is true with a null (frozen) expiry, regardless of how late", async () => {
      const seed = await seedTwoCampaigns(db!);
      const targetId = seed.campaignA.targetIds[0];
      const target = await claim(
        seed.campaignA.campaignId,
        targetId,
        seed.campaignA.playerId,
      );
      const frozen = { ...target, claimExpiresAt: null };
      const farFuture = new Date(Date.now() + 1_000 * 60 * 60 * 24 * 365);
      expect(
        isActivelyClaimedBy(frozen, seed.campaignA.playerId, farFuture),
      ).toBe(true);
    });
  });
});
