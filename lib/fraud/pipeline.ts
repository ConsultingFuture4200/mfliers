/**
 * Fraud pipeline orchestrator + tier-3 routing (T3.5).
 *
 * PRD FR-F7/FR-F8/FR-F9 (quoted in `docs/tasks/batch-3.md`):
 * > Tier-3 mandatory review: every submission from a player at 26+ approved
 * > (per campaign) routes to human review regardless of score. Human
 * > content review: host/admin confirms a flier is visibly posted. All
 * > check results stored and shown to reviewer.
 *
 * PRD §3 / G-3: "Auto-decide >=70% of tier-1/2 submissions; 100% of tier-3
 * routed to human review."
 *
 * This module composes the checks built by the gated card (T3.3's
 * `checkDuplicate`) and T3.4 (`checkProximity`, `checkGpsAgreement`,
 * `checkTimestamps`, `checkTravelSpeed`) into a single decision. It does
 * not implement any check itself — see those modules for the individual
 * `FraudCheckResult` logic and their own PostGIS/server-time-authoritative
 * guarantees (constitution §3).
 *
 * ## Decision policy (documented, per card acceptance criterion: "a dedupe
 * hit or proximity fail -> reject/needs_review per policy (documented)")
 *
 * The card's design intent names `proximity fail` and `dedupe hit`
 * specifically as candidate "hard-fail" checks, and separately calls out
 * "soft/ambiguous flags" for the rest. This module encodes the split
 * explicitly via `HARD_FAIL_CHECKS` — currently **`proximity` only**:
 *
 *   1. `proximity` failing -> **reject**, unconditionally. A device nowhere
 *      near the claimed pin is an unambiguous fraud signal — not something
 *      a human reviewer needs to adjudicate case-by-case.
 *
 *      `duplicate` (the dedupe hit) is deliberately **not** in
 *      `HARD_FAIL_CHECKS`, even though the card's design intent lists it as
 *      a candidate — see T3.3's own module doc comment
 *      (`lib/fraud/dedupe.ts`): the measured 0% false-positive rate is only
 *      against a 66-pair *synthetic* seed set, and that same module warns a
 *      real photograph of a reused print from a closely matching
 *      angle/background "could land in the ambiguous middle." Auto-rejecting
 *      on a signal whose real-world false-positive rate is still unvalidated
 *      would silently punish a legitimate player with no human in the loop —
 *      worse than the cost of a redundant review. A `duplicate` failure
 *      therefore falls through to step 3 (`needs_review`) below until T4.2's
 *      human review queue produces a real-world false-positive signal, at
 *      which point `duplicate` can move back into `HARD_FAIL_CHECKS` via a
 *      config change here.
 *   2. Otherwise, a tier-3 player (>=26 approved this campaign, FR-F7) ->
 *      **needs_review**, regardless of how clean every check came back.
 *      This precedes the "all-pass" branch below so a tier-3 player can
 *      never auto-approve (card anti-requirement).
 *   3. Otherwise, any remaining check failing (`duplicate`, `gps-agreement`,
 *      `timestamp-sanity`, `travel-speed` — signals that can have innocent
 *      explanations, or (for `duplicate`) an unvalidated real-world
 *      false-positive rate) -> **needs_review**.
 *   4. Otherwise (every check passed, player below tier-3) -> **approve**.
 *
 * Reject strictly outranks needs_review, which strictly outranks approve —
 * there is exactly one decision per submission, never a partial one.
 *
 * ## Tier-3 threshold: derived from `campaign.tierTable`, not hard-coded
 * FR-F7's "26+" is Mycofest's own top-band threshold (see
 * `docs/tasks/batch-4.md`: "T3 (26+) $2.25 — per campaign config (from
 * T3.1), not hard-coded"). `campaign.tierTable`'s last band is always the
 * open-ended "and above" band (`lib/campaign/tier-validation.ts` rejects
 * any table where that isn't true), so that band's `minCount` *is* "tier
 * 3" for whichever campaign is running — reading it off `campaign` (already
 * a required parameter here, exactly so per-campaign config like this and
 * `checkProximity`'s radius override can be honored) keeps this module
 * consistent with T3.1/T4.3's "read campaign config, never hard-code a
 * tier number" rule instead of hard-coding the literal `26` a second place.
 * `DEFAULT_TIER_3_THRESHOLD` documents FR-F7's literal number for tests/
 * reference; it is never read by `runPipeline` itself.
 *
 * ## Decoupling (card anti-requirement: "do NOT flip target state or write
 * the ledger directly from here")
 * `runPipeline` never imports `lib/target/state-machine.ts` or a ledger
 * module. It returns a `decision` plus a `nextActions` list describing
 * *what the caller should do* (approve the target + accrue the ledger, or
 * reject the target) — a future route handler (T4.1's capture flow, T4.2's
 * review queue for the human-decided needs_review case) is the one that
 * actually calls those modules. `needs_review` carries no actions: nothing
 * happens automatically until a human decides via T4.2.
 */
