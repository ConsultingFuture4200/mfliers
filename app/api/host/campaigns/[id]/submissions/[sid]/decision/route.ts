/**
 * `POST /api/host/campaigns/[id]/submissions/[sid]/decision` — approve,
 * reject, or manually adjust a `needs_review` submission (T4.2, PRD
 * FR-R1…FR-R4). Thin route handler; all decision logic lives in
 * `lib/review/decision.ts` (constitution §6).
 *
 * Auth: requires an authenticated staff (site-admin or host) session,
 * mirroring `app/api/admin/campaigns/[id]/route.ts`'s
 * `requireStaffPrincipal` shape exactly (that helper is duplicated
 * per-route-file throughout this codebase already, not shared — matching
 * existing convention rather than introducing a new shared module this
 * card doesn't ask for). `requireCampaignAccess` (called inside
 * `lib/review/decision.ts`) is what actually enforces "a host may only
 * act on its own campaigns" (card anti-requirement 1) — never a hidden
 * button (constitution §2).
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/config";
import { resolveStaffPrincipal, type StaffPrincipal } from "@/lib/auth/staff";
import {
  approveSubmission,
  rejectSubmission,
  recordManualAdjustmentForSubmission,
} from "@/lib/review/decision";

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

function isTypedDomainError(
  err: unknown,
): err is Error & { status: number; code: string } {
  return (
    err instanceof Error &&
    typeof (err as { status?: unknown }).status === "number" &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

interface RouteContext {
  params: Promise<{ id: string; sid: string }>;
}

interface DecisionRequestBody {
  action?: unknown;
  reasonCode?: unknown;
}

export async function POST(
  request: Request,
  { params }: RouteContext,
): Promise<Response> {
  const principalOrResponse = await requireStaffPrincipal();
  if (principalOrResponse instanceof NextResponse) return principalOrResponse;

  const { id: campaignId, sid: submissionId } = await params;

  let body: DecisionRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "bad_request", message: "Invalid JSON body." } },
      { status: 400 },
    );
  }

  const reasonCode =
    typeof body.reasonCode === "string" ? body.reasonCode : undefined;

  try {
    switch (body.action) {
      case "approve": {
        const result = await approveSubmission(
          principalOrResponse,
          campaignId,
          submissionId,
          reasonCode,
        );
        return NextResponse.json(result);
      }
      case "reject": {
        if (!reasonCode) {
          return NextResponse.json(
            {
              error: {
                code: "reason_required",
                message: "reasonCode is required to reject a submission.",
              },
            },
            { status: 400 },
          );
        }
        const result = await rejectSubmission(
          principalOrResponse,
          campaignId,
          submissionId,
          reasonCode,
        );
        return NextResponse.json(result);
      }
      case "adjust": {
        if (!reasonCode) {
          return NextResponse.json(
            {
              error: {
                code: "reason_required",
                message: "reasonCode is required to record an adjustment.",
              },
            },
            { status: 400 },
          );
        }
        await recordManualAdjustmentForSubmission(
          principalOrResponse,
          campaignId,
          submissionId,
          reasonCode,
        );
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json(
          {
            error: {
              code: "bad_request",
              message: '`action` must be "approve", "reject", or "adjust".',
            },
          },
          { status: 400 },
        );
    }
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
