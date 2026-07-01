/**
 * POST /api/campaigns/[id]/targets/[targetId]/claim — claims a red map pin
 * for the signed-in player (T3.2). Thin route handler; all state-machine
 * logic lives in `lib/target/state-machine.ts` (constitution §6: domain
 * logic in `lib/`, never in route handlers).
 *
 * Auth: requires an authenticated **player** session (constitution §5 —
 * authorization is server-side, always). `playerId` is read from the
 * server-verified session, never accepted from the request body, so a
 * caller can never claim a pin as someone else. Mirrors
 * `app/api/uploads/sign/route.ts` (T2.4)'s membership check — a player
 * token only authorizes campaigns it has joined.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/config";
import { assertCampaignLive } from "@/lib/campaign/lifecycle";
import { getCampaignById } from "@/lib/db/dal/campaigns";
import { getMembership } from "@/lib/db/dal/campaign-memberships";
import {
  ClaimConflictError,
  TargetNotFoundError,
  claim,
} from "@/lib/target/state-machine";

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

export async function POST(
  _request: Request,
  { params }: RouteContext,
): Promise<Response> {
  const session = await auth();
  if (!session || session.principalType !== "player" || !session.playerId) {
    return NextResponse.json(
      {
        error: {
          code: "unauthorized",
          message: "A player session is required to claim a target.",
        },
      },
      { status: 401 },
    );
  }

  const { id: campaignId, targetId } = await params;

  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    return NextResponse.json(
      { error: { code: "not_found", message: "Campaign not found." } },
      { status: 404 },
    );
  }

  const membership = await getMembership(campaignId, session.playerId);
  if (!membership) {
    return NextResponse.json(
      {
        error: {
          code: "forbidden",
          message: "You are not a member of this campaign.",
        },
      },
      { status: 403 },
    );
  }

  try {
    // Server-side, not just a hidden button (constitution §2): a target in
    // a draft or closed campaign must not become claimable via a direct
    // API call.
    assertCampaignLive(campaign);
    const target = await claim(campaignId, targetId, session.playerId);
    return NextResponse.json({ target });
  } catch (err) {
    if (
      err instanceof TargetNotFoundError ||
      err instanceof ClaimConflictError
    ) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: err.status },
      );
    }
    if (isTypedDomainError(err)) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: err.status },
      );
    }
    throw err;
  }
}
