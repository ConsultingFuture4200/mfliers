# Deploy — Vercel link + environment variables

> T1.5 deliverable. Covers linking this repo to Vercel and the environment
> variables every environment (CI, Preview, Production) needs. No secret
> value is ever committed — see `.env.example` for the template and
> constitution §5 ("secrets in env only; nothing secret in a client bundle").

## 1. Link the repo to Vercel

One-time setup, done by a human with Vercel access (not CI):

1. `pnpm dlx vercel login` (or use the Vercel dashboard).
2. From the repo root: `pnpm dlx vercel link` — connects this local checkout
   to a Vercel project. This also works via **Vercel Dashboard → Add New →
   Project → Import Git Repository** (the GitHub App integration), which is
   the recommended path since it auto-configures the GitHub Preview/Production
   deploy hooks without a local step.
3. Framework preset: **Next.js** (auto-detected). Build command / output stay
   at Vercel's Next.js defaults — do not override.
4. Set the environment variables below in **Vercel → Project → Settings →
   Environment Variables**, scoped per environment (Production / Preview /
   Development) as noted.
5. Push to `main` (or merge a PR) — Vercel's own Git integration builds and
   deploys automatically. This repo's GitHub Actions workflow
   (`.github/workflows/ci.yml`) only gates PRs with lint/build/migrate/test;
   it does not deploy anything (constitution §2, card anti-requirement: no
   deploy from CI).

## 2. Environment variables

All variables below live in `.env.example` as the source of truth for names.
Populate real values only in Vercel's dashboard (or a local, gitignored
`.env.local`) — never in a committed file.

| Variable | Scope | Notes |
|---|---|---|
| `DATABASE_URL` | Production, Preview | **Pooled** Postgres+PostGIS connection string (Supavisor/PgBouncer transaction-mode endpoint — e.g. port 6543 on Supabase-style poolers). `lib/db/client.ts` requires this; never point it at a raw/direct Postgres port from a serverless function (constitution §6). |
| `AUTH_SECRET` | Production, Preview | Auth.js session secret. Generate with `pnpm dlx auth secret` or `openssl rand -base64 32`. |
| `TWILIO_ACCOUNT_SID` | Production, Preview | Twilio Verify (T2.2, player phone-OTP). |
| `TWILIO_AUTH_TOKEN` | Production, Preview | Twilio Verify. Server-only — never exposed to the client. |
| `TWILIO_VERIFY_SERVICE_SID` | Production, Preview | Twilio Verify service instance. |
| `R2_ACCOUNT_ID` | Production, Preview | Cloudflare R2 (T2.4, submission photo storage). |
| `R2_ACCESS_KEY_ID` | Production, Preview | R2 S3-compatible API credential. Server-only. |
| `R2_SECRET_ACCESS_KEY` | Production, Preview | R2 S3-compatible API credential. Server-only. |
| `R2_BUCKET_NAME` | Production, Preview | R2 bucket for submission photos. |
| `R2_PUBLIC_URL` | Production, Preview | Public read URL/CDN domain for the R2 bucket. |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Production, Preview, Development | Mapbox **public** token, URL-restricted in the Mapbox dashboard to this deployment's domains. Safe for the client bundle by design (constitution §5) — this is the one exception to "no secret in a client bundle" because it isn't a secret. |

A local dev database can be a plain `docker run postgis/postgis:16-3.4`
instance (direct connection, no pooler needed at that scale) — the pooler
requirement is specifically for Vercel's serverless functions, not local dev.

## 3. CI environment variables (GitHub Actions)

CI (`.github/workflows/ci.yml`) does **not** read any of the secrets above.
It runs against an ephemeral `postgis/postgis` service container it starts
itself, with a hardcoded test-only `DATABASE_URL`
(`postgres://postgres:postgres@localhost:5432/mfliers_test`) that never
leaves the CI job and never touches a real database. Only `pnpm lint`,
`pnpm build`, `pnpm db:migrate`, and `pnpm test` run in CI — no deploy step,
no other env var is required.

If a future task needs CI to exercise a real third-party integration (e.g.
an actual Twilio/R2 call rather than a mock), add the credential as a
**GitHub Actions repository secret** (Settings → Secrets and variables →
Actions) and reference it as `${{ secrets.NAME }}` in the workflow — never
hardcode it.

---

## Live deployment (Phase-1 demo)

- **Production URL:** https://mfliers-eight.vercel.app (Vercel, personal scope; auto-deploys on push to `main`)
- **Database:** managed Supabase Postgres + PostGIS (transaction pooler, port 6543). The
  serverless app connects via the pooler with `prepare: false` (see `lib/db/client.ts`);
  migrations run against the **session pooler** (port 5432), because Supabase's *direct*
  host (`db.<ref>.supabase.co`) is IPv6-only and unreachable from IPv4-only environments.
- **Env vars (set in Vercel, encrypted):** `DATABASE_URL` (pooler URI), `AUTH_SECRET`.
- **Seeded:** Mycofest ($1,000 cap, 125/175/225 tiers, admin-only, 10 targets) + a second
  live campaign (`scripts/seed-*.ts`).
- **Deployment protection:** Vercel Authentication is **off** so the public landing/map are
  reachable (the app enforces its own auth server-side).

### Not yet configured (features degrade gracefully until set)
| Env var(s) | Unlocks | Without it |
|---|---|---|
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Mapbox base tiles on the maps | Map falls back to a plain pin list |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_VERIFY_SERVICE_SID` | Player phone-OTP login | OTP send/verify fails |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` / `R2_PUBLIC_URL` | Photo upload on submission | "Could not prepare the photo upload" |

Add any of these with `vercel env add <NAME> production` (and `preview`), then redeploy.
