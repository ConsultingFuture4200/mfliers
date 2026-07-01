/**
 * POST /api/admin/campaigns — creates a campaign (T3.1, PRD FR-C1). Thin
 * route handler; all domain logic (validation, authorization, the write)
 * lives in `lib/campaign/lifecycle.ts` (constitution §6).
 *
 * Auth: requires an authenticated staff session; `createCampaign` itself
 * calls `requireSiteAdmin` (constitution §5 — a host may never create a
 * campaign in v1, per this card's anti-requirements), so a `host`
 * principal reaches the DAL call, is rejected there, and this route
 * translates that `ForbiddenError` to a 403 — the guard is enforced
 * server-side regardless of what the UI would have shown a host.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/config";
import { resolveStaffPrincipal, type StaffPrincipal } from "@/lib/auth/staff";
import {
  createCampaign,
  type CreateCampaignInput,
} from "@/lib/campaign/lifecycle";
import type { TierTable } from "@/types/domain";

/**
 * Resolves the calling staff principal fresh from the DB (constitution §5:
 * authorization resolved server-side per request, never trusted from a
 * cached session field). Returns a ready-to-send `NextResponse` in place
 * of a principal when the caller isn't an authenticated staff session.
 */
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

/** Structural guard for the typed domain errors thrown by
 * `lib/campaign/lifecycle.ts`/`lib/campaign/tier-validation.ts`/
 * `lib/auth/guards.ts` — every one of them carries a numeric `status` and
 * a string `code` (constitution §3: "server logic ... throws typed
 * errors; route handlers translate to HTTP status + JSON error"). Re-
 * thrown for anything unrecognized so a genuine bug still surfaces loudly
 * instead of being swallowed into a generic 500 with no detail. */
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

interface CreateCampaignBody {
  name?: unknown;
  flierImageUrl?: unknown;
  budgetCapCents?: unknown;
  tierTable?: unknown;
  grandPrize?: unknown;
  privacySetting?: unknown;
  proximityRadiusM?: unknown;
  hostId?: unknown;
  startAt?: unknown;
  endAt?: unknown;
}

/** Converts an untyped JSON body into `CreateCampaignInput`. Deliberately
 * does the bare minimum shape coercion here (Dates aren't JSON-native);
 * every actual value/shape check (non-empty strings, integer cents, tier
 * table contiguity, date ordering) happens in
 * `lib/campaign/lifecycle.ts`, not here. */
function toCreateInput(body: CreateCampaignBody): CreateCampaignInput {
  return {
    name: typeof body.name === "string" ? body.name : "",
    flierImageUrl:
      typeof body.flierImageUrl === "string" ? body.flierImageUrl : undefined,
    budgetCapCents:
      typeof body.budgetCapCents === "number" ? body.budgetCapCents : NaN,
    tierTable: (body.tierTable ?? []) as TierTable,
    grandPrize: typeof body.grandPrize === "string" ? body.grandPrize : "",
    privacySetting:
      body.privacySetting === "public_username" ||
      body.privacySetting === "admin_only"
        ? body.privacySetting
        : "admin_only",
    proximityRadiusM:
      typeof body.proximityRadiusM === "number" ? body.proximityRadiusM : NaN,
    hostId: typeof body.hostId === "string" ? body.hostId : "",
    startAt: new Date(typeof body.startAt === "string" ? body.startAt : NaN),
    endAt: new Date(typeof body.endAt === "string" ? body.endAt : NaN),
  };
}

export async function POST(request: Request): Promise<Response> {
  const principalOrResponse = await requireStaffPrincipal();
  if (principalOrResponse instanceof NextResponse) return principalOrResponse;

  let body: CreateCampaignBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "bad_request", message: "Invalid JSON body." } },
      { status: 400 },
    );
  }

  try {
    const campaign = await createCampaign(
      principalOrResponse,
      toCreateInput(body),
    );
    return NextResponse.json({ campaign }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
