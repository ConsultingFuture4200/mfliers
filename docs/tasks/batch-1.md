# Phase 1 · Batch 1 — Task Cards

> **Version:** 1.0
> **Created:** 2026-06-30
> **Governing spec:** flier-canvassing-platform-PRD-v0.4.0.md
> **Constitution:** flier-canvassing-platform-CONSTITUTION-v1.0.md
> **Phase plan:** flier-canvassing-platform-PHASE-1-PLAN-v1.0.html
> **Batch:** 1 of 5 — Foundation (5 tasks, parallelizable, ~2 days)

These cards are written for stateless execution agents (Claude Code / Codex / a contractor). Each is self-contained: an agent with zero prior project knowledge should be able to complete it from the card alone. Constitution and spec constraints are quoted directly, not referenced.

**Resolved stack choices** (from Phase 1 plan §02, locked for this batch):
- ORM/query: **Drizzle ORM** (raw-SQL escape hatch for PostGIS)
- Object storage: **Cloudflare R2**
- Auth: **Auth.js + Twilio Verify**
- Package manager: **pnpm**

**Batch 1 dependency order:** T1.1 first (everything depends on the scaffold). Then T1.2, T1.4, T1.5 in parallel. Then T1.3 (needs types from T1.2).

```
T1.1 scaffold
  ├── T1.2 types ──→ T1.3 schema
  ├── T1.4 test infra
  └── T1.5 CI + pooled DB
```

---

## Task 1.1 — Next.js + pnpm + TypeScript scaffold

**Batch:** 1
**Depends on:** none
**Produces:** repo skeleton, `package.json`, Tailwind + shadcn config, folder layout, lint/format config
**Complexity:** DD: L | CD: L | BR: M

### Context

This is the foundation task for a multi-tenant web platform. Per the project constitution §2, the stack is **fixed and non-negotiable**:

> Language: TypeScript (strict). Framework: Next.js (App Router), full-stack. Front-end UI: React + Tailwind + shadcn/ui. Runtime: Node.js (Vercel serverless). Package manager: pnpm.

Constitution §3 mandates this folder structure:

> Next.js App Router conventions — `app/` for routes, `components/` for shared UI, `lib/` for server logic (db, fraud, payout, auth), `lib/db/` for queries, `types/` for shared types. Domain logic lives in `lib/`, never in route handlers directly.

Constitution §3 naming rules:
> `camelCase` for variables/functions, `PascalCase` for components/types, `kebab-case` for file names, `SCREAMING_SNAKE_CASE` for env vars. Absolute imports via `@/` alias.

Constitution §3 tooling:
> Linting: ESLint (Next.js config + TypeScript strict rules). Formatting: Prettier, default config, enforced in CI.

### Objective
Stand up a clean Next.js App Router project with pnpm, TypeScript strict mode, Tailwind, shadcn/ui, ESLint, and Prettier, organized to the constitution's folder layout.

### Requirements
1. Initialize a Next.js (latest stable, App Router) project using **pnpm**.
2. TypeScript with `strict: true` in `tsconfig.json`; configure the `@/` path alias to project root.
3. Install and configure Tailwind CSS and initialize shadcn/ui.
4. Create the directory skeleton: `app/`, `components/`, `lib/`, `lib/db/`, `lib/fraud/`, `lib/payout/`, `lib/auth/`, `types/`, with a `.gitkeep` in each empty dir.
5. Configure ESLint (Next.js + `@typescript-eslint` strict) and Prettier (default config). Add `lint` and `format` scripts to `package.json`.
6. Add a `.env.example` listing every env var the platform will need (placeholders only): `DATABASE_URL`, `TWILIO_*`, `R2_*`, `MAPBOX_*`, `AUTH_SECRET`. Ensure `.env*` is gitignored except `.env.example`.
7. Replace the default landing route with a minimal placeholder page (real landing is T5.1).

### Acceptance Criteria
- [ ] `pnpm install` succeeds with a committed `pnpm-lock.yaml`.
- [ ] `pnpm build` completes with zero TypeScript errors under strict mode.
- [ ] `pnpm lint` passes on the scaffold.
- [ ] `pnpm format --check` passes.
- [ ] All directories from Req 4 exist in the repo.
- [ ] `@/components/...` style imports resolve.
- [ ] `.env` is gitignored; `.env.example` is committed.

