import { expect, test } from "@playwright/test";
import sharp from "sharp";

/**
 * Submission capture flow e2e (T4.1) — PRD FR-S1…FR-S5, EC-2.
 *
 * The capture page (`app/campaigns/[id]/submit/[targetId]/page.tsx`) is a
 * pure client component: it never reads the DB/auth/R2 directly, only via
 * `fetch` to `/api/uploads/sign` and `/api/campaigns/[id]/submissions`. This
 * sandbox has no live R2/Twilio credentials configured for the dev server
 * (`.env.example`'s `R2_*`/`TWILIO_*` are empty — same constraint
 * `tests/e2e/player-session.spec.ts` documents for Twilio), so this suite
 * intercepts those two network calls with `page.route` rather than driving
 * a real upload — this is standard Playwright practice for UI-level e2e,
 * and it's what lets this spec exercise the *real* browser-side flow (GPS
 * gating, the real `parseJpegExif`/`compressImage` pipeline running against
 * a real JPEG, the real request bodies sent, the real confirmation
 * render/instrumentation) without needing live infrastructure this sandbox
 * doesn't have. The server-side half of this flow (fraud pipeline, target
 * dispatch, idempotency) is verified for real against a live PostGIS DB by
 * `tests/capture/submit.test.ts`.
 */

const CAMPAIGN_ID = "e2e-campaign";
const TARGET_ID = "e2e-target";
const SUBMISSION_ID = "e2e-submission";

async function makeTestJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 320, height: 240, channels: 3, background: "#4a7" },
  })
    .jpeg()
    .toBuffer();
}

interface SubmitRequestBody {
  targetId: string;
  submissionId: string;
  photoKey: string;
  deviceGps: { lat: number; long: number };
  isGalleryFallback: boolean;
}

async function mockSignAndSubmit(
  page: import("@playwright/test").Page,
  baseURL: string,
  onSubmit: (body: SubmitRequestBody) => void,
) {
  await page.route("**/api/uploads/sign", async (route) => {
    await route.fulfill({
      json: {
        uploadUrl: `${baseURL}/__mock_r2_upload__`,
        key: `${CAMPAIGN_ID}/${SUBMISSION_ID}.jpg`,
        submissionId: SUBMISSION_ID,
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
      const body = route.request().postDataJSON() as SubmitRequestBody;
      onSubmit(body);
      await route.fulfill({
        json: {
          submissionId: SUBMISSION_ID,
          targetId: TARGET_ID,
          decision: "approved",
          fraudChecks: [],
          isTier3: false,
          runningApprovedTotal: 3,
          targetState: "green",
        },
      });
    },
  );
}

test.describe("submission capture flow", () => {
  test("blocks submission with a clear message when GPS permission is denied", async ({
    page,
    context,
  }) => {
    // No geolocation permission granted — Playwright's headless Chromium
    // resolves `getCurrentPosition` as PERMISSION_DENIED rather than
    // showing a real OS prompt (requirement 3: GPS denial hard-blocks).
    await context.clearPermissions();

    await page.goto(`/campaigns/${CAMPAIGN_ID}/submit/${TARGET_ID}`);

    await expect(
      page.getByRole("heading", { name: "Location access required" }),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="camera-capture-input"]'),
    ).toHaveCount(0);
  });

  test("captures via the default rear-camera input, submits, and instruments a submit duration", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 46.9, longitude: -123.8 });

    let submittedBody: SubmitRequestBody | undefined;
    await mockSignAndSubmit(page, baseURL!, (body) => {
      submittedBody = body;
    });

    await page.goto(`/campaigns/${CAMPAIGN_ID}/submit/${TARGET_ID}`);

    const cameraInput = page.locator(
      '[data-testid="camera-capture-input"] input[type="file"]',
    );
    await expect(cameraInput).toBeEnabled();
    // Requirement 1: the default input is rear-camera-only (`capture`).
    await expect(cameraInput).toHaveAttribute("capture", "environment");

    const jpeg = await makeTestJpeg();
    await cameraInput.setInputFiles({
      name: "flier.jpg",
      mimeType: "image/jpeg",
      buffer: jpeg,
    });

    await expect(
      page.getByRole("heading", { name: "Placement approved!" }),
    ).toBeVisible({ timeout: 15_000 });

    expect(submittedBody?.isGalleryFallback).toBe(false);
    expect(submittedBody?.deviceGps).toEqual({ lat: 46.9, long: -123.8 });

    // Requirement 7 (EC-2): a measurable duration is recorded.
    const durationEl = page.locator('[data-testid="submit-duration-ms"]');
    await expect(durationEl).toBeVisible();
    const durationValue = Number(await durationEl.getAttribute("data-value"));
    expect(durationValue).toBeGreaterThan(0);
  });

  test("gallery fallback path flags the submission and still completes", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 46.9, longitude: -123.8 });

    let submittedBody: SubmitRequestBody | undefined;
    await mockSignAndSubmit(page, baseURL!, (body) => {
      submittedBody = body;
    });

    await page.goto(`/campaigns/${CAMPAIGN_ID}/submit/${TARGET_ID}`);

    const galleryInput = page.locator(
      '[data-testid="gallery-fallback-input"] input[type="file"]',
    );
    await expect(galleryInput).toBeEnabled();
    // The fallback input must NOT force rear-camera capture (it's a plain
    // gallery picker, not a second camera trigger).
    await expect(galleryInput).not.toHaveAttribute("capture", /.+/);

    const jpeg = await makeTestJpeg();
    await galleryInput.setInputFiles({
      name: "flier.jpg",
      mimeType: "image/jpeg",
      buffer: jpeg,
    });

    await expect(
      page.getByRole("heading", { name: "Placement approved!" }),
    ).toBeVisible({ timeout: 15_000 });

    expect(submittedBody?.isGalleryFallback).toBe(true);
  });
});
