# Phase 1 · Batch 3 — Task Cards

> **Version:** 1.0
> **Created:** 2026-06-30
> **Governing spec:** flier-canvassing-platform-PRD-v0.4.0.md
> **Constitution:** flier-canvassing-platform-CONSTITUTION-v1.0.md
> **Phase plan:** flier-canvassing-platform-PHASE-1-PLAN-v1.0.html
> **Batch:** 3 of 5 — Core logic (5 tasks, ~4 days) · ⊢ **dedupe review gate before dependents**

Entry: Batch 2 exit check passed (isolation DAL + suite green, auth + role guards, R2 storage). All Batch 3 tasks build on the DAL (T2.1) and guards (T2.3).

```
T3.1 campaign lifecycle ──┐
T3.2 target/claim machine ─┤
T3.3 dedupe (gate) ────────┼── T3.5 pipeline orchestrator
T3.4 geo+time checks ──────┘
```

T3.1, T3.2, T3.3, T3.4 run in parallel. T3.5 composes T3.3 + T3.4 and starts after both land (and after the T3.3 dedupe review gate clears).

---

## Task 3.1 — Campaign lifecycle + configuration

**Batch:** 3
**Depends on:** T2.1 (campaigns DAL), T2.3 (site-admin guard)
**Produces:** `lib/campaign/lifecycle.ts`, admin campaign CRUD routes
**Complexity:** DD: M | CD: M | BR: M

### Context

PRD FR-C1 / FR-C2 / FR-C4:
> Site admin creates a campaign: name, flier image, target set, budget cap, tier table, grand prize, privacy setting, proximity radius, start/end. Lifecycle: draft → live → closed. Only live campaigns appear on the universal map and accept submissions. Closing freezes the ledger, finalizes the leaderboard, triggers grand-prize determination.

PRD §3:
> tier breakpoints, payout amounts, budget cap, grand prize, settlement mode are per-campaign configuration set by site admin at creation.

Constitution §3: money as integer cents; tier math server-side. §5: only site_admin creates/configures campaigns in v1 (use `requireSiteAdmin`).

**Design intent:** campaign config is the per-tenant control surface. Budget cap and tier table are stored in cents. State transitions are guarded: draft→live requires at least the flier image + ≥1 target; live→closed triggers the freeze/finalize routine. The tier_table is validated as ordered, non-overlapping bands.

### Objective
Implement create/update/configure for campaigns and the draft→live→closed lifecycle with the close-time freeze/finalize routine, all behind the site-admin guard.

### Requirements
1. Create-campaign action (site-admin only) capturing all FR-C1 fields; budget + tier amounts in cents.
2. Validate `tier_table` as ordered, contiguous, non-overlapping bands ending in an open top band.
3. State machine: `draft → live → closed`. `draft→live` requires flier image set and ≥1 target. Reject illegal transitions.
4. `closed` runs a finalize routine: mark ledger frozen (no new accruals), snapshot final leaderboard ordering, set a `grand_prize_winner` (top of leaderboard per §3 tie-break: most approved placements, then earliest to reach that count).
5. Reads/writes go through the campaigns DAL (T2.1); all actions behind `requireSiteAdmin`.

### Acceptance Criteria
- [ ] Test: non-admin principal is denied create/update (403).
- [ ] Test: `draft→live` blocked when no targets or no flier image; allowed otherwise.
- [ ] Test: invalid tier table (overlap/gap/closed-top) rejected.
- [ ] Test: closing a campaign freezes the ledger (a subsequent accrual attempt is rejected) and records a grand-prize winner using the tie-break rule.
- [ ] Budget/tier amounts persisted as integer cents.

### Files to Create/Modify
- `lib/campaign/lifecycle.ts`, `lib/campaign/tier-validation.ts`
- `app/api/admin/campaigns/route.ts`, `app/api/admin/campaigns/[id]/route.ts`
- test: `tests/campaign/lifecycle.test.ts`

