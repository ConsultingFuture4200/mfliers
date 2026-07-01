/**
 * `POST /api/uploads/sign` authorization test (Linus batch-2 review
 * finding): the route must reject a player who is authenticated but is
 * NOT a member of the target campaign — an authenticated player token
 * only authorizes joined campaigns (constitution §5), it must not be
 * usable to mint a write-capable signed R2 URL into an arbitrary
 * campaign's prefix.
 *
 * Mocks `auth()`, the campaigns/campaign-memberships DAL, and
 * `createSignedUploadUrl` — this route's own job is orchestration
 * (constitution §6: domain logic lives in `lib/`, not here), so a unit
 * test over the handler with those collaborators mocked is the right
 * altitude; the DAL/storage functions themselves have their own
 * DB-/S3-backed suites (`tests/isolation/isolation.test.ts`,
 * `tests/storage/r2.test.ts`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/config", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db/dal/campaigns", () => ({ getCampaignById: vi.fn() }));
vi.mock("@/lib/db/dal/campaign-memberships", () => ({
  getMembership: vi.fn(),
}));
vi.mock("@/lib/storage/r2", () => ({ createSignedUploadUrl: vi.fn() }));

import { auth } from "@/lib/auth/config";
import { getCampaignById } from "@/lib/db/dal/campaigns";
import { getMembership } from "@/lib/db/dal/campaign-memberships";
import { createSignedUploadUrl } from "@/lib/storage/r2";
import { POST } from "@/app/api/uploads/sign/route";

const CAMPAIGN_ID = "11111111-1111-1111-1111-111111111111";
const PLAYER_ID = "22222222-2222-2222-2222-222222222222";

function req(body: unknown): Request {
  return new Request("http://localhost/api/uploads/sign", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/uploads/sign", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("401s an unauthenticated caller", async () => {
    vi.mocked(auth).mockResolvedValue(null);

    const res = await POST(req({ campaignId: CAMPAIGN_ID }));
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

    const res = await POST(req({ campaignId: CAMPAIGN_ID }));

    expect(getMembership).toHaveBeenCalledWith(CAMPAIGN_ID, PLAYER_ID);
    expect(res.status).toBe(403);
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("signs an upload URL for a player who IS a member of the campaign", async () => {
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
    vi.mocked(createSignedUploadUrl).mockResolvedValue({
      url: "https://example-r2/signed",
      key: `${CAMPAIGN_ID}/some-submission.jpg`,
      expiresInSeconds: 300,
    } as never);

    const res = await POST(req({ campaignId: CAMPAIGN_ID }));

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

    const res = await POST(req({ campaignId: CAMPAIGN_ID }));

    expect(res.status).toBe(404);
    expect(getMembership).not.toHaveBeenCalled();
  });
});
