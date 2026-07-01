# Phase 1 · Batch 4 — Task Cards

> **Version:** 1.0
> **Created:** 2026-06-30
> **Governing spec:** flier-canvassing-platform-PRD-v0.4.0.md
> **Constitution:** flier-canvassing-platform-CONSTITUTION-v1.0.md
> **Phase plan:** flier-canvassing-platform-PHASE-1-PLAN-v1.0.html
> **Batch:** 4 of 5 — Surfaces (5 tasks, ~4 days)

Entry: Batch 3 exit check passed (lifecycle, claim machine, fraud pipeline all green; dedupe gate cleared). These tasks build the user-facing surfaces on top of the core logic.

```
T4.1 capture flow      (depends T3.2 claim, T3.5 pipeline, T2.4 R2)
T4.2 review queue      (depends T3.5 pipeline)
T4.3 ledger + tiers    (depends T4.2 approval signal)
T4.4 per-campaign map  (depends T3.2 claim machine)
T4.5 target import     (depends T3.1 lifecycle, T4.4 map for pin-drop)
```

T4.1, T4.2, T4.4 parallel. T4.3 follows T4.2. T4.5 follows T4.4.

**Stack reminder:** Mapbox GL JS for maps; React + Tailwind + shadcn/ui for UI; money in cents, server-side.

---

## Task 4.1 — Submission capture flow

**Batch:** 4
**Depends on:** T3.2 (claim/target state), T3.5 (pipeline), T2.4 (R2 signed upload)
**Produces:** capture UI + submit handler
**Complexity:** DD: M | CD: M | BR: M

### Context

PRD FR-S1…FR-S5:
> Rear-camera only (`capture="environment"`); no gallery path in default flow; gallery fallback auto-flags. Records photo, device GPS + accuracy, client timestamp, EXIF GPS, EXIF timestamp. Server stamps authoritative `received_at`. GPS permission mandatory; denial blocks submission. Submission tied to a claimed target within a specific campaign; confirmation shows status + running total + target filled.

PRD G-2 / EC-2:
> Median submit time (camera open → confirmation) ≤ 20s.

Constitution §3: client-side compress before upload; store originals. §3 time: server `received_at` authoritative.

**Design intent:** the player, having claimed a target (T3.2), opens the camera (`capture="environment"`), shoots, the client reads device GPS (Geolocation API) + EXIF GPS/timestamp from the file, compresses the image, requests a signed R2 URL (T2.4), uploads, then POSTs submission metadata to a handler that stamps `received_at`, runs the pipeline (T3.5), and returns a decision. The whole path is optimized for ≤20s and instrumented to measure it (EC-2). GPS denial hard-blocks. Gallery fallback exists but auto-flags for review.

### Objective
Build the rear-camera capture + submit flow that uploads to R2, runs the fraud pipeline, and confirms in ≤20s, with submit-time instrumentation.

### Requirements
1. Camera capture via `<input capture="environment">`; gallery fallback path sets an auto-flag.
2. Read device GPS (Geolocation API, with accuracy) and EXIF GPS + timestamp from the captured file client-side.
3. Block submission if GPS permission denied (clear prompt).
4. Client-side compress before upload; request signed R2 URL (T2.4) and upload original.
5. POST metadata (target_id, campaign_id, device_gps, exif_gps, exif_ts, photo key) to a submit handler that stamps `received_at`, persists the submission (DAL), runs the pipeline (T3.5), updates target state per the decision, and returns status.
6. Confirmation screen shows status (approved / under review), running approved total, and which target filled.
7. Instrument camera-open → confirmation time (EC-2).

### Acceptance Criteria
- [ ] Default capture uses the rear camera; gallery-sourced submissions are auto-flagged.
- [ ] GPS denial blocks submission with a clear message.
- [ ] A submission persists with server `received_at`, links to its claimed target, and stores the R2 key.
- [ ] Confirmation reflects the pipeline decision and updated approved count.
- [ ] Submit-time instrumentation emits a measurable duration (e2e asserts a value is recorded).

