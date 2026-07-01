/**
 * Dedupe hash index DAL (T3.3) — the SECOND sanctioned cross-campaign read,
 * alongside `lib/db/dal/universal-map.ts`.
 *
 * ** Sanctioned by `docs/decisions/0002-dedupe-hash-cross-campaign-exception.md`,
 * which amends ADR-0001's original "exactly one" framing to name two
 * exceptions. See that ADR for the full rationale; this comment covers the
 * shape only. **
 *
 * `docs/decisions/0001-tenant-isolation-enforcement.md` and constitution
 * non-negotiable #1 originally described `universal-map.ts`'s
 * `getPublicPinsAcrossLiveCampaigns` as "the ONE sanctioned cross-campaign
 * read" / "exactly one." T3.3's own governing requirement (PRD FR-F3, quoted
 * in `docs/tasks/batch-3.md`) is the opposite for dedupe: "the same photo
 * reused across different pins" must be catchable, and "Cross-campaign reuse
 * is caught the same way (same photo, different campaign+target)" — i.e. the
 * reused-photo fraud signal has to be checked against *every* campaign's
 * submissions, not just the submitting campaign's own. There is no way to
 * satisfy FR-F3's cross-campaign clause while keeping every submissions read
 * scoped to a single `campaignId`.
 *
 * Resolution (ADR-0002): a second, equally narrow, equally-obvious exception
 * (own file, unmissable name, arity 0, like `universal-map.ts`) rather than
 * silently bypassing the DAL convention or silently dropping the
 * cross-campaign requirement. This function returns ONLY
 * `{submissionId, campaignId, targetId, phash}` for every submission that
 * exists — no player identity, no photo URL, no host identity, no
 * ledger/budget data. `tests/isolation/isolation.test.ts` structurally
 * enforces both this file's minimal export surface and its exact returned
 * column set, so a later edit can't silently widen this read's blast radius.
 */
import { db } from "@/lib/db/client";
import { submissions } from "@/lib/db/schema";

/** The only fields a dedupe hash comparison needs — no PII, no ledger data. */
export interface HashRecord {
  submissionId: string;
  campaignId: string;
  targetId: string;
  phash: string;
}

/**
 * Returns `{submissionId, campaignId, targetId, phash}` for every existing
 * submission, across every campaign. Used only by
 * `lib/fraud/dedupe.ts`'s different-target reused-photo check (PRD FR-F3).
 * No PII, photo URL, or ledger/budget field is read or returned — see the
 * module doc comment above for why this exists as a second, deliberately
 * narrow exception to the "campaign-scoped DAL" rule.
 */
export async function listAllSubmissionHashes(): Promise<HashRecord[]> {
  return db
    .select({
      submissionId: submissions.id,
      campaignId: submissions.campaignId,
      targetId: submissions.targetId,
      phash: submissions.phash,
    })
    .from(submissions);
}
