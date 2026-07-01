/**
 * Players DAL (T2.2).
 *
 * `players` is deliberately NOT a campaign-scoped table (constitution §1 /
 * PRD §7: "player identity is platform-global (one login, many
 * campaigns)"). It has no `campaign_id` column, so unlike every module
 * under `lib/db/dal/` for the campaign-scoped tables, functions here do
 * NOT take a `campaignId` parameter and are intentionally excluded from
 * the isolation suite's "every scoped export requires campaignId" check
 * (`tests/isolation/isolation.test.ts` only enumerates the campaign-scoped
 * modules) — there is nothing to scope. Per-campaign participation is
 * `campaign_memberships` (`lib/db/dal/campaign-memberships.ts`), which IS
 * scoped.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { players } from "@/lib/db/schema";
import type { Player } from "@/types/domain";

function toDomain(row: typeof players.$inferSelect): Player {
  return { id: row.id, phone: row.phone };
}

/** Reads a player by phone number, or `null` if none exists yet. */
export async function getPlayerByPhone(phone: string): Promise<Player | null> {
  const rows = await db
    .select()
    .from(players)
    .where(eq(players.phone, phone))
    .limit(1);
  return rows[0] ? toDomain(rows[0]) : null;
}

/** Reads a player by id (T4.1's capture flow: resolving the session's
 * `playerId` into a full `Player` for the fraud pipeline). Not campaign-
 * scoped, same reasoning as `getPlayerByPhone` — see module doc comment. */
export async function getPlayerById(playerId: string): Promise<Player | null> {
  const rows = await db
    .select()
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1);
  return rows[0] ? toDomain(rows[0]) : null;
}

/**
 * Returns the existing player for `phone`, or creates one. Global identity
 * per constitution/PRD — a phone number maps to exactly one player row
 * regardless of how many campaigns it later joins.
 *
 * Uses `ON CONFLICT DO NOTHING` + re-read rather than a plain insert, so two
 * concurrent first-verifications for the same phone (e.g. a double-tapped
 * "verify" button) can't race into two rows — `players.phone` has a unique
 * constraint (see `lib/db/schema/players.ts`) that this relies on.
 */
export async function getOrCreatePlayerByPhone(phone: string): Promise<{
  player: Player;
  isNewPlayer: boolean;
}> {
  const inserted = await db
    .insert(players)
    .values({ phone })
    .onConflictDoNothing({ target: players.phone })
    .returning();

  if (inserted[0]) {
    return { player: toDomain(inserted[0]), isNewPlayer: true };
  }

  const existing = await getPlayerByPhone(phone);
  if (!existing) {
    // Should be unreachable: the insert only no-ops on a conflicting row,
    // which means a row with this phone must exist.
    throw new Error(
      `getOrCreatePlayerByPhone: no row found for ${phone} after conflict`,
    );
  }
  return { player: existing, isNewPlayer: false };
}
