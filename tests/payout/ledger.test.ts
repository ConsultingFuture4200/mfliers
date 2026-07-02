/**
 * Payout ledger suite (T4.3) — PRD FR-P1…FR-P3 / EC-7.
 *
 * Pure-function tests (`lib/payout/tiers.ts`) run with no DB. The
 * accrual/cap/idempotency/settlement acceptance criteria are exercised
 * against a real PostGIS test database, same pattern as
 * `tests/host/review-queue.test.ts`/`tests/campaign/lifecycle.test.ts`.
 * Skips (rather than fails) when `DATABASE_URL` isn't configured.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import {
  closeTestDb,
  getTestDb,
  hasTestDatabase,
  resetTestDb,
  type TestDb,
} from "../setup";
import { ForbiddenError } from "@/lib/auth/guards";
import type { StaffPrincipal } from "@/lib/auth/staff";
import { getMembership } from "@/lib/db/dal/campaign-memberships";
import { listAuditLog } from "@/lib/audit/log";
import {
  accrue,
  balanceOwed,
  CampaignNotFoundError,
  committedTotal,
  getLedgerSummaryForHost,
  LedgerEntryNotFoundError,
  listLedger,
  markSettled,
  markSettledForHost,
} from "@/lib/payout/ledger";
import {
  isCapWarning,
  lookupTierBand,
  TierNotFoundError,
} from "@/lib/payout/tiers";
import type { TierTable } from "@/types/domain";

// ---------------------------------------------------------------------------
// Pure unit tests — lib/payout/tiers.ts. No DB.
// ---------------------------------------------------------------------------

describe("lookupTierBand (T4.3)", () => {
  // Mirrors the card's literal Mycofest example: "T1 (1-10) $1.25, T2
  // (11-25) $1.75, T3 (26+) $2.25" — the campaign's own tierTable, never
  // hard-coded in lib/payout/tiers.ts itself.
  const MYCOFEST_TIER_TABLE: TierTable = [
    { minCount: 0, maxCount: 10, payoutCents: 125 },
    { minCount: 11, maxCount: 25, payoutCents: 175 },
    { minCount: 26, maxCount: null, payoutCents: 225 },
  ];

  it("acceptance criterion: counts 10/11 and 25/26 yield the correct band amount", () => {
    expect(lookupTierBand(MYCOFEST_TIER_TABLE, 10)).toMatchObject({
      tierNumber: 1,
      band: { payoutCents: 125 },
    });
    expect(lookupTierBand(MYCOFEST_TIER_TABLE, 11)).toMatchObject({
      tierNumber: 2,
      band: { payoutCents: 175 },
    });
    expect(lookupTierBand(MYCOFEST_TIER_TABLE, 25)).toMatchObject({
      tierNumber: 2,
      band: { payoutCents: 175 },
    });
    expect(lookupTierBand(MYCOFEST_TIER_TABLE, 26)).toMatchObject({
      tierNumber: 3,
      band: { payoutCents: 225 },
    });
  });

  it("throws TierNotFoundError for a count no band covers", () => {
    const gappy: TierTable = [
      { minCount: 5, maxCount: null, payoutCents: 100 },
    ];
    expect(() => lookupTierBand(gappy, 1)).toThrow(TierNotFoundError);
  });
});

describe("isCapWarning (T4.3)", () => {
  it("flips at exactly 80% of budgetCap, not before", () => {
    expect(isCapWarning(799, 1000)).toBe(false);
    expect(isCapWarning(800, 1000)).toBe(true);
    expect(isCapWarning(801, 1000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DB-backed integration tests — lib/payout/ledger.ts + accrueLedgerEntry.
// ---------------------------------------------------------------------------

async function insertHost(db: TestDb): Promise<string> {
  const [row] = await db
    .insert(schema.users)
    .values({ type: "host" })
    .returning({ id: schema.users.id });
  return row.id;
}

async function insertCampaign(
  db: TestDb,
  opts: { tierTable: TierTable; budgetCapCents: number; hostId: string },
): Promise<string> {
  const [row] = await db
    .insert(schema.campaigns)
    .values({
      name: "Ledger Test Campaign",
      flierImageUrl: "https://example.com/fliers/ledger-test.png",
      budgetCap: opts.budgetCapCents,
      tierTable: opts.tierTable,
      grandPrize: "Test grand prize",
      privacySetting: "admin_only",
      proximityRadiusM: 30,
      settlementMode: "manual",
      state: "live",
      hostId: opts.hostId,
      startAt: new Date("2026-01-01T00:00:00Z"),
      endAt: new Date("2026-12-31T00:00:00Z"),
    })
    .returning({ id: schema.campaigns.id });
  return row.id;
}

async function insertPlayer(db: TestDb, email: string): Promise<string> {
  const [row] = await db
    .insert(schema.players)
    .values({ email })
    .returning({ id: schema.players.id });
  return row.id;
}

async function insertTarget(
  db: TestDb,
  campaignId: string,
  label: string,
): Promise<string> {
  const [row] = await db
    .insert(schema.targets)
    .values({
      campaignId,
      label,
      location: "POINT(-123.8 46.9)",
      state: "red",
    })
    .returning({ id: schema.targets.id });
  return row.id;
}

async function insertApprovedSubmission(
  db: TestDb,
  campaignId: string,
  playerId: string,
  targetId: string,
): Promise<string> {
  const [row] = await db
    .insert(schema.submissions)
    .values({
      campaignId,
      playerId,
      targetId,
      photoUrl: `${campaignId}/${targetId}.jpg`,
      deviceGps: "POINT(-123.8 46.9)",
      phash: "a".repeat(16),
      decision: "approved",
    })
    .returning({ id: schema.submissions.id });
  return row.id;
}

function hostPrincipalFor(campaignId: string, userId: string): StaffPrincipal {
  return { userId, type: "host", scopedCampaignIds: [campaignId] };
}

const MYCOFEST_TIER_TABLE: TierTable = [
  { minCount: 0, maxCount: 10, payoutCents: 125 },
  { minCount: 11, maxCount: 25, payoutCents: 175 },
  { minCount: 26, maxCount: null, payoutCents: 225 },
];

describe.skipIf(!hasTestDatabase())("payout ledger accrual (T4.3)", () => {
  const db = hasTestDatabase() ? getTestDb() : undefined;

  beforeEach(async () => {
    await resetTestDb(db!);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("accrues the correct tiered amount as a player's approved count crosses each band boundary", async () => {
    const hostId = await insertHost(db!);
    const campaignId = await insertCampaign(db!, {
      tierTable: MYCOFEST_TIER_TABLE,
      budgetCapCents: 100_000_00, // budget is not the point of this test
      hostId,
    });
    const playerId = await insertPlayer(db!, "u15550009999@example.com");

    // 26 sequential accruals — no pre-existing campaign_memberships row for
    // this player, so the first accrual must also create it (upsert).
    let lastEntry;
    for (let i = 1; i <= 26; i++) {
      const targetId = await insertTarget(db!, campaignId, `Target ${i}`);
      const submissionId = await insertApprovedSubmission(
        db!,
        campaignId,
        playerId,
        targetId,
      );
      lastEntry = await accrue(campaignId, submissionId, playerId);
      if (i === 10) {
        expect(lastEntry.entry.tierAtTime).toBe(1);
        expect(lastEntry.entry.amountCents).toBe(125);
      }
      if (i === 11) {
        expect(lastEntry.entry.tierAtTime).toBe(2);
        expect(lastEntry.entry.amountCents).toBe(175);
      }
      if (i === 25) {
        expect(lastEntry.entry.tierAtTime).toBe(2);
        expect(lastEntry.entry.amountCents).toBe(175);
      }
      if (i === 26) {
        expect(lastEntry.entry.tierAtTime).toBe(3);
        expect(lastEntry.entry.amountCents).toBe(225);
      }
    }

    const membership = await getMembership(campaignId, playerId);
    expect(membership?.approvedCount).toBe(26);
    expect(membership?.currentTier).toBe(3);
    // 10*125 + 15*175 + 1*225 = 1250 + 2625 + 225 = 4100
    expect(membership?.balanceOwedCents).toBe(4100);
    expect(await committedTotal(campaignId)).toBe(4100);
  });

  it("is idempotent by (campaignId, submissionId) — a retried accrual never double-pays", async () => {
    const hostId = await insertHost(db!);
    const campaignId = await insertCampaign(db!, {
      tierTable: MYCOFEST_TIER_TABLE,
      budgetCapCents: 100_000_00,
      hostId,
    });
    const playerId = await insertPlayer(db!, "u15550008888@example.com");
    const targetId = await insertTarget(db!, campaignId, "Target 1");
    const submissionId = await insertApprovedSubmission(
      db!,
      campaignId,
      playerId,
      targetId,
    );

    const first = await accrue(campaignId, submissionId, playerId);
    expect(first.alreadyAccrued).toBe(false);

    const second = await accrue(campaignId, submissionId, playerId);
    expect(second.alreadyAccrued).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);

    const entries = await listLedger(campaignId);
    expect(entries).toHaveLength(1);

    const membership = await getMembership(campaignId, playerId);
    expect(membership?.approvedCount).toBe(1);
    expect(membership?.balanceOwedCents).toBe(125);
  });

  it("survives two concurrent accrual calls for the same submission without double-paying", async () => {
    const hostId = await insertHost(db!);
    const campaignId = await insertCampaign(db!, {
      tierTable: MYCOFEST_TIER_TABLE,
      budgetCapCents: 100_000_00,
      hostId,
    });
    const playerId = await insertPlayer(db!, "u15550007777@example.com");
    const targetId = await insertTarget(db!, campaignId, "Target 1");
    const submissionId = await insertApprovedSubmission(
      db!,
      campaignId,
      playerId,
      targetId,
    );

    const [a, b] = await Promise.all([
      accrue(campaignId, submissionId, playerId),
      accrue(campaignId, submissionId, playerId),
    ]);
    expect(a.entry.id).toBe(b.entry.id);
    // Exactly one of the two calls did the real work.
    expect([a.alreadyAccrued, b.alreadyAccrued].sort()).toEqual([false, true]);

    const entries = await listLedger(campaignId);
    expect(entries).toHaveLength(1);
    const membership = await getMembership(campaignId, playerId);
    expect(membership?.approvedCount).toBe(1);
  });

  it("acceptance criterion: cumulative committed never exceeds budget_cap; the crossing submission is marked unpayable", async () => {
    const hostId = await insertHost(db!);
    const flatTable: TierTable = [
      { minCount: 0, maxCount: null, payoutCents: 500 },
    ];
    const campaignId = await insertCampaign(db!, {
      tierTable: flatTable,
      budgetCapCents: 1_200, // room for exactly two $5 accruals, not three
      hostId,
    });
    const playerId = await insertPlayer(db!, "u15550006666@example.com");

    async function accrueOne() {
      const targetId = await insertTarget(db!, campaignId, "Target");
      const submissionId = await insertApprovedSubmission(
        db!,
        campaignId,
        playerId,
        targetId,
      );
      return accrue(campaignId, submissionId, playerId);
    }

    const first = await accrueOne();
    expect(first.entry.unpayable).toBe(false);
    expect(first.entry.amountCents).toBe(500);

    const second = await accrueOne();
    expect(second.entry.unpayable).toBe(false);
    expect(second.entry.amountCents).toBe(500);

    // Third would push committed to 1500 > 1200 — must be marked unpayable,
    // never counted toward the payable total.
    const third = await accrueOne();
    expect(third.entry.unpayable).toBe(true);
    expect(third.entry.amountCents).toBe(0);

    const total = await committedTotal(campaignId);
    expect(total).toBe(1000);
    expect(total).toBeLessThanOrEqual(1_200);
  });

  it("survives a concurrent near-cap race without exceeding the payable cap", async () => {
    const hostId = await insertHost(db!);
    const flatTable: TierTable = [
      { minCount: 0, maxCount: null, payoutCents: 600 },
    ];
    const campaignId = await insertCampaign(db!, {
      tierTable: flatTable,
      budgetCapCents: 1_000, // only one of two concurrent $6 accruals fits
      hostId,
    });
    const playerA = await insertPlayer(db!, "u15550005551@example.com");
    const playerB = await insertPlayer(db!, "u15550005552@example.com");
    const targetA = await insertTarget(db!, campaignId, "Target A");
    const targetB = await insertTarget(db!, campaignId, "Target B");
    const submissionA = await insertApprovedSubmission(
      db!,
      campaignId,
      playerA,
      targetA,
    );
    const submissionB = await insertApprovedSubmission(
      db!,
      campaignId,
      playerB,
      targetB,
    );

    const [a, b] = await Promise.all([
      accrue(campaignId, submissionA, playerA),
      accrue(campaignId, submissionB, playerB),
    ]);

    const unpayableCount = [a, b].filter((r) => r.entry.unpayable).length;
    expect(unpayableCount).toBe(1);
    const total = await committedTotal(campaignId);
    expect(total).toBe(600);
    expect(total).toBeLessThanOrEqual(1_000);
  });

  it("acceptance criterion: the 80% warning flag flips at the right cumulative value", async () => {
    const hostId = await insertHost(db!);
    const flatTable: TierTable = [
      { minCount: 0, maxCount: null, payoutCents: 100 },
    ];
    const campaignId = await insertCampaign(db!, {
      tierTable: flatTable,
      budgetCapCents: 1_000, // 80% == 800
      hostId,
    });
    const playerId = await insertPlayer(db!, "u15550004444@example.com");

    async function accrueOne() {
      const targetId = await insertTarget(db!, campaignId, "Target");
      const submissionId = await insertApprovedSubmission(
        db!,
        campaignId,
        playerId,
        targetId,
      );
      return accrue(campaignId, submissionId, playerId);
    }

    let result;
    for (let i = 1; i <= 8; i++) {
      result = await accrueOne();
      if (i === 7) expect(result.capWarning).toBe(false); // 700/1000
      if (i === 8) expect(result.capWarning).toBe(true); // 800/1000
    }
  });

  it("balanceOwed reflects a player's running total; 0 for a player with no membership", async () => {
    const hostId = await insertHost(db!);
    const campaignId = await insertCampaign(db!, {
      tierTable: MYCOFEST_TIER_TABLE,
      budgetCapCents: 100_000_00,
      hostId,
    });
    const playerId = await insertPlayer(db!, "u15550003333@example.com");
    const noSubmissionsPlayer = await insertPlayer(
      db!,
      "u15550003334@example.com",
    );

    expect(await balanceOwed(campaignId, noSubmissionsPlayer)).toBe(0);

    const targetId = await insertTarget(db!, campaignId, "Target");
    const submissionId = await insertApprovedSubmission(
      db!,
      campaignId,
      playerId,
      targetId,
    );
    await accrue(campaignId, submissionId, playerId);
    expect(await balanceOwed(campaignId, playerId)).toBe(125);
  });

  it("throws CampaignNotFoundError for a nonexistent campaign", async () => {
    await expect(
      accrue(
        "00000000-0000-0000-0000-000000000000",
        "00000000-0000-0000-0000-000000000001",
        "00000000-0000-0000-0000-000000000002",
      ),
    ).rejects.toThrow(CampaignNotFoundError);
  });

  // -------------------------------------------------------------------
  // Acceptance criterion: marking an entry settled updates
  // settled/settled_at.
  // -------------------------------------------------------------------
  it("marks a ledger entry settled and audit-logs the settlement", async () => {
    const hostId = await insertHost(db!);
    const campaignId = await insertCampaign(db!, {
      tierTable: MYCOFEST_TIER_TABLE,
      budgetCapCents: 100_000_00,
      hostId,
    });
    const playerId = await insertPlayer(db!, "u15550002222@example.com");
    const targetId = await insertTarget(db!, campaignId, "Target");
    const submissionId = await insertApprovedSubmission(
      db!,
      campaignId,
      playerId,
      targetId,
    );
    const { entry } = await accrue(campaignId, submissionId, playerId);
    expect(entry.settled).toBe(false);
    expect(entry.settledAt).toBeNull();

    const settled = await markSettled(campaignId, entry.id, hostId);
    expect(settled.settled).toBe(true);
    expect(settled.settledAt).toBeInstanceOf(Date);

    const auditEntries = await listAuditLog(campaignId);
    expect(
      auditEntries.some(
        (e) => e.action === "settle" && e.submissionId === submissionId,
      ),
    ).toBe(true);
  });

  it("throws LedgerEntryNotFoundError for a nonexistent ledger entry", async () => {
    const hostId = await insertHost(db!);
    const campaignId = await insertCampaign(db!, {
      tierTable: MYCOFEST_TIER_TABLE,
      budgetCapCents: 100_000_00,
      hostId,
    });
    await expect(
      markSettled(campaignId, "00000000-0000-0000-0000-000000000000", hostId),
    ).rejects.toThrow(LedgerEntryNotFoundError);
  });

  // -------------------------------------------------------------------
  // Host-facing authorization (constitution §2/§5): server-side, never a
  // hidden button.
  // -------------------------------------------------------------------
  it("denies a host scoped to a different campaign from reading or settling this campaign's ledger", async () => {
    const hostId = await insertHost(db!);
    const otherHostUserId = "00000000-0000-0000-0000-0000000000ff";
    const campaignId = await insertCampaign(db!, {
      tierTable: MYCOFEST_TIER_TABLE,
      budgetCapCents: 100_000_00,
      hostId,
    });
    const outsider = hostPrincipalFor(
      "00000000-0000-0000-0000-000000000abc",
      otherHostUserId,
    );

    await expect(getLedgerSummaryForHost(outsider, campaignId)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(
      markSettledForHost(
        outsider,
        campaignId,
        "00000000-0000-0000-0000-000000000000",
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it("lets a campaign's own host read the ledger summary", async () => {
    const hostId = await insertHost(db!);
    const campaignId = await insertCampaign(db!, {
      tierTable: MYCOFEST_TIER_TABLE,
      budgetCapCents: 1_000_00,
      hostId,
    });
    const playerId = await insertPlayer(db!, "u15550001111@example.com");
    const targetId = await insertTarget(db!, campaignId, "Target");
    const submissionId = await insertApprovedSubmission(
      db!,
      campaignId,
      playerId,
      targetId,
    );
    await accrue(campaignId, submissionId, playerId);

    const principal = hostPrincipalFor(campaignId, hostId);
    const summary = await getLedgerSummaryForHost(principal, campaignId);
    expect(summary.entries).toHaveLength(1);
    expect(summary.committedTotalCents).toBe(125);
    expect(summary.budgetCapCents).toBe(1_000_00);
    expect(summary.capWarning).toBe(false);
  });
});
