/**
 * Per-campaign map domain-logic suite (T4.4) — PRD FR-M2, FR-M3, FR-M4,
 * FR-M7.
 *
 * Exercises `lib/campaign/map.ts` against a real PostGIS test database,
 * same pattern as `tests/isolation/isolation.test.ts`/
 * `tests/host/review-queue.test.ts`: the two-campaign fixture (T1.4) is
 * the substrate for the isolation assertions (`listMapPins`/
 * `getTargetDetail` never leak campaign B's rows into a caller scoped to
 * campaign A), plus the privacy-gating matrix (card requirement 3) and
 * the red/amber/green shape (card requirements 1/4).
 *
 * `lib/storage/r2.ts`'s `createSignedGetUrl` is mocked (same pattern
 * `tests/host/review-queue.test.ts` uses) — this suite doesn't need a
 * live R2/MinIO endpoint to prove the map's own logic. Skips (rather than
 * fails) when `DATABASE_URL` isn't configured.
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
import {
  CampaignNotFoundError,
  getTargetDetail,
  listMapPins,
  type MapPrincipal,
} from "@/lib/campaign/map";
import { TargetNotFoundError } from "@/lib/target/state-machine";

/** A player identity, resolved per-test to a real seeded player id, see
 * usages below. `MapPrincipal`'s player variant now carries `playerId`
 * (batch-4 review fix, Liotta): `getTargetDetail`'s photo/GPS membership
 * gate needs a real identity to check, not just "some player." */
function playerPrincipal(playerId: string): MapPrincipal {
  return { type: "player", playerId };
}

function staffFor(campaignId: string): MapPrincipal {
  const staff: StaffPrincipal = {
    userId: "00000000-0000-0000-0000-0000000000bb",
    type: "host",
    scopedCampaignIds: [campaignId],
  };
  return { type: "staff", staff };
}

function siteAdmin(): MapPrincipal {
  const staff: StaffPrincipal = {
    userId: "00000000-0000-0000-0000-0000000000cc",
    type: "site_admin",
    scopedCampaignIds: [],
  };
  return { type: "staff", staff };
}

/** Marks `campaign.targetIds[targetIndex]` `green`, filled by a freshly
 * inserted submission for `campaign.playerId` — direct schema writes
 * (test-only; app code must go through the DAL/state machine per
 * constitution §3/§6) so this suite can set up a filled pin without
 * driving the whole claim->submit->approve flow. */
async function fillTarget(
  db: TestDb,
  campaign: SeededCampaign,
  targetIndex: number,
): Promise<string> {
  const [submission] = await db
    .insert(schema.submissions)
    .values({
      campaignId: campaign.campaignId,
      playerId: campaign.playerId,
      targetId: campaign.targetIds[targetIndex],
      photoUrl: `${campaign.campaignId}/${campaign.targetIds[targetIndex]}.jpg`,
      deviceGps: "POINT(-123.8 46.9)",
      phash: "a".repeat(16),
      decision: "approved",
    })
    .returning({ id: schema.submissions.id });

  await db
    .update(schema.targets)
    .set({ state: "green", filledBySubmissionId: submission.id })
    .where(eq(schema.targets.id, campaign.targetIds[targetIndex]));

  return submission.id;
}

async function setPrivacy(
  db: TestDb,
  campaignId: string,
  privacySetting: "public_username" | "admin_only",
): Promise<void> {
  await db
    .update(schema.campaigns)
    .set({ privacySetting })
    .where(eq(schema.campaigns.id, campaignId));
}

