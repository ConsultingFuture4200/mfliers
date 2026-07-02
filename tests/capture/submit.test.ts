/**
 * `lib/capture/submit.ts` (T4.1 capture flow) integration suite, run
 * against a real PostGIS test database — same pattern as
 * `tests/target/state-machine.test.ts` / `tests/fraud/pipeline.test.ts`.
 * Skips (rather than fails) when `DATABASE_URL` isn't configured.
 *
 * `getObjectBytes` (R2) and `computePhash` (sharp) are mocked — this suite
 * is about the DB-backed orchestration (persistence, the fraud pipeline's
 * real proximity/dedupe checks, the target-state dispatch, idempotency),
 * not about exercising a live R2 bucket or `sharp`'s image decode (T2.4's
 * `tests/storage/r2.test.ts` and T3.3's `tests/fraud/dedupe.test.ts` own
 * those). Every other module (`lib/db/dal/*`, `lib/target/state-machine.ts`,
 * `lib/fraud/pipeline.ts`) runs for real.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestDb, getTestDb, hasTestDatabase, resetTestDb } from "../setup";
import { seedTwoCampaigns } from "../fixtures/seed-two-campaigns";
import * as schema from "@/lib/db/schema";
import { eq } from "drizzle-orm";

vi.mock("@/lib/storage/r2", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/storage/r2")>(
      "@/lib/storage/r2",
    );
  return { ...actual, getObjectBytes: vi.fn() };
});
vi.mock("@/lib/fraud/dedupe", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/fraud/dedupe")>(
      "@/lib/fraud/dedupe",
    );
  return { ...actual, computePhash: vi.fn() };
});

import { getObjectBytes } from "@/lib/storage/r2";
import { computePhash } from "@/lib/fraud/dedupe";
import {
  deriveOfflineSubmissionId,
  PhotoKeyMismatchError,
  submitCapture,
  TargetNotClaimedError,
  type SubmitCaptureInput,
} from "@/lib/capture/submit";
import { CampaignNotLiveError } from "@/lib/campaign/lifecycle";
import { claim } from "@/lib/target/state-machine";
import { getTarget } from "@/lib/db/dal/targets";
import { getSubmission } from "@/lib/db/dal/submissions";
import { listAuditLog } from "@/lib/audit/log";
import { listLedgerEntries } from "@/lib/db/dal/payout-ledger";
import type { Player } from "@/types/domain";

function uniqueHash(): string {
  return randomBytes(8).toString("hex");
}

function baseInput(overrides: Partial<SubmitCaptureInput>): SubmitCaptureInput {
  return {
    targetId: "",
    submissionId: randomUUID(),
    photoKey: "",
    deviceGps: { lat: 46.9, long: -123.8 },
    exifGps: null,
    exifTs: null,
    clientTs: null,
    isGalleryFallback: false,
    ...overrides,
  };
}

describe.skipIf(!hasTestDatabase())("submitCapture (T4.1)", () => {
  const db = hasTestDatabase() ? getTestDb() : undefined;

  beforeEach(async () => {
    await resetTestDb(db!);
    vi.clearAllMocks();
    vi.mocked(getObjectBytes).mockResolvedValue(
      Buffer.from("fake-photo-bytes"),
    );
    vi.mocked(computePhash).mockImplementation(async () => uniqueHash());
  });

  afterAll(async () => {
    await closeTestDb();
  });

  async function seedAndClaim() {
    const seed = await seedTwoCampaigns(db!);
    const player: Player = {
      id: seed.campaignA.playerId,
      email: "canvasser-a@example.com",
    };
    const targetId = seed.campaignA.targetIds[0];
    await claim(seed.campaignA.campaignId, targetId, player.id);
    return { seed, player, targetId };
  }

  function photoKeyFor(campaignId: string, submissionId: string): string {
    return `${campaignId}/${submissionId}.jpg`;
  }

  it("approves a clean submission, flips the target green, and counts the running total", async () => {
    const { seed, player, targetId } = await seedAndClaim();
    const submissionId = randomUUID();

    const result = await submitCapture(
      seed.campaignA.campaignId,
      player,
      baseInput({
        targetId,
        submissionId,
        photoKey: photoKeyFor(seed.campaignA.campaignId, submissionId),
        deviceGps: { lat: 46.9, long: -123.8 }, // matches the fixture's target 1 exactly
      }),
    );

    expect(result.decision).toBe("approved");
    expect(result.runningApprovedTotal).toBe(1);
    expect(result.targetState).toBe("green");
    expect(result.fraudChecks).toHaveLength(5);

    const target = await getTarget(seed.campaignA.campaignId, targetId);
    expect(target?.state).toBe("green");
    expect(target?.filledBySubmissionId).toBe(submissionId);

    const submission = await getSubmission(
      seed.campaignA.campaignId,
      submissionId,
    );
    expect(submission?.decision).toBe("approved");
    expect(submission?.receivedAt).toBeInstanceOf(Date);
    expect(getObjectBytes).toHaveBeenCalledTimes(1);
    expect(computePhash).toHaveBeenCalledTimes(1);

    // Batch-4 review fix (Liotta): auto-approval is the majority decision
    // path but previously wrote no audit row at all: a payout-dispute
    // investigation on an auto-approved entry had no "who/when" trail
    // beyond the ledger/submission rows themselves.
    const audit = await listAuditLog(seed.campaignA.campaignId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      submissionId,
      playerId: player.id,
      actorUserId: null, // system/pipeline decision, not a human one
      action: "approve",
    });
  });

  it("is idempotent on a retry with the same submissionId (no double-fetch, no double-count)", async () => {
    const { seed, player, targetId } = await seedAndClaim();
    const submissionId = randomUUID();
    const input = baseInput({
      targetId,
      submissionId,
      photoKey: photoKeyFor(seed.campaignA.campaignId, submissionId),
      deviceGps: { lat: 46.9, long: -123.8 },
    });

    const first = await submitCapture(seed.campaignA.campaignId, player, input);
    const second = await submitCapture(
      seed.campaignA.campaignId,
      player,
      input,
    );

    expect(second.decision).toBe(first.decision);
    expect(second.runningApprovedTotal).toBe(1); // not double-counted
    expect(second.targetState).toBe("green");
    // The photo is only fetched/hashed once — a retry reuses the persisted
    // decision rather than recomputing it (module doc comment).
    expect(getObjectBytes).toHaveBeenCalledTimes(1);
    expect(computePhash).toHaveBeenCalledTimes(1);

    const target = await getTarget(seed.campaignA.campaignId, targetId);
    expect(target?.state).toBe("green"); // still green, not re-thrown as a conflict

    // The retried accrue_ledger dispatch must not write a second audit
    // row for the same auto-approval.
    const audit = await listAuditLog(seed.campaignA.campaignId);
    expect(audit).toHaveLength(1);
  });

  it("offline-sync retry (same queueId-derived submissionId) never double-pays a target (Liotta batch-5 review)", async () => {
    // Simulates the exact scenario the finding describes: a queued
    // submission syncs, the submit succeeds, but the ack is lost (dead
    // zone) so the offline queue item stays "queued" and a later sync
    // pass retries it. `lib/offline/sync.ts` re-requests a signed URL
    // through `/api/uploads/sign` on every attempt, which now derives the
    // *same* submissionId from `(campaignId, queueId)` instead of minting
    // a fresh `randomUUID()` — so this is what a real retry sends to
    // `submitCapture`.
    const { seed, player, targetId } = await seedAndClaim();
    const queueId = "queue-item-offline-1";
    const submissionId = deriveOfflineSubmissionId(
      seed.campaignA.campaignId,
      queueId,
    );
    const input = baseInput({
      targetId,
      submissionId,
      photoKey: photoKeyFor(seed.campaignA.campaignId, submissionId),
      deviceGps: { lat: 46.9, long: -123.8 },
    });

    const first = await submitCapture(seed.campaignA.campaignId, player, input);
    // Re-derive independently (as a second sign call would) to prove the
    // id isn't just being reused by test-code coincidence.
    const resignedSubmissionId = deriveOfflineSubmissionId(
      seed.campaignA.campaignId,
      queueId,
    );
    expect(resignedSubmissionId).toBe(submissionId);
    const retry = await submitCapture(
      seed.campaignA.campaignId,
      player,
      baseInput({
        ...input,
        submissionId: resignedSubmissionId,
        photoKey: photoKeyFor(seed.campaignA.campaignId, resignedSubmissionId),
      }),
    );

    expect(retry.decision).toBe(first.decision);
    expect(retry.runningApprovedTotal).toBe(1); // no double-count

    const ledgerEntries = await listLedgerEntries(seed.campaignA.campaignId);
    expect(ledgerEntries).toHaveLength(1); // no double-pay

    const audit = await listAuditLog(seed.campaignA.campaignId);
    expect(audit).toHaveLength(1); // no duplicate approval audit row
  });

  it("auto-flags a gallery-fallback submission to needs_review instead of auto-approving", async () => {
    const { seed, player, targetId } = await seedAndClaim();
    const submissionId = randomUUID();

    const result = await submitCapture(
      seed.campaignA.campaignId,
      player,
      baseInput({
        targetId,
        submissionId,
        photoKey: photoKeyFor(seed.campaignA.campaignId, submissionId),
        deviceGps: { lat: 46.9, long: -123.8 },
        isGalleryFallback: true,
      }),
    );

    expect(result.decision).toBe("needs_review");
    expect(result.targetState).toBe("amber"); // not flipped — a human decides
    expect(result.runningApprovedTotal).toBe(0);
    expect(result.fraudChecks.some((c) => c.check === "gallery-fallback")).toBe(
      true,
    );

    const target = await getTarget(seed.campaignA.campaignId, targetId);
    expect(target?.state).toBe("amber");
  });

  it("rejects and reopens the target on a hard proximity fail", async () => {
    const { seed, player, targetId } = await seedAndClaim();
    const submissionId = randomUUID();

    const result = await submitCapture(
      seed.campaignA.campaignId,
      player,
      baseInput({
        targetId,
        submissionId,
        photoKey: photoKeyFor(seed.campaignA.campaignId, submissionId),
        deviceGps: { lat: 40.7, long: -74.0 }, // NYC — nowhere near the target
      }),
    );

    expect(result.decision).toBe("rejected");
    expect(result.targetState).toBe("red");

    const target = await getTarget(seed.campaignA.campaignId, targetId);
    expect(target?.state).toBe("red");
    expect(target?.claimedBy).toBeNull();
  });

  it("throws TargetNotClaimedError for a target the player never claimed", async () => {
    const seed = await seedTwoCampaigns(db!);
    const player: Player = {
      id: seed.campaignA.playerId,
      email: "canvasser-a@example.com",
    };
    const targetId = seed.campaignA.targetIds[1]; // never claimed
    const submissionId = randomUUID();

    await expect(
      submitCapture(
        seed.campaignA.campaignId,
        player,
        baseInput({
          targetId,
          submissionId,
          photoKey: photoKeyFor(seed.campaignA.campaignId, submissionId),
        }),
      ),
    ).rejects.toBeInstanceOf(TargetNotClaimedError);
  });

  it("throws PhotoKeyMismatchError when the photoKey doesn't match the deterministic key", async () => {
    const { seed, player, targetId } = await seedAndClaim();
    const submissionId = randomUUID();

    await expect(
      submitCapture(
        seed.campaignA.campaignId,
        player,
        baseInput({
          targetId,
          submissionId,
          photoKey: "some-other-campaign/some-other-submission.jpg",
        }),
      ),
    ).rejects.toBeInstanceOf(PhotoKeyMismatchError);
  });

  it("throws CampaignNotLiveError against a non-live campaign", async () => {
    const { seed, player, targetId } = await seedAndClaim();
    await db!
      .update(schema.campaigns)
      .set({ state: "closed" })
      .where(eq(schema.campaigns.id, seed.campaignA.campaignId));

    const submissionId = randomUUID();
    await expect(
      submitCapture(
        seed.campaignA.campaignId,
        player,
        baseInput({
          targetId,
          submissionId,
          photoKey: photoKeyFor(seed.campaignA.campaignId, submissionId),
        }),
      ),
    ).rejects.toBeInstanceOf(CampaignNotLiveError);
  });
});
