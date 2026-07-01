import { expect, test } from "@playwright/test";

/**
 * Universal aggregate map e2e (T5.2) — PRD FR-L2, FR-L3, FR-L4 / EC-4.
 *
 * `components/map/UniversalMap.tsx` is a pure, public (no-auth) client
 * component: it never reads the DB directly, only via `fetch` to
 * `/api/public/pins`. This sandbox has no `NEXT_PUBLIC_MAPBOX_TOKEN`
 * configured (`.env.example` leaves it blank — see `docs/deploy.md`), so
 * every run here exercises the no-Mapbox `PinFallbackList` fallback
 * (same reasoning as `tests/e2e/campaign-map.spec.ts` for T4.4's
 * component) — the exact same tap/select logic the real clustered
 * Mapbox layer would drive, on a plain DOM button list instead of a
 * WebGL canvas. The real Mapbox clustering/rendering behavior needs a
 * live token + WebGL and is marked unverified-here in the task's build
 * report.
 */

interface Pin {
  campaignId: string;
  campaignName: string;
  id: string;
  state: "red" | "amber" | "green";
  lat: number;
  long: number;
  photoUrl: string | null;
}

const CAMPAIGN_A = "campaign-a";
const CAMPAIGN_B = "campaign-b";

const PINS: Pin[] = [
  {
    campaignId: CAMPAIGN_A,
    campaignName: "Campaign A",
    id: "target-a-red",
    state: "red",
    lat: 46.9,
    long: -123.8,
    photoUrl: null,
  },
  {
    campaignId: CAMPAIGN_A,
    campaignName: "Campaign A",
    id: "target-a-green",
    state: "green",
    lat: 46.901,
    long: -123.801,
    photoUrl: "https://example.com/photos/target-a-green.jpg",
  },
  {
    campaignId: CAMPAIGN_B,
    campaignName: "Campaign B",
    id: "target-b-amber",
    state: "amber",
    lat: 47.0,
    long: -123.9,
    photoUrl: null,
  },
];

async function mockPins(page: import("@playwright/test").Page, pins: Pin[]) {
  await page.route("**/api/public/pins", async (route) => {
    await route.fulfill({ json: { pins } });
  });
}

test.describe("universal aggregate map", () => {
  test("renders pins from at least two live campaigns (EC-4)", async ({
    page,
  }) => {
    await mockPins(page, PINS);

    await page.goto("/map");

    const list = page.locator('[data-testid="universal-pin-fallback-list"]');
    await expect(list).toBeVisible();

    await expect(
      page.locator(`[data-testid="universal-map-pin-target-a-red"]`),
    ).toHaveAttribute("data-campaign-id", CAMPAIGN_A);
    await expect(
      page.locator(`[data-testid="universal-map-pin-target-b-amber"]`),
    ).toHaveAttribute("data-campaign-id", CAMPAIGN_B);
  });

  test("tapping a pin shows its campaign name + state, and routes into that campaign's map", async ({
    page,
  }) => {
    await mockPins(page, PINS);

    await page.goto("/map");
    await page
      .locator(`[data-testid="universal-map-pin-target-a-red"]`)
      .click();

    const panel = page.locator('[data-testid="universal-pin-detail-panel"]');
    await expect(panel).toBeVisible();
    await expect(
      panel.locator('[data-testid="universal-pin-detail-campaign-name"]'),
    ).toHaveText("Campaign A");
    await expect(
      panel.locator('[data-testid="universal-pin-detail-state"]'),
    ).toContainText("Open");

    await panel.locator('[data-testid="universal-pin-open-campaign"]').click();
    await expect(page).toHaveURL(`/campaigns/${CAMPAIGN_A}/map`);
  });

  test("a green pin's detail shows its photo but never a username", async ({
    page,
  }) => {
    await mockPins(page, PINS);

    await page.goto("/map");
    await page
      .locator(`[data-testid="universal-map-pin-target-a-green"]`)
      .click();

    const panel = page.locator('[data-testid="universal-pin-detail-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator("img")).toHaveAttribute(
      "src",
      "https://example.com/photos/target-a-green.jpg",
    );
    // Anti-requirement: no username/ledger/budget field is ever rendered
    // by this map — there is no such data in the response to begin with
    // (see lib/campaign/universal-map.ts's doc comment).
    await expect(panel.getByText(/username|balance|budget/i)).toHaveCount(0);
  });

  test("shows a clear message when the public pin feed can't be loaded", async ({
    page,
  }) => {
    await page.route("**/api/public/pins", async (route) => {
      await route.fulfill({
        status: 500,
        json: { error: { code: "internal", message: "Could not load." } },
      });
    });

    await page.goto("/map");

    await expect(
      page.locator('[data-testid="universal-map-load-error"]'),
    ).toBeVisible();
  });
});
