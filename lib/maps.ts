/**
 * Builds a Google Maps URL that lands on a target's **business page** by
 * searching for its name (our targets are named businesses, geocoded to
 * city-level coordinates — so a raw lat/long link only drops a generic pin,
 * not the business listing). Falls back to coordinates when there's no name.
 *
 * Uses the documented Maps URLs API (`?api=1&query=`), which is stable across
 * Google URL-format changes.
 */
export function businessMapsUrl(
  name: string,
  lat: number,
  long: number,
): string {
  const query = name.trim() ? name.trim() : `${lat},${long}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
