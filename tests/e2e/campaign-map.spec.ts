import { expect, test } from "@playwright/test";

/**
 * Per-campaign map e2e (T4.4) — PRD FR-M2, FR-M3, FR-M4, FR-M7.
 *
 * `components/map/CampaignMap.tsx` is a pure client component (mirrors
 * `tests/e2e/submit-flow.spec.ts`'s own reasoning for T4.1's capture
 * page): it never reads the DB/auth directly, only via `fetch` to
 * `/api/campaigns/[id]/targets(/[targetId](/claim)?)?`. This sandbox has
 * no `NEXT_PUBLIC_MAPBOX_TOKEN` configured (`.env.example` leaves it
 * blank — see `docs/deploy.md`), so every run here exercises the
 * no-Mapbox `PinFallbackList` fallback the component's own doc comment
 * describes: the *exact same* `handleTap`/`handleClaim` logic the real
 * Mapbox markers would drive, on a plain DOM button list instead of a
 * WebGL canvas. The actual Mapbox rendering (colored pins plotted on a
 * real basemap) needs a live token + WebGL and is marked unverified-here
 * in the task's build report.
 */

const CAMPAIGN_ID = "e2e-campaign";
const RED_ID = "target-red";
const AMBER_ID = "target-amber";
const GREEN_ID = "target-green";

interface Pin {
  id: string;
  label: string;
  lat: number;
  long: number;
  state: "red" | "amber" | "green";
}

const BASE_PINS: Pin[] = [
  { id: RED_ID, label: "Red Target", lat: 46.9, long: -123.8, state: "red" },
  {
    id: AMBER_ID,
    label: "Amber Target",
    lat: 46.901,
    long: -123.801,
    state: "amber",
  },
  {
    id: GREEN_ID,
    label: "Green Target",
    lat: 46.902,
    long: -123.802,
    state: "green",
  },
];

