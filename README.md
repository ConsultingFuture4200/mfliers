# mfliers — Flier Canvassing Platform

Multi-tenant, gamified flier-canvassing platform. Campaigns provide a flier image and a
map of predetermined targets; players claim targets, post the flier, and submit geotagged
photos that are fraud-screened and paid on a per-campaign tier curve. First tenant:
**Mycofest**. Settlement is **manual** in v1 (the platform tracks what's owed, moves no money).

This is a **spec-driven build**. Start with the governing documents, in precedence order:

1. [`CLAUDE.md`](./CLAUDE.md) — how to work in this repo (agent operating instructions).
2. [`docs/constitution.md`](./docs/constitution.md) — non-negotiable project law.
3. [`docs/prd.md`](./docs/prd.md) — PRD provenance note (requirements are quoted inline in the cards).
4. [`docs/phase-1-plan.html`](./docs/phase-1-plan.html) — deliverables, exit criteria, batch sequence.
5. [`docs/tasks/batch-1.md`](./docs/tasks/) … `batch-5.md` — the unit of work (24 task cards).

## Stack

TypeScript (strict) · Next.js App Router · React + Tailwind + shadcn/ui · PostgreSQL +
PostGIS · Drizzle ORM · Vercel · Mapbox GL JS · Cloudflare R2 · Auth.js + Twilio Verify ·
Vitest + Playwright · **pnpm**.

## Commands

```bash
pnpm install                 # install deps
pnpm dev                     # local dev server
pnpm build                   # production build (strict TS)
pnpm lint                    # ESLint
pnpm test                    # Vitest unit/integration
pnpm test tests/isolation    # tenant-isolation suite (exit gate EC-5)
pnpm test:e2e                # Playwright e2e
pnpm db:generate             # generate Drizzle migration
pnpm db:migrate              # apply migrations (needs DATABASE_URL + PostGIS)
```

## Build status

**Phase 1 complete** — all 24 task cards (Batches 1–5) built, reviewed (Linus for
bugs/security + Liotta for architecture per batch), and committed. Both mid-build
review gates cleared: T2.1 tenant-isolation DAL and T3.3 dedupe.

Verified locally against real PostGIS 3.4 + real Chromium (Playwright): the full
claim → submit → approve → green-pin + ledger-accrual loop, the tenant-isolation
suite, the ledger tier/cap math, and the Mycofest seed. Unit/integration: 316 passing.
e2e: 59 passing.

Phase-1 exit criteria (EC-1…EC-7):

| EC | Criterion | Status |
|----|-----------|--------|
| EC-1 | End-to-end loop claim→submit→approve→green | Loop **verified** (e2e, live DB + ledger accrual); real-phone-outdoors demo pending a device |
| EC-2 | Median submit ≤20s, n≥20 real submits | Instrumentation **verified**; the ≤20s field median needs real submits |
| EC-3 | Auto-decide ≥70% tier-1/2, 100% tier-3 to review | Tier-3→review **verified**; ≥70% rate is instrumented, measured on real data |
| EC-4 | Universal map ≥2 live campaigns + clustering; correct pin states | 2 campaigns + pin states **verified**; Mapbox cluster *visual* needs a token |
| EC-5 | Zero cross-campaign leaks; isolation suite 100% | **Verified** (64-test isolation suite green) |
| EC-6 | Admin creates campaign/imports/goes live, no DB access | Routes + import **verified**; full UI click-through demo pending |
| EC-7 | Ledger tiered payout in cents; over-cap unpayable at $1,000 | **Verified** (15 ledger tests incl. cap boundary + concurrent race) |

Items marked "pending" need live external services/secrets not present in the build
sandbox (a real device camera, Twilio SMS, live Cloudflare R2 + Mapbox tokens, a deploy).
Decision records in [`docs/decisions/`](./docs/decisions/); open follow-ups in Linear.
Progress tracker: [`tasks/todo.md`](./tasks/todo.md); build lessons: [`tasks/lessons.md`](./tasks/lessons.md).
