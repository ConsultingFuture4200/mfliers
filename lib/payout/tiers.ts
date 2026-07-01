/**
 * Tier lookup (T4.3) — PRD FR-P1 / constitution §3: "Tier math is computed
 * server-side only — never trust a client-supplied amount." Pure functions
 * only; no DB access (that's `lib/db/dal/payout-ledger.ts`'s job) and no
 * hard-coded Mycofest numbers (card anti-requirement) — every function here
 * takes the campaign's own `tierTable` as an argument.
 *
 * ## The "count" convention (card acceptance criterion: "counts 10/11 and
 * 25/26 yield the correct band amount")
 * Mycofest's example table (card): "T1 (1–10) $1.25, T2 (11–25) $1.75, T3
 * (26+) $2.25" is stored as `[{minCount:0,maxCount:10,...}, {minCount:11,
 * maxCount:25,...}, {minCount:26,maxCount:null,...}]` (T3.1's
 * `validateTierTable` shape — first band starts at `minCount: 0`). For this
 * to literally match "the 1st through 10th approved submission earns
 * tier 1," the `count` passed to `lookupTierBand` must be the *ordinal*
 * number of this approval — i.e. `priorApprovedCount + 1` — not the raw
 * prior `approved_count` a membership row carries before this accrual:
 *   - submission #1  -> count=1  -> band [0,10]  -> tier 1 ($1.25)
 *   - submission #10 -> count=10 -> band [0,10]  -> tier 1 ($1.25)
 *   - submission #11 -> count=11 -> band [11,25] -> tier 2 ($1.75)
 *   - submission #26 -> count=26 -> band [26,∞)  -> tier 3 ($2.25)
 * `lib/db/dal/payout-ledger.ts`'s `accrueLedgerEntry` is responsible for
 * passing `priorApprovedCount + 1`, never the raw prior count.
 *
 * `lib/fraud/pipeline.ts` (T3.5) uses the same ordinal convention
 * (`priorApprovedCount + 1`) against the same table's open top band to
 * decide whether a submission is forced into human review ("tier-3 money
 * concentration... forces human review," FR-F7): the two call sites are
 * kept in lockstep on purpose, so the exact submission that first earns
 * the top tier's payout rate is always the one forced into review (batch-4
 * review fix; previously off-by-one between the two call sites, tracked in
 * `tasks/lessons.md`).
 */
import type { TierBand, TierTable } from "@/types/domain";

/** Thrown when no band in `tierTable` covers `count`. Should be
 * unreachable against a table that passed T3.1's `validateTierTable` (its
 * first band starts at 0 and its last band is open-ended), but a campaign
 * created before that validation existed, or a malformed fixture, could
 * still produce a gap — never silently fall through to an undefined
 * payout. */
export class TierNotFoundError extends Error {
  readonly status = 500 as const;
  readonly code = "tier_not_found" as const;

  constructor(count: number) {
    super(
      `no band in this campaign's tierTable covers count ${count} — the ` +
        "tier table may be malformed (see validateTierTable).",
    );
    this.name = "TierNotFoundError";
  }
}

export interface TierLookup {
  band: TierBand;
  /** 1-based tier number matching the band's position in `tierTable`
   * (index 0 -> tier 1, index 1 -> tier 2, ...). */
  tierNumber: number;
}

/**
 * Finds the band in `tierTable` that covers `count` (see module doc
 * comment for what `count` should be). Throws `TierNotFoundError` rather
 * than returning `undefined` — a caller computing a payout amount must
 * never silently treat "no band matched" as "$0."
 */
export function lookupTierBand(
  tierTable: TierTable,
  count: number,
): TierLookup {
  const index = tierTable.findIndex(
    (band) =>
      count >= band.minCount &&
      (band.maxCount === null || count <= band.maxCount),
  );
  if (index === -1) throw new TierNotFoundError(count);
  return { band: tierTable[index], tierNumber: index + 1 };
}

/**
 * 80%-of-budget-cap warning flag (card requirement 4: "an 80% threshold
 * raises a warning flag the host UI surfaces"). Pure integer arithmetic
 * (`cumulativeCommittedCents * 5 >= budgetCapCents * 4` is exactly
 * `cumulativeCommittedCents / budgetCapCents >= 0.8`) — constitution §3
 * forbids float math on money, including in comparisons derived from it.
 */
export function isCapWarning(
  cumulativeCommittedCents: number,
  budgetCapCents: number,
): boolean {
  return cumulativeCommittedCents * 5 >= budgetCapCents * 4;
}