### Files to Create/Modify
- `app/campaigns/[id]/submit/[targetId]/page.tsx` (capture UI)
- `lib/capture/exif.ts`, `lib/capture/compress.ts`
- `app/api/campaigns/[id]/submissions/route.ts` (submit handler)
- test: `tests/e2e/submit-flow.spec.ts`

### Anti-Requirements
- Do NOT make gallery upload the default path.
- Do NOT trust client timestamp for the authoritative record — server stamps `received_at`.
- Do NOT compress on the server (client compresses; server stores original via R2).
- Do NOT implement offline queueing here — that's T5.3.

---

## Task 4.2 — Host review queue

**Batch:** 4
**Depends on:** T3.5 (pipeline + stored results), T2.3 (host guard)
**Produces:** review queue UI + approve/reject handlers
**Complexity:** DD: M | CD: M | BR: H

### Context

PRD FR-R1…FR-R4:
> Per-campaign review queue (flagged + tier-3); host sees only theirs. Each card: photo, target pin + distance-from-target, all check results, canvasser, metadata. Approve/Reject + reason code. Approve → target green + payout accrual against that campaign's budget. Reject → target red, claim freed. Rejection reason visible to player. Audit-logged manual adjustments.

Constitution §5: server-side authorization; §3: immutable audit log of approvals/rejections.

**Design intent:** a host-scoped queue (via `requireCampaignAccess`) listing submissions with `decision = needs_review` (flagged + all tier-3). Each card renders the photo (from R2), the target pin + computed distance, every stored `FraudCheckResult`, and submitter metadata. Approve calls the target state machine → green (T3.2) and the ledger accrual (T4.3); reject reopens the target to red and frees the claim, with a reason visible to the player. Every action writes an immutable audit entry.

### Objective
Build the per-campaign, host-scoped review queue with approve/reject that drives target state + ledger and writes an audit log.

### Requirements
1. Queue lists `needs_review` submissions for the host's campaign(s) only (guarded server-side).
2. Each card: photo, target + distance-from-target, all `FraudCheckResult`s, canvasser, timestamps.
3. Approve → target→green (T3.2) + ledger accrual (T4.3); Reject → target→red + claim freed, with reason code.
4. Rejection reason persisted and exposed to the player.
5. Every approve/reject/adjustment writes an immutable, append-only audit entry (campaign_id, player_id, submission_id, actor, action, reason, timestamp).
6. Manual point/payout adjustment action (audit-logged) per FR-R4.

### Acceptance Criteria
- [ ] Test: a host sees only their campaign's review items (cross-campaign items absent / 403 on access).
- [ ] Test: approve flips the target to green and creates a ledger accrual.
- [ ] Test: reject reopens the target to red, frees the claim, stores a player-visible reason.
- [ ] Every action appends an immutable audit row.
- [ ] All check results render on the card.

### Files to Create/Modify
- `app/host/campaigns/[id]/review/page.tsx`
- `app/api/host/campaigns/[id]/submissions/[sid]/decision/route.ts`
- `lib/audit/log.ts`
- test: `tests/host/review-queue.test.ts`

### Anti-Requirements
- Do NOT let a host act on another campaign's submissions.
- Do NOT mutate or delete audit entries — append-only.
- Do NOT compute payout amounts here — call the ledger (T4.3).

---

## Task 4.3 — Ledger + tier math + budget cap

**Batch:** 4
**Depends on:** T4.2 (approval signal), T3.1 (campaign tier_table/budget)
**Produces:** `lib/payout/ledger.ts`, tier math, cap enforcement
**Complexity:** DD: M | CD: L | BR: H

### Context

PRD FR-P1…FR-P3 / §3 / EC-7:
> Bundled payout computed on the campaign's tier curve; print baked in. Per-campaign hard cap + 80% warning; a campaign's spend never draws on another's budget. Only approved placements are payable. At-cap: new submissions accepted and still flip pins green, but marked over-cap / unpayable. Ledger computes correct tiered payout in cents; cap enforcement marks over-cap submissions unpayable at $1,000.

