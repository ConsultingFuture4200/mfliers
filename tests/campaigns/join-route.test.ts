/**
 * `POST /api/campaigns/[id]/join` — route orchestration only (T5.1
 * carry-forward). Mocks `auth()` and `lib/campaign/membership.ts`'s
 * `joinCampaign` — same altitude as `tests/campaigns/targets-route.test.ts`
 * / `tests/target/claim-route.test.ts`; the domain logic itself (live-only
 * gate, idempotent insert) is covered against a live PostGIS DB by
 * `tests/campaign/join.test.ts`. This suite only proves the route
 * resolves a session into `playerId`, 401s without one, and translates
 * `lib/campaign/membership.ts`'s typed errors to the right HTTP status.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/config", () => ({ auth: vi.fn() }));
vi.mock("@/lib/campaign/membership", () => ({ joinCampaign: vi.fn() }));

import { auth } from "@/lib/auth/config";
import { joinCampaign } from "@/lib/campaign/membership";
import {
  CampaignNotFoundError,
  CampaignNotLiveError,
} from "@/lib/campaign/lifecycle";
import { POST as joinRoute } from "@/app/api/campaigns/[id]/join/route";

const CAMPAIGN_ID = "11111111-1111-1111-1111-111111111111";
const PLAYER_ID = "33333333-3333-3333-3333-333333333333";

function req(): Request {
  return new Request(`http://localhost/api/campaigns/${CAMPAIGN_ID}/join`, {
    method: "POST",
  });
}
function ctx() {
  return { params: Promise.resolve({ id: CAMPAIGN_ID }) };
}

describe("POST /api/campaigns/[id]/join", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("401s with no session", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await joinRoute(req(), ctx());

    expect(res.status).toBe(401);
    expect(joinCampaign).not.toHaveBeenCalled();
  });

  it("401s a staff session (join is player-only)", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "host",
      userId: "host-1",
    } as never);

    const res = await joinRoute(req(), ctx());

    expect(res.status).toBe(401);
    expect(joinCampaign).not.toHaveBeenCalled();
  });

  it("joins the campaign using the session's playerId, never a body-supplied id", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "player",
      playerId: PLAYER_ID,
    } as never);
    vi.mocked(joinCampaign).mockResolvedValue({
      campaignId: CAMPAIGN_ID,
      playerId: PLAYER_ID,
      approvedCount: 0,
      currentTier: 0,
      balanceOwedCents: 0,
      rank: 0,
    });

    const res = await joinRoute(req(), ctx());
    const body = (await res.json()) as { membership: { playerId: string } };

    expect(res.status).toBe(200);
    expect(joinCampaign).toHaveBeenCalledWith(CAMPAIGN_ID, PLAYER_ID);
    expect(body.membership.playerId).toBe(PLAYER_ID);
  });

  it("404s when the campaign doesn't exist", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "player",
      playerId: PLAYER_ID,
    } as never);
    vi.mocked(joinCampaign).mockRejectedValue(
      new CampaignNotFoundError(CAMPAIGN_ID),
    );

    const res = await joinRoute(req(), ctx());
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(404);
    expect(body.error.code).toBe("campaign_not_found");
  });

  it("409s when the campaign isn't live", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "player",
      playerId: PLAYER_ID,
    } as never);
    vi.mocked(joinCampaign).mockRejectedValue(
      new CampaignNotLiveError(CAMPAIGN_ID),
    );

    const res = await joinRoute(req(), ctx());
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("campaign_not_live");
  });
});
