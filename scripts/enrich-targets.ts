/**
 * One-time target enrichment from OpenStreetMap (operator direction).
 *
 * Our targets were geocoded from business names to city-level coordinates, so
 * a target row only has {label, location}. This backfill searches Nominatim by
 * business name (biased to the target's coordinates) and stores whatever OSM
 * has — address / phone / website / hours — into `targets.place_details`, so
 * the campaign pin sheet can show a place card. OSM coverage is partial; a
 * business with no OSM match keeps `place_details = null`.
 *
 * Photos/ratings/hours-for-every-business are NOT available from OSM — those
 * need the Google Places API (a separate, keyed integration).
 *
 * Run against a DB you control (never CI):
 *   DATABASE_URL=postgres://... pnpm tsx scripts/enrich-targets.ts
 */
import postgres from "postgres";

const UA = "mfliers-enrich/1.0 (consultingfutures@gmail.com)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Details {
  address?: string;
  phone?: string;
  website?: string;
  hours?: string;
}

async function lookup(
  name: string,
  lat: number,
  long: number,
): Promise<Details | null> {
  // Bias the name search to a ~55km box around the target so a common name
  // resolves to the right locale (bounded=1), then rate-limit per OSM policy.
  const d = 0.5;
  const params = new URLSearchParams({
    format: "jsonv2",
    limit: "1",
    addressdetails: "1",
    extratags: "1",
    q: name,
    viewbox: `${long - d},${lat - d},${long + d},${lat + d}`,
    bounded: "1",
  });
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?${params}`,
    { headers: { "User-Agent": UA } },
  );
  await sleep(1200);
  if (!res.ok) return null;
  const arr = (await res.json()) as Array<{
    address?: Record<string, string>;
    extratags?: Record<string, string>;
  }>;
  if (!arr.length) return null;

  const a = arr[0].address ?? {};
  const e = arr[0].extratags ?? {};
  const address = [
    [a.house_number, a.road].filter(Boolean).join(" "),
    a.city || a.town || a.village,
    a.state,
    a.postcode,
  ]
    .filter(Boolean)
    .join(", ");

  const details: Details = {};
  if (address) details.address = address;
  const phone = e.phone || e["contact:phone"];
  if (phone) details.phone = phone;
  const website = e.website || e["contact:website"];
  if (website) details.website = website;
  if (e.opening_hours) details.hours = e.opening_hours;

  return Object.keys(details).length ? details : null;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required.");
  const sql = postgres(url, { prepare: false, max: 1 });

  const rows = await sql<
    { id: string; label: string; lat: number; long: number }[]
  >`
    select id, label,
           ST_Y(location::geometry) as lat,
           ST_X(location::geometry) as long
    from targets
    order by label
  `;

  let hits = 0;
  for (const t of rows) {
    const d = await lookup(t.label, Number(t.lat), Number(t.long)).catch(
      () => null,
    );
    if (d) {
      await sql`update targets set place_details = ${sql.json(d as Record<string, string>)} where id = ${t.id}`;
      hits++;
      console.log(`  ✓ ${t.label} -> ${d.address ?? "(details)"}`);
    } else {
      console.log(`  · ${t.label} (no OSM match)`);
    }
  }

  console.log(`\nEnriched ${hits}/${rows.length} targets.`);
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
