/**
 * `GET /api/host/campaigns/[id]/ledger` — the campaign's payout ledger +
 * budget-cap summary. `POST` — mark a ledger entry settled (T4.3, PRD
 * FR-P1…FR-P3, EC-7). Thin route handler; all ledger logic lives in
 * `lib/payout/ledger.ts` (constitution §6).
 *
 * Auth: requires an authenticated staff (site-admin or host) session,
 * mirroring `app/api/host/campaigns/[id]/submissions/[sid]/decision/
 * route.ts`'s `requireStaffPrincipal` shape exactly (duplicated
 * per-route-file throughout this codebase already — matching existing
 * convention rather than introducing a new shared module this card doesn't
 * ask for). `requireCampaignAccess` (called inside
 * `lib/payout/ledger.ts`'s host-facing functions) is what actually
 * enforces "a host may only see/settle its own campaigns" — never a hidden
 * button (constitution §2).
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/config";
import { resolveStaffPrincipal, type StaffPrincipal } from "@/lib/auth/staff";
import {
  getLedgerSummaryForHost,
  markSettledForHost,
} from "@/lib/payout/ledger";

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
  params: Promise<{ id: string }>;
}

export async function GET(
  _request: Request,
  { params }: RouteContext,
): Promise<Response> {
  const principalOrResponse = await requireStaffPrincipal();
  if (principalOrResponse instanceof NextResponse) return principalOrResponse;

  const { id: campaignId } = await params;

  try {
    const summary = await getLedgerSummaryForHost(
      principalOrResponse,
      campaignId,
    );
    return NextResponse.json(summary);
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

interface SettleRequestBody {
  action?: unknown;
  ledgerEntryId?: unknown;
}

export async function POST(
  request: Request,
  { params }: RouteContext,
): Promise<Response> {
  const principalOrResponse = await requireStaffPrincipal();
  if (principalOrResponse instanceof NextResponse) return principalOrResponse;

  const { id: campaignId } = await params;

  let body: SettleRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "bad_request", message: "Invalid JSON body." } },
      { status: 400 },
    );
  }

  if (body.action !== "settle" || typeof body.ledgerEntryId !== "string") {
    return NextResponse.json(
      {
        error: {
          code: "bad_request",
          message:
            '`action` must be "settle" and `ledgerEntryId` must be a string.',
        },
      },
      { status: 400 },
    );
  }

  try {
    const entry = await markSettledForHost(
      principalOrResponse,
      campaignId,
      body.ledgerEntryId,
    );
    return NextResponse.json(entry);
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
