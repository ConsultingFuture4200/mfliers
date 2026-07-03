# CLAUDE.md — Flier Canvassing Platform (Mycofest)

> Agent operating instructions for this repository. Read this before touching code.
> **Project:** multi-tenant, gamified flier-canvassing platform. First tenant: Mycofest.
> **Last updated:** 2026-07-02

**Status:** Phase 1 is **built, verified, and deployed live** — https://mfliers-eight.vercel.app
(Vercel + Supabase Postgres/PostGIS). Phase-1 work was a **spec-driven build (SDD)**; the
task cards are done. Ongoing work is **operator-directed** enhancement (post-Phase-1), so
the "card is the contract" discipline below applies when building *from a card*; for
operator-directed changes, honor the constitution non-negotiables, keep tests green, and
record any decision that touches a non-negotiable as an ADR (see `docs/decisions/`).

When the spec/constitution and this file conflict, the spec/constitution win — flag the
conflict, do not silently resolve it.

---

## Governing documents (read before building)

The build is fully specified. Do not invent scope. The authoritative documents, in precedence order:

1. **Constitution** — `docs/constitution.md` (from `flier-canvassing-platform-CONSTITUTION-v1.0.md`). Non-negotiable project law: stack, code standards, security, anti-patterns. If a change would violate it, stop and surface it.
2. **PRD** — `docs/prd.md` (from `flier-canvassing-platform-PRD-v0.4.0.md`). What the platform does; the FR-* requirements and EC-* exit criteria.
3. **Phase plan** — `docs/phase-1-plan.html`. Deliverables, exit criteria, batch sequence, cost, risks.
4. **Task cards** — `docs/tasks/batch-{1..5}.md`. The unit of work. Each card is self-contained; build exactly what a card specifies, nothing more.
5. **Decision records** — `docs/decisions/*.md`. ADRs that lock in structure or amend a non-negotiable. Current: 0001 tenant-isolation = scoped-repository DAL; 0002 a 2nd sanctioned cross-campaign read (PII-free dedupe hashes); 0003 player auth = email one-time-code (superseded phone-OTP). A change touching a non-negotiable needs a new ADR.

**Rule:** work is done card-by-card. Pick a task card, satisfy its acceptance criteria, respect its anti-requirements, stop. Do not pull work forward from later cards or invent requirements a card doesn't state. If a card is ambiguous or the spec is silent, insert a `NEEDS_CLARIFICATION` note and ask — never guess.

---

## What this project is / is not

