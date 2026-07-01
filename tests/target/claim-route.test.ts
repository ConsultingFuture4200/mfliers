/**
 * `POST /api/campaigns/[id]/targets/[targetId]/claim` — campaign-live guard
 * (Linus + Liotta batch-3 review finding): a target in a `draft` or
 * `closed` campaign must not become claimable via a direct API call, even
 * though the UI never shows a claimable pin for a non-live campaign
 * (constitution §2 — "hiding a button is not security").
 *
 * Mocks `auth()`, the campaigns/campaign-memberships DAL, and
 * `lib/target/state-machine.ts`'s `claim` — same altitude as
 * `tests/uploads/sign-route.test.ts` (route orchestration only; the
 * state-machine/DAL atomicity itself is covered by
 * `tests/target/state-machine.test.ts` against a live database).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/config", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db/dal/campaigns", () => ({ getCampaignById: vi.fn() }));
vi.mock("@/lib/db/dal/campaign-memberships", () => ({
  getMembership: vi.fn(),
}));
vi.mock("@/lib/target/state-machine", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/target/state-machine")
  >("@/lib/target/state-machine");
  return { ...actual, claim: vi.fn() };
});

import { auth } from "@/lib/auth/config";
import { getCampaignById } from "@/lib/db/dal/campaigns";
import { getMembership } from "@/lib/db/dal/campaign-memberships";
import { claim } from "@/lib/target/state-machine";
import { POST } from "@/app/api/campaigns/[id]/targets/[targetId]/claim/route";

const CAMPAIGN_ID = "11111111-1111-1111-1111-111111111111";
const TARGET_ID = "22222222-2222-2222-2222-222222222222";
const PLAYER_ID = "33333333-3333-3333-3333-333333333333";

function req(): Request {
  return new Request(
    `http://localhost/api/campaigns/${CAMPAIGN_ID}/targets/${TARGET_ID}/claim`,
    { method: "POST" },
  );
}

function ctx() {
  return { params: Promise.resolve({ id: CAMPAIGN_ID, targetId: TARGET_ID }) };
}

describe("POST /api/campaigns/[id]/targets/[targetId]/claim", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function mockAuthedMember() {
    vi.mocked(auth).mockResolvedValue({
      principalType: "player",
      playerId: PLAYER_ID,
    } as never);
    vi.mocked(getMembership).mockResolvedValue({
      campaignId: CAMPAIGN_ID,
      playerId: PLAYER_ID,
    } as never);
  }

  it.each(["draft", "closed"] as const)(
    "409s a claim against a %s campaign without calling claim()",
    async (state) => {
      mockAuthedMember();
      vi.mocked(getCampaignById).mockResolvedValue({
        id: CAMPAIGN_ID,
        state,
      } as never);

      const res = await POST(req(), ctx());

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("campaign_not_live");
      expect(claim).not.toHaveBeenCalled();
    },
  );

  it("calls claim() and succeeds for a live campaign", async () => {
    mockAuthedMember();
    vi.mocked(getCampaignById).mockResolvedValue({
      id: CAMPAIGN_ID,
      state: "live",
    } as never);
    vi.mocked(claim).mockResolvedValue({ id: TARGET_ID } as never);

    const res = await POST(req(), ctx());

    expect(res.status).toBe(200);
    expect(claim).toHaveBeenCalledWith(CAMPAIGN_ID, TARGET_ID, PLAYER_ID);
  });
});
