/**
 * Campaigns DAL (T2.1; extended by T3.1 with the create/update/lifecycle
 * write paths — `lib/campaign/lifecycle.ts` is the only caller of the
 * write functions below, per constitution §6 (domain logic in `lib/`,
 * never in route handlers) and this file's own scope (the DAL only reads
 * and writes rows; validation and authorization live in
 * `lib/campaign/lifecycle.ts`/`lib/auth/guards.ts`).
 *
 * `campaigns` is the tenant table itself, so "scoping by campaignId" here
 * means "look up the one row whose primary key is that id" rather than a
 * `WHERE campaign_id = ...` predicate on a child table — there is no
 * separate campaign-scoping column to filter by. The exported function
 * still takes `campaignId` as its required first parameter (not `id`),
 * both for naming consistency with the rest of the DAL and so the
 * type-level isolation check in `tests/isolation/isolation.test.ts` (every
 * exported DAL function requires a `campaignId`) covers this module too.
 * For the two write functions below that create/mutate a row, the caller
 * (`lib/campaign/lifecycle.ts`) mints the campaign id up front (mirrors the
 * submission-id-minting pattern in `app/api/uploads/sign/route.ts`) so
 * `campaignId` is still a genuine, non-optional first parameter rather than
 * an awkward fit for an insert.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { campaigns } from "@/lib/db/schema";
import type { Campaign, CampaignState, TierTable } from "@/types/domain";
import { assertCampaignId } from "./scope";

function toDomain(row: typeof campaigns.$inferSelect): Campaign {
  return {
    id: row.id,
    name: row.name,
    flierImageUrl: row.flierImageUrl,
    budgetCapCents: row.budgetCap,
    tierTable: row.tierTable,
    grandPrize: row.grandPrize,
    privacySetting: row.privacySetting,
    proximityRadiusM: row.proximityRadiusM,
    settlementMode: row.settlementMode,
    state: row.state,
    hostId: row.hostId,
    startAt: row.startAt,
    endAt: row.endAt,
  };
}

/** Reads a single campaign by id, or `null` if it doesn't exist. */
export async function getCampaignById(
  campaignId: string,
): Promise<Campaign | null> {
  assertCampaignId(campaignId, "getCampaignById");
  const rows = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  return rows[0] ? toDomain(rows[0]) : null;
}

/** Fields a new campaign is created with (T3.1, PRD FR-C1). Money fields
 * are integer cents (constitution §3); `lib/campaign/lifecycle.ts` is
 * responsible for validating shape (tier table, non-negative amounts,
 * date ordering) before calling this — this function trusts its input. */
export interface NewCampaignFields {
  name: string;
  flierImageUrl: string;
  /** Total campaign budget, in integer cents. */
  budgetCapCents: number;
  tierTable: TierTable;
  grandPrize: string;
  privacySetting: Campaign["privacySetting"];
  proximityRadiusM: number;
  hostId: string;
  startAt: Date;
  endAt: Date;
}

/**
 * Inserts a new campaign row with `campaignId` as the caller-minted primary
 * key, always starting in `draft` state (PRD FR-C2: lifecycle starts at
 * draft; a campaign is never created already-live). The DB trigger
 * `sync_campaign_host_to_user_campaigns` (`lib/db/schema/users.ts`)
 * creates the host's `user_campaigns` grant row automatically — callers
 * must NOT also insert that row by hand.
 */
export async function insertCampaign(
  campaignId: string,
  fields: NewCampaignFields,
): Promise<Campaign> {
  assertCampaignId(campaignId, "insertCampaign");
  const [row] = await db
    .insert(campaigns)
    .values({
      id: campaignId,
      name: fields.name,
      flierImageUrl: fields.flierImageUrl,
      budgetCap: fields.budgetCapCents,
      tierTable: fields.tierTable,
      grandPrize: fields.grandPrize,
      privacySetting: fields.privacySetting,
      proximityRadiusM: fields.proximityRadiusM,
      settlementMode: "manual",
      state: "draft",
      hostId: fields.hostId,
      startAt: fields.startAt,
      endAt: fields.endAt,
    })
    .returning();
  return toDomain(row);
}

/** Patch of the mutable campaign-configuration fields (T3.1 requirement:
 * "update/configure"). Never includes `state` — state transitions go
 * through `setCampaignState` so the lifecycle guard is the only path that
 * flips it. */
export type CampaignFieldsPatch = Partial<Omit<NewCampaignFields, "hostId">>;

/** Updates the mutable configuration fields of `campaignId`. Only the keys
 * present in `patch` are changed. `lib/campaign/lifecycle.ts` is
 * responsible for rejecting edits to a `closed` (frozen) campaign before
 * calling this. */
export async function updateCampaignFields(
  campaignId: string,
  patch: CampaignFieldsPatch,
): Promise<Campaign> {
  assertCampaignId(campaignId, "updateCampaignFields");
  const values: Partial<typeof campaigns.$inferInsert> = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.flierImageUrl !== undefined) {
    values.flierImageUrl = patch.flierImageUrl;
  }
  if (patch.budgetCapCents !== undefined) {
    values.budgetCap = patch.budgetCapCents;
  }
  if (patch.tierTable !== undefined) values.tierTable = patch.tierTable;
  if (patch.grandPrize !== undefined) values.grandPrize = patch.grandPrize;
  if (patch.privacySetting !== undefined) {
    values.privacySetting = patch.privacySetting;
  }
  if (patch.proximityRadiusM !== undefined) {
    values.proximityRadiusM = patch.proximityRadiusM;
  }
  if (patch.startAt !== undefined) values.startAt = patch.startAt;
  if (patch.endAt !== undefined) values.endAt = patch.endAt;

  const [row] = await db
    .update(campaigns)
    .set(values)
    .where(eq(campaigns.id, campaignId))
    .returning();
  return toDomain(row);
}

/**
 * Sets `campaignId`'s lifecycle state directly, atomically — the `UPDATE`'s
 * `WHERE` also requires the row's *current* state to still be `fromState`
 * (mirrors `lib/db/dal/targets.ts`'s conditional-`UPDATE` claim pattern).
 * `lib/campaign/lifecycle.ts` is the only caller and is responsible for
 * validating the transition is legal (`draft -> live -> closed`, no
 * skips/reversals) and, for `draft -> live`, that the readiness
 * preconditions (flier image + >=1 target) hold — this function performs
 * the write only.
 *
 * Returns `null` if no row matched (the campaign doesn't exist, or its
 * state had already moved on from `fromState` by the time this ran — e.g.
 * two concurrent `close` requests) instead of unconditionally overwriting
 * whatever state the row is actually in. Without this guard, two
 * concurrent `PATCH .../campaigns/[id] {state:'closed'}` calls would both
 * read the same stale `live` row, both pass the caller's transition check,
 * and both re-run the full finalize routine (leaderboard snapshot, etc.)
 * redundantly — harmless while finalize is idempotent, but the moment a
 * non-idempotent side effect (settlement webhook, notification) is added
 * to a transition, a lost-update/double-fire bug is silent without this.
 */
export async function setCampaignState(
  campaignId: string,
  fromState: CampaignState,
  state: CampaignState,
): Promise<Campaign | null> {
  assertCampaignId(campaignId, "setCampaignState");
  const [row] = await db
    .update(campaigns)
    .set({ state })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.state, fromState)))
    .returning();
  return row ? toDomain(row) : null;
}