- **Is:** a reusable, campaign-agnostic platform that hosts many flier campaigns; players claim map targets, post a flier, submit a geotagged photo that is fraud-screened and paid on a per-campaign tier curve.
- **Is not:** a payments processor (settlement is **manual** in v1 — the platform tracks what's owed, moves no money), a canvassing CRM, or a social network. Do not add a payment rail, messaging, or route optimization in v1 — those are explicitly deferred to Phase 3.

---

## Tech stack (fixed — do not relitigate)

| Layer | Choice |
|-------|--------|
| Language | TypeScript (strict) |
| Framework | Next.js (App Router), full-stack |
| UI | React + Tailwind + shadcn/ui |
| DB | PostgreSQL + **PostGIS** |
| ORM | Drizzle (raw-SQL escape hatch for PostGIS) |
| DB access | pooled connection (never raw from serverless) |
| Hosting | Vercel (app) + **Supabase** managed Postgres+PostGIS |
| Map | Mapbox GL JS (**v3**) |
| Storage | S3-compatible client (`lib/storage/r2.ts`) → **Supabase Storage** live (R2-compatible; supports any S3 endpoint via `R2_ENDPOINT`) |
| Auth | Auth.js v5 — **email one-time-code** for players (ADR-0003, was phone-OTP; Twilio removed); email/password host+admin |
| UI system | shadcn **base-nova** (Base UI, not Radix) + field-guide design tokens (`docs/decisions`, `docs/prototype.jsx`) |
| Test | Vitest (unit/integration) + Playwright (e2e) |
| Package manager | **pnpm** |

---

## The non-negotiables (constitution §3, §5, §6)

These are the rules most likely to be violated by accident. Internalize them:

1. **Tenant isolation is the core security property.** Every query touching campaign-scoped data (`targets`, `submissions`, `campaign_memberships`, `payout_ledger`) MUST filter by `campaign_id` at the data-access layer. There is exactly one sanctioned cross-campaign read (the universal map) and it exposes no private fields. A campaign-scoped query without a `campaign_id` predicate is a critical bug, not a style nit.
2. **Authorization is server-side, always.** Hiding a button is not security. Hosts are scoped to their `scoped_campaign_ids`; site admins are platform-wide. Guard every host/admin route.
3. **Money is integer cents.** Never floats/`numeric` for money. Tier math is computed **server-side only** — never trust a client-supplied amount.
4. **Server time is authoritative.** `received_at` is stamped server-side and is the basis for all payout and fraud logic. Never trust the client clock.
5. **Distance is PostGIS.** Use `ST_DWithin` / `ST_Distance` on `geography(Point,4326)`. No hand-rolled haversine in app code.
6. **Domain logic lives in `lib/`**, never in route handlers. Route handlers translate HTTP ↔ typed `lib/` calls.
7. **Camera-only capture by default.** Gallery upload is a fallback that auto-flags for review — never the default path.
8. **Secrets in env only.** No secret in a client bundle. Mapbox public token is URL-restricted; everything else server-side.

If you catch yourself about to break one of these "just for now," stop — that's the anti-pattern the constitution names.

---

## Project structure

```
app/            # Next.js routes (thin — no domain logic)
components/     # Shared UI (React + shadcn/ui)
  map/          # Mapbox components (campaign + universal)
lib/            # All domain logic (server-side)
  db/           # Drizzle schema, migrations, pooled client
    dal/        # Campaign-scoped data-access layer (isolation lives here)
  auth/         # Auth.js config, player OTP, staff auth, guards
  fraud/        # dedupe, geo, time checks, pipeline orchestrator
  payout/       # ledger, tier math, cap enforcement
  campaign/     # lifecycle, config, tier validation
  target/       # claim state machine, csv import
  storage/      # R2 client + signed uploads
  offline/      # queue + sync
types/          # Shared domain types (leaf-level, no lib imports)
tests/          # vitest unit/integration + playwright e2e
  isolation/    # the tenant-isolation suite (exit gate EC-5)
  fraud/        # dedupe/geo/time + seed fixtures
docs/           # constitution, prd, phase plan, task cards
scripts/        # seed-mycofest, seed-second-campaign
tasks/          # todo.md, lessons.md (self-improvement loop)
```

---

## Operational workflow

### 1. Starting a task
- Read the task card end to end (`docs/tasks/batch-N.md`). Note its Depends-on, Produces, and Anti-Requirements.
- Confirm its dependencies are already built. If not, stop — build order matters.
- Re-read the constitution sections the card quotes.

### 2. Building
- Build only what the card specifies. Respect Anti-Requirements literally.
- No two cards touch the same file — if you find yourself editing another card's file, you're out of scope; stop and flag.
- Put domain logic in `lib/`, tests alongside per the card's Files list.

### 3. Verifying
- Satisfy every Acceptance Criterion; they are written to be programmatically checkable.
- Run `pnpm lint && pnpm build && pnpm test` before considering a task done.
- For cards producing UI flows, run the relevant Playwright spec.

### 4. Review gates (mandatory human checkpoints)
Two tasks block their dependents until a human confirms:
- **T2.1** — isolation DAL + suite must be 100% green before any Batch 3 work.
- **T3.3** — dedupe false-positive/false-negative rate on the seed set must be confirmed acceptable before T3.5 composes it.
Do not proceed past a gate on your own authority.

### 5. Finishing
- Update `tasks/todo.md` (check off the task, note follow-ups).
- If you learned something that would help future tasks (a pitfall, a non-obvious constraint), append it to `tasks/lessons.md`.

---

## Quick reference commands

```bash
pnpm install                 # install deps
pnpm dev                     # local dev server (port 3000)
pnpm build                   # production build (must pass, strict TS)
pnpm lint                    # ESLint (Next + TS strict)
pnpm format:check            # Prettier check   (pnpm format = --write)
pnpm test                    # Vitest unit/integration
pnpm test tests/isolation    # the tenant-isolation suite (EC-5)
pnpm test:e2e                # Playwright e2e
pnpm db:generate             # generate Drizzle migration from schema
pnpm db:migrate              # apply migrations (needs DATABASE_URL, PostGIS)
pnpm tsx scripts/seed-mycofest.ts   # seed the Mycofest campaign
```

**DB- and browser-backed tests need env set INLINE** (bash env doesn't persist between
tool calls). A local PostGIS via Docker is the standard test DB:

```bash
docker run -d --name mfliers-testdb -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=mfliers_test -p 5433:5432 postgis/postgis:16-3.4
# then, prefixed on each command:
DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5433/mfliers_test" pnpm db:migrate
DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5433/mfliers_test" \
  AUTH_SECRET=any R2_ACCOUNT_ID=t R2_ACCESS_KEY_ID=t R2_SECRET_ACCESS_KEY=t \
  R2_BUCKET_NAME=t R2_PUBLIC_URL=https://x.test pnpm exec playwright test
```

Env vars (see `.env.example`): `DATABASE_URL`, `AUTH_SECRET`, `R2_*` (+ optional
`R2_ENDPOINT`/`R2_REGION` for Supabase Storage), `NEXT_PUBLIC_MAPBOX_TOKEN`,
`RESEND_API_KEY`/`EMAIL_FROM` **or** `SMTP_*` (email OTP). Never commit `.env`.

## Deploy & environment (live)

- **Production:** https://mfliers-eight.vercel.app — Vercel project `mfliers`, scope
  `consultingfuture4200s-projects`. Auto-deploys on push to `main`; or
  `vercel deploy --prod --yes --scope consultingfuture4200s-projects`.
- **DB = Supabase** (project ref in `docs/deploy.md`). App connects via the **transaction
  pooler** (`...pooler.supabase.com:6543`) as `DATABASE_URL`. Run migrations against the
  **session pooler** (`:5432`). The **direct** host `db.<ref>.supabase.co` is **IPv6-only**
  and unreachable from IPv4-only environments — always use the pooler.
- **Storage = Supabase Storage** (S3-compatible) via the R2 client + `R2_ENDPOINT`/`R2_REGION`.
- **Email OTP delivery is NOT configured** on Vercel yet → login codes only go to the
  server logs. Set `RESEND_API_KEY`+`EMAIL_FROM` (or `SMTP_*`) and redeploy for real email.

## Hard-won gotchas (do not relearn these)

- **`sharp` on Vercel:** `next.config.ts` must keep `serverExternalPackages:['sharp']` AND
  `outputFileTracingIncludes` for the pnpm-nested `@img/sharp-*` + libvips `.so`, or the
  submit/sign routes 500 with `ERR_DLOPEN_FAILED`.
- **Mapbox GL v3:** `mapboxgl.supported()` was removed (don't call it). The map container
  needs an **explicit height** (`h-[70vh]`, not `min-h`+`flex-1`) and `position:absolute`
  via **inline style** (mapbox-gl.css's `.mapboxgl-map{position:relative}` overrides a
  Tailwind `.absolute` class).
- **Build must work with NO DB:** `lib/db/client.ts` is a lazy Proxy (connects on first
  query, not import) so `next build` needs no live DB. Don't reintroduce import-time DB access.
- **e2e asserts the no-token map fallback list:** run Playwright **without**
  `NEXT_PUBLIC_MAPBOX_TOKEN` or the map specs fail (real canvas renders instead of the list).
- **shadcn is `base-nova` = Base UI:** use the `render={<Link/>}` prop, not Radix `asChild`;
  style Dropdown/Sheet triggers directly with `buttonVariants(...)`.
- **Port 3000 squatters:** if e2e fails wholesale with empty errors, check
  `ss -ltnp | grep :3000` — a stray server hijacks Playwright's `reuseExistingServer`.

## Design system

Field-guide aesthetic (Paper/Ink/Forest, Space Grotesk + Inter + mono, teardrop pins,
2px editorial borders), dark-mode-safe. **Use semantic tokens only** (`bg-background`,
`text-foreground`, `border-foreground/15`, `--pin-red/amber/green`) — never hardcoded hex.
Brand primitives in `components/brand/` (Logo, Pin, StateBadge, Pill, StatCard, PageShell).
Reference: `docs/prototype.jsx`.

---

## Core principles

- **The card is the contract.** Scope creep is the primary failure mode of agent builds — resist it. Smaller, exact tasks beat clever expansive ones.
- **Isolation and money are where bugs cost real money or trust.** Spend extra care in `lib/db/dal/`, `lib/fraud/`, and `lib/payout/`.
- **Prefer the boring, proven path.** The constitution already chose the stack; don't introduce a new library to solve a problem the chosen one handles.
- **When the spec is silent, ask — don't guess.** Insert a `NEEDS_CLARIFICATION` note and surface it.
- **Leave the campground cleaner:** update `tasks/lessons.md` when you hit a non-obvious constraint, so the next agent doesn't relearn it.

---

## Known pitfalls (seed for tasks/lessons.md)

- **Serverless + Postgres:** raw connections exhaust the pool on Vercel. Always use the pooled client in `lib/db/client.ts`.
- **Drizzle + PostGIS:** geography columns and `ST_DWithin` need Drizzle's raw-SQL escape hatch; don't fight the ORM's typed builder for spatial ops.
- **Shared flier image:** every campaign's fliers look identical, so naive full-frame pHash false-matches legitimate distinct placements. The dedupe (T3.3) flags a match ONLY when it's on a *different target*. Do not "fix" this into flagging same-target lookalikes.
- **Claim races:** two players can tap the same red pin at once. The claim (T3.2) must be atomic (conditional update / row lock) so exactly one wins.
- **Tier-3 money concentration:** the escalating payout curve puts the most money on top players, so the pipeline forces human review of every tier-3 submission (FR-F7). Never auto-approve tier-3.
- **At-cap behavior:** when a campaign hits its budget cap, pins still flip green (coverage continues) but accruals are marked unpayable. Don't hard-stop submissions or exceed the cap in payable totals.

---

## Self-improvement loop (non-negotiable)

After each task, ask: *did I hit anything the card or this file didn't warn me about?* If yes, append it to `tasks/lessons.md` under Patterns (recurring) or Pitfalls (one-off traps). This file and the task cards should get more accurate over the build, not staler. If a lesson invalidates a future card's assumption, flag it for change propagation rather than silently working around it.
