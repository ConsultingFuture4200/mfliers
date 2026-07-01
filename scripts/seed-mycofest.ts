/**
 * Seeds the real Mycofest campaign (T5.5, PRD EC-1…EC-7's demo tenant).
 *
 * Usage (fresh DB — see docs/seed.md for the full runbook):
 *   DATABASE_URL=postgres://... pnpm tsx scripts/seed-mycofest.ts
 *
 * Every Mycofest-specific value (budget cap, tier table, grand prize,
 * privacy setting, target set) lives *only* here, in this seed script's
 * own config literal and `data/mycofest-targets.csv` — never hard-coded
 * into `app/`/`lib/` (anti-requirement). This script is just a caller of
 * the same site-admin-guarded domain functions a real admin UI would use
 * (`lib/campaign/lifecycle.ts`'s `createCampaign`/`activateCampaign`,
 * `lib/target/csv-import.ts`'s `importTargetsFromCsv`) — no schema/lib
 * changes, no shortcuts around authorization.
 *
 * Not idempotent by design: each run creates a fresh campaign (campaigns
 * have no unique-name constraint — PRD doesn't ask for one), so re-running
 * against a DB that already has a Mycofest campaign produces a second one.
 * Intended to run once against a freshly migrated database (docs/seed.md);
 * the staff accounts it creates *are* idempotent by email (`getOrCreate
 * StaffUser`), so re-running only ever adds one new campaign, never
 * duplicate users.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { hashPassword, type StaffPrincipal } from "@/lib/auth/staff";
import { activateCampaign, createCampaign } from "@/lib/campaign/lifecycle";
import { importTargetsFromCsv } from "@/lib/target/csv-import";
import type { TierTable, UserType } from "@/types/domain";

// PRD's literal Mycofest numbers (card requirement 3): $1,000 budget cap,
// T1 (1-10) $1.25, T2 (11-25) $1.75, T3 (26+) $2.25 — stored per
// `lib/payout/tiers.ts`'s documented ordinal-count convention (first band
// starts at `minCount: 0`, since submission #1 through #10 are "1-10").
const MYCOFEST_BUDGET_CAP_CENTS = 100_000; // $1,000.00
const MYCOFEST_TIER_TABLE: TierTable = [
  { minCount: 0, maxCount: 10, payoutCents: 125 },
  { minCount: 11, maxCount: 25, payoutCents: 175 },
  { minCount: 26, maxCount: null, payoutCents: 225 },
];
const MYCOFEST_GRAND_PRIZE = "2 Mycofest tickets";
const MYCOFEST_ADMIN_EMAIL = "admin@mfliers.local";
const MYCOFEST_HOST_EMAIL = "host@mycofest.local";
// Throwaway seed passwords — never used for a real deployed environment
// (constitution §5: secrets in env only; these are dev/demo-only login
// credentials for the staff accounts this script itself creates, not a
// secret this codebase depends on). Documented in docs/seed.md so a demo
// operator can actually log in as either account.
const SEED_ADMIN_PASSWORD = "mfliers-seed-admin-2026";
const SEED_HOST_PASSWORD = "mfliers-seed-host-2026";

/**
 * Finds an existing staff user by email, or creates one (idempotent by
 * email — see module doc comment). Not exported/shared with
 * `scripts/seed-second-campaign.ts`: each seed script is self-contained,
 * matching this codebase's established "duplicated per call site, not a
 * shared module this card's Files list doesn't ask for" convention (e.g.
 * `requireStaffPrincipal` duplicated across every host/admin route file).
 */
async function getOrCreateStaffUser(
  email: string,
  type: UserType,
  password: string,
): Promise<string> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const passwordHash = await hashPassword(password);
  const [row] = await db
    .insert(users)
    .values({ type, email, passwordHash })
    .returning({ id: users.id });
  return row.id;
}

async function main(): Promise<void> {
  const adminUserId = await getOrCreateStaffUser(
    MYCOFEST_ADMIN_EMAIL,
    "site_admin",
    SEED_ADMIN_PASSWORD,
  );
  const hostUserId = await getOrCreateStaffUser(
    MYCOFEST_HOST_EMAIL,
    "host",
    SEED_HOST_PASSWORD,
  );
  const adminPrincipal: StaffPrincipal = {
    userId: adminUserId,
    type: "site_admin",
    scopedCampaignIds: [],
  };

  const now = new Date();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

  const campaign = await createCampaign(adminPrincipal, {
    name: "Mycofest",
    flierImageUrl: "https://example.com/fliers/mycofest.png",
    budgetCapCents: MYCOFEST_BUDGET_CAP_CENTS,
    tierTable: MYCOFEST_TIER_TABLE,
    grandPrize: MYCOFEST_GRAND_PRIZE,
    privacySetting: "admin_only",
    proximityRadiusM: 40,
    hostId: hostUserId,
    startAt: now,
    endAt: new Date(now.getTime() + ninetyDaysMs),
  });
  console.log(`Created campaign "${campaign.name}" (${campaign.id}), draft.`);

  const csvPath = path.join(process.cwd(), "data/mycofest-targets.csv");
  const csvText = readFileSync(csvPath, "utf8");
  const report = await importTargetsFromCsv(
    adminPrincipal,
    campaign.id,
    csvText,
  );
  console.log(`Imported ${report.created.length} targets from ${csvPath}.`);
  if (report.errors.length > 0) {
    console.warn(
      `${report.errors.length} row(s) in ${csvPath} were rejected:`,
      report.errors,
    );
  }

  const live = await activateCampaign(adminPrincipal, campaign.id);
  console.log(`Campaign "${live.name}" is now live (${live.id}).`);
  console.log(
    `Staff logins — admin: ${MYCOFEST_ADMIN_EMAIL} / ${SEED_ADMIN_PASSWORD}; ` +
      `host: ${MYCOFEST_HOST_EMAIL} / ${SEED_HOST_PASSWORD} (see docs/seed.md).`,
  );
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("Mycofest seed failed:", err);
    process.exit(1);
  });
