/**
 * Tier-table shape validation (T3.1, card requirement 2).
 *
 * PRD §3: "tier breakpoints, payout amounts ... are per-campaign
 * configuration set by site admin at creation." Constitution §3: money is
 * integer cents, and "tier math computed server-side only." This module
 * validates the *shape* of a `tier_table` at campaign create/update time —
 * it does not do the tier lookup itself (that's T4.3's job, applied against
 * a player's `approvedCount`).
 *
 * A valid tier table is:
 * - non-empty
 * - every band's `minCount`/`payoutCents` a non-negative integer, and
 *   `maxCount` either `null` or an integer >= that band's `minCount`
 * - ordered and contiguous with no gap or overlap: band `i`'s `minCount`
 *   equals band `i-1`'s `maxCount + 1`
 * - the first band starts at `minCount: 0` (every approved-count total
 *   must land in some band)
 * - exactly the last band is open-ended (`maxCount: null`) — an "and
 *   above" top band; no earlier band may be open-ended (that would make
 *   every band after it unreachable, which is really the same shape as an
 *   overlap/gap bug)
 */
import type { TierTable } from "@/types/domain";

/**
 * Thrown when a `tierTable` fails the ordered/contiguous/non-overlapping/
 * open-top-band contract. Carries `status = 400` so a route handler can
 * translate it directly (constitution §3: "server logic ... throws typed
 * errors; route handlers translate to HTTP status + JSON error").
 */
export class InvalidTierTableError extends Error {
  readonly status = 400 as const;
  readonly code = "invalid_tier_table" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidTierTableError";
  }
}

/**
 * Validates `tierTable`. Throws `InvalidTierTableError` describing the
 * first violation found; returns normally (`void`) when the table is
 * valid. Never mutates or reorders the input — a caller-supplied table
 * that isn't already sorted by `minCount` is rejected as non-contiguous
 * rather than silently sorted, since an out-of-order table is itself a
 * sign the caller's bands don't mean what they say.
 */
export function validateTierTable(tierTable: TierTable): void {
  if (!Array.isArray(tierTable) || tierTable.length === 0) {
    throw new InvalidTierTableError(
      "tierTable must be a non-empty array of bands.",
    );
  }

  tierTable.forEach((band, i) => {
    if (!Number.isInteger(band.minCount) || band.minCount < 0) {
      throw new InvalidTierTableError(
        `band ${i}: minCount must be a non-negative integer.`,
      );
    }
    if (band.maxCount !== null) {
      if (!Number.isInteger(band.maxCount) || band.maxCount < band.minCount) {
        throw new InvalidTierTableError(
          `band ${i}: maxCount must be null (open-ended) or an integer >= minCount.`,
        );
      }
    }
    if (!Number.isInteger(band.payoutCents) || band.payoutCents < 0) {
      throw new InvalidTierTableError(
        `band ${i}: payoutCents must be a non-negative integer (cents) — ` +
          "never a float (constitution §3).",
      );
    }
  });

  if (tierTable[0].minCount !== 0) {
    throw new InvalidTierTableError(
      "the first band must start at minCount 0 — every approved count must " +
        "land in some band.",
    );
  }

  for (let i = 1; i < tierTable.length; i++) {
    const prev = tierTable[i - 1];
    const curr = tierTable[i];
    if (prev.maxCount === null) {
      throw new InvalidTierTableError(
        `band ${i - 1} is open-ended (maxCount: null) but is not the last ` +
          "band — only the final band may be open-ended.",
      );
    }
    if (curr.minCount !== prev.maxCount + 1) {
      throw new InvalidTierTableError(
        `band ${i}: minCount (${curr.minCount}) must equal the previous ` +
          `band's maxCount + 1 (${prev.maxCount + 1}) — bands must be ` +
          "contiguous with no gap or overlap.",
      );
    }
  }

  const lastBand = tierTable[tierTable.length - 1];
  if (lastBand.maxCount !== null) {
    throw new InvalidTierTableError(
      "the last band must be open-ended (maxCount: null) — an 'and above' " +
        "top band.",
    );
  }
}
