/**
 * POST /api/campaigns/[id]/join — creates the `campaign_memberships` row
 * for the signed-in player (T5.1 carry-forward: `claim`/`submitCapture`
 * both assume that row already exists; nothing before this card created
 * it outside a seed script). Thin route handler; all domain logic
 * (existence check, live-only gate, idempotent insert) lives in
 * `lib/campaign/membership.ts` (constitution §6).
 *
 * Auth: requires an authenticated **player** session (constitution §5 —
 * authorization is server-side, always; the landing page itself is
 * public, but this action is not). `playerId` is read from the
 * server-verified session, never the request body, mirroring
 * `app/api/campaigns/[id]/targets/[targetId]/claim/route.ts` (T3.2).
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/config";
import { joinCampaign } from "@/lib/campaign/membership";

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
          message: "A player session is required to join a campaign.",
        },
      },
      { status: 401 },
    );
  }

  const { id: campaignId } = await params;

  try {
    const membership = await joinCampaign(campaignId, session.playerId);
    return NextResponse.json({ membership });
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
