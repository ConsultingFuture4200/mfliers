/**
 * `POST /api/campaigns/[id]/submissions` — route orchestration only (T4.1).
 * Mocks `auth()`, the players DAL, and `lib/capture/submit.ts`'s
 * `submitCapture` — same altitude as `tests/target/claim-route.test.ts` /
 * `tests/uploads/sign-route.test.ts`; the domain logic itself (fraud
 * pipeline dispatch, idempotency, DB writes) is covered against a live
 * PostGIS DB by `tests/capture/submit.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/config", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db/dal/players", () => ({ getPlayerById: vi.fn() }));
vi.mock("@/lib/capture/submit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/capture/submit")>(
    "@/lib/capture/submit",
  );
  return { ...actual, submitCapture: vi.fn() };
});

import { auth } from "@/lib/auth/config";
import { getPlayerById } from "@/lib/db/dal/players";
import { submitCapture } from "@/lib/capture/submit";
import { TargetNotClaimedError } from "@/lib/capture/submit";
import { POST } from "@/app/api/campaigns/[id]/submissions/route";

const CAMPAIGN_ID = "11111111-1111-1111-1111-111111111111";
const TARGET_ID = "22222222-2222-2222-2222-222222222222";
const PLAYER_ID = "33333333-3333-3333-3333-333333333333";
const SUBMISSION_ID = "44444444-4444-4444-4444-444444444444";

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    targetId: TARGET_ID,
    submissionId: SUBMISSION_ID,
    photoKey: `${CAMPAIGN_ID}/${SUBMISSION_ID}.jpg`,
    deviceGps: { lat: 46.9, long: -123.8 },
    exifGps: null,
    exifTs: null,
    clientTs: new Date().toISOString(),
    isGalleryFallback: false,
    ...overrides,
  };
}

function req(body: unknown): Request {
  return new Request(
    `http://localhost/api/campaigns/${CAMPAIGN_ID}/submissions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function ctx() {
  return { params: Promise.resolve({ id: CAMPAIGN_ID }) };
}

describe("POST /api/campaigns/[id]/submissions", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("401s when there is no player session", async () => {
    vi.mocked(auth).mockResolvedValue(null);

    const res = await POST(req(validBody()), ctx());

    expect(res.status).toBe(401);
    expect(submitCapture).not.toHaveBeenCalled();
  });

  it("400s on a malformed body without calling submitCapture", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "player",
      playerId: PLAYER_ID,
    } as never);

    const res = await POST(req({ targetId: TARGET_ID }), ctx());

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.error.code).toBe("invalid_submission_input");
    expect(submitCapture).not.toHaveBeenCalled();
  });

  it("404s when the session's player no longer exists", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "player",
      playerId: PLAYER_ID,
    } as never);
    vi.mocked(getPlayerById).mockResolvedValue(null);

    const res = await POST(req(validBody()), ctx());

    expect(res.status).toBe(404);
    expect(submitCapture).not.toHaveBeenCalled();
  });

  it("calls submitCapture with the authenticated player and returns 200 on success", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "player",
      playerId: PLAYER_ID,
    } as never);
    vi.mocked(getPlayerById).mockResolvedValue({
      id: PLAYER_ID,
      email: "submitter@example.com",
    });
    vi.mocked(submitCapture).mockResolvedValue({
      submissionId: SUBMISSION_ID,
      targetId: TARGET_ID,
      decision: "approved",
      fraudChecks: [],
      isTier3: false,
      runningApprovedTotal: 1,
      targetState: "green",
    });

    const res = await POST(req(validBody()), ctx());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe("approved");
    expect(body.runningApprovedTotal).toBe(1);
    expect(submitCapture).toHaveBeenCalledWith(
      CAMPAIGN_ID,
      { id: PLAYER_ID, email: "submitter@example.com" },
      expect.objectContaining({
        targetId: TARGET_ID,
        submissionId: SUBMISSION_ID,
      }),
    );
  });

  it("translates a typed domain error from submitCapture into its HTTP status", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "player",
      playerId: PLAYER_ID,
    } as never);
    vi.mocked(getPlayerById).mockResolvedValue({
      id: PLAYER_ID,
      email: "submitter@example.com",
    });
    vi.mocked(submitCapture).mockRejectedValue(
      new TargetNotClaimedError(CAMPAIGN_ID, TARGET_ID),
    );

    const res = await POST(req(validBody()), ctx());

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("target_not_claimed");
  });
});
