/**
 * Shared column helpers for the Drizzle schema.
 *
 * Constitution §3 (geospatial): "coordinates stored as PostGIS
 * geography(Point, 4326); distance checks use ST_DWithin in meters, not
 * hand-rolled haversine in app code."
 *
 * Drizzle's typed pg-core builder has no native `geography` column type, so
 * this uses the documented raw-SQL escape hatch (`customType`) to declare the
 * column's Postgres DDL type directly. Reading/writing WKT and running
 * `ST_DWithin`/`ST_Distance` queries against this column is the
 * data-access layer's job (T2.1) — this task only needs the column to exist
 * with the correct type, constraints, and a GiST index where required.
 */
import { customType, timestamp } from "drizzle-orm/pg-core";

/**
 * A PostGIS `geography(Point,4326)` column.
 *
 * This `customType` declares no `toDriver`/`fromDriver`, so there is no
 * automatic WKT<->JS round-trip — the `data: string` shape is only honored
 * on the write path (Postgres accepts WKT/EWKT text for a `geography` column
 * via implicit input-function casting), and only reliably when writing
 * through raw SQL, e.g. `sql\`ST_GeogFromText(${wkt})\``.
 *
 * On read, a plain `select()` through the typed query builder returns
 * Postgres's default text output for `geography`, which is **hex-encoded
 * EWKB** (e.g. `0101000020E6100000...`), NOT WKT. Any caller that needs
 * lat/long must explicitly wrap the column in `ST_AsText`/`ST_X`/`ST_Y` (or
 * an equivalent raw-SQL cast) — this is the data-access layer's job (T2.1),
 * not something this column type does for you.
 */
export const geographyPoint = customType<{ data: string }>({
  dataType() {
    return "geography(Point,4326)";
  },
});

/**
 * A `timestamptz` column, mapped to a JS `Date`. Constitution §3 (time):
 * "all timestamps stored UTC." `timestamptz` + JS `Date` is the pairing
 * Postgres/Drizzle use to guarantee UTC storage regardless of session
 * timezone.
 */
export function timestamptz(name: string) {
  return timestamp(name, { withTimezone: true, mode: "date" });
}
