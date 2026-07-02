import { expect, test, type Page } from "@playwright/test";
import { encode } from "next-auth/jwt";
import sharp from "sharp";
import { closeTestDb, getTestDb, hasTestDatabase, resetTestDb } from "../setup";
import { seedTwoCampaigns } from "../fixtures/seed-two-campaigns";
import { getCampaignById } from "@/lib/db/dal/campaigns";
import { getTarget } from "@/lib/db/dal/targets";
import { getPlayerById } from "@/lib/db/dal/players";
import {
  insertSubmission,
  countApprovedSubmissions,
  recordSubmissionDecision,
} from "@/lib/db/dal/submissions";
import { computePhash } from "@/lib/fraud/dedupe";
import { runPipeline } from "@/lib/fraud/pipeline";
import { assertCampaignLive } from "@/lib/campaign/lifecycle";
import {
  isActivelyClaimedBy,
  markPendingReview,
} from "@/lib/target/state-machine";
import { submissionPhotoKey } from "@/lib/storage/r2";
import { listLedger } from "@/lib/payout/ledger";
import type { FraudCheckResult } from "@/types/domain";

/**
 * Full end-to-end loop (T5.5) — PRD EC-1/EC-2, the phase-1 closing gate.
 *
 * "player claims a red target -> captures+submits -> host approves ->
 * pin turns green -> a payout_ledger accrual row exists," walked for real
 * against the live PostGIS test database (`DATABASE_URL`), through the
 * real running app (claim, the review queue, the decision route are all
 * genuinely hit over HTTP by a real browser context) — no canned JSON
 * responses for those legs, unlike every prior e2e spec in this suite
 * (`tests/e2e/submit-flow.spec.ts` et al., which mock the entire
 * `/api/campaigns/[id]/submissions` response because those cards only
 * needed to prove *client-side* behavior). This spec is the one place in
 * the suite that needs the *server-side* effect (fraud decision, target
 * transition, ledger accrual) to be real, so it can't reuse that
 * shortcut.
 *
 * ## The one substitution this sandbox forces (R2), and why it's still real
 * Cloudflare R2 is not available here (no live account — same constraint
 * this task's own build instructions call out for Mapbox/Twilio/R2). Two
 * different R2 touch points behave differently under that constraint:
 *
 *  - `POST /api/uploads/sign` and the host review queue's
 *    `createSignedGetUrl` only *sign* a URL — that's a local HMAC
 *    computation (`@aws-sdk/s3-request-presigner`), no network call. Both
 *    run for real against the real dev server here, using throwaway
 *    `R2_*` env vars (passed by whoever invokes `pnpm test:e2e` for this
 *    file — see `docs/seed.md`) purely so `loadR2ConfigFromEnv` doesn't
 *    throw; no MinIO/R2 endpoint is actually reachable at that hostname.
 *  - `getObjectBytes` (inside `lib/capture/submit.ts`'s `submitCapture`)
 *    *does* make a real outbound GET to read the uploaded photo back —
 *    that leg cannot succeed without a genuinely reachable object store,
 *    and `submitCapture` has no injectable override for it (by design;
 *    it's not this card's file to change — see `docs/tasks/batch-5.md`'s
 *    Files list). So this spec intercepts the browser's PUT (to whatever
 *    R2 host the real signed URL points at) to capture the *actual*
 *    compressed JPEG bytes the real client-side pipeline produced, and
 *    intercepts the submissions POST to run a harness
 *    (`realSubmitCapture` below) that is `lib/capture/submit.ts`'s
 *    `submitCapture` with exactly one line changed: the already-captured
 *    PUT bytes stand in for `getObjectBytes`'s network read. Every other
 *    step — `computePhash` on those real bytes, the real `runPipeline`
 *    fraud checks, the real `markPendingReview`/`insertSubmission` calls —
 *    runs against the live DB, in the same process as this test (which is
 *    why it can be called directly rather than mocked as a static
 *    response). The gallery-fallback forced-review rule it also
 *    replicates (`forceGalleryReview` in `lib/capture/submit.ts`) is not
 *    exported, so it's inlined here rather than imported — see that
 *    module's doc comment for the canonical version this mirrors.
 *
 * Everything downstream of "submission persisted as needs_review" —
 * the host's `/host/campaigns/[id]/review` page load (a real Server
 * Component, real `listReviewQueue` call), the real
 * `POST .../decision` approve action, the real target `amber -> green`
 * transition, and the real ledger accrual — is 100% real, asserted by
 * reading straight back out of the live DB afterward.
 */

