/**
 * GET /api/campaigns/[id]/targets/[targetId] — a single pin's tap-through
 * detail (T4.4, card requirements 3/4). `components/map/CampaignMap.tsx`
 * calls this when a green or amber pin is tapped (a red-pin tap goes
 * straight to `.../claim` instead, per the card's claim-then-post flow).
 * Thin route handler; the privacy-gated assembly + authorization lives in
 * `lib/campaign/map.ts` (constitution §6/§5).
 *
 * Auth mirrors `.../targets/route.ts` (the poll-list sibling — see that
 * file's doc comment for why the session -> `MapPrincipal` resolution is
 * duplicated here rather than imported): any authenticated player may
 * view, a staff viewer is scoped by `lib/campaign/map.ts`'s own
 * `requireCampaignAccess` call. The resolved `MapPrincipal` ("player" vs
 * "staff") is what `getTargetDetail` uses to gate the canvasser's username
 * behind `campaign.privacySetting` (requirement 3) — a staff viewer always
 * sees it, same as the review queue (T4.2). A player `MapPrincipal` now
 * also carries `playerId` (batch-4 review fix, Liotta): `getTargetDetail`
 * uses it to gate a filled pin's *photo and GPS* on the caller actually
 * being a member of this campaign: previously any authenticated player
 * could read another campaign's green-pin photo/GPS by id, which the
 * pin-list route's "no membership gate on browsing" design was never
 * meant to extend to.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/config";
import { resolveStaffPrincipal } from "@/lib/auth/staff";
import { getTargetDetail, type MapPrincipal } from "@/lib/campaign/map";

interface RouteContext {
  params: Promise<{ id: string; targetId: string }>;
}

function isTypedDomainError(
  err: unknown,
): err is Error & { status: number; code: string } {
  return (
    err instanceof Error &&
    typeof (err as { status?: unknown }).status === "number" &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

async function resolveMapPrincipal(): Promise<MapPrincipal | NextResponse> {
  const session = await auth();
  if (!session?.principalType) {
    return NextResponse.json(
      {
        error: {
          code: "unauthorized",
          message: "Sign in to view this pin's detail.",
        },
      },
      { status: 401 },
    );
  }

  if (
    session.principalType === "host" ||
    session.principalType === "site_admin"
  ) {
    if (!session.userId) {
      return NextResponse.json(
        {
          error: {
            code: "unauthorized",
            message: "A staff session is required.",
          },
        },
        { status: 401 },
      );
    }
    const staff = await resolveStaffPrincipal(session.userId);
    if (!staff) {
      return NextResponse.json(
        {
          error: {
            code: "unauthorized",
            message: "This staff account no longer exists.",
          },
        },
        { status: 401 },
      );
    }
    return { type: "staff", staff };
  }

  if (!session.playerId) {
    return NextResponse.json(
      {
        error: {
          code: "unauthorized",
          message: "A player session is required.",
        },
      },
      { status: 401 },
    );
  }

  return { type: "player", playerId: session.playerId };
}

export async function GET(
  _request: Request,
  { params }: RouteContext,
): Promise<Response> {
  const principalOrResponse = await resolveMapPrincipal();
  if (principalOrResponse instanceof NextResponse) return principalOrResponse;

  const { id: campaignId, targetId } = await params;

  try {
    const detail = await getTargetDetail(
      principalOrResponse,
      campaignId,
      targetId,
    );
    return NextResponse.json({ target: detail });
  } catch (err) {
    if (isTypedDomainError(err)) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: err.status },
      );
    }
    throw err;
  }
}
