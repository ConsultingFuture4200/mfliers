import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for e2e (T1.4). A single browser engine (Chromium) is
 * sufficient for v1 per the card; a dedicated mobile-viewport project is
 * included because the camera capture flow (T4.1) is mobile-first and
 * later specs will target it explicitly.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 5"] },
    },
  ],
});
