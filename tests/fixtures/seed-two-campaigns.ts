/**
 * Reusable two-campaign seed fixture (T1.4).
 *
 * Produces two wholly separate campaigns (`Campaign A`, `Campaign B`), each
 * with its own host, its own targets, and its own player + membership. The
 * two campaigns share no rows — this is deliberate: it's the fixture the
 * tenant-isolation suite (T2.1) and the multi-campaign map tests (T4.4/T5.2)
 * build on to prove no cross-campaign read leaks.
 *
 * Anti-requirement (card): this seeds generic Campaign A/B only, never the
 * real Mycofest data (that's T5.5's job).
 */
import * as schema from "@/lib/db/schema";
import type { TierTable } from "@/types/domain";
import type { TestDb } from "../setup";

/** IDs and shape of a single seeded campaign, for assertions in callers. */
export interface SeededCampaign {
  campaignId: string;
  hostId: string;
  playerId: string;
  targetIds: string[];
}

export interface SeedTwoCampaignsResult {
  campaignA: SeededCampaign;
  campaignB: SeededCampaign;
}

const DEFAULT_TIER_TABLE: TierTable = [
  { minCount: 0, maxCount: 5, payoutCents: 500 },
  { minCount: 6, maxCount: 15, payoutCents: 750 },
  { minCount: 16, maxCount: null, payoutCents: 1000 },
];

interface SeedCampaignOptions {
  name: string;
  phone: string;
  /** Base coordinate the campaign's targets are placed around. */
  center: { lat: number; long: number };
}

async function seedCampaign(
  db: TestDb,
  { name, phone, center }: SeedCampaignOptions,
): Promise<SeededCampaign> {
  const [host] = await db
    .insert(schema.users)
    .values({ type: "host" })
    .returning({ id: schema.users.id });

  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      name,
      flierImageUrl: `https://example.com/fliers/${name.toLowerCase().replace(/\s+/g, "-")}.png`,
      budgetCap: 100_000, // $1,000.00, integer cents
      tierTable: DEFAULT_TIER_TABLE,
      grandPrize: "Test grand prize",
      privacySetting: "admin_only",
      proximityRadiusM: 30,
      settlementMode: "manual",
      state: "live",
      hostId: host.id,
      startAt: new Date("2026-01-01T00:00:00Z"),
      endAt: new Date("2026-12-31T00:00:00Z"),
    })
    .returning({ id: schema.campaigns.id });

  await db.insert(schema.userCampaigns).values({
    userId: host.id,
    campaignId: campaign.id,
  });

  const [player] = await db
    .insert(schema.players)
    .values({ phone })
    .returning({ id: schema.players.id });

  await db.insert(schema.campaignMemberships).values({
    campaignId: campaign.id,
    playerId: player.id,
  });

  // Three targets, offset slightly from the campaign's center point so
  // each campaign's targets occupy a visibly distinct area on the map.
  const offsets = [
    { dLat: 0, dLong: 0 },
    { dLat: 0.001, dLong: 0.001 },
    { dLat: -0.001, dLong: 0.002 },
  ];
  const targetRows = await db
    .insert(schema.targets)
    .values(
      offsets.map((offset, i) => ({
        campaignId: campaign.id,
        label: `${name} Target ${i + 1}`,
        location: `POINT(${center.long + offset.dLong} ${center.lat + offset.dLat})`,
        state: "red" as const,
      })),
    )
    .returning({ id: schema.targets.id });

  return {
    campaignId: campaign.id,
    hostId: host.id,
    playerId: player.id,
    targetIds: targetRows.map((t) => t.id),
  };
}

/**
 * Seeds two disjoint campaigns (each with its own host, player, and ≥3
 * targets) into `db`. Callers are responsible for resetting the DB
 * (`resetTestDb` in `tests/setup.ts`) before/after, so repeated seeding
 * doesn't leak state across tests.
 */
export async function seedTwoCampaigns(
  db: TestDb,
): Promise<SeedTwoCampaignsResult> {
  const campaignA = await seedCampaign(db, {
    name: "Campaign A",
    phone: "+15550001111",
    center: { lat: 46.9, long: -123.8 }, // Pacific County, WA area
  });
  const campaignB = await seedCampaign(db, {
    name: "Campaign B",
    phone: "+15550002222",
    center: { lat: 40.7, long: -74.0 }, // NYC area — far from Campaign A
  });

  return { campaignA, campaignB };
}