async function mockPins(
  page: import("@playwright/test").Page,
  pins: Pin[] = BASE_PINS,
) {
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}/targets`, async (route) => {
    await route.fulfill({ json: { pins } });
  });
}

test.describe("per-campaign map", () => {
  test("renders every pin, colored by state, via the fallback list", async ({
    page,
  }) => {
    await mockPins(page);

    await page.goto(`/campaigns/${CAMPAIGN_ID}/map`);

    const list = page.locator('[data-testid="pin-fallback-list"]');
    await expect(list).toBeVisible();

    await expect(
      page.locator(`[data-testid="map-pin-${RED_ID}"]`),
    ).toHaveAttribute("data-state", "red");
    await expect(
      page.locator(`[data-testid="map-pin-${AMBER_ID}"]`),
    ).toHaveAttribute("data-state", "amber");
    await expect(
      page.locator(`[data-testid="map-pin-${GREEN_ID}"]`),
    ).toHaveAttribute("data-state", "green");
  });

  test("tapping a red pin claims it and routes to the capture flow", async ({
    page,
  }) => {
    await mockPins(page);
    // Tapping a pin now opens its detail sheet (which fetches the target),
    // then the "Claim & post flier" button drives the claim → capture route.
    await page.route(
      `**/api/campaigns/${CAMPAIGN_ID}/targets/${RED_ID}`,
      async (route) => {
        await route.fulfill({
          json: {
            target: {
              id: RED_ID,
              label: "Red Target",
              lat: 46.9,
              long: -123.8,
              state: "red",
              photoUrl: null,
              submissionGps: null,
              username: null,
            },
          },
        });
      },
    );
    await page.route(
      `**/api/campaigns/${CAMPAIGN_ID}/targets/${RED_ID}/claim`,
      async (route) => {
        await route.fulfill({ json: { target: { id: RED_ID } } });
      },
    );

    await page.goto(`/campaigns/${CAMPAIGN_ID}/map`);
    await page.locator(`[data-testid="map-pin-${RED_ID}"]`).click();
    await page.locator('[data-testid="pin-claim-button"]').click();

    await expect(page).toHaveURL(`/campaigns/${CAMPAIGN_ID}/submit/${RED_ID}`);
  });

  test("shows a clear message when a claim loses the race (409)", async ({
    page,
  }) => {
    await mockPins(page);
    await page.route(
      `**/api/campaigns/${CAMPAIGN_ID}/targets/${RED_ID}`,
      async (route) => {
        await route.fulfill({
          json: {
            target: {
              id: RED_ID,
              label: "Red Target",
              lat: 46.9,
              long: -123.8,
              state: "red",
              photoUrl: null,
              submissionGps: null,
              username: null,
            },
          },
        });
      },
    );
    await page.route(
      `**/api/campaigns/${CAMPAIGN_ID}/targets/${RED_ID}/claim`,
      async (route) => {
        await route.fulfill({
          status: 409,
          json: { error: { code: "claim_conflict", message: "Taken." } },
        });
      },
    );

    await page.goto(`/campaigns/${CAMPAIGN_ID}/map`);
    await page.locator(`[data-testid="map-pin-${RED_ID}"]`).click();
    await page.locator('[data-testid="pin-claim-button"]').click();

    await expect(page.locator('[data-testid="map-banner"]')).toHaveText(
      "Someone else already claimed this target.",
    );
    // Requirement 2: no crash/navigation on a lost claim race.
    await expect(page).toHaveURL(`/campaigns/${CAMPAIGN_ID}/map`);
  });

  test("tapping an amber pin shows an informational, detail-free view", async ({
    page,
  }) => {
    await mockPins(page);
    await page.route(
      `**/api/campaigns/${CAMPAIGN_ID}/targets/${AMBER_ID}`,
      async (route) => {
        await route.fulfill({
          json: {
            target: {
              id: AMBER_ID,
              label: "Amber Target",
              lat: 46.901,
              long: -123.801,
              state: "amber",
              photoUrl: null,
              submissionGps: null,
              username: null,
            },
          },
        });
      },
    );

    await page.goto(`/campaigns/${CAMPAIGN_ID}/map`);
    await page.locator(`[data-testid="map-pin-${AMBER_ID}"]`).click();

    const panel = page.locator('[data-testid="pin-detail-panel"]');
    await expect(panel).toBeVisible();
    await expect(
      panel.locator('[data-testid="pin-detail-state"]'),
    ).toContainText("Claimed / pending");
    await expect(
      panel.locator('[data-testid="pin-detail-username"]'),
    ).toHaveCount(0);
  });

  test("tapping a green pin shows photo/GPS and hides the username under admin-only privacy", async ({
    page,
  }) => {
    await mockPins(page);
    await page.route(
      `**/api/campaigns/${CAMPAIGN_ID}/targets/${GREEN_ID}`,
      async (route) => {
        await route.fulfill({
          json: {
            target: {
              id: GREEN_ID,
              label: "Green Target",
              lat: 46.902,
              long: -123.802,
              state: "green",
              photoUrl: "https://example.com/signed-get.jpg",
              submissionGps: { lat: 46.9021, long: -123.8021 },
              username: null,
            },
          },
        });
      },
    );

    await page.goto(`/campaigns/${CAMPAIGN_ID}/map`);
    await page.locator(`[data-testid="map-pin-${GREEN_ID}"]`).click();

    const panel = page.locator('[data-testid="pin-detail-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator("img")).toHaveAttribute(
      "src",
      "https://example.com/signed-get.jpg",
    );
    await expect(panel.locator('[data-testid="pin-detail-gps"]')).toContainText(
      "46.90210",
    );
    // Requirement 3: privacy = admin-only hides the canvasser's identity
    // from a player.
    await expect(
      panel.locator('[data-testid="pin-detail-username"]'),
    ).toHaveText("Canvasser (hidden)");
  });

  test("shows the username on a green pin when privacy is public_username", async ({
    page,
  }) => {
    await mockPins(page);
    await page.route(
      `**/api/campaigns/${CAMPAIGN_ID}/targets/${GREEN_ID}`,
      async (route) => {
        await route.fulfill({
          json: {
            target: {
              id: GREEN_ID,
              label: "Green Target",
              lat: 46.902,
              long: -123.802,
              state: "green",
              photoUrl: "https://example.com/signed-get.jpg",
              submissionGps: { lat: 46.9021, long: -123.8021 },
              username: "+15550001111",
            },
          },
        });
      },
    );

    await page.goto(`/campaigns/${CAMPAIGN_ID}/map`);
    await page.locator(`[data-testid="map-pin-${GREEN_ID}"]`).click();

    await expect(
      page.locator('[data-testid="pin-detail-username"]'),
    ).toHaveText("+15550001111");
  });

  test("updates pin state via polling without a manual reload", async ({
    page,
  }) => {
    let callCount = 0;
    await page.route(
      `**/api/campaigns/${CAMPAIGN_ID}/targets`,
      async (route) => {
        callCount += 1;
        const pins =
          callCount === 1
            ? BASE_PINS
            : BASE_PINS.map((p) =>
                p.id === RED_ID ? { ...p, state: "green" as const } : p,
              );
        await route.fulfill({ json: { pins } });
      },
    );

    await page.goto(`/campaigns/${CAMPAIGN_ID}/map`);
    await expect(
      page.locator(`[data-testid="map-pin-${RED_ID}"]`),
    ).toHaveAttribute("data-state", "red");

    // The poll interval is 7s (`POLL_INTERVAL_MS`); wait past it for the
    // next tick to land without a page reload.
    await expect(
      page.locator(`[data-testid="map-pin-${RED_ID}"]`),
    ).toHaveAttribute("data-state", "green", { timeout: 12_000 });
    expect(callCount).toBeGreaterThan(1);
  });

  test("shows a clear message when the map can't be loaded (e.g. unauthenticated)", async ({
    page,
  }) => {
    await page.route(
      `**/api/campaigns/${CAMPAIGN_ID}/targets`,
      async (route) => {
        await route.fulfill({
          status: 401,
          json: {
            error: { code: "unauthorized", message: "Sign in to continue." },
          },
        });
      },
    );

    await page.goto(`/campaigns/${CAMPAIGN_ID}/map`);

    await expect(page.locator('[data-testid="map-load-error"]')).toHaveText(
      "Sign in to continue.",
    );
  });
});
