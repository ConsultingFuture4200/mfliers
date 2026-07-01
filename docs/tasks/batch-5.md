# Phase 1 · Batch 5 — Task Cards

> **Version:** 1.0
> **Created:** 2026-06-30
> **Governing spec:** flier-canvassing-platform-PRD-v0.4.0.md
> **Constitution:** flier-canvassing-platform-CONSTITUTION-v1.0.md
> **Phase plan:** flier-canvassing-platform-PHASE-1-PLAN-v1.0.html
> **Batch:** 5 of 5 — Integration (5 tasks, ~3 days)

Entry: Batch 4 exit check passed (capture, review, ledger, per-campaign map, target import all green). This batch wires the public surfaces, hardens field use, and proves the whole loop on real Mycofest data.

```
T5.1 landing        (depends T4.4)
T5.2 universal map  (depends T4.4 + T2.1 universal read)
T5.3 offline sync   (depends T4.1 capture)
T5.4 leaderboard    (depends T4.3 ledger)
T5.5 e2e + seed     (depends ALL — runs last)
```

T5.1–T5.4 parallel; T5.5 is the final serial gate that demonstrates the exit criteria.

---

## Task 5.1 — Landing page

**Batch:** 5
**Depends on:** T4.4 (map component)
**Produces:** public landing route
**Complexity:** DD: L | CD: L | BR: L

### Context

PRD FR-L1, FR-L5:
> Public landing page (no login) — platform intro, player login/signup, host/admin login entry. Campaign directory/list beside the map — browse live campaigns, see coverage %, join.

**Design intent:** the front door. No auth required to view. Introduces the platform, routes players to phone-OTP login (T2.2) and staff to staff-login (T2.3), and lists live campaigns with coverage %. The universal map (T5.2) is embedded or linked here. Coverage % per campaign = green targets / total targets, read via the universal/campaign DAL.

### Objective
Build the public landing page with platform intro, login entry points for players and staff, and a live-campaign directory showing coverage.

### Requirements
1. Public (no-auth) route.
2. Player login entry (→ T2.2) and staff login entry (→ T2.3).
3. Campaign directory: live campaigns with name, blurb, coverage % (green/total).
4. Link/embed the universal map (T5.2).
5. Responsive, sunlight-readable, accessible (keyboard focus, reduced-motion) per constitution NFR.

### Acceptance Criteria
- [ ] Landing renders with no session.
- [ ] Player and staff login entries route to the correct flows.
- [ ] Directory lists only `live` campaigns with correct coverage %.
- [ ] Passes a basic accessibility check (focus visible, reduced-motion respected).

### Files to Create/Modify
- `app/page.tsx` (replace Batch-1 placeholder)
- `components/landing/CampaignDirectory.tsx`
- test: `tests/e2e/landing.spec.ts`

### Anti-Requirements
- Do NOT require auth to view the landing.
- Do NOT list draft/closed campaigns in the live directory.

---

## Task 5.2 — Universal aggregate map

**Batch:** 5
**Depends on:** T4.4 (map component), T2.1 (universal-map cross-campaign read)
**Produces:** universal map view with clustering
**Complexity:** DD: M | CD: M | BR: M

### Context

PRD FR-L2, FR-L3, FR-L4 / EC-4:
> Universal Mapbox map aggregating target pins across all live campaigns, retaining red/amber/green states. Tapping a pin shows campaign name + state; green pins show photo/GPS/username per that campaign's privacy setting; tapping into a campaign opens its dedicated view. Mapbox clustering at low zoom. Universal map renders pins from ≥2 live campaigns with clustering.

Constitution §7: the universal map is the one intentional cross-campaign read — it goes through the single named DAL function from T2.1 and exposes no private fields.

**Design intent:** one Mapbox map aggregating pins from all `live` campaigns via the dedicated cross-campaign read (T2.1). Clustering at low zoom for performance (EC-4 / scale). Tapping a pin shows campaign + state and routes into that campaign's view (T4.4). Per-campaign privacy is respected (admin-only usernames stay hidden from players).

### Objective
Build the universal map aggregating live-campaign pins with clustering, per-pin campaign context, and privacy-respecting detail, sourced from the single cross-campaign DAL read.

### Requirements
1. Render pins from all `live` campaigns using the T2.1 universal read (no private fields leaked).
2. Mapbox clustering at low zoom; decluster on zoom-in.
3. Tap a pin → campaign name + state; route to that campaign's map (T4.4).
4. Green-pin detail respects each campaign's privacy setting.
5. Reuse the Mapbox component/config from T4.4 where possible.