const CENTER = { lat: 46.9, long: -123.8 }; // matches seedTwoCampaigns' Campaign A center

async function makeTestJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 320, height: 240, channels: 3, background: "#4a7" },
  })
    .jpeg()
    .toBuffer();
}

function galleryFallbackCheck(): FraudCheckResult {
  return {
    check: "gallery-fallback",
    passed: false,
    detail:
      "submitted via the gallery-upload fallback, not the default rear-" +
      "camera capture; auto-flagged for human review.",
  };
}

interface HarnessInput {
  targetId: string;
  submissionId: string;
  photoKey: string;
  photoBytes: Buffer;
  deviceGps: { lat: number; long: number };
  clientTs: Date | null;
  isGalleryFallback: boolean;
}

/**
 * Mirrors `lib/capture/submit.ts`'s `submitCapture` — see module doc
 * comment above for exactly what's substituted and why.
 */
async function realSubmitCapture(
  campaignId: string,
  playerId: string,
  input: HarnessInput,
) {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) throw new Error(`campaign ${campaignId} not found`);
  assertCampaignLive(campaign);

  const expectedKey = submissionPhotoKey(campaignId, input.submissionId);
  if (input.photoKey !== expectedKey) {
    throw new Error("photoKey did not match the issued upload key");
  }

  const target = await getTarget(campaignId, input.targetId);
  if (!target) throw new Error(`target ${input.targetId} not found`);
  if (!isActivelyClaimedBy(target, playerId)) {
    throw new Error(`target ${input.targetId} is not actively claimed`);
  }

  const player = await getPlayerById(playerId);
  if (!player) throw new Error(`player ${playerId} not found`);

  // The one substitution: real bytes captured off the real PUT, standing
  // in for `getObjectBytes`'s network read (see module doc comment).
  const phash = await computePhash(input.photoBytes);

  await markPendingReview(campaignId, input.targetId);

  const submission = await insertSubmission(campaignId, input.submissionId, {
    playerId,
    targetId: input.targetId,
    photoUrl: expectedKey,
    deviceGps: input.deviceGps,
    exifGps: null,
    exifTs: null,
    phash,
    receivedAt: new Date(),
  });

  let pipelineResult = await runPipeline(submission, campaign, player, {
    clientTs: input.clientTs ?? undefined,
  });

  if (input.isGalleryFallback && pipelineResult.decision === "approved") {
    const fraudChecks = [...pipelineResult.fraudChecks, galleryFallbackCheck()];
    await recordSubmissionDecision(
      campaignId,
      submission.id,
      fraudChecks,
      "needs_review",
    );
    pipelineResult = {
      ...pipelineResult,
      decision: "needs_review",
      fraudChecks,
      nextActions: [],
    };
  }

  // `needs_review` carries no `nextActions` — nothing to dispatch here;
  // the host's real approve action (later in this test) is what drives
  // the target/ledger side effects for real.

  const [finalTarget, runningApprovedTotal] = await Promise.all([
    getTarget(campaignId, input.targetId),
    countApprovedSubmissions(campaignId, playerId),
  ]);

  return {
    submissionId: submission.id,
    targetId: input.targetId,
    decision: pipelineResult.decision,
    fraudChecks: pipelineResult.fraudChecks,
    isTier3: pipelineResult.isTier3,
    runningApprovedTotal,
    targetState: finalTarget?.state ?? target.state,
  };
}

