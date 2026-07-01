/**
 * Admin target import suite (T4.5) — PRD FR-M1.
 *
 * Two altitudes in one file, same pattern as
 * `tests/host/review-queue.test.ts`:
 * - `parseTargetsCsv` — a pure function, always runs (no DB needed).
 * - `importTargetsFromCsv` / `createPinDropTarget` — exercised against a
 *   real two-campaign PostGIS fixture (`tests/fixtures/seed-two-
 *   campaigns.ts`), same fixture/skip pattern as
 *   `tests/isolation/isolation.test.ts`. Skips (rather than fails) when
 *   `DATABASE_URL` isn't configured.
 *
 * The route (`app/api/admin/campaigns/[id]/targets/import/route.ts`) is a
 * thin translator over these two functions — same `ForbiddenError` ->
 * `403`/typed-error -> HTTP-status translation every other admin/host
 * route in this codebase already uses (see e.g.
 * `app/api/admin/campaigns/route.ts`), so this suite proves the 403/
 * validation semantics at the `lib/` layer rather than re-mocking the
 * whole HTTP stack just to re-prove that translation again.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, getTestDb, hasTestDatabase, resetTestDb } from "../setup";
import {
  seedTwoCampaigns,
  type SeedTwoCampaignsResult,
} from "../fixtures/seed-two-campaigns";
import { ForbiddenError } from "@/lib/auth/guards";
import type { StaffPrincipal } from "@/lib/auth/staff";
import {
  InvalidImportInputError,
  createPinDropTarget,
  importTargetsFromCsv,
  parseTargetsCsv,
} from "@/lib/target/csv-import";
import { listTargets } from "@/lib/db/dal/targets";
import { listMapPins } from "@/lib/campaign/map";

function siteAdmin(): StaffPrincipal {
  return { userId: "admin-1", type: "site_admin", scopedCampaignIds: [] };
}

function hostFor(campaignId: string): StaffPrincipal {
  return { userId: "host-1", type: "host", scopedCampaignIds: [campaignId] };
}

describe("parseTargetsCsv", () => {
  it("parses valid label,lat,long rows, skipping an optional header", () => {
    const { rows, errors } = parseTargetsCsv(
      "label,lat,long\nTarget A,46.90,-123.80\nTarget B,45.00,-122.00",
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { label: "Target A", lat: 46.9, long: -123.8 },
      { label: "Target B", lat: 45.0, long: -122.0 },
    ]);
  });

  it("reports malformed/out-of-range rows individually, without dropping them silently", () => {
    const { rows, errors } = parseTargetsCsv(
      [
        "Good One,46.90,-123.80",
        "Missing Field,46.90",
        "Bad Lat,999,-123.80",
        "Not Numbers,abc,def",
        "",
        "Good Two,45.00,-122.00",
      ].join("\n"),
    );

    expect(rows).toEqual([
      { label: "Good One", lat: 46.9, long: -123.8 },
      { label: "Good Two", lat: 45.0, long: -122.0 },
    ]);
    expect(errors).toHaveLength(3);
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4]);
    expect(errors[0].reason).toMatch(/expected 3 fields/);
    expect(errors[1].reason).toMatch(/out of range/);
    expect(errors[2].reason).toMatch(/must be numbers/);
  });

  it("treats a header-less CSV's first data row as a row, not a header", () => {
    const { rows, errors } = parseTargetsCsv("Solo Spot,46.90,-123.80");
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ label: "Solo Spot", lat: 46.9, long: -123.8 }]);
  });
});

describe.skipIf(!hasTestDatabase())(
  "admin target import (T4.5, live PostGIS DB)",
  () => {
    const db = hasTestDatabase() ? getTestDb() : undefined;
    let seed: SeedTwoCampaignsResult;

    beforeEach(async () => {
      await resetTestDb(db!);
      seed = await seedTwoCampaigns(db!);
    });

    afterAll(async () => {
      await closeTestDb();
    });

    it("a valid CSV creates the expected red targets scoped to the campaign", async () => {
      const csv =
        "label,lat,long\nFlier Spot 1,46.90,-123.80\nFlier Spot 2,46.91,-123.81";

      const report = await importTargetsFromCsv(
        siteAdmin(),
        seed.campaignA.campaignId,
        csv,
      );

      expect(report.errors).toEqual([]);
      expect(report.created).toHaveLength(2);
      for (const target of report.created) {
        expect(target.campaignId).toBe(seed.campaignA.campaignId);
        expect(target.state).toBe("red");
      }

      const campaignATargets = await listTargets(seed.campaignA.campaignId);
      expect(campaignATargets.map((t) => t.label)).toEqual(
        expect.arrayContaining(["Flier Spot 1", "Flier Spot 2"]),
      );

      // Tenant isolation: never leaks into campaign B.
      const campaignBTargets = await listTargets(seed.campaignB.campaignId);
      expect(
        campaignBTargets.some((t) => t.label.startsWith("Flier Spot")),
      ).toBe(false);

      // AC 5: imported targets appear on the campaign map (the exact read
      // `components/map/CampaignMap.tsx` polls via `listMapPins`).
      const pins = await listMapPins(
        { type: "staff", staff: siteAdmin() },
        seed.campaignA.campaignId,
      );
      const pinLabels = pins.map((p) => p.label);
      expect(pinLabels).toEqual(
        expect.arrayContaining(["Flier Spot 1", "Flier Spot 2"]),
      );
      for (const pin of pins) {
        if (pin.label.startsWith("Flier Spot")) {
          expect(pin.state).toBe("red");
        }
      }
    });

    it("malformed rows / out-of-range coords are rejected with a report, not silently dropped", async () => {
      const csv = [
        "label,lat,long",
        "Valid Spot,46.90,-123.80",
        "Bad Lat,999,-123.80",
        "Missing Field,46.90",
      ].join("\n");

      const before = await listTargets(seed.campaignA.campaignId);
      const report = await importTargetsFromCsv(
        siteAdmin(),
        seed.campaignA.campaignId,
        csv,
      );

      expect(report.created).toHaveLength(1);
      expect(report.created[0].label).toBe("Valid Spot");
      expect(report.errors).toHaveLength(2);
      expect(report.errors.map((e) => e.line)).toEqual([3, 4]);

      const after = await listTargets(seed.campaignA.campaignId);
      expect(after).toHaveLength(before.length + 1);
      expect(after.some((t) => t.label === "Bad Lat")).toBe(false);
      expect(after.some((t) => t.label === "Missing Field")).toBe(false);
    });

    it("a pin-drop creates one red target at the chosen coordinates", async () => {
      const before = await listTargets(seed.campaignA.campaignId);

      const target = await createPinDropTarget(
        siteAdmin(),
        seed.campaignA.campaignId,
        { label: "Dropped Pin", lat: 46.895, long: -123.805 },
      );

      expect(target.campaignId).toBe(seed.campaignA.campaignId);
      expect(target.state).toBe("red");
      expect(target.lat).toBeCloseTo(46.895, 5);
      expect(target.long).toBeCloseTo(-123.805, 5);

      const after = await listTargets(seed.campaignA.campaignId);
      expect(after).toHaveLength(before.length + 1);
    });

    it("rejects an out-of-range pin-drop coordinate without creating a target", async () => {
      const before = await listTargets(seed.campaignA.campaignId);

      await expect(
        createPinDropTarget(siteAdmin(), seed.campaignA.campaignId, {
          label: "Bad Pin",
          lat: 999,
          long: 0,
        }),
      ).rejects.toThrow(InvalidImportInputError);

      const after = await listTargets(seed.campaignA.campaignId);
      expect(after).toHaveLength(before.length);
    });

    it("denies a host (non-site-admin) principal on both import paths (403)", async () => {
      const host = hostFor(seed.campaignA.campaignId);

      await expect(
        importTargetsFromCsv(
          host,
          seed.campaignA.campaignId,
          "label,lat,long\nHost CSV,1,1",
        ),
      ).rejects.toThrow(ForbiddenError);
      await expect(
        createPinDropTarget(host, seed.campaignA.campaignId, {
          label: "Host Pin",
          lat: 1,
          long: 1,
        }),
      ).rejects.toThrow(ForbiddenError);

      const targets = await listTargets(seed.campaignA.campaignId);
      expect(targets.some((t) => t.label === "Host CSV")).toBe(false);
      expect(targets.some((t) => t.label === "Host Pin")).toBe(false);
    });
  },
);
