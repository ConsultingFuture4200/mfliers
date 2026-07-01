/**
 * Dedupe suite (T3.3 — Batch 3 review gate).
 *
 * Exercises `lib/fraud/dedupe.ts` at two levels:
 *  - unit-level hashing/distance correctness, and the seeded-set threshold
 *    tuning measurement (no DB needed);
 *  - `checkDuplicate` against a real PostGIS test database (via
 *    `lib/db/dal/dedupe-hashes.ts`), covering the three acceptance-criteria
 *    cases: reused photo on a different target (flag), distinct photos of
 *    the same flier on different targets (don't flag), and a near-identical
 *    resubmission to the *same* target (don't flag — FR-F4's concern, not
 *    this check's). Skips the DB-backed describe block (rather than
 *    failing) when `DATABASE_URL` isn't configured, matching the repo's
 *    established pattern (`tests/isolation/isolation.test.ts`, etc).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { closeTestDb, getTestDb, hasTestDatabase, resetTestDb } from "../setup";
import { seedTwoCampaigns } from "../fixtures/seed-two-campaigns";
import {
  renderFlierPhoto,
  reencodePhoto,
  SEED_PLACEMENTS,
} from "./fixtures/synth-flier";
import {
  checkDuplicate,
  computePhash,
  hammingDistance,
  DUPLICATE_HASH_THRESHOLD,
} from "@/lib/fraud/dedupe";

describe("computePhash / hammingDistance (unit)", () => {
  it("is deterministic for the same image bytes", async () => {
    const photo = await renderFlierPhoto(SEED_PLACEMENTS[0]);
    const a = await computePhash(photo);
    const b = await computePhash(photo);
    expect(a).toBe(b);
  });

  it("returns a 16-character lowercase hex string (64 bits)", async () => {
    const photo = await renderFlierPhoto(SEED_PLACEMENTS[0]);
    const hash = await computePhash(photo);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("hammingDistance is 0 for a hash compared with itself", async () => {
    const photo = await renderFlierPhoto(SEED_PLACEMENTS[0]);
    const hash = await computePhash(photo);
    expect(hammingDistance(hash, hash)).toBe(0);
  });

  it("hammingDistance rejects mismatched hash lengths", () => {
    expect(() => hammingDistance("ab", "abcd")).toThrow(/length mismatch/);
  });
});

describe("seeded threshold tuning (T3.3 review-gate measurement)", () => {
  it("distinct-placement pairs never fall within threshold; reused-photo pairs always do", async () => {
    // (a) 12 independently-"photographed" distinct placements of the
    // identical flier artwork.
    const photos = await Promise.all(
      SEED_PLACEMENTS.map((p) => renderFlierPhoto(p)),
    );
    const hashes = await Promise.all(photos.map((p) => computePhash(p)));

    const distinctDistances: number[] = [];
    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) {
        distinctDistances.push(hammingDistance(hashes[i], hashes[j]));
      }
    }
    expect(distinctDistances).toHaveLength(66); // C(12,2)
    const falsePositives = distinctDistances.filter(
      (d) => d <= DUPLICATE_HASH_THRESHOLD,
    );
    // Documented in lib/fraud/dedupe.ts's module comment: 0/66 measured.
    expect(falsePositives.length).toBe(0);

    // (b) each of the 12 photos, re-encoded (not re-photographed) — the
    // "same photo reused on a different pin" fraud case.
    const reencoded = await Promise.all(photos.map((p) => reencodePhoto(p)));
    const reencodedHashes = await Promise.all(
      reencoded.map((p) => computePhash(p)),
    );
    const reuseDistances = hashes.map((h, i) =>
      hammingDistance(h, reencodedHashes[i]),
    );
    expect(reuseDistances).toHaveLength(12);
    const falseNegatives = reuseDistances.filter(
      (d) => d > DUPLICATE_HASH_THRESHOLD,
    );
    // Documented in lib/fraud/dedupe.ts's module comment: 0/12 measured.
    expect(falseNegatives.length).toBe(0);
  });
});

describe.skipIf(!hasTestDatabase())(
  "checkDuplicate against a live database (T3.3 acceptance criteria)",
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
      phash: string;
    }): Promise<string> {
      const [row] = await db!
        .insert(schema.submissions)
        .values({
          campaignId: params.campaignId,
          playerId: params.playerId,
          targetId: params.targetId,
          photoUrl: `https://example.com/photos/${randomUUID()}.jpg`,
          deviceGps: "POINT(-123.8 46.9)",
          phash: params.phash,
        })
        .returning({ id: schema.submissions.id });
      return row.id;
    }

    it("flags: same flier photo reused on a different target (cross-campaign included)", async () => {
      const seed = await seedTwoCampaigns(db!);
      const photo = await renderFlierPhoto(SEED_PLACEMENTS[0]);
      const hash = await computePhash(photo);

      // Prior submission on campaign A's first target.
      await insertSubmission({
        campaignId: seed.campaignA.campaignId,
        playerId: seed.campaignA.playerId,
        targetId: seed.campaignA.targetIds[0],
        phash: hash,
      });

      // The *same* photo, re-encoded (re-uploaded), attributed to a
      // different target in a *different* campaign.
      const reused = await reencodePhoto(photo);
      const reusedHash = await computePhash(reused);

      const result = await checkDuplicate({
        targetId: seed.campaignB.targetIds[0],
        phash: reusedHash,
      });

      expect(result.check).toBe("duplicate");
      expect(result.passed).toBe(false);
      expect(result.detail).toContain(seed.campaignA.targetIds[0]);
    });

    it("does NOT flag: visually-distinct photos of the same flier at different targets", async () => {
      const seed = await seedTwoCampaigns(db!);

      // Seed every placement except the last as prior submissions spread
      // across both campaigns' targets (alternating A/B, cycling through
      // each campaign's own 3 targets — never a cross-campaign target id).
      const priorPlacements = SEED_PLACEMENTS.slice(0, -1);
      for (let i = 0; i < priorPlacements.length; i++) {
        const photo = await renderFlierPhoto(priorPlacements[i]);
        const hash = await computePhash(photo);
        const campaign = i % 2 === 0 ? seed.campaignA : seed.campaignB;
        const targetId = campaign.targetIds[Math.floor(i / 2) % 3];
        await insertSubmission({
          campaignId: campaign.campaignId,
          playerId: campaign.playerId,
          targetId,
          phash: hash,
        });
      }

      // A genuinely new, independently-"photographed" placement of the
      // identical flier, submitted against a target none of the priors used.
      const freshPhoto = await renderFlierPhoto(
        SEED_PLACEMENTS[SEED_PLACEMENTS.length - 1],
      );
      const freshHash = await computePhash(freshPhoto);

      const result = await checkDuplicate({
        targetId: seed.campaignA.targetIds[2],
        phash: freshHash,
      });

      expect(result.check).toBe("duplicate");
      expect(result.passed).toBe(true);
    });

    it("does NOT flag: a near-identical resubmission to the SAME target", async () => {
      const seed = await seedTwoCampaigns(db!);
      const photo = await renderFlierPhoto(SEED_PLACEMENTS[0]);
      const hash = await computePhash(photo);
      const targetId = seed.campaignA.targetIds[0];

      await insertSubmission({
        campaignId: seed.campaignA.campaignId,
        playerId: seed.campaignA.playerId,
        targetId,
        phash: hash,
      });

      // Same photo file, re-encoded, resubmitted to the SAME target (e.g. a
      // retry after a rejected first attempt) — hash distance is well
      // within the flag threshold, but the different-target gate must
      // still suppress it.
      const resubmission = await reencodePhoto(photo);
      const resubmissionHash = await computePhash(resubmission);
      expect(hammingDistance(hash, resubmissionHash)).toBeLessThanOrEqual(
        DUPLICATE_HASH_THRESHOLD,
      );

      const result = await checkDuplicate({
        targetId,
        phash: resubmissionHash,
      });

      expect(result.check).toBe("duplicate");
      expect(result.passed).toBe(true);
    });

    it("excludes a submission from matching against itself when re-checked", async () => {
      const seed = await seedTwoCampaigns(db!);
      const photo = await renderFlierPhoto(SEED_PLACEMENTS[0]);
      const hash = await computePhash(photo);
      const targetId = seed.campaignA.targetIds[0];

      const submissionId = await insertSubmission({
        campaignId: seed.campaignA.campaignId,
        playerId: seed.campaignA.playerId,
        targetId,
        phash: hash,
      });

      const result = await checkDuplicate({
        submissionId,
        targetId,
        phash: hash,
      });

      expect(result.passed).toBe(true);
    });

    it("persists the phash on the submission record for future comparisons", async () => {
      const seed = await seedTwoCampaigns(db!);
      const photo = await renderFlierPhoto(SEED_PLACEMENTS[0]);
      const hash = await computePhash(photo);

      const submissionId = await insertSubmission({
        campaignId: seed.campaignA.campaignId,
        playerId: seed.campaignA.playerId,
        targetId: seed.campaignA.targetIds[0],
        phash: hash,
      });

      const [row] = await db!
        .select({ phash: schema.submissions.phash })
        .from(schema.submissions)
        .where(eq(schema.submissions.id, submissionId));
      expect(row.phash).toBe(hash);
    });
  },
);
