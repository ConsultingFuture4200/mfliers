/**
 * Lat/long <-> PostGIS `geography(Point,4326)` codec.
 *
 * `lib/db/schema/columns.ts`'s `geographyPoint` customType deliberately
 * declares no `toDriver`/`fromDriver` (see that file's doc comment): a
 * plain typed-builder `select()` of a geography column returns Postgres's
 * raw text output for the type, which is **hex-encoded EWKB**
 * (`0101000020E6100000...`), not WKT — and a plain `insert()` relies on an
 * implicit WKT-text->geography input-function cast. T1.3 deliberately
 * deferred fixing this to the DAL (T2.1's carry-forward note). This module
 * is that single choke point: every DAL read goes through `latOf`/`longOf`
 * (wrapping the column in `ST_Y`/`ST_X` against the geometry cast) so
 * callers get plain numbers, and every DAL write goes through
 * `toGeography` (explicit `ST_SetSRID(ST_MakePoint(...), 4326)`) so the
 * SRID is never left to an implicit cast. No caller outside this module
 * should ever see hex EWKB.
 *
 * `distanceMeters` (T3.4) extends this module's role from "column codec"
 * to "the one place PostGIS geography math happens": it computes
 * `ST_Distance` between two literal `{ lat, long }` coordinates that don't
 * come from a table at all (e.g. a submission's device GPS vs. its own
 * EXIF GPS, or two submissions' device GPS) — there is no campaign-scoped
 * row to look up, so it deliberately does NOT take a `campaignId` (it is
 * not one of `tests/isolation/isolation.test.ts`'s scoped modules; see
 * that suite's "DAL typed surface" block, which only iterates
 * campaigns/targets/submissions/campaignMemberships/payoutLedger). A
 * proximity check against an actual `targets` row's `location` column
 * still goes through `lib/db/dal/targets.ts` (campaign-scoped, uses
 * `ST_DWithin` directly against the indexed column) rather than this
 * function, so the GiST index stays usable for that case.
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db/client";
import type { Coordinate } from "@/types/domain";

/**
 * Write-side SQL fragment: builds a SRID-4326 geography point from a typed
 * `{ lat, long }` coordinate. Use as the value for a `geography(Point,4326)`
 * column in an `insert`/`update` — e.g.
 * `db.insert(targets).values({ location: toGeography(coord), ... })`.
 */
export function toGeography(coord: Coordinate): SQL {
  return sql`ST_SetSRID(ST_MakePoint(${coord.long}, ${coord.lat}), 4326)::geography`;
}

/**
 * Read-side SQL fragment: latitude (degrees, WGS84) of a
 * `geography(Point,4326)` column. Use inside a `select()` projection.
 */
export function latOf(column: AnyPgColumn): SQL<number> {
  return sql<number>`ST_Y(${column}::geometry)`;
}

/**
 * Read-side SQL fragment: longitude (degrees, WGS84) of a
 * `geography(Point,4326)` column. Use inside a `select()` projection.
 */
export function longOf(column: AnyPgColumn): SQL<number> {
  return sql<number>`ST_X(${column}::geometry)`;
}

/**
 * PostGIS great-circle distance (meters) between two literal WGS84
 * coordinates, via `ST_Distance` on ad-hoc `geography(Point,4326)` values
 * (constitution §3 — never hand-rolled haversine in app code). Used by the
 * fraud checks (T3.4, `lib/fraud/geo.ts`/`lib/fraud/time.ts`) that compare
 * two points neither of which needs a table lookup.
 */
export async function distanceMeters(
  a: Coordinate,
  b: Coordinate,
): Promise<number> {
  const rows = await db.execute<{ distance: number }>(
    sql`SELECT ST_Distance(${toGeography(a)}, ${toGeography(b)}) AS distance`,
  );
  return Number(rows[0].distance);
}
