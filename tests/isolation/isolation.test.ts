/**
 * Tenant-isolation suite (T2.1) — the Batch 2 review gate.
 *
 * PRD G-6 / constitution §5: "automated tests assert no host reads another
 * campaign's data and no spend crosses budgets." This suite exercises the
 * DAL built for T2.1 (`lib/db/dal/*`) against the real two-campaign fixture
 * (T1.4) on a live PostGIS database, plus a type/runtime-level check that
 * the DAL's isolation contract (every scoped export requires `campaignId`
 * as its first parameter — see
 * `docs/decisions/0001-tenant-isolation-enforcement.md`) actually holds for
 * every current export, not just the ones this file happens to exercise.
 *
 * Skips (rather than fails) when `DATABASE_URL` isn't configured, matching
 * the pattern in `tests/fixtures/seed-two-campaigns.test.ts`.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
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

import * as campaignsDal from "@/lib/db/dal/campaigns";
import * as targetsDal from "@/lib/db/dal/targets";
import * as submissionsDal from "@/lib/db/dal/submissions";
import * as membershipsDal from "@/lib/db/dal/campaign-memberships";
import * as ledgerDal from "@/lib/db/dal/payout-ledger";
import * as universalMapDal from "@/lib/db/dal/universal-map";

/** Amounts (integer cents) seeded into each campaign's ledger below. Chosen
 * to be distinct so a budget-bleed bug (reading the wrong campaign's rows)
 * would produce a visibly wrong total, not one that happens to match by
 * coincidence. */
const CAMPAIGN_A_LEDGER_AMOUNTS = [200, 300]; // sums to 500
const CAMPAIGN_B_LEDGER_AMOUNTS = [400, 500]; // sums to 900

async function insertSubmission(
  db: TestDb,
  campaign: SeededCampaign,
): Promise<string> {
  const [row] = await db
    .insert(schema.submissions)
    .values({
      campaignId: campaign.campaignId,
      playerId: campaign.playerId,
      targetId: campaign.targetIds[0],
      photoUrl: `https://example.com/photos/${campaign.campaignId}.jpg`,
      deviceGps: "POINT(-123.8 46.9)",
      phash: "f".repeat(16),
    })
    .returning({ id: schema.submissions.id });
  return row.id;
}

/** Seeds one submission and two ledger entries per campaign — the isolation
 * suite's substrate for the submissions/ledger/budget assertions. The
 * fixture (T1.4) only seeds campaigns/hosts/players/targets/memberships. */
async function seedSubmissionsAndLedger(
  db: TestDb,
  seed: SeedTwoCampaignsResult,
): Promise<void> {
  const submissionA = await insertSubmission(db, seed.campaignA);
  const submissionB = await insertSubmission(db, seed.campaignB);

  let cumulativeA = 0;
  const ledgerA = CAMPAIGN_A_LEDGER_AMOUNTS.map((amount) => {
    cumulativeA += amount;
    return {
      campaignId: seed.campaignA.campaignId,
      submissionId: submissionA,
      playerId: seed.campaignA.playerId,
      amount,
      tierAtTime: 1,
      cumulativeCommitted: cumulativeA,
    };
  });

  let cumulativeB = 0;
  const ledgerB = CAMPAIGN_B_LEDGER_AMOUNTS.map((amount) => {
    cumulativeB += amount;
    return {
      campaignId: seed.campaignB.campaignId,
      submissionId: submissionB,
      playerId: seed.campaignB.playerId,
      amount,
      tierAtTime: 1,
      cumulativeCommitted: cumulativeB,
    };
  });

  await db.insert(schema.payoutLedger).values([...ledgerA, ...ledgerB]);
}

