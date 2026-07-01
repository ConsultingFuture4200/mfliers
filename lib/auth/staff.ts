/**
 * Host/admin (staff) email+password domain logic (T2.3) — PRD FR-A2,
 * constitution §2/§5.
 *
 * Mirrors the shape of `lib/auth/player.ts` (T2.2): this is the one place
 * the staff login flow lives; the Auth.js Credentials provider
 * (`lib/auth/config.ts`) is a thin caller into `authenticateStaff`, and
 * `app/(auth)/staff-login/page.tsx` only calls `signIn()` — constitution
 * §6, domain logic lives in `lib/`, never in route handlers or components.
 *
 * Password hashing: Node's built-in `crypto.scrypt` rather than an added
 * `bcrypt`/`argon2` dependency. The card says "e.g. argon2/bcrypt" (an
 * example, not a mandate) — scrypt is a memory-hard KDF in the same family
 * (OWASP's password-storage cheat sheet lists it as an accepted
 * alternative when bcrypt/argon2 aren't available) and needs no native
 * addon, which avoids a native-compile dependency in this sandbox/CI.
 * Flagged in `tasks/lessons.md` so a later card doesn't assume bcrypt's
 * hash format when touching `users.password_hash`.
 */
import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import {
  getUserByEmail,
  getUserById,
  getScopedCampaignIdsForUser,
  type StaffUserRow,
} from "@/lib/db/dal/users";
import type { UserType } from "@/types/domain";

/**
 * `util.promisify(crypto.scrypt)` resolves to the no-options overload's
 * type (its options-object overload isn't the one promisify's helper
 * types pick up), which fails `tsc` when calling it with `{ N }` below.
 * A small explicit `Promise` wrapper sidesteps the overload-resolution
 * issue and keeps the options argument fully typed.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

const SCRYPT_KEYLEN = 64;
/** `N` cost parameter — 2^15, a reasonable interactive-login cost per
 * Node's own scrypt guidance (default `N` is 2^14; one notch up). */
const SCRYPT_N = 2 ** 15;
/**
 * Node's `crypto.scrypt` defaults `maxmem` to 32 MiB, which is exactly
 * `128 * N * r` bytes at `N = 2^15, r = 8` (the default block size `r`) —
 * i.e. right at the ceiling, and `scrypt` rejects params that reach it
 * ("memory limit exceeded"). Doubling the allowance here is the
 * documented fix (Node's own `crypto.scrypt` docs: raise `maxmem` to fit
 * a higher `N`), not a security-relevant knob.
 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/**
 * Hashes `password` with a fresh random salt. Stored format is
 * `scrypt:N:saltHex:hashHex` — the algorithm/cost is embedded so a future
 * change to `SCRYPT_N` doesn't break verifying older hashes.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt:${SCRYPT_N}:${salt.toString("hex")}:${derived.toString("hex")}`;
}

/**
 * Verifies `password` against a stored `scrypt:...` hash. Constant-time
 * comparison (`timingSafeEqual`) so response timing doesn't leak how much
 * of the hash matched.
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const [, nStr, saltHex, hashHex] = parts;
  const n = Number(nStr);
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (!Number.isFinite(n) || salt.length === 0 || expected.length === 0) {
    return false;
  }
  const derived = await scrypt(password, salt, expected.length, {
    N: n,
    maxmem: SCRYPT_MAXMEM,
  });
  return (
    derived.length === expected.length && timingSafeEqual(derived, expected)
  );
}

/** The authenticated staff principal (constitution §5: "host token
 * authorizes only its scoped_campaign_ids; site admin is platform-wide"). */
export interface StaffPrincipal {
  userId: string;
  type: UserType;
  /** Ignored for `site_admin` (platform-wide by type, not by grant list). */
  scopedCampaignIds: string[];
}

async function toPrincipal(user: StaffUserRow): Promise<StaffPrincipal> {
  const scopedCampaignIds =
    user.type === "host" ? await getScopedCampaignIdsForUser(user.id) : [];
  return { userId: user.id, type: user.type, scopedCampaignIds };
}

/**
 * Verifies `email`+`password` against the `users` table. Returns the
 * resolved `StaffPrincipal` (with `scopedCampaignIds` already loaded) on a
 * correct match, or `null` on any failure (unknown email, no password set,
 * wrong password) — never distinguishes which, per Auth.js's own
 * generic-error guidance (see `lib/auth/config.ts`'s `InvalidOtpError`).
 */
export async function authenticateStaff(
  email: string,
  password: string,
): Promise<StaffPrincipal | null> {
  const user = await getUserByEmail(email);
  if (!user || !user.passwordHash) return null;
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return null;
  return toPrincipal(user);
}

/**
 * Resolves a `StaffPrincipal` fresh from the database for `userId` —
 * re-reading both the user row (type may have changed) and
 * `scopedCampaignIds` (grants may have changed) rather than trusting
 * anything cached in a session/JWT.
 *
 * Constitution §5 requires authorization be enforced server-side on
 * *every* request; a host's grant list stamped into a JWT at login would
 * otherwise stay valid (or invalid) for the life of that token — up to
 * NextAuth's default ~30 day `maxAge` — even after the grant changes.
 * `lib/auth/config.ts` deliberately does NOT stamp `scopedCampaignIds`
 * onto the session for this reason; every privileged route handler must
 * call this function (via `session.userId`) to get a principal whose
 * `scopedCampaignIds` reflect `user_campaigns` as of *this* request, then
 * pass it to `requireCampaignAccess`/`requireSiteAdmin`
 * (`lib/auth/guards.ts`). Returns `null` if the user no longer exists
 * (e.g. deleted/offboarded since the token was issued).
 */
export async function resolveStaffPrincipal(
  userId: string,
): Promise<StaffPrincipal | null> {
  const user = await getUserById(userId);
  if (!user) return null;
  return toPrincipal(user);
}