### Files to Create/Modify
- `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `next.config.js`
- `tailwind.config.ts`, `postcss.config.js`, `components.json` (shadcn)
- `.eslintrc.json`, `.prettierrc`, `.gitignore`, `.env.example`
- `app/layout.tsx`, `app/page.tsx` (placeholder)
- `.gitkeep` files across the `lib/*` and `types/` dirs

### Anti-Requirements
- Do NOT use npm or yarn — pnpm only.
- Do NOT add a database client, auth library, or Mapbox yet — those are later tasks.
- Do NOT build real UI beyond a placeholder page.
- Do NOT put any business logic in `app/` route files.

---

## Task 1.2 — Shared domain types

**Batch:** 1
**Depends on:** T1.1 (scaffold + `types/` dir + `@/` alias)
**Produces:** `types/domain.ts` — all core entity types
**Complexity:** DD: L | CD: L | BR: H (every later task imports these)

### Context

This task defines the TypeScript types for every core entity. It has **high blast radius** — schema (T1.3), DAL (T2.1), fraud pipeline, ledger, and all surfaces import these. Get the shapes right.

The data model from PRD §8 (authoritative):

> - **Campaign**: id, name, flier_image_url, budget_cap, tier_table(json), grand_prize, privacy_setting, proximity_radius_m, settlement_mode, state(draft/live/closed), host_id, start/end
> - **Target**: id, campaign_id, label, lat, long, state, claimed_by, claim_expires_at, filled_by_submission_id
> - **Submission**: id, campaign_id, player_id, target_id, photo_url, device_gps, exif_gps, exif_ts, received_at, phash, fraud_checks[], decision, decided_by, decided_at
> - **Player**: id, phone (global login)
> - **CampaignMembership**: player_id, campaign_id, approved_count, current_tier, balance_owed, rank
> - **PayoutLedger**: id, campaign_id, submission_id, player_id, amount, tier_at_time, cumulative_committed, settled(bool), settled_at
> - **User/Role**: id, type(site_admin/host), scoped_campaign_ids[]

Two constitution §3 constraints that shape the types directly:

> **Money:** all monetary values stored as integer cents, never floats.
> **Time:** all timestamps stored UTC; server `received_at` is authoritative.

So: `budget_cap`, `amount`, `cumulative_committed`, `balance_owed` are `number` typed as **integer cents** (annotate clearly). Timestamps are ISO strings or `Date` (pick one and be consistent — recommend `Date` in the domain, serialized at boundaries).

Pin state and decision enums:
- Target `state`: `'red' | 'amber' | 'green'`
- Campaign `state`: `'draft' | 'live' | 'closed'`
- Submission `decision`: `'pending' | 'approved' | 'rejected' | 'needs_review'`
- privacy_setting: `'public_username' | 'admin_only'`
- settlement_mode: `'manual'` (only value in v1; keep as enum for future)
- User type: `'site_admin' | 'host'`

A coordinate type: `{ lat: number; long: number }`. A `tier_table` type: an ordered array of `{ minCount: number; maxCount: number | null; payoutCents: number }`. A `fraud_check` result type: `{ check: string; passed: boolean; detail: string; score?: number }`.

### Objective
Define all core domain types in a single `types/domain.ts`, with money-as-cents and enums made explicit.

### Requirements
1. Export a TypeScript type/interface for each entity in PRD §8.
2. Define the enums/unions listed above as exported string-literal union types (or `as const` objects).
3. Define `Coordinate`, `TierTable` (ordered band array), and `FraudCheckResult` helper types.
4. Annotate every monetary field with a comment marking it integer cents.
5. Use `Date` for timestamps in the domain layer.
6. No runtime logic — types only (plus `as const` enums if used).

### Acceptance Criteria
- [ ] `pnpm build` passes with these types in strict mode.
- [ ] Every entity from PRD §8 has a corresponding exported type.
- [ ] Monetary fields are clearly marked as cents.
- [ ] Target/campaign/submission state unions match the values listed in Context.
- [ ] No imports from `lib/` (types are leaf-level, depend on nothing project-internal).

### Files to Create/Modify
- `types/domain.ts` — all entity and helper types

### Anti-Requirements
- Do NOT add database/ORM decorators — these are pure TS types (Drizzle schema is T1.3).
- Do NOT include validation logic (that lives with the DAL/handlers).
- Do NOT use `number` for money without a cents annotation.
- Do NOT define types for any entity not in PRD §8.

---

## Task 1.3 — PostGIS schema + migrations

**Batch:** 1
**Depends on:** T1.2 (domain types to mirror)
**Produces:** Drizzle schema, SQL migration enabling PostGIS, indexes
**Complexity:** DD: M | CD: M | BR: H

### Context

This task creates the database schema using **Drizzle ORM** against **PostgreSQL with the PostGIS extension**. Drizzle was chosen specifically because (Phase 1 plan §02):

> Drizzle ORM — first-class raw-SQL escape hatch for PostGIS `ST_DWithin`; Prisma's geospatial support is weak.

Constitution §3, geospatial rule:
> coordinates stored as PostGIS `geography(Point, 4326)`; distance checks use `ST_DWithin` in meters, not hand-rolled haversine in app code.

Constitution §3, the load-bearing isolation rule:
> every query that touches campaign-scoped data MUST filter by `campaign_id` at the data-access layer ... This is enforced by convention and by isolation tests.

So the schema must put `campaign_id` (FK) on every campaign-scoped table: `targets`, `submissions`, `campaign_memberships`, `payout_ledger`. Add a composite/secondary index on `campaign_id` for each, plus a spatial index on the geography columns.

Constitution §3, money + time:
> Money as integer cents; timestamps UTC.

So monetary columns are `integer` (or `bigint`) cents, never `numeric`/`float`. Timestamps are `timestamptz`.

Mirror the entities from `types/domain.ts` (T1.2). Tables: `campaigns`, `targets`, `submissions`, `players`, `campaign_memberships`, `payout_ledger`, `users` (host/admin), plus a join representation for `users.scoped_campaign_ids` (either an array column or a `user_campaigns` join table — prefer a join table for FK integrity).

Coordinates: store `geography(Point,4326)` for `targets` (target location) and for the device/EXIF GPS on `submissions`.

### Objective
Define the full Drizzle schema and an initial migration that enables PostGIS, creates all tables with `campaign_id` scoping, money-as-cents columns, `timestamptz`, geography points, and the required indexes.

### Requirements
1. Drizzle schema file(s) under `lib/db/schema/` mirroring `types/domain.ts`.
2. Initial migration that runs `CREATE EXTENSION IF NOT EXISTS postgis;` before table creation.
3. Every campaign-scoped table (`targets`, `submissions`, `campaign_memberships`, `payout_ledger`) has a non-null `campaign_id` FK and an index on it.
4. `targets.location`, `submissions.device_gps`, `submissions.exif_gps` are `geography(Point,4326)`; add GiST spatial indexes on `targets.location`.
5. Monetary columns (`budget_cap`, `amount`, `cumulative_committed`, `balance_owed`) are integer cents.
6. All timestamps `timestamptz`. Enumerated columns use Postgres enums or check constraints matching the T1.2 unions.
7. `users.scoped_campaign_ids` modeled as a `user_campaigns` join table.
8. Provide a documented way to run migrations (`pnpm db:migrate` script) against a `DATABASE_URL`.

### Acceptance Criteria
- [ ] Migration applies cleanly against a fresh Postgres+PostGIS database with zero errors.
- [ ] `SELECT postgis_version();` succeeds after migration.
- [ ] Every campaign-scoped table has a `campaign_id` column with an index (verifiable via `\d+`).
- [ ] A GiST index exists on `targets.location`.
- [ ] A `ST_DWithin` query against `targets.location` runs and uses the spatial index (`EXPLAIN` shows index scan).
- [ ] No monetary column is `float`/`numeric`-typed; all are integer-based.
- [ ] Drizzle schema compiles under `pnpm build`.

### Files to Create/Modify
- `lib/db/schema/*.ts` — Drizzle table definitions
- `lib/db/migrate.ts` (or drizzle-kit config) + generated SQL migration under `lib/db/migrations/`
- `drizzle.config.ts`
- `package.json` — add `db:migrate`, `db:generate` scripts

### Anti-Requirements
- Do NOT write the data-access/query layer here — that's T2.1. Schema + migration only.
- Do NOT use Prisma.
- Do NOT store coordinates as separate float lat/long columns — use `geography(Point,4326)`.
- Do NOT store money as `numeric` or `real`.
- Do NOT seed data here (Mycofest seed is T5.5).

---

## Task 1.4 — Test infrastructure (Vitest + Playwright)

**Batch:** 1
**Depends on:** T1.1 (scaffold)
**Produces:** Vitest + Playwright config, seeded two-campaign test fixture
**Complexity:** DD: L | CD: L | BR: M

### Context

Constitution §2 test stack:
> Vitest (unit/integration) + Playwright (e2e). Vitest pairs with the TS/Vite ecosystem; Playwright for the camera/map flows.

This infra is needed early because two later exit criteria depend on it:
- **EC-5 (isolation):** "Automated isolation test suite, 100% pass" — needs a fixture with **two** campaigns to prove no cross-campaign reads.
- **EC-4 (maps):** "Two seeded campaigns, visual + state assert."

So the test fixture must seed **two distinct campaigns** with their own targets/submissions, enabling isolation and multi-campaign map assertions later. The fixture should be reusable by T2.1's isolation suite.

This task sets up the harness and fixture only — it does not write feature tests (those ship with their features).

### Objective
Configure Vitest and Playwright, and provide a reusable seeded test fixture containing two separate campaigns with targets, for use by isolation and map tests downstream.

### Requirements
1. Vitest config for unit + integration tests, with a test DB setup/teardown helper.
2. Playwright config for e2e (single browser is fine for v1; mobile viewport project for the camera flow).
3. A seed/fixture module that creates two campaigns (`Campaign A`, `Campaign B`), each with ≥3 targets and ≥1 player membership, against an isolated test database.
4. Test scripts in `package.json`: `test`, `test:e2e`.
5. A teardown that resets the test DB between runs (transaction rollback or truncate).

### Acceptance Criteria
- [ ] `pnpm test` runs Vitest and passes with at least one trivial smoke test.
- [ ] `pnpm test:e2e` launches Playwright and passes a trivial smoke test.
- [ ] The fixture creates exactly two campaigns with disjoint targets, verifiable by a fixture self-test.
- [ ] Test DB state does not leak between test runs.

### Files to Create/Modify
- `vitest.config.ts`, `playwright.config.ts`
- `tests/fixtures/seed-two-campaigns.ts`
- `tests/setup.ts` (DB setup/teardown)
- `tests/smoke.test.ts`, `tests/e2e/smoke.spec.ts`
- `package.json` — `test`, `test:e2e` scripts

### Anti-Requirements
- Do NOT write feature/isolation tests here — only the harness + fixture (isolation suite is T2.1).
- Do NOT seed the real Mycofest data — generic Campaign A/B only.
- Do NOT depend on a deployed environment; tests run against a local/CI Postgres+PostGIS.

---

## Task 1.5 — CI pipeline + pooled DB connection

**Batch:** 1
**Depends on:** T1.1 (scaffold). Coordinates with T1.3 (uses `DATABASE_URL`) and T1.4 (runs tests).
**Produces:** GitHub Actions workflow, pooled Postgres client, Vercel link
**Complexity:** DD: L | CD: M | BR: L

### Context

Constitution §2:
> CI/CD: Vercel Git integration + GitHub Actions for tests. Tests gate on PR; Vercel handles deploy/preview.

Constitution §6 anti-pattern (load-bearing for serverless):
> Raw Postgres connections from serverless functions → Connection exhaustion under load; always go through a pooler.

So the database client this task creates must connect **through a pooler** (Supavisor, PgBouncer, or a serverless driver's pooled endpoint), not open raw connections per invocation. Provide a single shared `lib/db/client.ts` that the rest of the app imports.

The CI workflow must spin up a Postgres+PostGIS service, run migrations (from T1.3), and run the test suite (from T1.4) on every PR.

### Objective
Create the pooled database client and a GitHub Actions CI workflow that runs lint, build, migrations, and tests against a PostGIS service on every PR; link the repo to Vercel.

### Requirements
1. `lib/db/client.ts` — a single pooled Drizzle/Postgres client instance suitable for serverless (pooled connection string or serverless driver). No per-call raw connections.
2. GitHub Actions workflow: on PR, run `pnpm install`, `pnpm lint`, `pnpm build`, apply migrations against a `postgis/postgis` service container, then `pnpm test`.
3. CI fails the PR if lint, build, or tests fail.
4. Document the Vercel link step and required env vars (in README or `docs/deploy.md`).
5. Ensure secrets come from CI/Vercel env, never committed (constitution §5).

### Acceptance Criteria
- [ ] The Actions workflow runs green on a PR containing Batches 1's other tasks.
- [ ] CI uses a `postgis/postgis` service container and migrations apply in CI.
- [ ] A deliberately failing test causes the PR check to fail (verify once, then revert).
- [ ] `lib/db/client.ts` uses a pooled connection (documented in a comment with the pooler used).
- [ ] No secrets are present in the repo; CI reads them from GitHub secrets.

### Files to Create/Modify
- `lib/db/client.ts`
- `.github/workflows/ci.yml`
- `docs/deploy.md` (Vercel link + env var list)

### Anti-Requirements
- Do NOT open raw `pg` connections in serverless code paths — pooled only.
- Do NOT commit any secret or real connection string.
- Do NOT deploy to production in CI — preview/test only; Vercel handles deploy on merge.

---

## Batch 1 Exit Check

Batch 1 is complete and Batch 2 may start when:
- [ ] All five task acceptance-criteria sets pass.
- [ ] `pnpm install && pnpm lint && pnpm build && pnpm test` is green locally and in CI.
- [ ] Migrations apply to a fresh PostGIS DB; `ST_DWithin` uses the spatial index.
- [ ] The two-campaign test fixture is in place (gates EC-4/EC-5 work in later batches).
- [ ] DB client is pooled; no raw serverless connections.

**Next:** Batch 2 (Data + Auth) — T2.1 isolation-scoped DAL is the first task and carries a review gate before Batch 3. Ask for Batch 2 cards when Batch 1 lands.