describe.skipIf(!hasTestDatabase())("lib/campaign/map.ts", () => {
  let db: TestDb;
  let seed: SeedTwoCampaignsResult;

  beforeEach(async () => {
    db = getTestDb();
    await resetTestDb(db);
    seed = await seedTwoCampaigns(db);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  describe("listMapPins", () => {
    it("lists only campaignId's own targets, never another campaign's (isolation)", async () => {
      const pins = await listMapPins(
        playerPrincipal(seed.campaignA.playerId),
        seed.campaignA.campaignId,
      );
      expect(pins).toHaveLength(seed.campaignA.targetIds.length);
      expect(pins.map((p) => p.id).sort()).toEqual(
        [...seed.campaignA.targetIds].sort(),
      );
      // None of Campaign B's target ids ever appear.
      for (const pin of pins) {
        expect(seed.campaignB.targetIds).not.toContain(pin.id);
      }
    });

    it("returns only id/label/lat/long/state — no claimedBy/claimExpiresAt", async () => {
      const pins = await listMapPins(
        playerPrincipal(seed.campaignA.playerId),
        seed.campaignA.campaignId,
      );
      for (const pin of pins) {
        expect(Object.keys(pin).sort()).toEqual(
          ["id", "label", "lat", "long", "state"].sort(),
        );
      }
    });

    it("colors pins by target state (requirement 1)", async () => {
      await fillTarget(db, seed.campaignA, 0);
      const pins = await listMapPins(
        playerPrincipal(seed.campaignA.playerId),
        seed.campaignA.campaignId,
      );
      const filled = pins.find((p) => p.id === seed.campaignA.targetIds[0]);
      const untouched = pins.find((p) => p.id === seed.campaignA.targetIds[1]);
      expect(filled?.state).toBe("green");
      expect(untouched?.state).toBe("red");
    });

    it("allows any authenticated player to view any campaign's map", async () => {
      await expect(
        listMapPins(
          playerPrincipal(seed.campaignA.playerId),
          seed.campaignB.campaignId,
        ),
      ).resolves.toHaveLength(seed.campaignB.targetIds.length);
    });

    it("allows a scoped host to view its own campaign", async () => {
      await expect(
        listMapPins(
          staffFor(seed.campaignA.campaignId),
          seed.campaignA.campaignId,
        ),
      ).resolves.toHaveLength(seed.campaignA.targetIds.length);
    });

    it("denies a host scoped to a different campaign", async () => {
      await expect(
        listMapPins(
          staffFor(seed.campaignB.campaignId),
          seed.campaignA.campaignId,
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("allows a site admin to view any campaign", async () => {
      await expect(
        listMapPins(siteAdmin(), seed.campaignB.campaignId),
      ).resolves.toHaveLength(seed.campaignB.targetIds.length);
    });

    it("throws CampaignNotFoundError for an unknown campaign id", async () => {
      await expect(
        listMapPins(
          playerPrincipal(seed.campaignA.playerId),
          "00000000-0000-0000-0000-000000000000",
        ),
      ).rejects.toBeInstanceOf(CampaignNotFoundError);
    });
  });

  describe("getTargetDetail", () => {
    it("returns an informational, detail-free view for a red pin (requirement 4)", async () => {
      const detail = await getTargetDetail(
        playerPrincipal(seed.campaignA.playerId),
        seed.campaignA.campaignId,
        seed.campaignA.targetIds[0],
      );
      expect(detail.state).toBe("red");
      expect(detail.photoUrl).toBeNull();
      expect(detail.submissionGps).toBeNull();
      expect(detail.username).toBeNull();
    });

    it("returns an informational, detail-free view for an amber pin (requirement 4)", async () => {
      await db
        .update(schema.targets)
        .set({ state: "amber", claimedBy: seed.campaignA.playerId })
        .where(eq(schema.targets.id, seed.campaignA.targetIds[0]));

      const detail = await getTargetDetail(
        playerPrincipal(seed.campaignA.playerId),
        seed.campaignA.campaignId,
        seed.campaignA.targetIds[0],
      );
      expect(detail.state).toBe("amber");
      expect(detail.photoUrl).toBeNull();
      expect(detail.username).toBeNull();
    });

    it("hides the canvasser's username from a player when privacy is admin_only (default)", async () => {
      await setPrivacy(db, seed.campaignA.campaignId, "admin_only");
      await fillTarget(db, seed.campaignA, 0);

      const detail = await getTargetDetail(
        playerPrincipal(seed.campaignA.playerId),
        seed.campaignA.campaignId,
        seed.campaignA.targetIds[0],
      );
      expect(detail.state).toBe("green");
      expect(detail.photoUrl).toBe("https://example.com/signed-get");
      expect(detail.submissionGps).toEqual({ lat: 46.9, long: -123.8 });
      expect(detail.username).toBeNull();
    });

    it("hides a filled pin's photo and GPS from a player who is NOT a member of this campaign (batch-4 review fix, Liotta)", async () => {
      // Regression test: any authenticated player could previously read
      // ANY campaign's green-pin photo + canvasser device GPS by id,
      // regardless of membership; only `username` was privacy-gated.
      await setPrivacy(db, seed.campaignA.campaignId, "admin_only");
      await fillTarget(db, seed.campaignA, 0);

      // seed.campaignB.playerId is a member of Campaign B, NOT Campaign A.
      const detail = await getTargetDetail(
        playerPrincipal(seed.campaignB.playerId),
        seed.campaignA.campaignId,
        seed.campaignA.targetIds[0],
      );
      expect(detail.state).toBe("green");
      expect(detail.photoUrl).toBeNull();
      expect(detail.submissionGps).toBeNull();
      expect(detail.username).toBeNull();
    });

    it("still hides a non-member's photo/GPS even when privacySetting is public_username (membership gate is independent of the username gate)", async () => {
      await setPrivacy(db, seed.campaignA.campaignId, "public_username");
      await fillTarget(db, seed.campaignA, 0);

      const detail = await getTargetDetail(
        playerPrincipal(seed.campaignB.playerId),
        seed.campaignA.campaignId,
        seed.campaignA.targetIds[0],
      );
      expect(detail.photoUrl).toBeNull();
      expect(detail.submissionGps).toBeNull();
      // Username's own, independent gate is unaffected by this fix.
      expect(detail.username).toBe("campaign-a-player@example.com");
    });

    it("shows a filled pin's photo and GPS to a player who IS a member of this campaign", async () => {
      await fillTarget(db, seed.campaignA, 0);

      const detail = await getTargetDetail(
        playerPrincipal(seed.campaignA.playerId),
        seed.campaignA.campaignId,
        seed.campaignA.targetIds[0],
      );
      expect(detail.photoUrl).toBe("https://example.com/signed-get");
      expect(detail.submissionGps).toEqual({ lat: 46.9, long: -123.8 });
    });

    it("shows the canvasser's username to a player when privacy is public_username", async () => {
      await setPrivacy(db, seed.campaignA.campaignId, "public_username");
      await fillTarget(db, seed.campaignA, 0);

      const detail = await getTargetDetail(
        playerPrincipal(seed.campaignA.playerId),
        seed.campaignA.campaignId,
        seed.campaignA.targetIds[0],
      );
      expect(detail.username).toBe("campaign-a-player@example.com");
    });

    it("always shows the canvasser's username to staff, regardless of privacy setting", async () => {
      await setPrivacy(db, seed.campaignA.campaignId, "admin_only");
      await fillTarget(db, seed.campaignA, 0);

      const detail = await getTargetDetail(
        staffFor(seed.campaignA.campaignId),
        seed.campaignA.campaignId,
        seed.campaignA.targetIds[0],
      );
      expect(detail.username).toBe("campaign-a-player@example.com");
    });

    it("denies a host scoped to a different campaign", async () => {
      await expect(
        getTargetDetail(
          staffFor(seed.campaignB.campaignId),
          seed.campaignA.campaignId,
          seed.campaignA.targetIds[0],
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("throws TargetNotFoundError for a target belonging to another campaign", async () => {
      await expect(
        getTargetDetail(
          playerPrincipal(seed.campaignA.playerId),
          seed.campaignA.campaignId,
          seed.campaignB.targetIds[0],
        ),
      ).rejects.toBeInstanceOf(TargetNotFoundError);
    });

    it("throws CampaignNotFoundError for an unknown campaign id", async () => {
      await expect(
        getTargetDetail(
          playerPrincipal(seed.campaignA.playerId),
          "00000000-0000-0000-0000-000000000000",
          seed.campaignA.targetIds[0],
        ),
      ).rejects.toBeInstanceOf(CampaignNotFoundError);
    });
  });
});
