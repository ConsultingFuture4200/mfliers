# ADR 0001 — Tenant Isolation Enforcement Mechanism

**Status:** Accepted (amended by ADR-0002)
**Date:** 2026-06-30

> **Amendment (ADR-0002, T3.3):** the "exactly one sanctioned cross-campaign read"
> language below is superseded — there are now **two** named exceptions
> (`universal-map.ts` and `lib/db/dal/dedupe-hashes.ts`). See ADR-0002 for the
> rationale and the updated isolation-suite enforcement. Every other decision and
> rationale in this ADR (the scoped-repository DAL as the primary mechanism, RLS
> deferred) still stands unchanged.
**Task:** T2.1 (Batch 2), clearing a gating decision raised by Liotta's Batch 1 review
**Governing law:** `docs/constitution.md` §3, §5, §6 (tenant isolation is the platform's
core, non-negotiable security property)

## Context

The constitution requires that every query touching campaign-scoped data (`targets`,
`submissions`, `campaign_memberships`, `payout_ledger`) filter by `campaign_id`, and
that this be true "by convention and by isolation tests," not left to the UI. Batch 1's
review (Liotta) flagged that "by convention" is not itself an enforcement mechanism —
it names an intent, not a structural guard — and asked that Batch 2 pick one
deliberately before the isolation suite is built on top of it.

Two candidate mechanisms were considered:

1. **Scoped-repository DAL** — a `lib/db/dal/` module per campaign-scoped table where
   every exported function takes `campaignId: string` as a required, non-optional
   first parameter, and the function body is the *only* place a query against that
   table is constructed. No other code path (route handler, script, future lib module)
   queries `targets`/`submissions`/`campaign_memberships`/`payout_ledger` directly.
2. **Postgres Row-Level Security (RLS)** — RLS policies on each campaign-scoped table
   keyed off a session-local `app.current_campaign_id` (or similar) setting, enforced
   by Postgres itself regardless of which code path issues the query.

## Decision

**Adopt the scoped-repository DAL (option 1) as the primary structural guard for v1.**
Postgres RLS is noted as a future defense-in-depth layer and explicitly **not**
implemented in this phase.

Concretely:

- `lib/db/dal/{targets,submissions,campaign-memberships,payout-ledger}.ts` are the
  *only* modules in the codebase permitted to query those four tables. Every exported
  function's first parameter is `campaignId: string` (required, not optional, not
  defaulted), and its query includes an `eq(<table>.campaignId, campaignId)` predicate
  (`lib/db/dal/scope.ts`'s `assertCampaignId` adds a matching runtime check, since an
  `any`-typed or dynamically-constructed caller can still defeat a compile-time-only
  guard).
- `lib/db/dal/campaigns.ts` follows the same signature convention (`campaignId` as
  first parameter) even though a campaign row's own primary key *is* the scoping key,
  for surface consistency and so the isolation suite's type-level check
  (`tests/isolation/isolation.test.ts`) covers it uniformly with the other four.
- Exactly one function in the entire DAL is exempt: `lib/db/dal/universal-map.ts`'s
  `getPublicPinsAcrossLiveCampaigns()`, the single sanctioned cross-campaign read
  (PRD FR-L2). It is isolated in its own file, named to make its exceptional status
  unmissable, and returns only public-safe fields (campaign id, target id, pin state,
  coordinates, flier photo url — never usernames, host/player identity, or
  ledger/budget data).
- Route handlers (Batch 3+) call these DAL functions; they never construct their own
  Drizzle queries against a campaign-scoped table.

## Rationale

- **Structural over conventional.** A required, non-optional TypeScript parameter
  fails the build (`tsc`/`pnpm build`) at the call site if omitted — the isolation
  property is checked by the compiler on every touch of the code, not just by a test
  suite that has to remember to cover every new call site.
- **Single choke point.** Concentrating every query against a campaign-scoped table in
  one small set of files makes the isolation suite's job tractable: it can assert
  "every exported function here requires `campaignId`" as a closed-world check over a
  handful of files, rather than trying to audit every present-and-future route handler
  for a stray unscoped query.
- **RLS deferred, not rejected.** RLS is a legitimate belt-and-suspenders layer — it
  would catch a bug in the DAL itself, or a future direct-SQL escape hatch that bypasses
  the DAL entirely — but it adds real operational cost now: session-variable plumbing
  through the pooled/transaction-mode connection (constitution §2's pooler
  requirement — `SET LOCAL` semantics need care with poolers that can route each
  statement to a different backend connection), policy-maintenance overhead as the
  schema grows across Batches 3-5, and a second place isolation bugs can hide (a wrong
  policy silently passing) if it's added before the DAL surface has stabilized. At v1's
  scale (~25 campaigns / 5,000 pins / 2,000 players, per constitution §4) the
  scoped-repository DAL plus its isolation suite is sufficient; RLS is the natural next
  layer to add once the DAL surface is stable and if a future audit (or a real incident)
  calls for defense-in-depth beyond the application layer.
- **Composite FKs already carry some of this load.** T1.3 additionally hardened
  `targets.filled_by_submission_id` <-> `submissions.target_id` with composite
  `(campaign_id, id)` foreign keys, so a submission can never point at a target in a
  different campaign at the schema level, independent of any query-layer discipline.
  This ADR's DAL requirement is the query-layer analog of that same "make it impossible
  by construction" principle, extended to reads and to the tables that don't have an
  FK-shaped relationship to lean on.

## Consequences

- Every future task that reads or writes `targets`, `submissions`,
  `campaign_memberships`, or `payout_ledger` must add its function to the relevant
  `lib/db/dal/*.ts` module (extending, not bypassing, the existing file) rather than
  querying the table from a route handler or a new ad hoc module.
- The isolation suite (`tests/isolation/isolation.test.ts`) is the enforcement
  mechanism's test: if a future DAL function's `campaignId` parameter becomes optional,
  is dropped, or a new unscoped query is added elsewhere, the suite's type-level and
  runtime checks are expected to catch it (demonstrated once during T2.1 by
  deliberately introducing an unscoped query, observing the suite fail, and reverting).
- If a future phase's scale or threat model changes (e.g. a direct-SQL admin tool, a
  reporting/BI read path outside the DAL, or a compliance requirement), revisit RLS as
  an additive layer — it does not conflict with the DAL approach and the two can coexist.
