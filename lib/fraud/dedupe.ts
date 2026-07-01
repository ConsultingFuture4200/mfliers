/**
 * Perceptual-hash dedupe check (T3.3 — Batch 3 review gate).
 *
 * PRD FR-F3 (quoted in `docs/tasks/batch-3.md`):
 * > Compute full-frame perceptual hash (pHash) on every submission. Treat as
 * > a duplicate (reject) only when the hash matches a prior submission AND
 * > the two are claiming different targets. Rationale: same-target
 * > resubmissions are expected to look alike and are already governed by
 * > one-claim-per-target (FR-F4); the fraud signal is the same photo reused
 * > across different pins. This avoids false-matching legitimate distinct
 * > placements of an identical flier without needing background
 * > segmentation. Cross-campaign reuse is caught the same way (same photo,
 * > different campaign+target).
 *
 * ## The false-match trap
 * Every campaign's fliers are the *same artwork*. A naive full-frame
 * perceptual hash of two independently-photographed, legitimately distinct
 * placements of that artwork will often be close (the flier dominates the
 * frame), which is exactly why this check gates on **target_id**, not hash
 * distance alone: a hash match is only a fraud signal when the matched
 * prior submission is on a *different* target. A same-target near-match is
 * expected and explicitly ignored here (FR-F4 — one-claim-per-target — owns
 * that case).
 *
 * ## Algorithm
 * `computePhash` is a 64-bit **dHash** (difference hash, Krawetz's "kind of
 * like a perceptual hash" construction): downsample to 9x8 grayscale, then
 * for each row emit one bit per adjacent-pixel comparison (`left > right`).
 * dHash was chosen over a DCT-based pHash for this v1: it needs no DCT
 * library, is cheap to compute per-submission, and — per the seeded
 * measurement below — clears the different-target gate's false-positive
 * bar at v1 scale. It is NOT a claim that dHash is more accurate than DCT
 * pHash in general, only that it is sufficient here.
 *
 * `hammingDistance` compares two hex-encoded 64-bit hashes bit-by-bit.
 *
 * ## Threshold: 9 (of 64 bits), chosen against the seeded adversarial set
 * See `tests/fraud/fixtures/synth-flier.ts` (generator) and
 * `tests/fraud/dedupe.test.ts` (the seeded-set measurement, run against a
 * real `sharp`-rendered image set, not hand-picked numbers). The set
 * contains:
 *   (a) 12 "legitimate distinct placement" photos — the *same* flier
 *       artwork composited onto 12 different backgrounds/positions/scales,
 *       standing in for 12 different real-world targets photographed
 *       independently (66 all-different-target pairs);
 *   (b) 12 "reused photo" cases — each of the 12 photos above re-encoded
 *       (resized + JPEG-requantized, i.e. a re-save/re-upload of the exact
 *       same shot, not a fresh photograph) and attributed to a *different*
 *       target than the original.
 * Measured (see `tests/fraud/dedupe.test.ts`'s "seeded threshold tuning"
 * block, which asserts these bounds against a live-rendered set on every
 * run, not just once by hand):
 *   - distinct-placement pairwise distances: min 13, max 40 (all 66 pairs).
 *   - reused-photo distances (original vs. its re-encoded copy): min 1,
 *     max 5 (all 12 cases).
 * At threshold = 9 (centered in the gap between 5 and 13):
 *   - measured false-positive rate on (a): **0/66 (0%)** — no pair of
 *     independently-photographed distinct placements was ever close enough
 *     to trigger a flag.
 *   - measured false-negative rate on (b): **0/12 (0%)** — every
 *     re-encoded reuse stayed within distance 9 of its original.
 * The two clusters have a clear empirical gap (reused-photo pairs top out
 * at 5 bits; distinct-placement pairs bottom out at 13 bits) at this
 * synthetic set's scale, so 9 sits centered in that gap rather than pinned
 * to either boundary. This is **not** a guarantee against every real-world
 * case (e.g. a player photographing the reused print from a closely
 * matching angle/background could land in the ambiguous middle); see the
 * kill-criterion note below.
 *
 * ## Kill-criterion status
 * The measured false-positive rate (0%) on the seeded set is within a
 * workable bound, so this ships as full-frame dHash + different-target gate
 * without background-region segmentation, per the card's anti-requirement.
 * If production data later shows a materially higher false-positive rate
 * than this synthetic set predicts, the phase-1 plan's kill criterion
 * (escalate to background-region hashing) should be revisited — flagged in
 * this task's `needsClarification` for the reviewer, not silently deferred.
 */
