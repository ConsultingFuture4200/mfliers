/**
 * Player email one-time-code store (email-OTP login, ADR-0003).
 *
 * Like `players`, this is a **global, non-campaign-scoped** table: a login
 * identity is platform-wide, not tied to a campaign, so there is no
 * `campaign_id` column and nothing here is subject to the isolation DAL's
 * "every scoped query filters by campaign_id" rule (constitution §3 /
 * `tests/isolation/isolation.test.ts`, which enumerates only the
 * campaign-scoped modules).
 *
 * Security (constitution §5): only a **hash** of the 6-digit code is stored,
 * never the plaintext — the code itself is delivered out-of-band by email and
 * never persisted or returned to a client. `attempts` backs a per-code
 * verification cap; `expires_at` bounds a code's lifetime; `consumed_at`
 * makes a successful code single-use.
 */
import { pgTable, uuid, text, integer, index } from "drizzle-orm/pg-core";
import { timestamptz } from "./columns";

export const playerEmailOtp = pgTable(
  "player_email_otp",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    /** HASH of the 6-digit code (see `lib/auth/player.ts#hashOtpCode`) —
     * never the plaintext code. */
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamptz("consumed_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [index("player_email_otp_email_idx").on(table.email)],
);
