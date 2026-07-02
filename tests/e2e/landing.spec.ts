import { expect, test } from "@playwright/test";

/**
 * Public landing page e2e (T5.1) — PRD FR-L1/FR-L5.
 *
 * `components/landing/CampaignDirectory.tsx` is a pure client component
 * (mirrors `tests/e2e/campaign-map.spec.ts`'s own reasoning for T4.4's
 * map): it never reads the DB/auth directly, only via `fetch` to
 * `/api/public/campaigns` and `/api/campaigns/[id]/join`, both mocked
 * here with `page.route`. Coverage-% correctness and the live-only filter
 * are covered against a live PostGIS DB by
 * `tests/campaign/directory.test.ts` — this suite only proves the page
 * renders with no session, the login entries route correctly, the
 * directory renders the given data, the join action's redirect-when-
 * unauthenticated behavior, and the two accessibility acceptance criteria
 * (focus visible, reduced motion respected).
 */

const LIVE_CAMPAIGNS = [
  {
    id: "campaign-a",
    name: "Campaign A",
    blurb: "Grand prize: A trophy",
    totalTargets: 4,
    greenTargets: 2,
    coveragePercent: 50,
  },
  {
    id: "campaign-b",
    name: "Campaign B",
    blurb: "Grand prize: Cold hard cash",
    totalTargets: 3,
    greenTargets: 1,
    coveragePercent: 33,
  },
];

async function mockDirectory(page: import("@playwright/test").Page) {
  await page.route("**/api/public/campaigns", async (route) => {
    await route.fulfill({ json: { campaigns: LIVE_CAMPAIGNS } });
  });
}

test.describe("public landing page", () => {
  test("renders with no session", async ({ page }) => {
    await mockDirectory(page);
    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: "Mycofest Canvassing" }),
    ).toBeVisible();
  });

  test("lists only the given live campaigns with correct coverage %", async ({
    page,
  }) => {
    await mockDirectory(page);
    await page.goto("/");

    const cards = page.locator('[data-testid="campaign-card"]');
    await expect(cards).toHaveCount(2);

    const a = page.locator('[data-campaign-id="campaign-a"]');
    await expect(a.getByText("Campaign A")).toBeVisible();
    await expect(a.locator('[data-testid="campaign-coverage"]')).toHaveText(
      "50%",
    );

    const b = page.locator('[data-campaign-id="campaign-b"]');
    await expect(b.locator('[data-testid="campaign-coverage"]')).toHaveText(
      "33%",
    );
  });

  test("player login entry routes to the player login flow", async ({
    page,
  }) => {
    await mockDirectory(page);
    await page.goto("/");

    await page.locator('[data-testid="player-login-link"]').click();
    await expect(page).toHaveURL("/login");
    await expect(
      page.getByRole("heading", { name: "Player login" }),
    ).toBeVisible();
  });

  test("staff login entry routes to the staff login flow", async ({ page }) => {
    await mockDirectory(page);
    await page.goto("/");

    await page.locator('[data-testid="staff-login-link"]').click();
    await expect(page).toHaveURL("/staff-login");
    await expect(
      page.getByRole("heading", { name: "Host / admin login" }),
    ).toBeVisible();
  });

  test("universal map entry links to /map (T5.2)", async ({ page }) => {
    await mockDirectory(page);
    await page.goto("/");

    await expect(
      page.locator('[data-testid="universal-map-link"]'),
    ).toHaveAttribute("href", "/map");
  });

  test("joining while unauthenticated redirects to player login", async ({
    page,
  }) => {
    await mockDirectory(page);
    await page.route("**/api/campaigns/campaign-a/join", async (route) => {
      await route.fulfill({
        status: 401,
        json: {
          error: {
            code: "unauthorized",
            message: "A player session is required to join a campaign.",
          },
        },
      });
    });

    await page.goto("/");
    await page
      .locator('[data-campaign-id="campaign-a"] [data-testid="join-button"]')
      .click();

    await expect(page).toHaveURL("/login");
  });

  test("joining succeeds for an authenticated player", async ({ page }) => {
    await mockDirectory(page);
    await page.route("**/api/campaigns/campaign-a/join", async (route) => {
      await route.fulfill({
        json: {
          membership: {
            campaignId: "campaign-a",
            playerId: "player-1",
            approvedCount: 0,
            currentTier: 0,
            balanceOwedCents: 0,
            rank: 0,
          },
        },
      });
    });

    await page.goto("/");
    const card = page.locator('[data-campaign-id="campaign-a"]');
    await card.locator('[data-testid="join-button"]').click();

    await expect(card.locator('[data-testid="join-success"]')).toBeVisible();
  });

  test("keyboard focus is visible when tabbing to the player login link", async ({
    page,
  }) => {
    await mockDirectory(page);
    await page.goto("/");

    const link = page.locator('[data-testid="player-login-link"]');
    // Real Tab keypresses (not a programmatic `.focus()`) so Chromium's
    // focus-visible heuristic actually applies the `:focus-visible` ring this
    // asserts on. The global SiteHeader now precedes the sign-in links, so tab
    // through it until the player-login link receives focus.
    for (
      let i = 0;
      i < 8 && !(await link.evaluate((el) => el === document.activeElement));
      i++
    ) {
      await page.keyboard.press("Tab");
    }
    await expect(link).toBeFocused();

    const boxShadow = await link.evaluate(
      (el) => getComputedStyle(el).boxShadow,
    );
    expect(boxShadow).not.toBe("none");
  });

  test("respects prefers-reduced-motion on the campaign cards", async ({
    page,
  }) => {
    await mockDirectory(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");

    const card = page.locator('[data-testid="campaign-card"]').first();
    await expect(card).toBeVisible();

    const transitionDuration = await card.evaluate(
      (el) => getComputedStyle(el).transitionDuration,
    );
    // Every listed duration must be 0s under prefers-reduced-motion
    // (`motion-reduce:duration-0` on the card).
    expect(
      transitionDuration
        .split(",")
        .map((d) => d.trim())
        .every((d) => d === "0s"),
    ).toBe(true);
  });
});