describe.skipIf(!hasTestDatabase())(
  "tenant isolation (T2.1 review gate)",
  () => {
    const db = hasTestDatabase() ? getTestDb() : undefined;
    let seed: SeedTwoCampaignsResult;

    beforeEach(async () => {
      await resetTestDb(db!);
      seed = await seedTwoCampaigns(db!);
      await seedSubmissionsAndLedger(db!, seed);
    });

    afterAll(async () => {
      await closeTestDb();
    });

    describe("scoped reads never cross campaigns", () => {
      it("targets: campaign A's read returns only A's targets", async () => {
        const rows = await targetsDal.listTargets(seed.campaignA.campaignId);
        expect(rows.length).toBe(seed.campaignA.targetIds.length);
        expect(
          rows.every((t) => t.campaignId === seed.campaignA.campaignId),
        ).toBe(true);
        const bTargetIds = new Set(seed.campaignB.targetIds);
        expect(rows.some((t) => bTargetIds.has(t.id))).toBe(false);
      });

      it("targets: campaign B's read returns only B's targets", async () => {
        const rows = await targetsDal.listTargets(seed.campaignB.campaignId);
        expect(rows.length).toBe(seed.campaignB.targetIds.length);
        expect(
          rows.every((t) => t.campaignId === seed.campaignB.campaignId),
        ).toBe(true);
        const aTargetIds = new Set(seed.campaignA.targetIds);
        expect(rows.some((t) => aTargetIds.has(t.id))).toBe(false);
      });

      it("getTarget returns null for a target that exists, but in another campaign", async () => {
        const crossRead = await targetsDal.getTarget(
          seed.campaignA.campaignId,
          seed.campaignB.targetIds[0],
        );
        expect(crossRead).toBeNull();
      });

      it("submissions: each campaign's read returns only its own rows", async () => {
        const rowsA = await submissionsDal.listSubmissions(
          seed.campaignA.campaignId,
        );
        const rowsB = await submissionsDal.listSubmissions(
          seed.campaignB.campaignId,
        );
        expect(rowsA).toHaveLength(1);
        expect(rowsB).toHaveLength(1);
        expect(
          rowsA.every((s) => s.campaignId === seed.campaignA.campaignId),
        ).toBe(true);
        expect(rowsA[0].id).not.toBe(rowsB[0].id);
        expect(rowsA[0].deviceGps).toEqual({ lat: 46.9, long: -123.8 });
      });

      it("campaign memberships: each campaign's read returns only its own player", async () => {
        const rowsA = await membershipsDal.listMemberships(
          seed.campaignA.campaignId,
        );
        expect(rowsA).toHaveLength(1);
        expect(rowsA[0].campaignId).toBe(seed.campaignA.campaignId);
        expect(rowsA[0].playerId).toBe(seed.campaignA.playerId);
        expect(rowsA.some((m) => m.playerId === seed.campaignB.playerId)).toBe(
          false,
        );

        const crossRead = await membershipsDal.getMembership(
          seed.campaignA.campaignId,
          seed.campaignB.playerId,
        );
        expect(crossRead).toBeNull();
      });

      it("payout ledger: each campaign's read returns only its own entries", async () => {
        const rowsA = await ledgerDal.listLedgerEntries(
          seed.campaignA.campaignId,
        );
        const rowsB = await ledgerDal.listLedgerEntries(
          seed.campaignB.campaignId,
        );
        expect(rowsA).toHaveLength(CAMPAIGN_A_LEDGER_AMOUNTS.length);
        expect(rowsB).toHaveLength(CAMPAIGN_B_LEDGER_AMOUNTS.length);
        expect(
          rowsA.every((l) => l.campaignId === seed.campaignA.campaignId),
        ).toBe(true);
      });
    });

    describe("budget computation ignores other campaigns' ledger rows", () => {
      it("campaign A's cumulative committed total is unaffected by campaign B's ledger", async () => {
        const committedA = await ledgerDal.getCumulativeCommittedCents(
          seed.campaignA.campaignId,
        );
        const committedB = await ledgerDal.getCumulativeCommittedCents(
          seed.campaignB.campaignId,
        );

        const expectedA = CAMPAIGN_A_LEDGER_AMOUNTS.reduce((a, b) => a + b, 0);
        const expectedB = CAMPAIGN_B_LEDGER_AMOUNTS.reduce((a, b) => a + b, 0);

        expect(committedA).toBe(expectedA);
        expect(committedB).toBe(expectedB);
        // The two totals are deliberately different amounts (500 vs 900) —
        // if A's computation ever bled in B's rows, this assertion (not just
        // "some value came back") would catch it.
        expect(committedA).not.toBe(committedB);
      });
    });

    describe("universal map: the one sanctioned cross-campaign read", () => {
      it("returns pins from both campaigns", async () => {
        const pins = await universalMapDal.getPublicPinsAcrossLiveCampaigns();
        const campaignIds = new Set(pins.map((p) => p.campaignId));
        expect(campaignIds.has(seed.campaignA.campaignId)).toBe(true);
        expect(campaignIds.has(seed.campaignB.campaignId)).toBe(true);
        expect(pins.length).toBe(
          seed.campaignA.targetIds.length + seed.campaignB.targetIds.length,
        );
      });

      it("exposes only public-safe fields — no player/host identity, no ledger/budget data", async () => {
        const pins = await universalMapDal.getPublicPinsAcrossLiveCampaigns();
        expect(pins.length).toBeGreaterThan(0);
        for (const pin of pins) {
          expect(Object.keys(pin).sort()).toEqual(
            ["campaignId", "id", "lat", "long", "photoUrl", "state"].sort(),
          );
        }
      });
    });

    describe("DAL typed surface: every campaign-scoped export requires campaignId", () => {
      const scopedModules: Record<string, Record<string, unknown>> = {
        campaigns: campaignsDal,
        targets: targetsDal,
        submissions: submissionsDal,
        campaignMemberships: membershipsDal,
        payoutLedger: ledgerDal,
      };

      for (const [moduleName, mod] of Object.entries(scopedModules)) {
        for (const [fnName, fn] of Object.entries(mod)) {
          if (typeof fn !== "function") continue;

          it(`${moduleName}.${fnName} declares a required first parameter`, () => {
            // Function.length counts parameters before the first one with a
            // default value. None of these functions default `campaignId`,
            // so an arity of 0 here would mean the "required first
            // parameter" contract has been silently dropped from this
            // function's signature.
            expect(fn.length).toBeGreaterThanOrEqual(1);
          });

          it(`${moduleName}.${fnName} throws at runtime when campaignId is missing`, async () => {
            const call = fn as (...args: unknown[]) => unknown;
            await expect(
              Promise.resolve().then(() => call(undefined)),
            ).rejects.toThrow(/campaignId/i);
          });
        }
      }

      it("the universal-map module is the sole, explicitly-named exception", () => {
        expect(Object.keys(universalMapDal)).toEqual([
          "getPublicPinsAcrossLiveCampaigns",
        ]);
        expect(universalMapDal.getPublicPinsAcrossLiveCampaigns.length).toBe(0);
      });
    });
  },
);
