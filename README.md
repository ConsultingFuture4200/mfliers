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

Progress is tracked in [`tasks/todo.md`](./tasks/todo.md); lessons in
[`tasks/lessons.md`](./tasks/lessons.md). Issues live in the Linear "Flier Canvassing
Platform — Phase 1" project (Development team). Each batch is reviewed by Linus
(bugs/security) and Liotta (architecture) before its gate opens.