import type {
  Campaign,
  FraudCheckResult,
  Player,
  Submission,
  SubmissionDecision,
} from "@/types/domain";
import { checkDuplicate } from "@/lib/fraud/dedupe";
import { checkGpsAgreement, checkProximity } from "@/lib/fraud/geo";
import {
  checkTimestamps,
  checkTravelSpeed,
  type CheckTimestampsOptions,
} from "@/lib/fraud/time";
import { getMembership } from "@/lib/db/dal/campaign-memberships";
import { recordSubmissionDecision } from "@/lib/db/dal/submissions";

/**
 * FR-F7's literal per-campaign tier-3 threshold ("26+ approved") — kept
 * here only as a documented reference/test fixture default. `runPipeline`
 * derives the real threshold from `campaign.tierTable`'s open-ended top
 * band (see module doc comment) so a campaign with a differently-shaped
 * tier table is routed correctly instead of always checking against `26`.
 */
export const DEFAULT_TIER_3_THRESHOLD = 26;

/** Checks whose failure is an unambiguous, auto-rejectable fraud signal —
 * see module doc comment's decision policy. Every other check name
 * (including `duplicate` — see module doc comment for why it's excluded
 * for now) is treated as a "soft" flag (failure routes to needs_review,
 * never an auto-reject). */
const HARD_FAIL_CHECKS = new Set(["proximity"]);

/** What the caller should do as a result of `runPipeline`'s decision. This
 * module never performs these itself (anti-requirement) — it only
 * describes them so a route handler (T4.1/T4.2) can dispatch to
 * `lib/target/state-machine.ts` / the ledger (T4.3) without this module
 * reaching into their internals. */
export type PipelineAction =
  | {
      type: "approve_target";
      campaignId: string;
      targetId: string;
      submissionId: string;
    }
  | {
      type: "accrue_ledger";
      campaignId: string;
      submissionId: string;
      playerId: string;
    }
  | { type: "reject_target"; campaignId: string; targetId: string };

export interface PipelineResult {
  decision: SubmissionDecision;
  fraudChecks: FraudCheckResult[];
  /** True when `player`'s per-campaign approved count met/exceeded the
   * campaign's tier-3 threshold — surfaced separately from `decision` so a
   * caller/reviewer can tell "forced to review by tier-3" apart from
   * "forced to review by an ambiguous flag" without re-deriving it. */
  isTier3: boolean;
  /** Empty for `needs_review` — nothing happens automatically; a human
   * decides via T4.2's review queue. */
  nextActions: PipelineAction[];
}

export interface RunPipelineOptions {
  /** Threaded through to `checkTimestamps` — see `lib/fraud/time.ts`'s
   * `CheckTimestampsOptions` doc comment (NEEDS_CLARIFICATION: no
   * persisted `clientTs` column exists yet). */
  clientTs?: CheckTimestampsOptions["clientTs"];
}

