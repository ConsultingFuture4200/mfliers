# Phase 1 · Batch 2 — Task Cards

> **Version:** 1.0
> **Created:** 2026-06-30
> **Governing spec:** flier-canvassing-platform-PRD-v0.4.0.md
> **Constitution:** flier-canvassing-platform-CONSTITUTION-v1.0.md
> **Phase plan:** flier-canvassing-platform-PHASE-1-PLAN-v1.0.html
> **Batch:** 2 of 5 — Data + Auth (4 tasks, ~3 days) · ⊢ **isolation review gate before Batch 3**

Entry: Batch 1 exit check passed (scaffold, types, PostGIS schema, test infra, pooled DB client, two-campaign fixture all in place).

**T2.1 is the critical-path, highest-blast-radius task in the whole phase.** It carries a mandatory review gate: no Batch 3 task starts until the isolation suite is green. T2.2/T2.3/T2.4 can proceed in parallel once T2.1's DAL contract exists.

```
T2.1 isolation DAL + suite  ──┬── T2.2 player OTP auth
   (review gate)              ├── T2.3 host/admin auth + role mw
                              └── (T2.4 R2 depends on T1.3, not T2.1)
```

**Locked stack (from Phase 1 plan §02):** Drizzle ORM · Cloudflare R2 · Auth.js + Twilio Verify · pnpm.

---

## Task 2.1 — Isolation-scoped data-access layer + isolation test suite

**Batch:** 2
**Depends on:** T1.3 (schema), T1.4 (two-campaign fixture)
**Produces:** `lib/db/dal/*` (campaign-scoped query layer), `tests/isolation/*`
**Complexity:** DD: H | CD: M | BR: H — **REVIEW GATE**

### Context

This is the load-bearing security task. Constitution §5:
> **Tenant isolation:** the load-bearing security property. Cross-campaign data access by a host or player is a critical vulnerability, not a bug.

Constitution §3, the rule this task makes structural:
> every query that touches campaign-scoped data MUST filter by `campaign_id` at the data-access layer ... No campaign-scoped query may be written without an explicit `campaign_id` predicate. This is enforced by convention and by isolation tests (PRD G-6), not left to the UI.

Constitution §6 anti-pattern:
> Campaign-scoped query without a `campaign_id` filter → Breaks tenant isolation — the platform's core security property.

PRD §7:
> Data scoping: every domain row (target, submission, ledger, membership) carries `campaign_id`; host/player queries filtered at the data layer. Budget isolation: each campaign's ledger draws only on its own cap. Isolation testing (G-6): automated tests assert no host reads another campaign's data and no spend crosses budgets.

**Design intent:** make unscoped access *impossible by construction*, not merely discouraged. The DAL exposes functions for campaign-scoped entities (targets, submissions, memberships, ledger) where `campaignId` is a **required, non-optional first argument**, and every generated query includes the `campaign_id` predicate. There is no public DAL function that reads campaign-scoped rows without a `campaignId`. Cross-campaign reads (only the universal map needs one — PRD FR-L2) go through a single, separate, explicitly-named function (e.g. `getPublicPinsAcrossLiveCampaigns()`) that returns only public-safe fields.

The fixture from T1.4 (Campaign A + Campaign B, disjoint targets) is the substrate for the isolation suite.

### Objective
Build a data-access layer where every campaign-scoped query requires an explicit `campaignId`, plus an automated suite proving no cross-campaign read or budget bleed is possible.