### Acceptance Criteria
- [ ] With two seeded live campaigns, the universal map shows pins from both (EC-4).
- [ ] Clustering appears at low zoom and declusters on zoom-in.
- [ ] Tapping a pin routes into the correct campaign.
- [ ] No private field (username under admin-only, ledger/budget) is exposed via the universal read.

### Files to Create/Modify
- `components/map/UniversalMap.tsx`
- `app/map/page.tsx`
- `app/api/public/pins/route.ts` (calls T2.1 universal read)
- test: `tests/e2e/universal-map.spec.ts`

### Anti-Requirements
- Do NOT query campaigns individually and merge client-side — use the single cross-campaign DAL read.
- Do NOT leak usernames/ledger/budget through the public pins endpoint.
- Do NOT include draft/closed campaigns.

---

## Task 5.3 — Offline queue-and-sync

**Batch:** 5
**Depends on:** T4.1 (capture flow)
**Produces:** offline submission queue + sync
**Complexity:** DD: M | CD: M | BR: M

### Context

PRD §8 NFR:
> Offline tolerance: queue-and-sync for submissions (canvassing dead zones) — in v1, given outdoor field use.

Phase 1 plan risk: claim race + sync conflict — "offline-sync conflict path surfaces 'already filled' cleanly."

**Design intent:** canvassers work in cell dead zones. When offline, a captured submission (photo + metadata) is queued locally (IndexedDB) and the UI confirms "queued — will submit when online." On reconnect, queued submissions POST to the submit handler (T4.1). Conflict handling: if the target was filled/closed while offline, surface a clear "target already filled" outcome rather than failing silently or double-paying. Photos stay local until synced; client compression still applies.

### Objective
Queue submissions locally when offline and sync them on reconnect, with clear conflict handling when a target was filled in the meantime.

### Requirements
1. Detect offline; queue captured submissions (photo + metadata) in IndexedDB with a clear "queued" UI state.
2. On reconnect, automatically POST queued submissions to the submit handler (T4.1) in order.
3. Conflict handling: target already green/closed → surface "already filled" to the player; do not double-submit or double-pay.
4. Successful sync transitions the queued item to the normal pending/approved flow.
5. Queue survives app reload (persisted, not in-memory).

### Acceptance Criteria
- [ ] Test: a submission captured offline is queued and not lost on reload.
- [ ] Test: on reconnect, the queued submission is sent and enters the normal flow.
- [ ] Test: if the target was filled while offline, the player sees "already filled" and no duplicate submission/payment occurs.
- [ ] Queue is persisted in IndexedDB (survives reload).

### Files to Create/Modify
- `lib/offline/queue.ts`, `lib/offline/sync.ts`
- integrate into `app/campaigns/[id]/submit/...` (from T4.1)
- test: `tests/e2e/offline-sync.spec.ts`

### Anti-Requirements
- Do NOT keep the queue only in memory — persist it.
- Do NOT allow a sync to double-pay a target that was filled offline.
- Do NOT block capture while offline — capture works; submission queues.

---

## Task 5.4 — Leaderboard + personal stats

**Batch:** 5
**Depends on:** T4.3 (ledger), T3.1 (close/finalize for grand prize)
**Produces:** leaderboard + player stats UI
**Complexity:** DD: L | CD: L | BR: M

### Context