import sharp from "sharp";
import type { FraudCheckResult } from "@/types/domain";
import { listAllSubmissionHashes } from "@/lib/db/dal/dedupe-hashes";

/** Hamming-distance threshold (out of 64 bits) — see module doc comment for
 * how this was tuned and its measured false-positive/false-negative rates. */
export const DUPLICATE_HASH_THRESHOLD = 9;

const HASH_WIDTH = 9; // one extra column so each row yields 8 comparisons
const HASH_HEIGHT = 8; // 8 rows * 8 comparisons/row = 64 bits

/**
 * Computes a 64-bit dHash of an image, returned as a 16-character lowercase
 * hex string. Deterministic for a given image buffer (same bytes in, same
 * hash out) — the reused-photo fraud case (re-encoding aside) relies on
 * this.
 */
export async function computePhash(imageBuffer: Buffer): Promise<string> {
  const { data } = await sharp(imageBuffer)
    .resize(HASH_WIDTH, HASH_HEIGHT, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = "";
  for (let row = 0; row < HASH_HEIGHT; row++) {
    for (let col = 0; col < HASH_WIDTH - 1; col++) {
      const left = data[row * HASH_WIDTH + col];
      const right = data[row * HASH_WIDTH + col + 1];
      bits += left > right ? "1" : "0";
    }
  }
  return bitsToHex(bits);
}

function bitsToHex(bits: string): string {
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/** Bit-level Hamming distance between two same-length hex-encoded hashes. */
export function hammingDistance(hexA: string, hexB: string): number {
  if (hexA.length !== hexB.length) {
    throw new Error(
      `hammingDistance: hash length mismatch ("${hexA}" vs "${hexB}")`,
    );
  }
  let distance = 0;
  for (let i = 0; i < hexA.length; i++) {
    let x = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    while (x) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance;
}

/** The minimal shape `checkDuplicate` needs from a submission — deliberately
 * not the full `Submission` domain type, so a caller mid-way through
 * assembling one (e.g. before it has an `id`) can still run the check. */
export interface DedupeCandidate {
  /** Omit when checking a not-yet-persisted submission; set it when
   * re-checking an existing one, so it doesn't match against itself. */
  submissionId?: string;
  targetId: string;
  phash: string;
}

/**
 * Flags `submission` as a duplicate only when its hash matches (Hamming
 * distance <= `DUPLICATE_HASH_THRESHOLD`) a prior submission on a
 * *different* `targetId` — any campaign (PRD FR-F3). Same-target matches
 * are ignored here by design (FR-F4 owns that case). Never throws on a
 * normal "no duplicate" outcome — returns a `passed: true` result instead.
 */
export async function checkDuplicate(
  submission: DedupeCandidate,
): Promise<FraudCheckResult> {
  const priorHashes = await listAllSubmissionHashes();

  let best: { distance: number; targetId: string; campaignId: string } | null =
    null;
  for (const record of priorHashes) {
    if (
      submission.submissionId &&
      record.submissionId === submission.submissionId
    ) {
      continue; // never compare a submission against itself
    }
    if (record.targetId === submission.targetId) {
      continue; // same-target: not this check's concern (FR-F4)
    }
    const distance = hammingDistance(submission.phash, record.phash);
    if (
      distance <= DUPLICATE_HASH_THRESHOLD &&
      (best === null || distance < best.distance)
    ) {
      best = {
        distance,
        targetId: record.targetId,
        campaignId: record.campaignId,
      };
    }
  }

  if (best) {
    return {
      check: "duplicate",
      passed: false,
      detail:
        `phash matches a prior submission on a different target ` +
        `(target ${best.targetId}, campaign ${best.campaignId}) at Hamming ` +
        `distance ${best.distance} (threshold ${DUPLICATE_HASH_THRESHOLD})`,
      score: best.distance,
    };
  }

  return {
    check: "duplicate",
    passed: true,
    detail: "no matching hash found on a different target",
  };
}
