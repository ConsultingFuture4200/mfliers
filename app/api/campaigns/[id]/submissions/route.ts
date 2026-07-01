/**
 * POST /api/campaigns/[id]/submissions — the capture flow's submit handler
 * (T4.1). Thin route handler; all domain logic (validation, phash, the
 * fraud pipeline, target-state dispatch) lives in `lib/capture/submit.ts`
 * (constitution §6).
 *
 * Auth: requires an authenticated **player** session (constitution §5).
 * `playerId` is read from the server-verified session, never accepted from
 * the request body — mirrors `app/api/campaigns/[id]/targets/[targetId]/
 * claim/route.ts` and `app/api/uploads/sign/route.ts`.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/config";
import { getPlayerById } from "@/lib/db/dal/players";
import {
  InvalidSubmissionInputError,
  parseSubmitCaptureInput,
  PhotoKeyMismatchError,
  PhotoNotUploadedError,
  submitCapture,
  TargetNotClaimedError,
} from "@/lib/capture/submit";
import {
  CampaignNotFoundError,
  CampaignNotLiveError,
} from "@/lib/campaign/lifecycle";
import { TargetNotFoundError } from "@/lib/target/state-machine";

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

const KNOWN_ERRORS = [
  InvalidSubmissionInputError,
  PhotoKeyMismatchError,
  PhotoNotUploadedError,
  TargetNotClaimedError,
  CampaignNotFoundError,
  CampaignNotLiveError,
  TargetNotFoundError,
];

export async function POST(
  request: Request,
  { params }: RouteContext,
): Promise<Response> {
  const session = await auth();
  if (!session || session.principalType !== "player" || !session.playerId) {
    return NextResponse.json(
      {
        error: {
          code: "unauthorized",
          message: "A player session is required to submit a photo.",
        },
      },
      { status: 401 },
    );
  }

  const { id: campaignId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "bad_request", message: "Invalid JSON body." } },
      { status: 400 },
    );
  }

  try {
    const input = parseSubmitCaptureInput(body);

    const player = await getPlayerById(session.playerId);
    if (!player) {
      return NextResponse.json(
        { error: { code: "not_found", message: "Player not found." } },
        { status: 404 },
      );
    }

    const result = await submitCapture(campaignId, player, input);
    return NextResponse.json(result);
  } catch (err) {
    if (
      isTypedDomainError(err) &&
      KNOWN_ERRORS.some((ErrorClass) => err instanceof ErrorClass)
    ) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: err.status },
      );
    }
    throw err;
  }
}
