/**
 * Seeds a second, generic live campaign (T5.5 requirement 4) so the
 * universal aggregate map (`lib/campaign/universal-map.ts`, T5.2) has
 * >=2 live tenants to demonstrate EC-4 ("clustering across ≥2 campaigns")
 * against real seeded data rather than a single-campaign demo.
 *
 * Deliberately generic — this is not a second real-world tenant, just a
 * distinct campaign (own host, own targets, own tier table/budget) so the
 * universal map has something else to aggregate alongside Mycofest.
 * Mirrors `tests/fixtures/seed-two-campaigns.ts`'s "Campaign B" in spirit
 * (a wholly separate campaign, far enough away geographically to be
 * visually distinct on a map), but as a standalone runnable seed script
 * rather than a test fixture, per this card's own Files list.
 *
 * Usage (fresh DB — see docs/seed.md):
 *   DATABASE_URL=postgres://... pnpm tsx scripts/seed-second-campaign.ts
 *
 * Not idempotent for the same reason `scripts/seed-mycofest.ts` isn't
 * (campaigns have no unique-name constraint) — the staff account this
 * creates *is* idempotent by email, so re-running only ever adds one more
 * campaign, never a duplicate user.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { hashPassword, type StaffPrincipal } from "@/lib/auth/staff";
import { activateCampaign, createCampaign } from "@/lib/campaign/lifecycle";
import { createPinDropTarget } from "@/lib/target/csv-import";
import type { TierTable, UserType } from "@/types/domain";

const SECOND_CAMPAIGN_NAME = "Downtown Flier Drive";
const SECOND_CAMPAIGN_BUDGET_CAP_CENTS = 50_000; // $500.00 — a smaller demo budget than Mycofest, on purpose
const SECOND_CAMPAIGN_TIER_TABLE: TierTable = [
  { minCount: 0, maxCount: 10, payoutCents: 100 },
  { minCount: 11, maxCount: null, payoutCents: 150 },
];
const SECOND_CAMPAIGN_ADMIN_EMAIL = "admin@mfliers.local"; // same platform admin Mycofest's seed uses
const SECOND_CAMPAIGN_HOST_EMAIL = "host@downtown-flier-drive.local";
const SEED_ADMIN_PASSWORD = "mfliers-seed-admin-2026";
const SEED_HOST_PASSWORD = "mfliers-seed-host-2026";

// Far from Mycofest's Pacific County, WA targets, so the two campaigns'
// pins are visually distinct on the universal map — matches
// `tests/fixtures/seed-two-campaigns.ts`'s "Campaign B" (NYC-area) choice.
const SECOND_CAMPAIGN_TARGETS = [
  { label: "Union Square Kiosk", lat: 40.7359, long: -73.9911 },
  { label: "Bryant Park Newsstand", lat: 40.7536, long: -73.9832 },
  { label: "Washington Square Arch", lat: 40.7308, long: -73.9973 },
];

/** See `scripts/seed-mycofest.ts`'s doc comment for why this isn't a
 * shared helper module. */
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
    SECOND_CAMPAIGN_ADMIN_EMAIL,
    "site_admin",
    SEED_ADMIN_PASSWORD,
  );
  const hostUserId = await getOrCreateStaffUser(
    SECOND_CAMPAIGN_HOST_EMAIL,
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
    name: SECOND_CAMPAIGN_NAME,
    flierImageUrl: "https://example.com/fliers/downtown-flier-drive.png",
    budgetCapCents: SECOND_CAMPAIGN_BUDGET_CAP_CENTS,
    tierTable: SECOND_CAMPAIGN_TIER_TABLE,
    grandPrize: "$50 gift card",
    privacySetting: "public_username",
    proximityRadiusM: 40,
    hostId: hostUserId,
    startAt: now,
    endAt: new Date(now.getTime() + ninetyDaysMs),
  });
  console.log(`Created campaign "${campaign.name}" (${campaign.id}), draft.`);

  for (const target of SECOND_CAMPAIGN_TARGETS) {
    await createPinDropTarget(adminPrincipal, campaign.id, target);
  }
  console.log(`Created ${SECOND_CAMPAIGN_TARGETS.length} targets.`);

  const live = await activateCampaign(adminPrincipal, campaign.id);
  console.log(`Campaign "${live.name}" is now live (${live.id}).`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("Second-campaign seed failed:", err);
    process.exit(1);
  });