async function addSessionCookie(
  page: Page,
  baseURL: string,
  token: Record<string, unknown>,
): Promise<void> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_SECRET must be set to run tests/e2e/full-loop.spec.ts — see docs/seed.md.",
    );
  }
  const cookieName = "authjs.session-token";
  const value = await encode({ token, secret, salt: cookieName });
  await page.context().addCookies([
    {
      name: cookieName,
      value,
      url: baseURL,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

test.describe("full claim -> capture+submit -> approve -> green+ledger loop", () => {
  test.skip(!hasTestDatabase(), "DATABASE_URL not configured for this run.");

  test.afterAll(async () => {
    await closeTestDb();
  });

  test("EC-1/EC-2: claim, submit (needs_review), host-approve, pin green, ledger accrues", async ({
    browser,
    baseURL,
  }, testInfo) => {
    // This spec's own `resetTestDb()` truncates the shared `DATABASE_URL`
    // database for real (mirrors `vitest.config.ts`'s documented
    // `fileParallelism: false` reasoning — two DB-backed runs truncating
    // the same tables concurrently would wipe each other's fixture rows
    // mid-run). `playwright.config.ts`'s `fullyParallel: true` runs every
    // *project* (desktop, mobile) concurrently by default, and this is the
    // only e2e spec in the suite that touches the real database — every
    // other spec mocks its network calls, so it never races a truncate.
    // Restricting this one test to a single project (rather than editing
    // `playwright.config.ts`, which isn't in this card's Files list) is
    // the narrowest fix.
    test.skip(
      testInfo.project.name !== "desktop",
      "real-DB e2e; runs once (desktop project only) to avoid racing another project's concurrent resetTestDb() against the same database",
    );

    const db = getTestDb();
    await resetTestDb(db);
    const { campaignA } = await seedTwoCampaigns(db);
    const campaignId = campaignA.campaignId;
    const hostId = campaignA.hostId;
    const playerId = campaignA.playerId;
    const targetId = campaignA.targetIds[0]; // Campaign A's targets are offset from CENTER; index 0 has zero offset.

    // --- Player: claim the red target via the real map UI + real claim route ---
    const playerContext = await browser.newContext();
    const playerPage = await playerContext.newPage();
    await addSessionCookie(playerPage, baseURL!, {
      playerId,
      principalType: "player",
      sub: playerId,
    });

    // Granted before any navigation: the submit page requests location on
    // mount, so permission/position must already be in place by the time
    // the claim click routes there (mirrors
    // `tests/e2e/submit-flow.spec.ts`'s own ordering).
    await playerContext.grantPermissions(["geolocation"]);
    await playerContext.setGeolocation({
      latitude: CENTER.lat,
      longitude: CENTER.long,
    });

    await playerPage.goto(`/campaigns/${campaignId}/map`);
    const redPin = playerPage.locator(`[data-testid="map-pin-${targetId}"]`);
    await expect(redPin).toHaveAttribute("data-state", "red");
    // Tapping a pin opens its detail sheet; the "Claim & post flier" button
    // drives the claim → capture route (UI rebuild: submit surfaces in the
    // pin view rather than an abrupt auto-claim on tap).
    await redPin.click();
    await playerPage.locator('[data-testid="pin-claim-button"]').click();

    await expect(playerPage).toHaveURL(
      `/campaigns/${campaignId}/submit/${targetId}`,
    );

    const claimedTarget = await getTarget(campaignId, targetId);
    expect(claimedTarget?.state).toBe("amber");
    expect(claimedTarget?.claimedBy).toBe(playerId);

    // --- Player: capture + submit (real client pipeline; R2 substituted per module doc comment) ---

    let capturedPhotoBytes: Buffer | undefined;
    let capturedSubmissionId: string | undefined;

    await playerPage.route(
      "**/*.r2.cloudflarestorage.com/**",
      async (route) => {
        capturedPhotoBytes = route.request().postDataBuffer() ?? undefined;
        await route.fulfill({ status: 200, body: "" });
      },
    );
    await playerPage.route(
      `**/api/campaigns/${campaignId}/submissions`,
      async (route) => {
        const body = route.request().postDataJSON() as {
          targetId: string;
          submissionId: string;
          photoKey: string;
          deviceGps: { lat: number; long: number };
          clientTs?: string;
          isGalleryFallback: boolean;
        };
        capturedSubmissionId = body.submissionId;
        if (!capturedPhotoBytes) {
          throw new Error("PUT to R2 was never intercepted before submit");
        }
        const result = await realSubmitCapture(campaignId, playerId, {
          targetId: body.targetId,
          submissionId: body.submissionId,
          photoKey: body.photoKey,
          photoBytes: capturedPhotoBytes,
          deviceGps: body.deviceGps,
          clientTs: body.clientTs ? new Date(body.clientTs) : null,
          isGalleryFallback: body.isGalleryFallback,
        });
        await route.fulfill({ json: result });
      },
    );

    const galleryInput = playerPage.locator(
      '[data-testid="gallery-fallback-input"] input[type="file"]',
    );
    await expect(galleryInput).toBeEnabled();
    const jpeg = await makeTestJpeg();
    await galleryInput.setInputFiles({
      name: "flier.jpg",
      mimeType: "image/jpeg",
      buffer: jpeg,
    });

    await expect(
      playerPage.getByRole("heading", { name: "Submitted — under review" }),
    ).toBeVisible({ timeout: 15_000 });

    // EC-2 evidence: a measured submit duration is recorded and surfaced.
    const durationEl = playerPage.locator('[data-testid="submit-duration-ms"]');
    await expect(durationEl).toBeVisible();
    const durationMs = Number(await durationEl.getAttribute("data-value"));
    expect(durationMs).toBeGreaterThan(0);

    expect(capturedSubmissionId).toBeTruthy();
    const submissionId = capturedSubmissionId!;

    // Sanity: pipeline persisted needs_review; nothing paid yet.
    const preApprovalTarget = await getTarget(campaignId, targetId);
    expect(preApprovalTarget?.state).toBe("amber");
    const preApprovalLedger = (await listLedger(campaignId)).filter(
      (entry) => entry.submissionId === submissionId,
    );
    expect(preApprovalLedger).toHaveLength(0);

    // --- Host: approve via the real review queue UI + real decision route ---
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    await addSessionCookie(hostPage, baseURL!, {
      userId: hostId,
      principalType: "host",
      sub: hostId,
    });

    await hostPage.goto(`/host/campaigns/${campaignId}/review`);
    const reviewCard = hostPage.locator(
      `[data-testid="review-card"][data-submission-id="${submissionId}"]`,
    );
    await expect(reviewCard).toBeVisible();
    await reviewCard.locator('[data-testid="approve-button"]').click();
    await expect(
      reviewCard.locator('[data-testid="review-decided"]'),
    ).toHaveText("Approved.");

    // --- Real DB assertions: EC-1's green pin + ledger accrual ---
    const approvedTarget = await getTarget(campaignId, targetId);
    expect(approvedTarget?.state).toBe("green");
    expect(approvedTarget?.filledBySubmissionId).toBe(submissionId);

    const ledgerEntries = (await listLedger(campaignId)).filter(
      (entry) => entry.submissionId === submissionId,
    );
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0].playerId).toBe(playerId);
    expect(ledgerEntries[0].amountCents).toBeGreaterThan(0);
    expect(ledgerEntries[0].unpayable).toBe(false);

    // --- Player-visible confirmation: the pin is green on a fresh map load ---
    await playerPage.unroute(`**/api/campaigns/${campaignId}/submissions`);
    await playerPage.unroute("**/*.r2.cloudflarestorage.com/**");
    await playerPage.goto(`/campaigns/${campaignId}/map`);
    await expect(
      playerPage.locator(`[data-testid="map-pin-${targetId}"]`),
    ).toHaveAttribute("data-state", "green");

    await playerContext.close();
    await hostContext.close();
  });
});