### Requirements
1. DAL modules under `lib/db/dal/` for: targets, submissions, campaignMemberships, payoutLedger, campaigns.
2. Every function reading/writing campaign-scoped rows takes `campaignId: string` as a required first parameter and includes `eq(table.campaignId, campaignId)` (or equivalent) in the query.
3. Exactly one explicitly-named cross-campaign read for the universal map, returning only public-safe fields (no usernames unless the campaign's privacy setting permits — but in v1 return campaign id + pin state + coords + photo url only; username resolution happens at a higher layer per privacy).
4. A budget helper that computes `cumulative_committed` for a campaign strictly from that campaign's ledger rows.
5. Isolation test suite under `tests/isolation/` asserting, using the two-campaign fixture:
   - Reading Campaign A's targets/submissions/ledger never returns Campaign B rows.
   - There is no code path that returns campaign-scoped rows without a `campaignId` (assert via the DAL's typed surface — every exported scoped function's signature requires it).
   - Budget computed for Campaign A is unaffected by Campaign B ledger rows.
6. All DAL functions are pure server-side (`lib/`), never imported into client components.

### Acceptance Criteria
- [ ] `pnpm test tests/isolation` passes 100%.
- [ ] No exported DAL function for a campaign-scoped table omits a required `campaignId` parameter (verifiable by inspecting exported signatures / a type-level test).
- [ ] A deliberately-introduced unscoped query is caught by the suite (demonstrate once, then revert).
- [ ] Universal-map read returns rows from both campaigns but exposes no private fields.
- [ ] Budget computation for one campaign ignores other campaigns' ledger entries.

### Files to Create/Modify
- `lib/db/dal/targets.ts`, `submissions.ts`, `campaign-memberships.ts`, `payout-ledger.ts`, `campaigns.ts`
- `lib/db/dal/universal-map.ts` (the one cross-campaign read)
- `tests/isolation/isolation.test.ts`

### Anti-Requirements
- Do NOT add HTTP route handlers here — pure data layer (handlers come in Batches 3–4).
- Do NOT expose a generic `query(table, where)` that can bypass campaign scoping.
- Do NOT let the universal-map read leak usernames or ledger/budget data.
- Do NOT import DAL into client components.

> **GATE:** A human reviewer confirms the isolation suite passes and the DAL surface has no unscoped campaign read before any Batch 3 task begins.

---

## Task 2.2 — Phone-OTP player authentication

**Batch:** 2
**Depends on:** T2.1 (DAL for player/membership reads)
**Produces:** `lib/auth/player.ts`, OTP routes, player session
**Complexity:** DD: M | CD: M | BR: M

### Context

PRD FR-A1:
> Player login — low-friction, recommend phone-OTP (street-worker-friendly, no password).

PRD FR-A3 / §7:
> Session persists per device. Player identity is platform-global (one login, many campaigns).

Constitution §2: Auth provider is **Auth.js (NextAuth) + Twilio Verify**. §5: secrets in env only; no secrets in client bundles; role claims enforce isolation.

**Design intent:** phone number → Twilio Verify sends OTP → user enters code → Auth.js issues a persistent session carrying a global `player_id`. A player is created on first successful verification. The session is a "player" principal (distinct from host/admin in T2.3).

### Objective
Implement phone-OTP login for players via Auth.js + Twilio Verify, creating a global player identity and a persistent device session.

### Requirements
1. Auth.js configured with a custom credentials/OTP flow backed by Twilio Verify (send code, check code).
2. Route(s) to (a) request an OTP for a phone number, (b) verify the OTP and establish a session.
3. On first successful verify, create a `players` row (global identity keyed by phone); on subsequent logins, reuse it.
4. Session carries `player_id` and principal type `player`; persists across reloads on the device.
5. Twilio credentials and `AUTH_SECRET` read from env only.
6. Basic rate-limiting / lockout on OTP requests to prevent abuse (e.g. max N sends per phone per window).

### Acceptance Criteria
- [ ] A test (mocking Twilio Verify) covers: request OTP → verify correct code → session created with a `player_id`.
- [ ] Wrong/expired code is rejected; no session issued.
- [ ] First verify creates exactly one player row; second verify for the same phone reuses it.
- [ ] Session principal type is `player` and persists across a page reload (e2e).
- [ ] No Twilio secret appears in any client bundle.

### Files to Create/Modify
- `lib/auth/player.ts`, `lib/auth/twilio.ts`
- `app/api/auth/otp/request/route.ts`, `app/api/auth/otp/verify/route.ts` (or Auth.js handler)
- `app/(auth)/login/page.tsx` (player login UI — phone + code entry)
- test: `tests/auth/player-otp.test.ts`

### Anti-Requirements
- Do NOT implement host/admin password auth here (that's T2.3).
- Do NOT store OTP codes in plaintext in the DB — rely on Twilio Verify's own verification.
- Do NOT expose Twilio secrets client-side.

---

## Task 2.3 — Host/admin auth + role-scoping middleware

**Batch:** 2
**Depends on:** T2.1 (DAL), coordinates with T2.2 (shared Auth.js setup)
**Produces:** `lib/auth/staff.ts`, role middleware, host/admin login
**Complexity:** DD: M | CD: M | BR: H

### Context

PRD FR-A2:
> Host/Admin login — email + password, role-scoped.

PRD §4 roles:
> Site Admin — platform-wide. Campaign Host — their campaign(s) only; cannot see other campaigns. v1: site admin also acts as host for Mycofest; host capabilities exist as a role.

Constitution §5:
> Authorization: role-based, enforced server-side on every request. A host token authorizes only its `scoped_campaign_ids`; UI-only gating is never sufficient.

Constitution §6 anti-pattern:
> UI-only authorization → Role checks must be server-side; hiding a button is not security.

**Design intent:** email+password auth for `users` (type `site_admin` | `host`). A reusable server-side guard — call it `requireCampaignAccess(req, campaignId)` — that (a) loads the principal, (b) for `host`, asserts `campaignId ∈ scoped_campaign_ids` (via the `user_campaigns` join from T1.3), (c) for `site_admin`, allows all. Every host/admin-facing route handler in later batches calls this guard. This is the server-side half of tenant isolation that complements T2.1's data-layer half.

### Objective
Implement email/password auth for site admins and hosts, plus a server-side guard that scopes hosts to their assigned campaigns and grants site admins platform-wide access.

### Requirements
1. Email/password auth (Auth.js credentials provider) for `users`, with securely hashed passwords (e.g. argon2/bcrypt).
2. Principal carries `user_id`, `type` (`site_admin`|`host`), and resolved `scoped_campaign_ids`.
3. A server-side guard `requireCampaignAccess(principal, campaignId)` returning allow/deny; deny → 403.
4. A guard `requireSiteAdmin(principal)` for platform-level actions.
5. Host/admin login UI distinct from the player login.
6. Passwords and `AUTH_SECRET` handled per constitution §5 (env, hashed, never logged).

### Acceptance Criteria
- [ ] Test: a host principal scoped to Campaign A is denied access to Campaign B via `requireCampaignAccess` (403).
- [ ] Test: a site_admin passes `requireCampaignAccess` for any campaign and `requireSiteAdmin`.
- [ ] Test: a host fails `requireSiteAdmin`.
- [ ] Passwords are stored hashed (no plaintext column).
- [ ] Login establishes a session with the correct principal type.

### Files to Create/Modify
- `lib/auth/staff.ts`, `lib/auth/guards.ts`
- `app/(auth)/staff-login/page.tsx`
- test: `tests/auth/role-scoping.test.ts`

### Anti-Requirements
- Do NOT rely on client-side checks for authorization — guards run server-side.
- Do NOT store plaintext passwords.
- Do NOT grant hosts any cross-campaign read — that is a critical isolation failure.

---

## Task 2.4 — Cloudflare R2 storage + signed uploads

**Batch:** 2
**Depends on:** T1.3 (schema for `photo_url`)
**Produces:** `lib/storage/r2.ts`, signed-upload route
**Complexity:** DD: L | CD: M | BR: L

### Context

Constitution §2 storage: **Cloudflare R2** (chosen for zero egress on repeated audit reads). Constitution §5:
> Data at rest: object storage encrypted at rest. Image handling: store originals for audit. Retention: purge photos + location 90 days after campaign close.

PRD FR-S / §9: client compresses before upload; originals stored for audit; keyed for retrievability.

**Design intent:** S3-compatible R2 client. Client requests a signed PUT URL, uploads the (already client-compressed) image directly to R2, then the submission record stores the resulting `photo_url`/key. Key layout encodes tenancy: `campaign_id/submission_id.jpg` — so retention purges and per-campaign audits are simple prefix operations.

### Objective
Provide an R2 client and a signed-upload flow that stores submission photos keyed by `campaign_id/submission_id`, with retention-friendly key layout.

### Requirements
1. S3-compatible R2 client configured from env (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET`, bucket).
2. A server route that issues a short-lived signed PUT URL for a given campaign+submission.
3. Key convention `\${campaignId}/\${submissionId}.jpg`.
4. A helper to delete all objects under a `campaignId/` prefix (for 90-day retention purge — the scheduler that calls it is out of scope here; just the function).
5. Secrets from env only; bucket not publicly listable.

### Acceptance Criteria
- [ ] A test (mocking R2 / using a local S3-compatible mock) covers: request signed URL → URL is scoped to the expected key → object retrievable by key.
- [ ] Keys follow the `campaignId/submissionId` convention.
- [ ] The prefix-delete helper removes only the targeted campaign's objects.
- [ ] No R2 secret appears client-side.

### Files to Create/Modify
- `lib/storage/r2.ts`
- `app/api/uploads/sign/route.ts`
- test: `tests/storage/r2.test.ts`

### Anti-Requirements
- Do NOT make the bucket public or world-listable.
- Do NOT perform server-side image compression here — the client compresses (capture task T4.1); this task stores.
- Do NOT build the retention scheduler — only the prefix-delete function it will call.

---

## Batch 2 Exit Check
- [ ] T2.1 isolation suite 100% green — **review gate cleared**.
- [ ] Player OTP login works end to end (mocked Twilio in tests).
- [ ] Host scoped to Campaign A is denied Campaign B (server-side); site admin passes.
- [ ] R2 signed uploads store to `campaignId/submissionId` keys.
- [ ] `pnpm lint && pnpm build && pnpm test` green in CI.

**Next:** Batch 3 (Core logic) — campaign lifecycle, target/claim state machine, and the fraud pipeline (with the dedupe review gate).
