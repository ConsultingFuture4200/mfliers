/**
 * Users (staff) DAL (T2.3).
 *
 * `users` is deliberately NOT a campaign-scoped table, the same reasoning
 * as `lib/db/dal/players.ts` (T2.2): a staff account is a single global
 * identity that may be authorized for zero, one, or many campaigns via the
 * `user_campaigns` join, not a row that itself carries a `campaign_id`.
 * Functions here are intentionally excluded from the isolation suite's
 * "every scoped export requires campaignId" check for the same reason
 * `players.ts` is — there is nothing on this table to scope.
 *
 * The set of campaign ids a user is authorized for ("scoped_campaign_ids"
 * in constitution §5) IS read from `user_campaigns`, a campaign-adjacent
 * join table — but resolving "which campaigns is this one user allowed
 * into" is an authorization lookup keyed by `userId`, not a campaign-scoped
 * data read, so it does not take a `campaignId` parameter either.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users, userCampaigns } from "@/lib/db/schema";
import type { UserType } from "@/types/domain";

export interface StaffUserRow {
  id: string;
  type: UserType;
  email: string | null;
  passwordHash: string | null;
}

function toDomain(row: typeof users.$inferSelect): StaffUserRow {
  return {
    id: row.id,
    type: row.type,
    email: row.email,
    passwordHash: row.passwordHash,
  };
}

/** Reads a staff user by email, or `null` if none exists. */
export async function getUserByEmail(
  email: string,
): Promise<StaffUserRow | null> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return rows[0] ? toDomain(rows[0]) : null;
}

/** Reads a staff user by id, or `null` if none exists. */
export async function getUserById(
  userId: string,
): Promise<StaffUserRow | null> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ? toDomain(rows[0]) : null;
}

/**
 * The campaign ids `userId` is authorized for, per `user_campaigns`.
 * Empty for a `site_admin` (who is platform-wide by type, not by grant
 * list — `requireCampaignAccess` never consults this for a site_admin) and
 * for a host with no grants yet.
 */
export async function getScopedCampaignIdsForUser(
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ campaignId: userCampaigns.campaignId })
    .from(userCampaigns)
    .where(eq(userCampaigns.userId, userId));
  return rows.map((r) => r.campaignId);
}
