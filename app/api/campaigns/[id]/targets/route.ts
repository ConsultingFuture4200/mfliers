/**
 * GET /api/campaigns/[id]/targets — the per-campaign map's live pin list
 * (T4.4). This is the endpoint `components/map/CampaignMap.tsx` both loads
 * on mount and polls every 5-10s (card requirement 5). Thin route handler;
 * all pin assembly + authorization lives in `lib/campaign/map.ts`
 * (constitution §6/§5).
 *
 * Auth: requires an authenticated session (constitution §5 — server-side,
 * always). Any authenticated player may view any campaign's map — there is
 * no membership gate on *browsing* (only on claiming, which
 * `.../targets/[targetId]/claim/route.ts` already checks); the batch-5
 * "browse live campaigns, then join" flow this feeds into has no join
 * step yet, so gating the map itself on membership would make it
 * unreachable before that lands. A staff (host/site-admin) viewer is
 * scoped by `lib/campaign/map.ts`'s own `requireCampaignAccess` call —
 * a host may only view its own campaigns' maps. A player's `MapPrincipal`
 * carries `playerId` (batch-4 review fix, Liotta) even though this pin
 * list itself is unaffected by it: the sibling `.../targets/[targetId]/
 * route.ts` needs it to gate a filled pin's photo/GPS on membership, and
 * both routes share this same session-resolution shape.
 *
 * The session -> `MapPrincipal` resolution below is duplicated in the
 * sibling `.../targets/[targetId]/route.ts`, mirroring
 * `app/api/host/campaigns/[id]/ledger/route.ts`'s own
 * `requireStaffPrincipal` shape (that file's doc comment: "duplicated
 * per-route-file throughout this codebase already — matching existing
 * convention rather than introducing a new shared module this card
 * doesn't ask for"). A `route.ts` module is also not a safe place to
 * export a shared helper from in the first place (Next.js route files are
 * validated to only export the recognized HTTP-method/config exports).
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/config";
import { resolveStaffPrincipal } from "@/lib/auth/staff";
import { listMapPins, type MapPrincipal } from "@/lib/campaign/map";

interface RouteContext {
  params: Promise<{ id: string }>;
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
          message: "Sign in to view this campaign's map.",
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

  const { id: campaignId } = await params;

  try {
    const pins = await listMapPins(principalOrResponse, campaignId);
    return NextResponse.json({ pins });
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
