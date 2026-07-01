# Build Todo — Flier Canvassing Platform (Phase 1)

Self-improvement loop per CLAUDE.md §"Operational workflow". Check off cards as their
acceptance criteria are met. Two review gates (T2.1, T3.3) block their dependents.

## Batch 1 — Foundation
- [ ] T1.1 — Next.js + pnpm + TypeScript scaffold
- [ ] T1.2 — Shared domain types
- [ ] T1.3 — PostGIS schema + migrations
- [ ] T1.4 — Test infrastructure (Vitest + Playwright)
- [ ] T1.5 — CI pipeline + pooled DB connection

## Batch 2 — Data + Auth  (⊢ T2.1 isolation review gate)
- [ ] T2.1 — Isolation-scoped DAL + isolation suite  **[REVIEW GATE]**
- [ ] T2.2 — Phone-OTP player authentication
- [ ] T2.3 — Host/admin auth + role-scoping middleware
- [ ] T2.4 — Cloudflare R2 storage + signed uploads

## Batch 3 — Core logic  (⊢ T3.3 dedupe review gate)
- [ ] T3.1 — Campaign lifecycle + configuration
- [ ] T3.2 — Target + claim state machine
- [ ] T3.3 — Dedupe: perceptual hash + different-target gate  **[REVIEW GATE]**
- [ ] T3.4 — Geo + time fraud checks
- [ ] T3.5 — Pipeline orchestrator + tier-3 routing

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
