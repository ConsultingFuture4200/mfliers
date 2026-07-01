import { expect, test } from "@playwright/test";
import sharp from "sharp";

/**
 * Offline queue-and-sync e2e (T5.3) — PRD phase-1-plan risk note quoted in
 * `docs/tasks/batch-5.md`: "offline-sync conflict path surfaces 'already
 * filled' cleanly."
 *
 * Same "mock the network, drive the real client code" approach
 * `tests/e2e/submit-flow.spec.ts` uses (this sandbox has no live R2
 * credentials) — the difference here is `context.setOffline`/`setOffline`
 * toggles Chromium's real network-offline emulation, which is what drives
 * this repo's `lib/offline/sync.ts`'s real `navigator.onLine` check and its
 * real `window` `online` event listener. The IndexedDB queue
 * (`lib/offline/queue.ts`) is real, unmocked browser IndexedDB — `page.
 * reload()` proves persistence across a reload for real, not against a
 * fake.
 */

const CAMPAIGN_ID = "offline-e2e-campaign";
const TARGET_ID = "offline-e2e-target";

async function makeTestJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 320, height: 240, channels: 3, background: "#4a7" },
  })
    .jpeg()
    .toBuffer();
}

async function captureOffline(page: import("@playwright/test").Page) {
  const cameraInput = page.locator(
    '[data-testid="camera-capture-input"] input[type="file"]',
  );
  await expect(cameraInput).toBeEnabled();
  const jpeg = await makeTestJpeg();
  await cameraInput.setInputFiles({
    name: "flier.jpg",
    mimeType: "image/jpeg",
    buffer: jpeg,
  });
}

test.describe("offline queue and sync", () => {
  test("a submission captured offline is queued and survives a reload", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 46.9, longitude: -123.8 });
    // Navigate while still online, then go offline — matching Chromium's
    // real network stack, which refuses even a localhost `goto` once
    // offline emulation is active before the first navigation.
    await page.goto(`/campaigns/${CAMPAIGN_ID}/submit/${TARGET_ID}`);
    await context.setOffline(true);
    await captureOffline(page);

    await expect(
      page.getByRole("heading", { name: "Queued — will submit when online" }),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="offline-queued-message"]'),
    ).toBeVisible();

    // Card requirement 5: the queue is persisted (IndexedDB), not in-memory
    // — reloading the page must restore the queued state rather than
    // dropping back to a fresh "take a photo" screen. Chromium's
    // `context.setOffline` network emulation blocks *all* traffic,
    // including `localhost` — a real device wouldn't refuse to reload an
    // already-cached page shell, but this app has no offline-first service
    // worker (not this card's scope), so a genuinely network-blocked
    // `page.reload()` can never fetch a fresh copy of the app itself.
    // Restoring real connectivity for the reload's own document/script
    // fetch, while mocking every production endpoint to still fail, keeps
    // the app's *business logic* exercised as "offline" (a sync attempt
    // gets a transient failure and leaves the item queued) without that
    // Chromium limitation invalidating the assertion.
    // Register the mock BEFORE reconnecting: `context.setOffline(false)`
    // fires the browser `online` event, which `registerAutoSync` uses to
    // kick off a sync pass immediately. That pass must hit this mocked
    // failing endpoint (a transient 500 -> the item stays `"queued"`), not
    // the real `/api/uploads/sign`, which 401s without an authenticated
    // player session and would terminalize the queued item as `"failed"`
    // before the reload — dropping the very "queued" state this test
    // asserts survives the reload. (Tests below already register their
    // mocks before `setOffline(false)` for the same reason.)
    await page.route("**/api/uploads/sign", async (route) => {
      await route.fulfill({ status: 500, json: { error: {} } });
    });
    await context.setOffline(false);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Queued — will submit when online" }),
    ).toBeVisible();
  });

  test("on reconnect, the queued submission is sent and enters the normal flow", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 46.9, longitude: -123.8 });

    await page.goto(`/campaigns/${CAMPAIGN_ID}/submit/${TARGET_ID}`);
    await context.setOffline(true);
    await captureOffline(page);
    await expect(
      page.getByRole("heading", { name: "Queued — will submit when online" }),
    ).toBeVisible();

    let submitCalls = 0;
    await page.route("**/api/uploads/sign", async (route) => {
      await route.fulfill({
        json: {
          uploadUrl: `${baseURL!}/__mock_r2_upload__`,
          key: `${CAMPAIGN_ID}/reconnect-submission.jpg`,
          submissionId: "reconnect-submission",
          expiresInSeconds: 300,
        },
      });
    });
    await page.route("**/__mock_r2_upload__", async (route) => {
      await route.fulfill({ status: 200, body: "" });
    });
    await page.route(
      `**/api/campaigns/${CAMPAIGN_ID}/submissions`,
      async (route) => {
        submitCalls += 1;
        await route.fulfill({
          json: {
            submissionId: "reconnect-submission",
            targetId: TARGET_ID,
            decision: "approved",
            fraudChecks: [],
            isTier3: false,
            runningApprovedTotal: 1,
            targetState: "green",
          },
        });
      },
    );

    // Reconnect — `lib/offline/sync.ts`'s `registerAutoSync` `online`
    // listener should fire automatically off the real browser event.
    await context.setOffline(false);

    await expect(page.getByRole("heading", { name: "Submitted" })).toBeVisible({
      timeout: 15_000,
    });
    expect(submitCalls).toBe(1);

    // The queue should be empty afterward — nothing left to re-sync on a
    // later reconnect (a duplicate sync must not double-post).
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Post your flier" }),
    ).toBeVisible();
  });

  test("a target filled while offline surfaces 'already filled', with no duplicate submission", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 46.9, longitude: -123.8 });

    const filledTargetId = "offline-e2e-target-filled";
    await page.goto(`/campaigns/${CAMPAIGN_ID}/submit/${filledTargetId}`);
    await context.setOffline(true);
    await captureOffline(page);
    await expect(
      page.getByRole("heading", { name: "Queued — will submit when online" }),
    ).toBeVisible();

    let submitCalls = 0;
    // Someone else filled the target while this device was offline — the
    // real `/api/uploads/sign` route 403s once the caller no longer holds
    // an active claim (`app/api/uploads/sign/route.ts`); this mock
    // reproduces that exact response shape.
    await page.route("**/api/uploads/sign", async (route) => {
      await route.fulfill({
        status: 403,
        json: {
          error: {
            code: "forbidden",
            message: "You do not have an active claim on this target.",
          },
        },
      });
    });
    await page.route(
      `**/api/campaigns/${CAMPAIGN_ID}/submissions`,
      async (route) => {
        submitCalls += 1;
        await route.fulfill({ status: 500, json: { error: {} } });
      },
    );

    await context.setOffline(false);

    await expect(
      page.getByRole("heading", { name: "Target already filled" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator('[data-testid="offline-already-filled-message"]'),
    ).toBeVisible();
    // Card anti-requirement: a sync must never double-submit/double-pay a
    // target that was filled offline — the submit endpoint must never even
    // be called once the sign step reports the conflict.
    expect(submitCalls).toBe(0);
  });
});
