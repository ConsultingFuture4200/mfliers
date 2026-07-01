/**
 * Admin target import (T4.5) — PRD FR-M1, constitution §5 (site-admin-
 * guarded), §3/§1 (targets are campaign-scoped, created via the DAL).
 *
 * Two import paths, both funneled through `createTargets`
 * (`lib/db/dal/targets.ts`) so every new target row is created the same
 * way — campaign-scoped, `red`, coordinate-validated:
 * - `importTargetsFromCsv` — parses `label,lat,long` rows (requirement 1),
 *   creating a target for every well-formed row and reporting (never
 *   silently dropping — requirement/AC 2) every malformed or out-of-range
 *   row instead of failing the whole upload. NEEDS_CLARIFICATION: the
 *   card doesn't say whether one bad row should fail the entire import.
 *   Treated it as partial-success-with-report (create the good rows,
 *   report the bad ones) since that's the only reading under which "a
 *   clear report" is more useful than a single all-or-nothing error, and
 *   it keeps the two acceptance criteria ("a valid CSV creates the
 *   expected red targets" / "malformed rows are rejected with a report,
 *   not silently dropped") independently true of the same function. Flag
 *   for review if an all-or-nothing transaction was actually intended.
 * - `createPinDropTarget` — a single admin-supplied `{ label, lat, long }`
 *   (requirement 2), validated with the exact same coordinate-range rule
 *   as a CSV row.
 *
 * Constitution §6: domain logic in `lib/`, never in route handlers — both
 * exports take a `StaffPrincipal` and call `requireSiteAdmin` themselves
 * (mirrors `lib/campaign/lifecycle.ts`'s `createCampaign`: a `host`
 * principal reaches this module and is turned away here, not trusted to
 * have been filtered out by the route or the UI — constitution §2, "UI-
 * only authorization" is never sufficient).
 */
import { requireSiteAdmin } from "@/lib/auth/guards";
import type { StaffPrincipal } from "@/lib/auth/staff";
import { createTargets } from "@/lib/db/dal/targets";
import type { Target } from "@/types/domain";

// ---------------------------------------------------------------------------
// Typed errors (constitution §3: "server logic ... throws typed errors;
// route handlers translate to HTTP status + JSON error" — no silent catches)
// ---------------------------------------------------------------------------

/** Thrown for a malformed *request*, as opposed to a malformed *CSV row*
 * (those are reported, not thrown — see module doc comment). */
export class InvalidImportInputError extends Error {
  readonly status = 400 as const;
  readonly code = "invalid_import_input" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidImportInputError";
  }
}

// ---------------------------------------------------------------------------
// Coordinate validation (shared by both import paths — requirement/AC:
// "do NOT skip coordinate validation")
// ---------------------------------------------------------------------------

const LAT_MIN = -90;
const LAT_MAX = 90;
const LONG_MIN = -180;
const LONG_MAX = 180;

function isValidLat(lat: number): boolean {
  return Number.isFinite(lat) && lat >= LAT_MIN && lat <= LAT_MAX;
}

