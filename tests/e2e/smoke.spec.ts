import { expect, test } from "@playwright/test";

/**
 * Trivial Playwright smoke test (T1.4): proves the e2e harness (browser
 * launch + dev server webServer hook) works end to end, on both the
 * desktop and mobile-viewport projects. Real feature specs ship with their
 * features (e.g. the camera capture flow in T4.1).
 */
test("landing page loads", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Mycofest Canvassing" }),
  ).toBeVisible();
});