Mycofest tiers (§3): T1 (1–10) $1.25, T2 (11–25) $1.75, T3 (26+) $2.25 — per campaign config (from T3.1), not hard-coded.

Constitution §3: money as integer cents; tier math **server-side only**; §6 anti-pattern: never trust client-computed amounts; never store money as float.

**Design intent:** on approval (signal from T4.2), the ledger looks up the player's current per-campaign approved count, finds the tier band from the campaign's `tier_table`, computes the payout in cents, and writes a ledger row with `tier_at_time` and updated `cumulative_committed`. If `cumulative_committed + amount > budget_cap`, the entry is marked `unpayable` (over-cap) — the pin still turns green (coverage continues) but no payable amount accrues. An 80% threshold raises a warning flag the host UI surfaces.

### Objective
Implement server-side tiered payout computation in cents, ledger accrual on approval, per-campaign cap enforcement with an 80% warning and over-cap unpayable marking.

### Requirements
1. `accrue(campaignId, submissionId, playerId)`: compute payout from the campaign's `tier_table` and the player's current approved count; write a ledger row (amount cents, `tier_at_time`, updated `cumulative_committed`).
2. Tier lookup driven by campaign config (T3.1), not hard-coded.
3. Cap enforcement: if accrual would exceed `budget_cap`, mark the entry `unpayable`; do not exceed the cap in payable totals.
4. 80% warning flag derivable for the host UI.
5. `balance_owed` per player and `settled` flag supported (manual settlement: a function to mark entries settled).
6. All amounts integer cents; all computation server-side.

### Acceptance Criteria
- [ ] Unit test: tier boundaries — counts 10/11 and 25/26 yield the correct band amount.
- [ ] Unit test: cumulative committed never exceeds `budget_cap` in payable total; the boundary submission that would cross is marked unpayable.
- [ ] Test: 80% warning flag flips at the right cumulative value.
- [ ] Test: marking an entry settled updates `settled`/`settled_at`.
- [ ] No monetary value stored or computed as float; no client-provided amount trusted.

### Files to Create/Modify
- `lib/payout/ledger.ts`, `lib/payout/tiers.ts`
- `app/api/host/campaigns/[id]/ledger/route.ts`
- test: `tests/payout/ledger.test.ts`

### Anti-Requirements
- Do NOT hard-code Mycofest's tier numbers — read campaign config.
- Do NOT accrue payable amount beyond the budget cap.
- Do NOT compute or accept payout amounts client-side.
- Do NOT integrate a payment rail (manual settlement only in v1).

---

## Task 4.4 — Per-campaign Mapbox map

**Batch:** 4
**Depends on:** T3.2 (target state for pin colors)
**Produces:** Mapbox map component with live pins + claim + detail
**Complexity:** DD: M | CD: M | BR: M

### Context

PRD FR-M2, FR-M3, FR-M4, FR-M7:
> States: red/amber/green pins. Claim mechanic: tap a red pin to claim (claim-then-post). Pin detail: green pin shows photo, GPS, username — per-campaign privacy setting (default admin-only). Near-real-time updates via short-interval polling (5–10s) in v1.

Constitution §2: **Mapbox GL JS**, public token URL-restricted (§5). §5: username on green pins defaults to admin-only.

