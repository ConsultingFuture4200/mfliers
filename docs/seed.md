# Seeding a fresh environment (T5.5)

> Standing up the real Mycofest campaign plus a second live campaign, so
> the Phase-1 demo (PRD EC-1…EC-7) has live data rather than test fixtures.
> Anti-requirement (`docs/tasks/batch-5.md`): never seed into a production
> environment from CI — this is a manually run, one-time operator step
> against a database *you* control, not a CI/deploy hook.

## 1. Prerequisites

- A migrated Postgres+PostGIS database. Either:
  - a fresh DB: run `pnpm db:migrate` against it first (see `docs/deploy.md`
    §2 for the connection-string shape), or
  - the local Docker PostGIS instance this repo's tests use — migrate the
    same way.
- `DATABASE_URL` pointed at that database for every command below.

Both seed scripts are **not idempotent against campaign duplication** —
each run creates a fresh campaign row (campaigns have no unique-name
constraint), so running a script twice against the same database produces
two campaigns with the same name. Run each script once per environment.
The staff accounts they create *are* idempotent by email — re-running is
safe with respect to users, just not campaigns. If you need to reseed,
start from a fresh (re-migrated or truncated) database.

## 2. Seed the Mycofest campaign

```bash
DATABASE_URL=postgres://... pnpm tsx scripts/seed-mycofest.ts
```

This (`scripts/seed-mycofest.ts`):

1. Creates (or reuses, by email) a site-admin account and a host account.
2. Creates the **Mycofest** campaign via `lib/campaign/lifecycle.ts`'s
   `createCampaign` — the real site-admin-guarded domain function, not a
   raw DB insert — with:
   - `budgetCapCents: 100000` ($1,000.00)
   - tier table: T1 (submissions 1–10) $1.25, T2 (11–25) $1.75,
     T3 (26+) $2.25 — stored as `[{minCount:0,maxCount:10,payoutCents:125},
     {minCount:11,maxCount:25,payoutCents:175},
     {minCount:26,maxCount:null,payoutCents:225}]` (see
     `lib/payout/tiers.ts`'s doc comment for why the first band's
     `minCount` is `0`, not `1`).
   - `grandPrize: "2 Mycofest tickets"`
   - `privacySetting: "admin_only"`
3. Imports `data/mycofest-targets.csv` via `lib/target/csv-import.ts`'s
   `importTargetsFromCsv` (the same site-admin CSV-import path
   `app/admin/campaigns/[id]/targets` uses) — every row becomes a `red`
   target.
4. Activates the campaign (`draft -> live`) via `activateCampaign`.

**On success**, the script prints the campaign id and the two staff
logins it created (`admin@mfliers.local` / `host@mycofest.local`, both
with seed-only passwords printed to stdout — see the script's own
constants; rotate these before any non-throwaway deployment).

`data/mycofest-targets.csv` ships with placeholder coordinates in Pacific
County, WA (real coordinates to be provided by the host per the task
card — swap the file's contents before a real event and re-run against a
fresh DB).

## 3. Seed a second live campaign (EC-4: ≥2 live campaigns on the universal map)

```bash
DATABASE_URL=postgres://... pnpm tsx scripts/seed-second-campaign.ts
```

`scripts/seed-second-campaign.ts` creates a second, unrelated live
campaign ("Downtown Flier Drive" — a generic demo tenant, not a second
real-world event) with its own host, budget, tier table, and a small
hand-placed target set (via `createPinDropTarget`, no CSV needed). Run
this *in addition to* step 2, not instead of it — together they give the
universal map (`/map`, `lib/campaign/universal-map.ts`) two live tenants
to aggregate, which is what EC-4 asks for.

## 4. Verify

- `GET /api/public/pins` (or visit `/map`) should show pins from both
  campaigns.
- `GET /api/public/campaigns` (or visit `/`) should list both campaigns in
  the public directory.
- Log in at `/staff-login` as the Mycofest host
  (`host@mycofest.local`) and visit `/host/campaigns/<mycofest-id>/review`
  to confirm host access.
- `psql`/`docker exec <postgis-container> psql -U postgres -d <db> -c
  "SELECT name, state, budget_cap, tier_table, grand_prize,
  privacy_setting FROM campaigns;"` to confirm both rows directly.

## 5. Re-running against a fresh database

Run migrations, then steps 2–3 above, in order:

```bash
DATABASE_URL=postgres://... pnpm db:migrate
DATABASE_URL=postgres://... pnpm tsx scripts/seed-mycofest.ts
DATABASE_URL=postgres://... pnpm tsx scripts/seed-second-campaign.ts
```

This is the exact sequence used to validate this document (against the
local Docker PostGIS test database, `DATABASE_URL=postgres://postgres:
postgres@127.0.0.1:5433/mfliers_test` in this repo's own sandbox) — both
scripts ran cleanly end to end, producing two `live` campaigns with the
budget/tier/privacy values above.
