/**
 * Player email-OTP DAL (ADR-0003).
 *
 * Global, NON-campaign-scoped (same as `players` — see that module's doc
 * comment): a login code belongs to an email identity, not a campaign, so
 * there is no `campaignId` parameter here and this module is intentionally
 * outside the isolation suite's scoped-module enumeration.
 *
 * This layer only reads/writes rows; it stores and compares a code HASH
 * (constitution §5 — no plaintext code is ever persisted). Hashing,
 * expiry, and the attempts cap are the domain layer's job
 * (`lib/auth/player.ts`).
 */
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { playerEmailOtp } from "@/lib/db/schema";

export type PlayerEmailOtpRow = typeof playerEmailOtp.$inferSelect;

/** Inserts a fresh OTP record (hashed code + expiry) for `email`. */
export async function createEmailOtp(input: {
  email: string;
  codeHash: string;
  expiresAt: Date;
}): Promise<PlayerEmailOtpRow> {
  const [row] = await db
    .insert(playerEmailOtp)
    .values({
      email: input.email,
      codeHash: input.codeHash,
      expiresAt: input.expiresAt,
    })
    .returning();
  return row;
}

/**
 * Returns the most recent unconsumed, unexpired OTP record for `email`, or
 * `null` if none is currently valid. "Latest" (newest `created_at`) so a
 * freshly requested code supersedes any older outstanding one.
 */
export async function getLatestActiveOtp(
  email: string,
): Promise<PlayerEmailOtpRow | null> {
  const rows = await db
    .select()
    .from(playerEmailOtp)
    .where(
      and(
        eq(playerEmailOtp.email, email),
        isNull(playerEmailOtp.consumedAt),
        gt(playerEmailOtp.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(playerEmailOtp.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Increments the attempts counter for one OTP record (a wrong-code try). */
export async function incrementOtpAttempts(id: string): Promise<void> {
  await db
    .update(playerEmailOtp)
    .set({ attempts: sql`${playerEmailOtp.attempts} + 1` })
    .where(eq(playerEmailOtp.id, id));
}

/**
 * Atomically consumes one OTP record IFF it is still unconsumed, stamping
 * `consumed_at` now. Returns the updated row when this call is the one that
 * flipped `consumed_at` from NULL, or `null` when it was already consumed.
 *
 * This is the single-use gate under concurrency: the `isNull(consumedAt)`
 * predicate + Postgres row-level MVCC serialize N concurrent verifies of the
 * same code so exactly ONE call's UPDATE affects a row — every other racer's
 * UPDATE matches zero rows and returns `null`, so it must not authenticate.
 * Mirrors the atomic-write-guard pattern already used by the target claim
 * and `getOrCreatePlayerByEmail`. (Linus review, ADR-0003.)
 */
export async function consumeOtpIfActive(
  id: string,
): Promise<typeof playerEmailOtp.$inferSelect | null> {
  const [row] = await db
    .update(playerEmailOtp)
    .set({ consumedAt: new Date() })
    .where(and(eq(playerEmailOtp.id, id), isNull(playerEmailOtp.consumedAt)))
    .returning();
  return row ?? null;
}
