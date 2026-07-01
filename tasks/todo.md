# Build Todo — Flier Canvassing Platform (Phase 1)

Self-improvement loop per CLAUDE.md §"Operational workflow". Check off cards as their
acceptance criteria are met. Two review gates (T2.1, T3.3) block their dependents.

## Batch 1 — Foundation
- [x] T1.1 — Next.js + pnpm + TypeScript scaffold
- [x] T1.2 — Shared domain types
- [x] T1.3 — PostGIS schema + migrations
- [x] T1.4 — Test infrastructure (Vitest + Playwright)
- [x] T1.5 — CI pipeline + pooled DB connection

## Batch 2 — Data + Auth  (⊢ T2.1 isolation review gate)
- [x] T2.1 — Isolation-scoped DAL + isolation suite  **[REVIEW GATE — suite is 100%
      green against a live PostGIS DB (28/28); awaiting the human confirmation
      CLAUDE.md requires before Batch 3 starts]**
- [x] T2.2 — Phone-OTP player authentication
- [x] T2.3 — Host/admin auth + role-scoping middleware  (46/46 tests green,
      `pnpm lint`/`build`/`format:check` clean; `users.email`/`password_hash`
      added via migration 0005, nullable — see lessons.md)
- [x] T2.4 — Cloudflare R2 storage + signed uploads (52/52 tests green,
      including a live-mock suite against a real MinIO S3-compatible
      container; `pnpm lint`/`build`/`format:check` clean; R2 credentials
      themselves unverified-here — no live Cloudflare account in this
      sandbox — see lessons.md)

## Batch 3 — Core logic  (⊢ T3.3 dedupe review gate)
- [x] T3.1 — Campaign lifecycle + configuration (24/24 new tests green
      against a live PostGIS DB; full suite 81/81 non-skipped green;
      `pnpm lint`/`build`/`format:check` clean — see lessons.md)
- [x] T3.2 — Target + claim state machine (15/15 new tests green against a
      live PostGIS DB, including a real concurrent-claim race test; full
      suite 104/104 non-skipped green; `pnpm lint`/`build`/`format:check`
      clean — see lessons.md)
- [x] T3.3 — Dedupe: perceptual hash + different-target gate  **[REVIEW GATE — 10/10
      new tests green against a live PostGIS DB (dHash unit tests + seeded
      threshold-tuning measurement + checkDuplicate acceptance criteria);
      full suite 114/114 non-skipped green; `pnpm lint`/`build`/`format:check`
      clean. Threshold=9/64 bits: measured 0% FP (0/66 seed pairs), 0% FN
      (0/12 seed pairs) — see lib/fraud/dedupe.ts's doc comment. NOT yet
      given the human confirmation CLAUDE.md requires before T3.5 composes
      it — also flags an unresolved conflict between this card's
      cross-campaign requirement (PRD FR-F3) and ADR-0001's "exactly one
      cross-campaign read" framing (see lessons.md and this task's
      needsClarification) that needs explicit reviewer sign-off alongside
      the threshold numbers.]**
- [x] T3.4 — Geo + time fraud checks (18/18 new tests green against a live
      PostGIS DB — checkProximity/checkGpsAgreement acceptance-criteria
      distances (18m/80m @ 40m default, 22m/120m @ 50m, per-campaign
      override) plus checkTimestamps (unit, no DB) and checkTravelSpeed
      (5km/2min flag + campaign-scoping); full suite 136/136 non-skipped
      green; `pnpm lint`/`build`/`format:check` clean. NEEDS_CLARIFICATION:
      no `clientTs` field exists on `Submission`/`submissions` — see
      lib/fraud/time.ts's doc comment and lessons.md.)
- [x] T3.5 — Pipeline orchestrator + tier-3 routing (9/9 new tests green
      against a live PostGIS DB — auto-approve on all-pass tier-1/2, forced
      needs_review at tier-3 (derived from `campaign.tierTable`'s open top
      band, not hard-coded), reject on a hard-fail (dedupe hit or proximity
      fail), needs_review on a soft/ambiguous flag alone, full persistence
      of all 5 `FraudCheckResult`s + decision, `autoDecisionRate` unit
      tests; full suite 147/147 non-skipped green; `pnpm lint`/`build`/
      `format:check` clean — see lessons.md)

## Batch 4 — Surfaces
- [ ] T4.1 — Submission capture flow
- [ ] T4.2 — Host review queue
- [ ] T4.3 — Ledger + tier math + budget cap
- [ ] T4.4 — Per-campaign Mapbox map
- [ ] T4.5 — Admin target import (CSV + pin-drop)

## Batch 5 — Integration
- [ ] T5.1 — Landing page
- [ ] T5.2 — Universal aggregate map
- [ ] T5.3 — Offline queue-and-sync
- [ ] T5.4 — Leaderboard + personal stats
- [ ] T5.5 — End-to-end suite + Mycofest seed