**Design intent:** a Mapbox GL map for one campaign, rendering targets as red/amber/green pins from live state. Tapping a red pin initiates claim (T3.2) → routes to capture (T4.1). Tapping a green pin opens a detail view (photo from R2, GPS, username gated by the campaign's privacy setting). State refreshes via 5–10s polling. Mapbox public token is URL-restricted and read from env.

### Objective
Build the per-campaign Mapbox map with live red/amber/green pins, claim-on-tap of red pins, green-pin detail respecting privacy, and 5–10s polling refresh.

### Requirements
1. Mapbox GL map centered on the campaign's target extent; pins colored by target state.
2. Tap red → claim (T3.2) → navigate to capture (T4.1); handle claim-race failure gracefully ("already claimed").
3. Tap green → detail (photo, GPS, username per privacy setting; default admin-only hides username from players).
4. Tap amber → informational ("claimed / pending").
5. Poll target state every 5–10s and update pins without full reload.
6. Mapbox token from env, URL-restricted; no secret in bundle beyond the public token.

### Acceptance Criteria
- [ ] Pins render in the correct color for each target state.
- [ ] Tapping a red pin claims it (or shows a clear "already claimed" on race loss).
- [ ] Green-pin detail hides the username when privacy = admin-only and the viewer is a player.
- [ ] Pin states update via polling without a manual refresh.
- [ ] Only the public Mapbox token reaches the client.

### Files to Create/Modify
- `components/map/CampaignMap.tsx`
- `app/campaigns/[id]/map/page.tsx`
- `lib/map/usePinPolling.ts`
- test: `tests/e2e/campaign-map.spec.ts`

### Anti-Requirements
- Do NOT expose usernames on green pins when privacy = admin-only to a player viewer.
- Do NOT ship any private token to the client.
- Do NOT build the universal aggregate map here (T5.2) — single campaign only.

---

## Task 4.5 — Admin target import (CSV + pin-drop)

**Batch:** 4
**Depends on:** T3.1 (campaign lifecycle), T4.4 (map component for pin-drop)
**Produces:** target import UI + handlers
**Complexity:** DD: M | CD: M | BR: L

### Context

PRD FR-M1:
> Site admin imports targets per campaign via CSV upload and/or manual pin-drop on an admin Mapbox view.

Constitution §5: site-admin-guarded. Targets created in `red` state, campaign-scoped (DAL).

**Design intent:** two import paths writing campaign-scoped targets in red state — (1) CSV upload (`label,lat,long`) parsed and validated, (2) manual pin-drop on the admin Mapbox view (reusing T4.4's map). Both behind the site-admin guard. Validation rejects malformed rows / out-of-range coordinates.

### Objective
Let a site admin populate a campaign's targets via CSV upload and manual Mapbox pin-drop, creating campaign-scoped red targets.

### Requirements
1. CSV upload parsing `label,lat,long`; validate coordinate ranges; reject malformed rows with a clear report.
2. Manual pin-drop on an admin map (reuse T4.4 component) creating a target at the dropped location with a label.
3. All created targets are campaign-scoped (DAL) and start in `red`.
4. Site-admin guard on both paths.
5. Show the resulting target set on the map after import.

### Acceptance Criteria
- [ ] Test: a valid CSV creates the expected red targets scoped to the campaign.
- [ ] Test: malformed rows / out-of-range coords are rejected with a report, not silently dropped.
- [ ] Test: a pin-drop creates one red target at the chosen coordinates.
- [ ] Non-admin is denied both paths (403).
- [ ] Imported targets appear on the campaign map.

### Files to Create/Modify
- `app/admin/campaigns/[id]/targets/page.tsx`
- `app/api/admin/campaigns/[id]/targets/import/route.ts`
- `lib/target/csv-import.ts`
- test: `tests/admin/target-import.test.ts`

### Anti-Requirements
- Do NOT allow non-admins to import targets.
- Do NOT create targets in any state other than red.
- Do NOT skip coordinate validation.

---

## Batch 4 Exit Check
- [ ] Capture flow submits end-to-end, server-stamped, pipeline-decided, ≤20s instrumented.
- [ ] Review queue is host-scoped; approve→green+accrue, reject→red+reason; audit-logged.
- [ ] Ledger tier math + cap enforcement correct to the cent (EC-7 unit tests pass).
- [ ] Per-campaign Mapbox map shows live states, claims red pins, respects privacy.
- [ ] Admin target import (CSV + pin-drop) creates red campaign-scoped targets.
- [ ] `pnpm lint && pnpm build && pnpm test` green in CI.

**Next:** Batch 5 (Integration) — landing, universal aggregate map, offline sync, leaderboard, e2e + Mycofest seed.
