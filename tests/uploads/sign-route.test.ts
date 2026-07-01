/**
 * `POST /api/uploads/sign` authorization test (Linus batch-2 + batch-4
 * review findings): the route must reject a player who is authenticated
 * but is NOT a member of the target campaign (an authenticated player
 * token only authorizes joined campaigns, constitution §5; it must not
 * be usable to mint a write-capable signed R2 URL into an arbitrary
 * campaign's prefix), AND (batch-4 tightening) must reject a member who
 * does not have an active claim on the specific `targetId` they're
 * requesting an upload URL for, closing the storage-cost/DoS surface a
 * bare membership check left open (any member could otherwise mint
 * unlimited signed PUT URLs unrelated to any claimed target).
 *
 * Mocks `auth()`, the campaigns/campaign-memberships/targets DAL,
 * `isActivelyClaimedBy`, and `createSignedUploadUrl` (this route's own
 * job is orchestration, constitution §6: domain logic lives in `lib/`,
 * not here), so a unit test over the handler with those collaborators
 * mocked is the right altitude; the DAL/storage functions themselves have
 * their own DB-/S3-backed suites (`tests/isolation/isolation.test.ts`,
 * `tests/storage/r2.test.ts`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/config", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db/dal/campaigns", () => ({ getCampaignById: vi.fn() }));
vi.mock("@/lib/db/dal/campaign-memberships", () => ({
  getMembership: vi.fn(),
}));
vi.mock("@/lib/db/dal/targets", () => ({ getTarget: vi.fn() }));
vi.mock("@/lib/target/state-machine", () => ({
  isActivelyClaimedBy: vi.fn(),
}));
vi.mock("@/lib/storage/r2", () => ({ createSignedUploadUrl: vi.fn() }));

import { auth } from "@/lib/auth/config";
import { getCampaignById } from "@/lib/db/dal/campaigns";
import { getMembership } from "@/lib/db/dal/campaign-memberships";
import { getTarget } from "@/lib/db/dal/targets";
import { isActivelyClaimedBy } from "@/lib/target/state-machine";
import { createSignedUploadUrl } from "@/lib/storage/r2";
import { POST } from "@/app/api/uploads/sign/route";

const CAMPAIGN_ID = "11111111-1111-1111-1111-111111111111";
const PLAYER_ID = "22222222-2222-2222-2222-222222222222";
const TARGET_ID = "33333333-3333-3333-3333-333333333333";

function req(body: unknown): Request {
  return new Request("http://localhost/api/uploads/sign", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Convenience: stubs a claimed-and-mine target so tests that aren't
 * exercising the claim-gate itself don't have to repeat this setup. */
function stubActiveClaim(): void {
  vi.mocked(getTarget).mockResolvedValue({ id: TARGET_ID } as never);
  vi.mocked(isActivelyClaimedBy).mockReturnValue(true);
}

describe("POST /api/uploads/sign", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("401s an unauthenticated caller", async () => {
    vi.mocked(auth).mockResolvedValue(null);

    const res = await POST(
      req({ campaignId: CAMPAIGN_ID, targetId: TARGET_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("403s a real player who is not a member of the target campaign", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "player",
      playerId: PLAYER_ID,
    } as never);
    vi.mocked(getCampaignById).mockResolvedValue({
      id: CAMPAIGN_ID,
    } as never);
    vi.mocked(getMembership).mockResolvedValue(null);

    const res = await POST(
      req({ campaignId: CAMPAIGN_ID, targetId: TARGET_ID }),
    );

    expect(getMembership).toHaveBeenCalledWith(CAMPAIGN_ID, PLAYER_ID);
    expect(res.status).toBe(403);
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("signs an upload URL for a player who IS a member with an active claim on the target", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "player",
      playerId: PLAYER_ID,
    } as never);
    vi.mocked(getCampaignById).mockResolvedValue({
      id: CAMPAIGN_ID,
    } as never);
    vi.mocked(getMembership).mockResolvedValue({
      campaignId: CAMPAIGN_ID,
      playerId: PLAYER_ID,
    } as never);
    stubActiveClaim();
    vi.mocked(createSignedUploadUrl).mockResolvedValue({
      url: "https://example-r2/signed",
      key: `${CAMPAIGN_ID}/some-submission.jpg`,
      expiresInSeconds: 300,
    } as never);

    const res = await POST(
      req({ campaignId: CAMPAIGN_ID, targetId: TARGET_ID }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uploadUrl).toBe("https://example-r2/signed");
  });

  it("404s when the campaign does not exist, without checking membership", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "player",
      playerId: PLAYER_ID,
    } as never);
    vi.mocked(getCampaignById).mockResolvedValue(null);

    const res = await POST(
      req({ campaignId: CAMPAIGN_ID, targetId: TARGET_ID }),
    );

    expect(res.status).toBe(404);
    expect(getMembership).not.toHaveBeenCalled();
  });

  it("400s when targetId is missing from the request body", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "player",
      playerId: PLAYER_ID,
    } as never);

    const res = await POST(req({ campaignId: CAMPAIGN_ID }));

    expect(res.status).toBe(400);
    expect(getCampaignById).not.toHaveBeenCalled();
  });

  it("404s when the target does not exist", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "player",
      playerId: PLAYER_ID,
    } as never);
    vi.mocked(getCampaignById).mockResolvedValue({ id: CAMPAIGN_ID } as never);
    vi.mocked(getMembership).mockResolvedValue({
      campaignId: CAMPAIGN_ID,
      playerId: PLAYER_ID,
    } as never);
    vi.mocked(getTarget).mockResolvedValue(null);

    const res = await POST(
      req({ campaignId: CAMPAIGN_ID, targetId: TARGET_ID }),
    );

    expect(res.status).toBe(404);
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("403s a member who does not have an active claim on the target (batch-4 review fix, Linus)", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "player",
      playerId: PLAYER_ID,
    } as never);
    vi.mocked(getCampaignById).mockResolvedValue({ id: CAMPAIGN_ID } as never);
    vi.mocked(getMembership).mockResolvedValue({
      campaignId: CAMPAIGN_ID,
      playerId: PLAYER_ID,
    } as never);
    vi.mocked(getTarget).mockResolvedValue({ id: TARGET_ID } as never);
    vi.mocked(isActivelyClaimedBy).mockReturnValue(false);

    const res = await POST(
      req({ campaignId: CAMPAIGN_ID, targetId: TARGET_ID }),
    );

    expect(isActivelyClaimedBy).toHaveBeenCalledWith(
      { id: TARGET_ID },
      PLAYER_ID,
    );
    expect(res.status).toBe(403);
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });
});
