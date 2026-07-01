# ADR 0002 — Second Sanctioned Cross-Campaign Read: Dedupe Hash Index

**Status:** Accepted
**Date:** 2026-06-30
**Task:** T3.3 (Batch 3), clearing the dedupe review gate; amends ADR-0001
**Governing law:** `docs/constitution.md` §1/§3 non-negotiable ("every campaign-scoped
query MUST filter by `campaign_id`... the only cross-campaign read is the single
named universal-map function"); PRD FR-F3

## Context

ADR-0001 states, twice, that exactly one function in the DAL is exempt from
campaign-scoping: `lib/db/dal/universal-map.ts`'s `getPublicPinsAcrossLiveCampaigns()`.
The tenant-isolation suite (`tests/isolation/isolation.test.ts`) encodes that as a
literal assertion ("the universal-map module is the sole, explicitly-named
exception").

T3.3's governing requirement, PRD FR-F3, is in direct tension with that "exactly one"
framing:

> Treat as a duplicate (reject) only when the hash matches a prior submission AND the
> two are claiming different targets... Cross-campaign reuse is caught the same way
> (same photo, different campaign+target).

Catching cross-campaign photo reuse requires comparing a new submission's perceptual
hash against *every* campaign's prior submissions, not just the submitting campaign's
own. There is no way to satisfy FR-F3's cross-campaign clause while keeping every
`submissions` read scoped to a single `campaignId`.

T3.3 added `lib/db/dal/dedupe-hashes.ts`'s `listAllSubmissionHashes()` to resolve this,
self-flagging the conflict in the file's own doc comment and in `tasks/lessons.md`
rather than silently shipping it. Both Linus (bug/security review) and Liotta
(architecture review) flagged the same root issue on the Batch 3 review pass: the
conflict was correctly identified but the required artifact — this ADR — did not exist
yet, and the isolation suite didn't know about the second exception either. This ADR
is that artifact, closing the T3.3 review gate.

## Decision

**Amend ADR-0001: name two sanctioned cross-campaign reads, not one.**

1. `lib/db/dal/universal-map.ts`'s `getPublicPinsAcrossLiveCampaigns()` — unchanged
   from ADR-0001 (PRD FR-L2, the public universal map).
2. `lib/db/dal/dedupe-hashes.ts`'s `listAllSubmissionHashes()` — new, for PRD FR-F3's
   cross-campaign reused-photo dedupe signal. Used only by
   `lib/fraud/dedupe.ts`'s `checkDuplicate`.

Both exceptions share the same shape, deliberately:

- Own file, arity 0, a name that makes the exceptional status unmissable at every call
  site and in every `import` statement.
- Returns only non-PII, non-ledger fields. `listAllSubmissionHashes` returns exactly
  `{submissionId, campaignId, targetId, phash}` — no player identity, no photo URL, no
  host identity, no budget/ledger data. (`getPublicPinsAcrossLiveCampaigns` returns
  `{id, campaignId, lat, long, state, photoUrl}` — public-safe by definition, since
  those pins are already shown on the public map.)
- No other module queries `submissions` (or `targets`) across campaigns; every other
  read stays behind the campaign-scoped DAL functions ADR-0001 established.

No third mechanism (RLS bypass role, ad hoc direct-SQL escape hatch) is introduced.
The "sanctioned exception" set is closed at two, named here, both structurally
enforced by the isolation suite (see Consequences).

### Why not the schema-level alternative (a dedicated `dedupe_hashes` table)?

T3.3's own build notes floated a second option: a campaign-agnostic `dedupe_hashes`
table outside the four named campaign-scoped tables (insert-only, populated by a
trigger or by the submission-insert path), which would sidestep the letter of
non-negotiable #1 entirely rather than creating a second exception to it.

Rejected for v1, on cost/benefit: it requires a schema migration, a trigger (or an
extra write in the submission-insert path) to keep it in sync with `submissions.phash`,
and a backfill story for existing rows — real work for a property (`phash` denormalized
into a second table) that the existing `submissions.phash` column already provides.
The narrow-DAL-function approach reads the same data through a read-only,
minimally-projected query with no schema change and no dual-write to keep in sync. If
a future audit finds the "second exception" pattern is spreading (a third, fourth
cross-campaign read appearing), revisit the dedicated-table approach then — it does
not conflict with this decision and the two can coexist.

## Consequences

- ADR-0001's "exactly one" language is superseded by this ADR: the DAL now has
  **exactly two** sanctioned cross-campaign reads, both named above.
- `tests/isolation/isolation.test.ts` is extended (same PR as this ADR) to:
  1. Register `lib/db/dal/dedupe-hashes.ts` as a second named exception alongside
     `universal-map.ts`, asserting its exported surface is exactly
     `["listAllSubmissionHashes"]` at arity 0 — the same structural check
     `universal-map.ts` already gets.
  2. Lock its projection: assert the returned rows' keys are exactly
     `["campaignId", "phash", "submissionId", "targetId"]`, so a later edit can't
     silently add `playerId`/`photoUrl`/other PII to this cross-tenant read without
     the isolation suite failing.
- Any future card that needs a similar cross-tenant-but-non-PII read should follow
  this same shape (own file, obvious name, minimal fields, isolation-suite
  registration in the same PR) rather than either loosening an existing scoped DAL
  module's `campaignId` requirement, or shipping a third unregistered exception and
  relying on a doc comment alone (which is exactly what this ADR exists to close out).