function isValidLong(long: number): boolean {
  return Number.isFinite(long) && long >= LONG_MIN && long <= LONG_MAX;
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/** One well-formed `label,lat,long` row, ready to hand to `createTargets`. */
export interface CsvTargetRow {
  label: string;
  lat: number;
  long: number;
}

/** One rejected row (requirement/AC: "reject ... with a clear report, not
 * silently dropped"). `line` is 1-indexed against the raw CSV text so a
 * caller can point back at exactly what was wrong. */
export interface CsvRowError {
  line: number;
  raw: string;
  reason: string;
}

export interface CsvParseResult {
  rows: CsvTargetRow[];
  errors: CsvRowError[];
}

/** True for a `label,lat,long` header row (case-insensitive, optional
 * "latitude"/"longitude" spelling) — skipped rather than reported as
 * malformed when it's the first line. */
function isHeaderRow(fields: readonly string[]): boolean {
  const [label, lat, long] = fields;
  return (
    /^label$/i.test(label ?? "") &&
    /^lat(itude)?$/i.test(lat ?? "") &&
    /^long(itude)?$/i.test(long ?? "")
  );
}

/**
 * Parses CSV text of `label,lat,long` rows. Blank lines are skipped
 * silently (not malformed — just formatting); an optional header row on
 * line 1 is recognized and skipped; every other line is either a valid
 * row or a reported error — never silently dropped.
 */
export function parseTargetsCsv(csvText: string): CsvParseResult {
  const rows: CsvTargetRow[] = [];
  const errors: CsvRowError[] = [];
  const lines = csvText.split(/\r\n|\r|\n/);

  lines.forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;

    const fields = trimmed.split(",").map((field) => field.trim());
    if (line === 1 && isHeaderRow(fields)) return;

    if (fields.length !== 3) {
      errors.push({
        line,
        raw,
        reason: `expected 3 fields (label,lat,long), found ${fields.length}`,
      });
      return;
    }

    const [label, latRaw, longRaw] = fields;
    if (!label) {
      errors.push({ line, raw, reason: "label is required" });
      return;
    }

    const lat = Number(latRaw);
    const long = Number(longRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(long)) {
      errors.push({ line, raw, reason: "lat/long must be numbers" });
      return;
    }
    if (!isValidLat(lat) || !isValidLong(long)) {
      errors.push({
        line,
        raw,
        reason: `lat/long out of range (lat must be ${LAT_MIN}..${LAT_MAX}, long must be ${LONG_MIN}..${LONG_MAX})`,
      });
      return;
    }

    rows.push({ label, lat, long });
  });

  return { rows, errors };
}

// ---------------------------------------------------------------------------
// Import actions
// ---------------------------------------------------------------------------

export interface CsvImportReport {
  created: Target[];
  errors: CsvRowError[];
}

/**
 * Parses `csvText` and creates a campaign-scoped, `red` target for every
 * well-formed row (requirement 1/3). Malformed/out-of-range rows never
 * reach the DAL — they come back in `errors` instead (requirement/AC 2).
 * Site-admin only (requirement 4).
 */
export async function importTargetsFromCsv(
  principal: StaffPrincipal,
  campaignId: string,
  csvText: string,
): Promise<CsvImportReport> {
  requireSiteAdmin(principal);
  if (typeof csvText !== "string" || csvText.trim().length === 0) {
    throw new InvalidImportInputError("csv text is required.");
  }
  const { rows, errors } = parseTargetsCsv(csvText);
  const created = await createTargets(campaignId, rows);
  return { created, errors };
}

/** Untyped pin-drop input, as received off a JSON request body. */
export interface PinDropInput {
  label: unknown;
  lat: unknown;
  long: unknown;
}

/**
 * Creates a single campaign-scoped, `red` target at an admin-dropped pin
 * location (requirement 2/3). Site-admin only (requirement 4).
 */
export async function createPinDropTarget(
  principal: StaffPrincipal,
  campaignId: string,
  input: PinDropInput,
): Promise<Target> {
  requireSiteAdmin(principal);

  if (typeof input.label !== "string" || input.label.trim().length === 0) {
    throw new InvalidImportInputError("label is required.");
  }
  if (typeof input.lat !== "number" || !isValidLat(input.lat)) {
    throw new InvalidImportInputError(
      `lat must be a number in ${LAT_MIN}..${LAT_MAX}.`,
    );
  }
  if (typeof input.long !== "number" || !isValidLong(input.long)) {
    throw new InvalidImportInputError(
      `long must be a number in ${LONG_MIN}..${LONG_MAX}.`,
    );
  }

  const [created] = await createTargets(campaignId, [
    { label: input.label, lat: input.lat, long: input.long },
  ]);
  return created;
}
