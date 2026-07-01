/**
 * POST /api/uploads/sign — issues a short-lived signed R2 PUT URL for a
 * submission photo (T2.4). Thin route handler; all storage logic lives in
 * `lib/storage/r2.ts` (constitution §6: domain logic in `lib/`, never in
 * route handlers).
 *
 * Auth: requires an authenticated **player** session (constitution §5:
 * authorization is server-side, always — an unauthenticated caller could
 * otherwise mint write access to arbitrary keys in the bucket). The
 * submission id is minted server-side (`crypto.randomUUID()`), never
 * accepted from the client, so a caller can never choose (and overwrite)
 * another submission's object key.
 *
 * This route checks the caller is a **member** of the target campaign
 * (via the T2.1 campaign-memberships DAL) and, per T4.1's tightening
 * (batch-4 review fix, Linus), that the caller has an **active claim** on
 * `targetId` (`lib/target/state-machine.ts`'s `isActivelyClaimedBy`)
 * before minting a signed URL: a player token only authorizes joined
 * campaigns, and now only a target they've actually claimed (constitution
 * §5). Without this, any campaign member could mint unlimited short-lived
 * signed PUT URLs unrelated to any claim, at zero server-side rate limit,
 * a storage-cost/DoS surface (not a fraud bypass end-to-end:
 * `lib/capture/submit.ts`'s `submitCapture` already independently calls
 * `isActivelyClaimedBy` before a submission can be persisted/paid).
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/config";
import { getCampaignById } from "@/lib/db/dal/campaigns";
import { getMembership } from "@/lib/db/dal/campaign-memberships";
import { getTarget } from "@/lib/db/dal/targets";
import { isActivelyClaimedBy } from "@/lib/target/state-machine";
import { createSignedUploadUrl } from "@/lib/storage/r2";

interface SignUploadBody {
  campaignId?: unknown;
  targetId?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  const session = await auth();
  if (!session || session.principalType !== "player" || !session.playerId) {
    return NextResponse.json(
      {
        error: {
          code: "unauthorized",
          message: "A player session is required to request an upload URL.",
        },
      },
      { status: 401 },
    );
  }

  let body: SignUploadBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "bad_request", message: "Invalid JSON body." } },
      { status: 400 },
    );
  }

  const campaignId = body.campaignId;
  if (typeof campaignId !== "string" || campaignId.trim().length === 0) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_campaign_id",
          message: "A non-empty `campaignId` string is required.",
        },
      },
      { status: 400 },
    );
  }

  const targetId = body.targetId;
  if (typeof targetId !== "string" || targetId.trim().length === 0) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_target_id",
          message: "A non-empty `targetId` string is required.",
        },
      },
      { status: 400 },
    );
  }

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

  const target = await getTarget(campaignId, targetId);
  if (!target) {
    return NextResponse.json(
      { error: { code: "not_found", message: "Target not found." } },
      { status: 404 },
    );
  }
  if (!isActivelyClaimedBy(target, session.playerId)) {
    return NextResponse.json(
      {
        error: {
          code: "forbidden",
          message: "You do not have an active claim on this target.",
        },
      },
      { status: 403 },
    );
  }

  const submissionId = randomUUID();

  try {
    const signed = await createSignedUploadUrl(campaignId, submissionId);
    return NextResponse.json({
      uploadUrl: signed.url,
      key: signed.key,
      submissionId,
      expiresInSeconds: signed.expiresInSeconds,
    });
  } catch {
    // Never leak R2 credential/config error detail (constitution §5/§8 —
    // secrets in env only) to the client.
    return NextResponse.json(
      {
        error: {
          code: "sign_failed",
          message: "Could not create an upload URL. Try again shortly.",
        },
      },
      { status: 502 },
    );
  }
}
