/**
 * `/api/admin/campaigns/[id]` — read, update-configuration, and
 * lifecycle-transition for a single campaign (T3.1). Thin route handler;
 * all domain logic lives in `lib/campaign/lifecycle.ts` (constitution §6).
 *
 * `GET` is scoped by `requireCampaignAccess` (a host may read only its own
 * campaigns; a site admin, any). `PATCH` requests a lifecycle transition
 * when the body's only field is `state` (`"live"` or `"closed"`) —
 * dispatched to `activateCampaign`/`closeCampaign`, both of which are
 * site-admin only, per this card's anti-requirement ("do NOT allow hosts
 * to create campaigns" extends to hosts changing lifecycle state, since
 * PRD FR-C1/FR-C2 name the site admin as the sole actor for both). Any
 * other `PATCH` body is treated as a configuration-fields update
 * (`updateCampaign`), also site-admin only.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/config";
import { requireCampaignAccess, ForbiddenError } from "@/lib/auth/guards";
import { resolveStaffPrincipal, type StaffPrincipal } from "@/lib/auth/staff";
import { getCampaignById } from "@/lib/db/dal/campaigns";
import {
  activateCampaign,
  closeCampaign,
  updateCampaign,
  type UpdateCampaignInput,
} from "@/lib/campaign/lifecycle";
import type { TierTable } from "@/types/domain";

async function requireStaffPrincipal(): Promise<StaffPrincipal | NextResponse> {
  const session = await auth();
  if (
    !session ||
    (session.principalType !== "site_admin" &&
      session.principalType !== "host") ||
    !session.userId
  ) {
    return NextResponse.json(
      {
        error: {
          code: "unauthorized",
          message: "A staff (host/site-admin) session is required.",
        },
      },
      { status: 401 },
    );
  }
  const principal = await resolveStaffPrincipal(session.userId);
  if (!principal) {
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
  return principal;
}

/** See the matching comment in `../route.ts` — same structural guard over
 * the typed domain errors this module's collaborators throw. */
function isTypedDomainError(
  err: unknown,
): err is Error & { status: number; code: string } {
  return (
    err instanceof Error &&
    typeof (err as { status?: unknown }).status === "number" &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

function errorResponse(err: unknown): NextResponse {
  if (isTypedDomainError(err)) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message } },
      { status: err.status },
    );
  }
  throw err;
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  _request: Request,
  { params }: RouteContext,
): Promise<Response> {
  const principalOrResponse = await requireStaffPrincipal();
  if (principalOrResponse instanceof NextResponse) return principalOrResponse;

  const { id: campaignId } = await params;
  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    return NextResponse.json(
      { error: { code: "not_found", message: "Campaign not found." } },
      { status: 404 },
    );
  }

  try {
    requireCampaignAccess(principalOrResponse, campaignId);
  } catch (err) {
    if (err instanceof ForbiddenError) return errorResponse(err);
    throw err;
  }

  return NextResponse.json({ campaign });
}

interface PatchCampaignBody {
  state?: unknown;
  name?: unknown;
  flierImageUrl?: unknown;
  budgetCapCents?: unknown;
  tierTable?: unknown;
  grandPrize?: unknown;
  privacySetting?: unknown;
  proximityRadiusM?: unknown;
  startAt?: unknown;
  endAt?: unknown;
}

function toUpdateInput(body: PatchCampaignBody): UpdateCampaignInput {
  const patch: UpdateCampaignInput = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.flierImageUrl === "string") {
    patch.flierImageUrl = body.flierImageUrl;
  }
  if (typeof body.budgetCapCents === "number") {
    patch.budgetCapCents = body.budgetCapCents;
  }
  if (body.tierTable !== undefined) {
    patch.tierTable = body.tierTable as TierTable;
  }
  if (typeof body.grandPrize === "string") patch.grandPrize = body.grandPrize;
  if (
    body.privacySetting === "public_username" ||
    body.privacySetting === "admin_only"
  ) {
    patch.privacySetting = body.privacySetting;
  }
  if (typeof body.proximityRadiusM === "number") {
    patch.proximityRadiusM = body.proximityRadiusM;
  }
  if (typeof body.startAt === "string") patch.startAt = new Date(body.startAt);
  if (typeof body.endAt === "string") patch.endAt = new Date(body.endAt);
  return patch;
}

export async function PATCH(
  request: Request,
  { params }: RouteContext,
): Promise<Response> {
  const principalOrResponse = await requireStaffPrincipal();
  if (principalOrResponse instanceof NextResponse) return principalOrResponse;

  const { id: campaignId } = await params;

  let body: PatchCampaignBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "bad_request", message: "Invalid JSON body." } },
      { status: 400 },
    );
  }

  try {
    if (body.state !== undefined) {
      const otherKeys = Object.keys(body).filter((k) => k !== "state");
      if (otherKeys.length > 0) {
        return NextResponse.json(
          {
            error: {
              code: "bad_request",
              message:
                "A `state` transition must be requested on its own, with " +
                "no other fields in the same request.",
            },
          },
          { status: 400 },
        );
      }
      if (body.state === "live") {
        const campaign = await activateCampaign(
          principalOrResponse,
          campaignId,
        );
        return NextResponse.json({ campaign });
      }
      if (body.state === "closed") {
        const result = await closeCampaign(principalOrResponse, campaignId);
        return NextResponse.json(result);
      }
      return NextResponse.json(
        {
          error: {
            code: "bad_request",
            message: '`state` must be "live" or "closed".',
          },
        },
        { status: 400 },
      );
    }

    const campaign = await updateCampaign(
      principalOrResponse,
      campaignId,
      toUpdateInput(body),
    );
    return NextResponse.json({ campaign });
  } catch (err) {
    return errorResponse(err);
  }
}
