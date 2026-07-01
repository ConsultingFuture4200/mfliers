# Flier Canvassing Platform — Constitution

> **Created:** 2026-06-30
> **Last updated:** 2026-06-30
> **Version:** 1.0
> **Scope:** All specs, plans, and tasks within the Flier Canvassing Platform.
> **Governing spec:** flier-canvassing-platform-PRD-v0.4.0.md

This constitution captures non-negotiable, project-level constraints. It does not describe features (the PRD does that). When any spec, plan, or task conflicts with this document, this document wins — or the conflict is escalated via a decision record.

---

## 1. Project Identity

A multi-tenant web platform that hosts many gamified flier-canvassing campaigns at once. Each campaign provides a flier image and a map of predetermined targets; players claim targets, post the flier, and submit geotagged photos that are fraud-screened and paid on a per-campaign tier curve. **It is** a reusable, campaign-agnostic scaffold (first tenant: Mycofest). **It is not** a generic gig-work marketplace, a social network, or a payments processor — money settlement is manual in v1 and the platform's job is to *track* what's owed, not move it.

---

## 2. Stack Constraints

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Language | TypeScript (strict) | Type safety across full stack; one language end-to-end |
| Framework | Next.js (App Router), full-stack | One repo, React front end + API route handlers; pairs with Vercel |
| Front-end UI | React + Tailwind + shadcn/ui | Standing default stack; accessible, fast to build |
| Runtime | Node.js (Vercel serverless functions) | Native Next.js target |
| Database | PostgreSQL + PostGIS extension | Geospatial queries (target proximity, clustering, distance) are first-class needs |
| DB hosting | Managed Postgres with PostGIS, external to Vercel | Vercel does not host databases; PostGIS must be enabled by the provider |
| DB access | Pooled connection (PgBouncer/Supavisor or serverless driver) | Serverless functions exhaust raw Postgres connections without a pooler |
| ORM/query | [NEEDS_CLARIFICATION: Prisma vs Drizzle vs raw SQL? Prisma's PostGIS support is weak — Drizzle or raw SQL handles geospatial better. | Affects: data-layer task sizing] |
| App hosting | Vercel | Pairs with Next.js; zero-config deploys, preview branches |
| Map | Mapbox GL JS | Selected in PRD §10; clustering + pin-drop built in |
| Object storage | [NEEDS_CLARIFICATION: provider — Vercel Blob, Cloudflare R2, or S3? R2 has no egress fees, good for image-heavy audit storage. | Affects: storage cost, upload task] |
| Auth (players) | Phone-OTP | PRD FR-A1; street-worker-friendly |
| Auth (host/admin) | Email + password, role-scoped | PRD FR-A2 |
| Auth provider | [NEEDS_CLARIFICATION: Auth.js (NextAuth) + Twilio Verify, Clerk, or Supabase Auth? Must support phone-OTP AND role claims for tenant isolation. | Affects: auth task, isolation enforcement] |
| Test runner | Vitest (unit/integration) + Playwright (e2e) | Vitest pairs with the TS/Vite ecosystem; Playwright for the camera/map flows |
| CI/CD | Vercel Git integration + GitHub Actions for tests | Tests gate on PR; Vercel handles deploy/preview |
| Package manager | [NEEDS_CLARIFICATION: pnpm vs npm? pnpm is faster/stricter; confirm preference. | Affects: lockfile, CI config] |

**Settled and non-negotiable:** TypeScript, Next.js full-stack, React+Tailwind+shadcn, PostgreSQL+PostGIS, Vercel, Mapbox. The bracketed rows are open implementation choices to resolve during Phase-1 design — they don't reopen the settled rows.

---

## 3. Code Standards

- **Naming:** `camelCase` for variables/functions, `PascalCase` for components/types, `kebab-case` for file names, `SCREAMING_SNAKE_CASE` for env vars. Database columns `snake_case`.
- **File structure:** Next.js App Router conventions — `app/` for routes, `components/` for shared UI, `lib/` for server logic (db, fraud, payout, auth), `lib/db/` for queries, `types/` for shared types. Domain logic lives in `lib/`, never in route handlers directly.
- **Tenant scoping (CRITICAL):** every query that touches campaign-scoped data MUST filter by `campaign_id` at the data-access layer. No campaign-scoped query may be written without an explicit `campaign_id` predicate. This is enforced by convention and by isolation tests (PRD G-6), not left to the UI.
- **Error handling:** server logic returns typed result objects or throws typed errors; route handlers translate to HTTP status + JSON `{ error: { code, message } }`. No silent catches.
- **Logging:** structured JSON logs; levels error/warn/info/debug. Every fraud decision, approval, rejection, settlement, and claim event is logged with `campaign_id`, `player_id`, `submission_id`.
- **Imports/exports:** named exports preferred; default export only where the framework requires it (Next.js pages/layouts). Absolute imports via `@/` alias.
- **Linting:** ESLint (Next.js config + TypeScript strict rules).
- **Formatting:** Prettier, default config, enforced in CI.
- **Money:** all monetary values stored as integer cents, never floats. Tier math computed server-side only — never trust client for payout amounts.
- **Time:** all timestamps stored UTC; server `received_at` is authoritative for any payout or fraud logic (never client clock).
- **Geospatial:** coordinates stored as PostGIS `geography(Point, 4326)`; distance checks use `ST_DWithin` in meters, not hand-rolled haversine in app code.

---

## 4. Cost Doctrine

- **Build vs. buy:** buy/borrow for commodity infrastructure (auth, storage, maps, OTP); build only the differentiated core (fraud pipeline, tenant model, target/claim game logic, tier ledger).
- **SaaS vs. self-hosted:** prefer managed services at this scale — the platform must not become an ops burden. The one self-managed piece (Postgres) is justified by the PostGIS requirement; use a managed PostGIS host, not a hand-rolled server, unless cost forces otherwise.
- **Per-unit cost ceiling:** the platform's own operating cost must stay well below campaign budgets. For Mycofest's $1,000 campaign, monthly infra (Vercel + managed Postgres + Mapbox + storage + OTP) should target < $50/mo, ideally on free/hobby tiers at this volume.
- **Settlement is off-platform in v1** — zero payment-processing cost or PCI scope until Phase 3.
- **Scaling assumption:** design for ~25 concurrent campaigns / 5,000 pins / 2,000 players (PRD §9) before any architectural redesign. Do not over-engineer for scale beyond that in v1.

---

## 5. Security & Compliance

- **Authentication:** phone-OTP (players), email+password (host/admin). No shared accounts.
- **Authorization:** role-based, enforced **server-side** on every request. A host token authorizes only its `scoped_campaign_ids`; a player token authorizes only joined campaigns plus public reads (landing/universal map). UI-only gating is never sufficient.
- **Tenant isolation:** the load-bearing security property. Cross-campaign data access by a host or player is a critical vulnerability, not a bug. Covered by automated isolation tests (PRD G-6) that must pass before any release.
- **Data at rest:** database and object storage encrypted at rest (provider-managed).
- **Data in transit:** HTTPS/TLS everywhere; no exceptions.
- **Secrets management:** all secrets in environment variables (Vercel env / `.env` never committed). No secrets in client bundles. Mapbox public token is scoped/URL-restricted; private keys server-only.
- **Location & photo privacy:** player location and photos are sensitive. Username-on-green-pin defaults to admin-only (PRD FR-M4). Retention: purge photos + location 90 days after campaign close (PRD §9).
- **Audit logging:** immutable, append-only log of all approvals, rejections, manual adjustments, settlements, and claim events. Required for fraud disputes and payout integrity.
- **Regulatory:** none triggered in v1 (no payment processing, manual settlement). Revisit 1099 reporting only if a single player's payout crosses the IRS threshold (unlikely at current budgets). No PCI scope until Phase 3 introduces a payment rail.

---

## 6. Anti-Patterns

| Anti-Pattern | Rationale |
|-------------|-----------|
| Campaign-scoped query without a `campaign_id` filter | Breaks tenant isolation — the platform's core security property |
| Trusting client clock or client-computed payout amounts | Enables payout fraud; server time + server-side tier math are authoritative |
| Storing money as floats | Rounding errors in payouts; use integer cents |
| Hand-rolled distance math in app code | PostGIS `ST_DWithin` is correct and indexed; app-side haversine drifts and won't use spatial indexes |
| UI-only authorization | Role checks must be server-side; hiding a button is not security |
| Raw Postgres connections from serverless functions | Connection exhaustion under load; always go through a pooler |
| Gallery-upload as the default submission path | Defeats live-capture fraud control (PRD FR-S1); camera-only by default |
| Adding a payment rail "while we're at it" in v1 | Manual settlement is a deliberate scope decision; payments are Phase 3, not creep |
| Prisma for the geospatial layer without verifying PostGIS support | Prisma's PostGIS handling is weak; may force raw SQL anyway — decide deliberately (§2) |
| Putting domain logic in route handlers | Untestable, unreusable; logic belongs in `lib/` |

---

## 7. Maintenance

When this constitution changes:
1. Create a decision record (Strategic or Existential tier per `decision-records.md`).
2. Evaluate impact on the PRD and any active task graph.
3. Run change propagation before modifying tasks.

The five bracketed `NEEDS_CLARIFICATION` items in §2 (ORM, storage provider, auth provider, package manager) are implementation choices to resolve at the start of Phase-1 planning. They do not block constitution approval — they are deliberately left open so the data-layer and auth tasks can be sized against a concrete choice during decomposition. None of them reopen the settled stack rows.