PRD FR-G1, FR-G2 / §3 grand prize:
> Per-campaign leaderboard (top N + viewer's rank). Per-campaign personal stats: approved count, current tier, $ earned, fliers to next tier, targets remaining. Grand prize awarded to #1 at close; tie-break = most approved placements, then earliest to reach that count.

Constitution §3: money in cents; tie-break logic must match §3.

**Design intent:** a per-campaign ranked board (by approved count / $ earned) showing top N plus the viewer's own rank, and a personal stats panel (approved, tier, $ earned, fliers to next tier, targets remaining). Grand-prize winner is determined at campaign close (the finalize routine in T3.1 sets it; this surface displays it). Tie-break exactly per §3.

### Objective
Build the per-campaign leaderboard and personal-stats surfaces, and display the grand-prize winner determined at close.

### Requirements
1. Per-campaign leaderboard: top N + the viewing player's rank, ordered by approved count (tie-break per §3).
2. Personal stats: approved count, current tier, $ earned (cents→display), fliers to next tier, targets remaining.
3. Display grand-prize winner once the campaign is closed (winner set by T3.1 finalize).
4. All reads campaign-scoped (DAL).

### Acceptance Criteria
- [ ] Leaderboard ordering matches approved count with the §3 tie-break applied.
- [ ] Personal stats compute "fliers to next tier" and "$ earned" correctly from ledger/membership.
- [ ] After close, the grand-prize winner is shown and matches the finalize result.
- [ ] All data is campaign-scoped (no cross-campaign rank bleed).

### Files to Create/Modify
- `app/campaigns/[id]/leaderboard/page.tsx`
- `components/stats/PersonalStats.tsx`
- `lib/leaderboard/rank.ts`
- test: `tests/leaderboard/rank.test.ts`

### Anti-Requirements
- Do NOT compute a cross-campaign global leaderboard (deferred to Phase 3).
- Do NOT re-derive the grand-prize winner here — display the finalize result from T3.1.
- Do NOT display money as floats.

---

## Task 5.5 — End-to-end suite + Mycofest seed

**Batch:** 5
**Depends on:** ALL prior tasks
**Produces:** full e2e suite, submit-time measurement, seeded Mycofest campaign
**Complexity:** DD: M | CD: H | BR: L

### Context

This is the phase's closing gate — it demonstrates the exit criteria on real data. PRD EC-1, EC-2:
> End-to-end loop works: claim → post → submit → approve → pin turns green, on a real phone outdoors. Median submit time ≤ 20s.

It also seeds the real **Mycofest** campaign so the demo is live, not synthetic: name, flier image, the actual target set, $1,000 budget cap, the $1.25/$1.75/$2.25 tier table, grand prize = 2 Mycofest tickets, privacy = admin-only.

**Design intent:** a Playwright e2e walking the full loop end to end (player claims → captures → submits → host approves → pin green → ledger accrues), an instrumented measurement asserting submit time is recorded (EC-2), and a seed script standing up the Mycofest campaign + targets from a provided CSV. Green-lights the Phase-1 demo.

### Objective
Author the full end-to-end test suite proving EC-1/EC-2 and a seed script that stands up the live Mycofest campaign with its real targets and config.

### Requirements
1. Playwright e2e: claim a red target → capture+submit → (host) approve → assert pin turns green and a ledger accrual exists (EC-1).
2. Submit-time instrumentation asserted (a measured duration is recorded; surface it for the ≤20s target, EC-2).
3. Seed script for the Mycofest campaign: config (budget $1,000 cents, tier table, grand prize, privacy admin-only) + targets from CSV.
4. A second seeded live campaign present so the universal map (EC-4) has ≥2 tenants.
5. Document how to run the seed against a fresh environment.

### Acceptance Criteria
- [ ] e2e passes the full claim→approve→green loop with a ledger accrual (EC-1).
- [ ] Submit-time measurement is recorded and surfaced (EC-2 evidence).
- [ ] Seed creates the Mycofest campaign with correct cents-based budget/tiers and its targets.
- [ ] With the seed, the universal map shows ≥2 live campaigns (supports EC-4).
- [ ] Seed run is documented and repeatable on a fresh DB.

### Files to Create/Modify
- `tests/e2e/full-loop.spec.ts`
- `scripts/seed-mycofest.ts`, `scripts/seed-second-campaign.ts`
- `docs/seed.md`
- (data) `data/mycofest-targets.csv` (placeholder; real coords provided by host)

### Anti-Requirements
- Do NOT hard-code Mycofest values into app logic — they live in the seed/config (campaign config from T3.1).
- Do NOT skip the ledger-accrual assertion — green pin without accrual is an incomplete loop.
- Do NOT seed into a production environment from CI.

---

## Batch 5 Exit Check  →  Phase 1 complete
- [ ] Full loop e2e green (EC-1); submit-time recorded (EC-2).
- [ ] Landing + universal map (≥2 live campaigns, clustering) working (EC-4).
- [ ] Offline capture queues and syncs with clean conflict handling.
- [ ] Leaderboard + stats correct; grand-prize winner shown at close.
- [ ] Mycofest campaign seeded and demonstrable.
- [ ] **Phase-1 exit criteria EC-1…EC-7 all pass** (see Phase 1 plan §04).
- [ ] `pnpm lint && pnpm build && pnpm test && pnpm test:e2e` green in CI.

**Phase 1 done.** Next: evaluate Phase 2 (Score & polish) entry, or run the Mycofest campaign live and gather real fraud/coverage data before committing Phase 2 budget.
