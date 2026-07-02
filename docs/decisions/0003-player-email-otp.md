# ADR 0003 — Player Login: Email One-Time-Code, Provider-Agnostic Sender

**Status:** Accepted
**Date:** 2026-07-01
**Task:** Operator-directed amendment (post Phase-1 build)
**Governing law:** `docs/constitution.md` §2 ("Auth (players): Phone-OTP — PRD FR-A1;
street-worker-friendly") and §5 ("Authentication: phone-OTP (players)"); PRD FR-A1.
Constitution §7 requires a decision record whenever these change — this is that record.

## Context

The constitution (§2, §5) and PRD FR-A1 chose **phone-OTP via Twilio Verify** for
player login, justified as "street-worker-friendly" (a canvasser with a phone number
but no email could still sign in). The Phase-1 build implemented that: `lib/auth/twilio.ts`
(Verify send/check), `lib/auth/player.ts` (rate-limited request + verify), a `player-otp`
Auth.js Credentials provider keyed on `{ phone, code }`, and a `players` table whose
global identity column was `phone`.

The operator has directed a change to **email one-time-code** instead, with a
**provider-agnostic** email sender (not locked to a single vendor). This is a deliberate
amendment of a stated non-negotiable, made at operator direction — it is recorded here
rather than silently resolved, per the constitution's own maintenance rule (§7) and
CLAUDE.md ("when [this file and the spec] conflict, the spec/constitution win — flag the
conflict, do not silently resolve it"). The operator's direction is the authority for
this specific amendment.

## Decision

**Replace player phone-OTP (Twilio Verify) with an email one-time-code flow, and make
the email transport provider-agnostic.**

1. **Identity.** `players` global identity column changes from `phone` (unique) to
   `email` (text, NOT NULL, UNIQUE). `players` remains a *global, non-campaign-scoped*
   login identity — exactly as `phone` was — so it stays out of the isolation DAL's
   `campaign_id`-required rule.
2. **Code store.** A new global (non-scoped) table `player_email_otp` stores, per
   request: a **hash** of the 6-digit code (never plaintext), `expires_at` (10 min),
   an `attempts` counter (cap 5), a `consumed_at` (single-use), and `created_at`.
   The code itself is delivered only by email and is never persisted or returned in
   any HTTP response or client bundle (constitution §5/§8).
3. **Provider-agnostic sender** (`lib/auth/email.ts`). The transport is resolved from
   environment variables **at call time**, so one build serves all environments:
   - `RESEND_API_KEY` (+ `EMAIL_FROM`) → POST to Resend's REST API via `fetch` (no SDK
     dependency);
   - else `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` (+ `EMAIL_FROM`) → `nodemailer`;
   - else (no credentials) → log the code server-side (info) and return success, so the
     whole login flow is testable without any provider.
4. **Flow** (`lib/auth/player.ts`, unchanged as the single home of the flow). `requestPlayerOtp(email)`
   validates/normalizes the email, applies the existing in-memory rate limiter (keyed by
   email), generates a 6-digit code, stores its hash, and sends it.
   `verifyPlayerOtp(email, code)` loads the latest unconsumed/unexpired record, enforces
   the attempts cap, compares the hash, and on success get-or-creates the player by email
   and consumes the code.
5. **Auth.js / route.** The `player-otp` provider's `authorize({ email, code })` and
   `POST /api/auth/otp/request` accept `{ email }`. Session still carries `playerId` +
   `principalType: "player"` (unchanged). Staff auth (email+password) is untouched.
6. **Removal.** `lib/auth/twilio.ts`, the `twilio` dependency, and `TWILIO_*` from
   `.env.example` are deleted (CLAUDE.md / global principle 9: "delete old code paths by
   default"). `RESEND_API_KEY`, `EMAIL_FROM`, and `SMTP_*` are added as placeholders.

## Rationale & trade-off

- **Provider-agnostic by requirement.** The operator asked not to be locked to one
  vendor. Resolving transport from env at call time (rather than an import-time client)
  keeps the domain flow identical across Resend, SMTP, and a no-credentials dev fallback,
  and keeps the build DB/secret-free (the lazy pattern the app already uses).
- **Hashed, capped, single-use codes.** Unlike Twilio Verify (which held and validated
  the code on Twilio's own infrastructure), the platform now stores the code itself — so
  it stores only a keyed **hash**, bounds lifetime (10 min) and guess attempts (5), and
  marks a used code consumed. This keeps constitution §5 ("no plaintext secret at rest,
  server-side enforcement") intact without the external verifier.
- **Trade-off (explicit):** this **loses the "street-worker, no-email" benefit** the PRD
  (FR-A1) and constitution (§2) cited for phone-OTP. A canvasser must now have an email
  address to log in. This is the cost the operator accepted in directing the change; it
  is the single most material downside and is called out here so it is not rediscovered
  later as an accident.
- **Deliverability/latency:** emailed codes can land in spam or arrive slower than SMS.
  Out of scope to solve here; the provider-agnostic sender lets the operator pick a
  vendor with good deliverability without a code change.

## Consequences

- Constitution §2/§5 and PRD FR-A1 now describe the *superseded* design; this ADR is the
  amendment of record. Propagating the change into the constitution/PRD prose (and
  CLAUDE.md's stack table + `docs/deploy.md`'s env table) is a documentation follow-up
  (Scribe), deliberately not done inline so this ADR's citations to the original §2/FR-A1
  text stay valid.
- New env vars: `EMAIL_FROM`, `RESEND_API_KEY`, `SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS`.
  Removed: `TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_VERIFY_SERVICE_SID`.
- New dependency `nodemailer` (SMTP transport only, dynamically imported); `twilio`
  removed.
- `players` and `player_email_otp` remain non-campaign-scoped; the tenant-isolation
  suite's closed-world exception check (universal-map + dedupe-hashes) is unaffected —
  neither table is a campaign-scoped read, so neither is registered there.
