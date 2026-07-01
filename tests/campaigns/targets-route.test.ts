/**
 * `GET /api/campaigns/[id]/targets` + `GET
 * /api/campaigns/[id]/targets/[targetId]` — route orchestration only
 * (T4.4). Mocks `auth()`, `resolveStaffPrincipal`, and
 * `lib/campaign/map.ts`'s exports — same altitude as
 * `tests/target/claim-route.test.ts`/`tests/campaigns/submissions-route.test.ts`;
 * the domain logic itself (pin assembly, privacy gating, authorization) is
 * covered against a live PostGIS DB by `tests/campaign/map.test.ts`. This
 * suite only proves the two route handlers resolve a session into the
 * right `MapPrincipal` and translate `lib/campaign/map.ts`'s typed errors
 * to the right HTTP status.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/config", () => ({ auth: vi.fn() }));
vi.mock("@/lib/auth/staff", () => ({ resolveStaffPrincipal: vi.fn() }));
vi.mock("@/lib/campaign/map", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/campaign/map")>(
      "@/lib/campaign/map",
    );
  return { ...actual, listMapPins: vi.fn(), getTargetDetail: vi.fn() };
});

import { auth } from "@/lib/auth/config";
import { resolveStaffPrincipal } from "@/lib/auth/staff";
import {
  CampaignNotFoundError,
  getTargetDetail,
  listMapPins,
} from "@/lib/campaign/map";
import { ForbiddenError } from "@/lib/auth/guards";
import { GET as getPins } from "@/app/api/campaigns/[id]/targets/route";
import { GET as getDetail } from "@/app/api/campaigns/[id]/targets/[targetId]/route";

const CAMPAIGN_ID = "11111111-1111-1111-1111-111111111111";
const TARGET_ID = "22222222-2222-2222-2222-222222222222";
const HOST_USER_ID = "44444444-4444-4444-4444-444444444444";

function pinsReq(): Request {
  return new Request(`http://localhost/api/campaigns/${CAMPAIGN_ID}/targets`);
}
function pinsCtx() {
  return { params: Promise.resolve({ id: CAMPAIGN_ID }) };
}
function detailReq(): Request {
  return new Request(
    `http://localhost/api/campaigns/${CAMPAIGN_ID}/targets/${TARGET_ID}`,
  );
}
function detailCtx() {
  return {
    params: Promise.resolve({ id: CAMPAIGN_ID, targetId: TARGET_ID }),
  };
}

describe("GET /api/campaigns/[id]/targets", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("401s with no session", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await getPins(pinsReq(), pinsCtx());

    expect(res.status).toBe(401);
    expect(listMapPins).not.toHaveBeenCalled();
  });

  it("passes a player principal for a player session, no staff resolution", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "player",
      playerId: "player-1",
    } as never);
    vi.mocked(listMapPins).mockResolvedValue([]);

    const res = await getPins(pinsReq(), pinsCtx());

    expect(res.status).toBe(200);
    expect(resolveStaffPrincipal).not.toHaveBeenCalled();
    expect(listMapPins).toHaveBeenCalledWith(
      { type: "player", playerId: "player-1" },
      CAMPAIGN_ID,
    );
  });

  it("401s a player session with no playerId (batch-4 review fix, Liotta)", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "player",
    } as never);

    const res = await getPins(pinsReq(), pinsCtx());

    expect(res.status).toBe(401);
    expect(listMapPins).not.toHaveBeenCalled();
  });

  it("resolves a staff principal for a host/site-admin session", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "host",
      userId: HOST_USER_ID,
    } as never);
    vi.mocked(resolveStaffPrincipal).mockResolvedValue({
      userId: HOST_USER_ID,
      type: "host",
      scopedCampaignIds: [CAMPAIGN_ID],
    });
    vi.mocked(listMapPins).mockResolvedValue([]);

    const res = await getPins(pinsReq(), pinsCtx());

    expect(res.status).toBe(200);
    expect(listMapPins).toHaveBeenCalledWith(
      {
        type: "staff",
        staff: {
          userId: HOST_USER_ID,
          type: "host",
          scopedCampaignIds: [CAMPAIGN_ID],
        },
      },
      CAMPAIGN_ID,
    );
  });

  it("401s a host session whose staff account no longer resolves", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "host",
      userId: HOST_USER_ID,
    } as never);
    vi.mocked(resolveStaffPrincipal).mockResolvedValue(null);

    const res = await getPins(pinsReq(), pinsCtx());

    expect(res.status).toBe(401);
    expect(listMapPins).not.toHaveBeenCalled();
  });

  it("403s when lib/campaign/map.ts throws ForbiddenError", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "host",
      userId: HOST_USER_ID,
    } as never);
    vi.mocked(resolveStaffPrincipal).mockResolvedValue({
      userId: HOST_USER_ID,
      type: "host",
      scopedCampaignIds: [],
    });
    vi.mocked(listMapPins).mockRejectedValue(
      new ForbiddenError("not authorized"),
    );

    const res = await getPins(pinsReq(), pinsCtx());

    expect(res.status).toBe(403);
  });

  it("404s when the campaign doesn't exist", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "player",
      playerId: "player-1",
    } as never);
    vi.mocked(listMapPins).mockRejectedValue(
      new CampaignNotFoundError(CAMPAIGN_ID),
    );

    const res = await getPins(pinsReq(), pinsCtx());

    expect(res.status).toBe(404);
  });
});

describe("GET /api/campaigns/[id]/targets/[targetId]", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("401s with no session", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await getDetail(detailReq(), detailCtx());

    expect(res.status).toBe(401);
    expect(getTargetDetail).not.toHaveBeenCalled();
  });

  it("passes a player principal through to getTargetDetail", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "player",
      playerId: "player-1",
    } as never);
    vi.mocked(getTargetDetail).mockResolvedValue({
      id: TARGET_ID,
      label: "Pin 1",
      lat: 1,
      long: 2,
      state: "red",
      photoUrl: null,
      submissionGps: null,
      username: null,
    });

    const res = await getDetail(detailReq(), detailCtx());

    expect(res.status).toBe(200);
    expect(getTargetDetail).toHaveBeenCalledWith(
      { type: "player", playerId: "player-1" },
      CAMPAIGN_ID,
      TARGET_ID,
    );
  });

  it("401s a player session with no playerId (batch-4 review fix, Liotta)", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "player",
    } as never);

    const res = await getDetail(detailReq(), detailCtx());

    expect(res.status).toBe(401);
    expect(getTargetDetail).not.toHaveBeenCalled();
  });

  it("403s when lib/campaign/map.ts throws ForbiddenError for a staff viewer", async () => {
    vi.mocked(auth).mockResolvedValue({
      principalType: "site_admin",
      userId: HOST_USER_ID,
    } as never);
    vi.mocked(resolveStaffPrincipal).mockResolvedValue({
      userId: HOST_USER_ID,
      type: "site_admin",
      scopedCampaignIds: [],
    });
    vi.mocked(getTargetDetail).mockRejectedValue(
      new ForbiddenError("not authorized"),
    );

    const res = await getDetail(detailReq(), detailCtx());

    expect(res.status).toBe(403);
  });
});