### Anti-Requirements
- Do NOT allow hosts (non-admins) to create campaigns in v1.
- Do NOT store money as float/numeric.
- Do NOT build target import here (that's T4.5) — only campaign config + lifecycle.
- Do NOT compute payouts here (ledger is T4.3) — finalize only snapshots ordering.

---

## Task 3.2 — Target + claim state machine

**Batch:** 3
**Depends on:** T2.1 (targets DAL)
**Produces:** `lib/target/state-machine.ts`, claim/expire logic
**Complexity:** DD: H | CD: M | BR: H

### Context

PRD FR-M2 / FR-M3 / FR-M5 / FR-F4:
> States: red (open) / amber (claimed or pending review; claim hold 3 hrs then auto-reverts to red) / green (approved). Claim mechanic: claim-then-post — a player taps a red pin to claim it (reserving it 3 hrs and anchoring their next submission to that target's coordinates). One-claim-per-target: a target fills once; a second submission to a green target is rejected unless admin reopens it. Rejection reopens the target (red, claim freed).

**Design intent:** the state machine is `red → amber → green`, with `amber → red` on (a) 3-hr claim expiry or (b) rejection. The **claim must be atomic** to prevent two players claiming the same red pin in a race — use a conditional update (`UPDATE ... WHERE state='red'` returning affected rows) or a transaction with row lock, so exactly one claimer wins. Claiming sets `claimed_by` and `claim_expires_at = now + 3h`. Expiry is enforced lazily (on read/claim attempt, treat an expired amber as claimable) and/or by a sweep; for v1, lazy enforcement is sufficient and simpler.

### Objective
Implement the target state machine with atomic claim, 3-hour hold, lazy expiry, and the transitions to green (approve) and back to red (expiry/reject).

### Requirements
1. `claim(campaignId, targetId, playerId)`: atomically transition `red → amber` only if currently red (or an expired amber); set `claimed_by`, `claim_expires_at = now+3h`. Return success/failure; failure if already actively claimed/green.
2. `markPendingReview` / keep amber while a submission is under review (claim does not expire out from under a pending submission — extend or freeze expiry when a submission is attached).
3. `approve(campaignId, targetId)`: `amber → green`, set `filled_by_submission_id`.
4. `reject(campaignId, targetId)`: `amber → red`, clear claim fields (reopen).
5. Lazy expiry: an amber target past `claim_expires_at` with no pending submission is treated as claimable.
6. One-claim-per-target: a submission/claim against a green target is rejected.
7. All through targets DAL (campaign-scoped).

### Acceptance Criteria
- [ ] Test: two concurrent claims on the same red target → exactly one succeeds.
- [ ] Test: claim sets `claim_expires_at` ~3h out; an expired amber (no pending submission) is re-claimable.
- [ ] Test: approve moves amber→green and sets `filled_by_submission_id`; green is not re-claimable.
- [ ] Test: reject moves amber→red and clears claim fields.
- [ ] Test: a pending submission prevents the claim from silently expiring.

### Files to Create/Modify
- `lib/target/state-machine.ts`
- `app/api/campaigns/[id]/targets/[targetId]/claim/route.ts`
- test: `tests/target/state-machine.test.ts`

### Anti-Requirements
- Do NOT implement the fraud checks here (T3.3/T3.4) — this is pure target state.
- Do NOT allow a non-atomic claim that can double-assign a target.
- Do NOT build the map UI here (T4.4).

---

## Task 3.3 — Dedupe: perceptual hash + different-target gate

**Batch:** 3
**Depends on:** T2.1 (submissions DAL), T2.4 (R2 for image access)
**Produces:** `lib/fraud/dedupe.ts`
**Complexity:** DD: H | CD: H | BR: H — **REVIEW GATE**

### Context

This is the resolved core technical risk. PRD FR-F3:
> Compute full-frame perceptual hash (pHash) on every submission. Treat as a duplicate (reject) only when the hash matches a prior submission AND the two are claiming different targets. Rationale: same-target resubmissions are expected to look alike and are already governed by one-claim-per-target (FR-F4); the fraud signal is the same photo reused across different pins. This avoids false-matching legitimate distinct placements of an identical flier without needing background segmentation. Cross-campaign reuse is caught the same way (same photo, different campaign+target).

Phase 1 plan risk + kill criterion:
> Different-target gate sidesteps the core false-match. Review gate + threshold tuning on a seeded adversarial set before dependents build. If dedupe can't get below a workable false-positive rate even with the different-target gate → escalate to background-region hashing now.

**Design intent:** on submit, compute a pHash of the image. Compare (Hamming distance) against stored hashes of prior submissions. A match (distance ≤ threshold) is flagged as duplicate **only if** the matched prior submission is on a *different* target (any campaign). Same-target near-matches are expected and ignored by this check. Store the pHash on the submission for future comparisons. The threshold must be tuned against a seeded set containing: (a) the same flier legitimately posted at different real locations [must NOT flag], and (b) the same photo resubmitted to a different pin [must flag].

### Objective
Implement perceptual-hash dedupe that flags a submission only when its hash matches a prior submission on a different target, tuned on a seeded adversarial set.

### Requirements
1. Compute a perceptual hash (pHash or dHash) for a submission image.
2. Store the hash on the submission record (via DAL).
3. `checkDuplicate(submission)`: find prior submissions within Hamming-distance threshold; flag as duplicate only if a match exists on a *different* `target_id` (cross-campaign included).
4. Return a `FraudCheckResult` ({check:'duplicate', passed, detail, score}); never throw on a normal "no duplicate."
5. A seeded test set with the two adversarial cases (legit different-location same-flier; reused-photo-different-pin) plus a calibrated threshold.
6. Document the chosen threshold and its measured false-positive / false-negative on the seed set in a comment.

### Acceptance Criteria
- [ ] Test: same flier image at two *different targets* with the reused photo → flagged duplicate.
- [ ] Test: visually-distinct photos of the same flier at different targets → NOT flagged.
- [ ] Test: a near-identical resubmission to the *same target* → NOT flagged by this check (handled by one-claim-per-target).
- [ ] Hash is persisted on each submission for future comparisons.
- [ ] Measured false-positive rate on the seed set is documented and within the workable bound; if not, the kill-criterion escalation is noted for the reviewer.

### Files to Create/Modify
- `lib/fraud/dedupe.ts`
- `tests/fraud/dedupe.test.ts`, `tests/fraud/fixtures/` (seed images / hashes)

### Anti-Requirements
- Do NOT flag same-target resubmissions as duplicates in this check.
- Do NOT block legitimate distinct placements of the identical flier artwork.
- Do NOT implement background-region segmentation in v1 unless the kill criterion forces it (then flag for the reviewer first).

> **GATE:** Reviewer confirms the dedupe false-positive/false-negative rates on the seed set are acceptable before T3.5 composes it into the pipeline.

---

## Task 3.4 — Geo + time fraud checks

**Batch:** 3
**Depends on:** T2.1 (submissions/targets DAL)
**Produces:** `lib/fraud/geo.ts`, `lib/fraud/time.ts`
**Complexity:** DD: M | CD: M | BR: M

### Context

PRD FR-F1, FR-F2, FR-F5, FR-F6:
> Target proximity: device GPS within 40m of the claimed target (platform default; per-campaign override). GPS agreement: device GPS vs EXIF GPS within 50m; disagreement flags. Timestamp sanity: EXIF capture, client, and server times internally consistent (within minutes); stale photos flag. Travel-speed anomaly: impossible distance/time between a player's consecutive posts flags.

Constitution §3 geospatial:
> distance checks use `ST_DWithin` in meters, not hand-rolled haversine in app code.

Constitution §3 time:
> server `received_at` is authoritative for any payout or fraud logic (never client clock).

**Design intent:** four independent checks, each returning a `FraudCheckResult`. Proximity and GPS-agreement use PostGIS `ST_DWithin`/`ST_Distance` against geography points (never app-side haversine). Proximity radius is read from the campaign config (default 40m). Timestamp sanity compares EXIF capture time, client time, and server `received_at` for internal consistency. Travel-speed compares against the player's previous submission location+time for a plausible max speed.

### Objective
Implement target-proximity, GPS-agreement, timestamp-sanity, and travel-speed checks, each returning a structured result, using PostGIS for distance and server time as authoritative.

### Requirements
1. `checkProximity(submission, campaign)`: device GPS within the campaign's `proximity_radius_m` (default 40) of the claimed target via `ST_DWithin`.
2. `checkGpsAgreement(submission)`: device GPS vs EXIF GPS within 50m via PostGIS distance.
3. `checkTimestamps(submission)`: EXIF capture / client / server `received_at` internally consistent within a configurable minutes window; stale (capture far before submit) flags.
4. `checkTravelSpeed(submission, player)`: distance/time vs the player's prior submission implies ≤ a max plausible speed.
5. Each returns a `FraudCheckResult`; results are reviewer-visible (stored by the orchestrator T3.5).
6. All distance math via PostGIS; all time logic anchored to server `received_at`.

### Acceptance Criteria
- [ ] Test: device GPS 18m from target passes proximity; 80m fails (default 40m).
- [ ] Test: device/EXIF 22m apart passes agreement; 120m fails.
- [ ] Test: a photo captured hours before submit flags timestamp sanity.
- [ ] Test: 5km between consecutive posts 2 minutes apart flags travel-speed.
- [ ] No hand-rolled haversine in app code (distance via PostGIS).
- [ ] Per-campaign proximity override is honored.

### Files to Create/Modify
- `lib/fraud/geo.ts`, `lib/fraud/time.ts`
- test: `tests/fraud/geo.test.ts`, `tests/fraud/time.test.ts`

### Anti-Requirements
- Do NOT compute distance in JavaScript with haversine — use PostGIS.
- Do NOT trust client timestamps for the authoritative check — anchor to server `received_at`.
- Do NOT compose checks into a decision here — that's T3.5.

---

## Task 3.5 — Pipeline orchestrator + tier-3 routing

**Batch:** 3
**Depends on:** T3.3 (dedupe, gate cleared), T3.4 (geo/time checks)
**Produces:** `lib/fraud/pipeline.ts`
**Complexity:** DD: M | CD: H | BR: H

### Context

PRD FR-F7, FR-F8, FR-F9:
> Tier-3 mandatory review: every submission from a player at 26+ approved (per campaign) routes to human review regardless of score. Human content review: host/admin confirms a flier is visibly posted. All check results stored and shown to reviewer.

PRD §3 / G-3:
> Auto-decide ≥70% of tier-1/2 submissions; 100% of tier-3 routed to human review.

**Design intent:** the orchestrator runs all checks (dedupe T3.3, the four geo/time checks T3.4), aggregates results into one decision:
- any hard-fail check (proximity fail, dedupe hit, geofence) → **reject** (auto), OR route to review per policy;
- all pass AND player below tier-3 → **approve** (auto);
- player at tier-3 (≥26 approved in this campaign) → **needs_review** regardless of scores (FR-F7);
- soft/ambiguous flags → **needs_review**.
All individual `FraudCheckResult`s are persisted on the submission so the review queue (T4.2) can display *why*. The player's per-campaign approved count (for tier-3 routing) comes from `campaign_memberships` via DAL.

### Objective
Compose the fraud checks into a single auto-decision (approve / reject / needs_review), forcing human review for tier-3 players, and persist all check results on the submission.

### Requirements
1. `runPipeline(submission, campaign, player)`: execute dedupe + the four geo/time checks; collect all results.
2. Decision policy: hard-fail → reject (or review per a documented rule); all-pass + below tier-3 → approve; tier-3 player → needs_review regardless; ambiguous → needs_review.
3. Tier-3 determination uses the player's per-campaign approved count (≥26) from the membership DAL.
4. Persist every `FraudCheckResult` and the final decision on the submission.
5. Auto-decision rate measurable (instrument approve+reject vs needs_review) to evidence G-3.
6. On approve, signal the target state machine (T3.2) to go green and the ledger (T4.3) to accrue — via a clear interface/return, not by reaching into those modules' internals.

### Acceptance Criteria
- [ ] Test: all-pass + tier-1 player → auto-approve.
- [ ] Test: a tier-3 player (≥26 approved) with all-pass → needs_review (not auto-approve).
- [ ] Test: a dedupe hit or proximity fail → reject/needs_review per policy (documented).
- [ ] All check results are persisted and retrievable for the review queue.
- [ ] Auto-decision rate is computable from stored decisions.

### Files to Create/Modify
- `lib/fraud/pipeline.ts`
- test: `tests/fraud/pipeline.test.ts`

### Anti-Requirements
- Do NOT auto-approve any tier-3 submission.
- Do NOT bury check results — every result must be persisted for reviewer visibility.
- Do NOT flip target state or write the ledger directly from here — return a decision the caller acts on (keeps modules decoupled).

---

## Batch 3 Exit Check
- [ ] T3.3 dedupe review gate cleared (false-positive rate acceptable on seed set).
- [ ] Campaign lifecycle + tier validation tested; close freezes ledger and picks a winner.
- [ ] Atomic claim proven race-safe; full target state machine tested.
- [ ] Geo/time checks use PostGIS + server time; all four tested.
- [ ] Pipeline auto-approves clean tier-1/2, forces tier-3 review, persists results.
- [ ] `pnpm lint && pnpm build && pnpm test` green in CI.

**Next:** Batch 4 (Surfaces) — capture flow, review queue, ledger + tiers, per-campaign Mapbox map, admin target import.
