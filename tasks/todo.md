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
- [x] T4.1 — Submission capture flow (rear-camera-default capture UI +
      client-side EXIF/GPS extraction + compression + submit handler;
      22/22 new DB-backed + unit tests green against a live PostGIS DB
      (`tests/capture/submit.test.ts`, `tests/capture/exif.test.ts`,
      `tests/capture/compress.test.ts`), 5/5 mocked route tests green
      (`tests/campaigns/submissions-route.test.ts`), 3/3 real-browser
      Playwright e2e specs green on both desktop + mobile projects
      (`tests/e2e/submit-flow.spec.ts` — GPS-denial block, default-camera
      submit + EC-2 duration instrumentation, gallery-fallback auto-flag);
      full suite 192/192 non-skipped green (incl. a live-MinIO R2 suite);
      `pnpm lint`/`build`/`format:check` clean. Closed the T3.5-review
      atomicity gap via a `submissionId`-keyed idempotency design rather
      than a cross-DAL transaction — see lessons.md. `accrue_ledger` is a
      documented no-op pending T4.3 (doesn't exist yet as of this card).
      NEEDS_CLARIFICATION for T4.3: confirm it extends `lib/capture/
      submit.ts`'s `dispatchAction` seam. See lessons.md for the EXIF
      timezone caveat and the server-side (not client-trusted) phash design.)
- [x] T4.2 — Host review queue (host-scoped `lib/review/queue.ts` +
      `lib/review/decision.ts` approve/reject/manual-adjustment
      orchestration, `lib/audit/log.ts` + `lib/db/dal/audit-log.ts`
      immutable audit trail, new `audit_log` table via migration 0006;
      12/12 new tests green against a live PostGIS DB
      (`tests/host/review-queue.test.ts` — cross-campaign scoping/denial,
      card contents (photo/distance/canvasser/checks), approve→green +
      audit row, idempotent re-approve, reject→red+claim-freed+
      player-visible reason, reason-required, manual adjustment,
      multi-action audit accumulation); full suite 198/198 non-skipped
      green; `pnpm lint`/`build`/`format:check` clean. Ledger accrual
      (PRD FR-R3) is a documented no-op — `lib/payout/ledger.ts` is T4.3,
      which depends on *this* card per batch-4.md's own sequencing, so it
      cannot exist yet; flagged `unverified` rather than faked. Rejection
      reason is stored on `Submission.fraudChecks` (no schema column,
      mirrors T4.1's gallery-fallback pattern) — flagged
      NEEDS_CLARIFICATION for a future player-facing endpoint. Also
      flagged for a future review pass: register `lib/db/dal/audit-log.ts`
      in `tests/isolation/isolation.test.ts`'s scoped-module list
      (T3.3's dedupe-hashes precedent — cross-cutting suite edits happen
      in a review pass, not the introducing card). See lessons.md.)
- [x] T4.3 — Ledger + tier math + budget cap (`lib/payout/tiers.ts` pure
      tier lookup + 80%-warning helper, `lib/payout/ledger.ts` public
      surface, `lib/db/dal/payout-ledger.ts`'s `accrueLedgerEntry` atomic
      transaction (campaign-row `FOR UPDATE` lock + `UNIQUE (campaign_id,
      submission_id)` + `ON CONFLICT DO NOTHING`), new migration 0007
      (`payout_ledger.unpayable` column + the unique constraint),
      `app/api/host/campaigns/[id]/ledger/route.ts`; wired both documented
      no-op seams from T4.1 (`lib/capture/submit.ts`'s `dispatchAction`'s
      `accrue_ledger` case) and T4.2 (`lib/review/decision.ts`'s
      `accrueLedgerForApproval`) to the real `accrue()`. 15/15 new tests
      green against a live PostGIS DB (`tests/payout/ledger.test.ts` — tier
      boundary counts 10/11/25/26, idempotent + concurrent-same-submission
      retry, at-cap unpayable marking + a real concurrent near-cap race,
      80% warning boundary, balance-owed, settlement + audit log, host
      authorization); full suite 217/217 non-skipped green (up from 198 —
      fixed 2 pre-existing isolation-suite assertions that assumed one
      ledger row could share a submission, now structurally impossible
      given the new unique constraint — see lessons.md); `pnpm lint`/
      `build`/`format:check` clean. Flags one NEEDS_CLARIFICATION: the
      tier-lookup "count" convention here (ordinal, `priorCount + 1`) is
      one off from T3.5's pipeline tier-3-routing gate (raw prior count,
      no `+1`) at the exact boundary — see lessons.md and lib/payout/
      tiers.ts's doc comment.)
- [x] T4.4 — Per-campaign Mapbox map (`lib/campaign/map.ts` domain logic —
      `listMapPins`/`getTargetDetail`, both taking a `MapPrincipal` that
      does its own `requireCampaignAccess` for a staff viewer and gates a
      green pin's canvasser identity behind `campaign.privacySetting` for
      a player viewer; `app/api/campaigns/[id]/targets/route.ts` (poll
      list) + `.../[targetId]/route.ts` (tap-through detail), both reusing
      the existing `.../claim/route.ts` sibling for red-pin claims;
      `components/map/CampaignMap.tsx` — a pure client component (mirrors
      T4.1's capture page) that loads/polls the list, renders Mapbox GL
      markers colored by state, and reconciles them in place; `app/
      campaigns/[id]/map/page.tsx` is a thin wrapper. No schema/migration
      changes — reused the existing `targets`/`campaigns`/`submissions`/
      `players` DAL reads. Added `mapbox-gl` (no `@types/mapbox-gl` — the
      package ships its own types). 16/16 new tests green against a live
      PostGIS DB (`tests/campaign/map.test.ts` — isolation, pin shape/
      coloring, staff scoping, the full privacy matrix, not-found errors),
      9/9 new route tests (`tests/campaigns/targets-route.test.ts`), 8/8
      new e2e tests both desktop and mobile (`tests/e2e/campaign-map.spec.ts`
      — claim/claim-conflict/detail/privacy/polling/load-error, all via the
      component's no-Mapbox `PinFallbackList` degradation path, since this
      sandbox has no `NEXT_PUBLIC_MAPBOX_TOKEN`/WebGL to drive real Mapbox
      rendering — see lessons.md); full suite 250/258 non-skipped green
      (8 pre-existing skips); `pnpm lint`/`build` clean. The real Mapbox
      visual-rendering acceptance criterion is marked `unverified-here`
      (needs a live Mapbox token + a WebGL-capable browser this sandbox
      doesn't reliably have) — the marker-creation/coloring/click-wiring
      code path is real and unit-exercised via the fallback, just not
      screenshotted against a live basemap. NEEDS_CLARIFICATION: there is
      still no player "join a campaign" write path as of this card (only
      T4.3's ledger-accrual upsert and the fixture/seed scripts write
      `campaign_memberships` rows) — batch-5 explicitly owns "browse live
      campaigns ... join," so this card lets any authenticated player
      browse/view any campaign's map without requiring prior membership,
      consistent with claim (`.../claim/route.ts`, T3.2) already being the
      first membership-gated step in that funnel. See lessons.md.)
- [x] T4.5 — Admin target import (CSV + pin-drop) (`lib/target/csv-import.ts`
      — `parseTargetsCsv`/`importTargetsFromCsv`/`createPinDropTarget`, both
      site-admin-guarded via `requireSiteAdmin`; `createTargets` bulk-insert
      added to `lib/db/dal/targets.ts`, explicit `state: "red"`, campaign-
      scoped, coordinates through `toGeography`; single dispatch route
      `app/api/admin/campaigns/[id]/targets/import/route.ts` — JSON body
      `{mode:"csv"|"pin",...}` rather than multipart, since the card names
      exactly one route file; `app/admin/campaigns/[id]/targets/page.tsx`
      (Server Component, site-admin-only, denies host/unauthenticated) +
      `TargetImportForm.tsx` client island (CSV file input + label/lat/long
      pin-drop form) + the reused T4.4 `CampaignMap` component underneath
      (its own 5-10s poll surfaces newly-imported pins — no extra wiring
      needed) for "resulting target set appears on the map." Tests
      (`tests/admin/target-import.test.ts`): 3 pure `parseTargetsCsv` cases
      + 6 live-PostGIS cases (valid CSV -> scoped red targets + isolation
      from campaign B + appears via `listMapPins`; malformed/out-of-range
      rows reported not dropped while good rows still import; pin-drop
      creates one red target at the coords; out-of-range pin-drop rejected
      with zero rows created; host principal denied `ForbiddenError` on
      both paths) — all passing against the real `mfliers-test` DB; full
      suite 252/260 green (8 pre-existing skips, none from this card);
      `pnpm lint`/`build`/`format:check` clean on every file this card
      touched. NEEDS_CLARIFICATION (see lessons.md): the card doesn't say
      whether one malformed CSV row should fail the whole import — treated
      it as partial-success-with-report (create the good rows, report the
      bad ones), which is the only reading under which both AC1 and AC2 are
      independently true of one function. Flag for review if an all-or-
      nothing transaction was actually intended.)

## Batch 5 — Integration
- [ ] T5.1 — Landing page
- [ ] T5.2 — Universal aggregate map
- [ ] T5.3 — Offline queue-and-sync
- [ ] T5.4 — Leaderboard + personal stats
- [ ] T5.5 — End-to-end suite + Mycofest seed
