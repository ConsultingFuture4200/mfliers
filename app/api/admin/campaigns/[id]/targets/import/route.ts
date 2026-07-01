/**
 * POST /api/admin/campaigns/[id]/targets/import — the single endpoint
 * behind both T4.5 import paths, discriminated by a `mode` field in the
 * JSON body:
 * - `{ mode: "csv", csv: string }` — CSV upload (requirement 1).
 * - `{ mode: "pin", label, lat, long }` — manual pin-drop (requirement 2).
 *
 * One route handles both because the card's Files list names exactly one
 * route file for target import; a JSON-body discriminator (rather than
 * `multipart/form-data`) keeps this route handler thin and matches the
 * rest of the codebase's JSON-body convention (e.g.
 * `app/api/admin/campaigns/route.ts`) — the CSV-upload UI
 * (`app/admin/campaigns/[id]/targets/TargetImportForm.tsx`) reads the
 * chosen file client-side with `File.text()` and sends its contents as a
 * JSON string rather than a multipart stream.
 *
 * Thin route handler; all domain logic (site-admin guard, coordinate
 * validation, the writes) lives in `lib/target/csv-import.ts`
 * (constitution §6). Auth mirrors `app/api/admin/campaigns/route.ts`'s
 * `requireStaffPrincipal` — a fresh `StaffPrincipal` resolved per request,
 * never trusted from a cached session field (constitution §5) — and both
 * `lib/target/csv-import.ts` exports call `requireSiteAdmin` themselves,
 * so a `host` principal reaches the DAL boundary and is turned away there
 * (403), not merely by this route not calling it (constitution §2: UI/
 * route-only gating is never sufficient on its own).
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/config";
import { resolveStaffPrincipal, type StaffPrincipal } from "@/lib/auth/staff";
import {
  createPinDropTarget,
  importTargetsFromCsv,
} from "@/lib/target/csv-import";

interface RouteContext {
  params: Promise<{ id: string }>;
}

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

function errorResponse(err: unknown): NextResponse {
  if (isTypedDomainError(err)) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message } },
      { status: err.status },
    );
  }
  throw err;
}

interface ImportBody {
  mode?: unknown;
  csv?: unknown;
  label?: unknown;
  lat?: unknown;
  long?: unknown;
}

export async function POST(
  request: Request,
  { params }: RouteContext,
): Promise<Response> {
  const principalOrResponse = await requireStaffPrincipal();
  if (principalOrResponse instanceof NextResponse) return principalOrResponse;

  const { id: campaignId } = await params;

  let body: ImportBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "bad_request", message: "Invalid JSON body." } },
      { status: 400 },
    );
  }

  try {
    if (body.mode === "pin") {
      const created = await createPinDropTarget(
        principalOrResponse,
        campaignId,
        { label: body.label, lat: body.lat, long: body.long },
      );
      return NextResponse.json(
        { created: [created], errors: [] },
        {
          status: 201,
        },
      );
    }

    if (body.mode === "csv") {
      if (typeof body.csv !== "string") {
        return NextResponse.json(
          {
            error: {
              code: "bad_request",
              message: "csv (string) is required for mode 'csv'.",
            },
          },
          { status: 400 },
        );
      }
      const report = await importTargetsFromCsv(
        principalOrResponse,
        campaignId,
        body.csv,
      );
      return NextResponse.json(report, { status: 201 });
    }

    return NextResponse.json(
      {
        error: {
          code: "bad_request",
          message: "mode must be 'csv' or 'pin'.",
        },
      },
      { status: 400 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