/**
 * Runs every fraud check (T3.3's dedupe + T3.4's four geo/time checks)
 * against `submission`, composes them into one auto-decision per the
 * documented policy above, persists the full check list + final decision
 * onto the submission row (`lib/db/dal/submissions.ts`'s
 * `recordSubmissionDecision`, card requirement 4), and returns a
 * `PipelineResult` describing the decision and what the caller should do
 * next.
 *
 * `submission` must already be persisted (it is updated in place by
 * `submissionId`); a not-yet-persisted submission has nowhere to store the
 * check results.
 */
export async function runPipeline(
  submission: Submission,
  campaign: Campaign,
  player: Player,
  options: RunPipelineOptions = {},
): Promise<PipelineResult> {
  const [
    duplicateResult,
    proximityResult,
    gpsAgreementResult,
    travelSpeedResult,
  ] = await Promise.all([
    checkDuplicate({
      submissionId: submission.id,
      targetId: submission.targetId,
      phash: submission.phash,
    }),
    checkProximity(submission, campaign),
    checkGpsAgreement(submission),
    checkTravelSpeed(submission, player),
  ]);
  const timestampResult = checkTimestamps(submission, {
    clientTs: options.clientTs,
  });

  const fraudChecks: FraudCheckResult[] = [
    duplicateResult,
    proximityResult,
    gpsAgreementResult,
    timestampResult,
    travelSpeedResult,
  ];

  const membership = await getMembership(campaign.id, player.id);
  const approvedCount = membership?.approvedCount ?? 0;
  const tier3Threshold =
    campaign.tierTable[campaign.tierTable.length - 1].minCount;
  const isTier3 = approvedCount >= tier3Threshold;

  const hasHardFail = fraudChecks.some(
    (result) => !result.passed && HARD_FAIL_CHECKS.has(result.check),
  );
  const hasSoftFail = fraudChecks.some(
    (result) => !result.passed && !HARD_FAIL_CHECKS.has(result.check),
  );

  let decision: SubmissionDecision;
  if (hasHardFail) {
    decision = "rejected";
  } else if (isTier3) {
    decision = "needs_review";
  } else if (hasSoftFail) {
    decision = "needs_review";
  } else {
    decision = "approved";
  }

  await recordSubmissionDecision(
    campaign.id,
    submission.id,
    fraudChecks,
    decision,
  );

  const nextActions: PipelineAction[] =
    decision === "approved"
      ? [
          {
            type: "approve_target",
            campaignId: campaign.id,
            targetId: submission.targetId,
            submissionId: submission.id,
          },
          {
            type: "accrue_ledger",
            campaignId: campaign.id,
            submissionId: submission.id,
            playerId: player.id,
          },
        ]
      : decision === "rejected"
        ? [
            {
              type: "reject_target",
              campaignId: campaign.id,
              targetId: submission.targetId,
            },
          ]
        : [];

  return { decision, fraudChecks, isTier3, nextActions };
}

/**
 * Auto-decision rate (card requirement 5 / PRD G-3: "auto-decide >=70% of
 * tier-1/2 submissions") over an already-decided batch of submissions:
 * the fraction whose `decision` is `approved` or `rejected` (i.e. decided
 * without a human) rather than `needs_review`. `pending` decisions (not
 * yet run through the pipeline) are excluded from the denominator — they
 * haven't been auto-decided *or* sent to review yet, so counting them
 * would understate the rate for a mid-run batch.
 *
 * Pure function over `SubmissionDecision[]`, not a DB query, so it can run
 * over any already-fetched batch (`lib/db/dal/submissions.ts`'s
 * `listSubmissions`, a single campaign's decided set, a test's collected
 * `runPipeline` outputs, etc.) — this is what makes G-3's rate
 * "computable from stored decisions" (acceptance criterion) rather than a
 * number that only exists inside a report.
 */
export function autoDecisionRate(decisions: SubmissionDecision[]): number {
  const decided = decisions.filter((decision) => decision !== "pending");
  if (decided.length === 0) return 0;
  const autoDecided = decided.filter(
    (decision) => decision === "approved" || decision === "rejected",
  ).length;
  return autoDecided / decided.length;
}
