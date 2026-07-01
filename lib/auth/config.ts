/**
 * Shared Auth.js (NextAuth v5) configuration (T2.2 added the `player-otp`
 * provider; T2.3 adds the second, staff-facing `staff-credentials`
 * provider to this same config per the batch-2 card: "T2.3 ... coordinates
 * with T2.2 (shared Auth.js setup)").
 *
 * Constitution §2: auth provider is Auth.js (NextAuth) + Twilio Verify for
 * players, email+password for host/admin. Constitution §5/§8: `AUTH_SECRET`
 * and Twilio credentials come from env only (NextAuth auto-infers
 * `AUTH_SECRET`); nothing here is importable from a client component (this
 * whole module runs server-side).
 *
 * Provider 1: a Credentials provider named `player-otp`. `authorize()`
 * verifies the OTP via Twilio (through `lib/auth/player.ts` — domain logic
 * lives in `lib/`, not here) and returns a `player` principal on success.
 * The client calls `signIn("player-otp", { phone, code })`, which posts to
 * Auth.js's own `/api/auth/callback/player-otp` endpoint (wired up by
 * `app/api/auth/[...nextauth]/route.ts`) — this *is* the "verify" route the
 * card allows as an alternative to a hand-written
 * `app/api/auth/otp/verify/route.ts`, and it's the right choice here: the
 * OTP send/check is a stateful, one-time Twilio operation, so having
 * exactly one call site (`authorize`) that checks the code avoids a second,
 * separate verify route either duplicating that check (Twilio would reject
 * the second check of an already-consumed code) or being the sole trusted
 * checker while Auth.js's own callback is bypassed.
 *
 * Provider 2: a Credentials provider named `staff-credentials` (T2.3).
 * `authorize()` verifies email+password via `lib/auth/staff.ts` and returns
 * a `site_admin`|`host` principal (with its resolved `scopedCampaignIds`)
 * on success. The client calls `signIn("staff-credentials", { email,
 * password })` from `app/(auth)/staff-login/page.tsx` — a distinct page
 * from the player login, per the card's requirement 5.
 *
 * Session strategy: `jwt` (required for Credentials providers — there's no
 * adapter/database session here). The JWT/session callbacks stamp the
 * signed-in principal's *identity* (`playerId`/`userId`) and `principalType`
 * onto the token/session so callers can distinguish a player session from a
 * staff (site_admin/host) session without a second round-trip to the DB on
 * every request.
 *
 * Deliberately NOT stamped: a host's `scopedCampaignIds`. Constitution §5
 * requires host authorization be "enforced server-side on every request" —
 * with NextAuth's default JWT `maxAge` (~30 days), a grant list baked into
 * the token at login would keep authorizing (or denying) access to
 * campaigns based on stale data until the token happens to refresh, which
 * is a tenant-isolation-relevant gap, not a UX nicety. Every privileged
 * route handler must instead resolve a fresh `StaffPrincipal` per request
 * via `resolveStaffPrincipal(session.userId)` (`lib/auth/staff.ts`), which
 * re-reads `user_campaigns` from the DB, before calling
 * `requireCampaignAccess`/`requireSiteAdmin` (`lib/auth/guards.ts`).
 */
import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { verifyPlayerOtp } from "@/lib/auth/player";
import { authenticateStaff } from "@/lib/auth/staff";
import type { UserType } from "@/types/domain";

/** Thrown by the `player-otp` provider's `authorize()` on a wrong/expired
 * code. A distinct, generically-named error per Auth.js's own guidance:
 * "generally, we recommend not hinting ... try something like
 * 'invalid-credentials'." */
class InvalidOtpError extends CredentialsSignin {
  code = "invalid_otp";
}

/** Thrown by the `staff-credentials` provider's `authorize()` on a
 * wrong/unknown email+password combination. Deliberately generic, same
 * reasoning as `InvalidOtpError`. */
class InvalidStaffCredentialsError extends CredentialsSignin {
  code = "invalid_credentials";
}

/** Discriminates every session principal this app issues. */
type PrincipalType = "player" | UserType;

declare module "next-auth" {
  interface User {
    /** Present only on a `player` principal (`player-otp` provider). */
    playerId?: string;
    /** Present only on a staff principal (`staff-credentials` provider,
     * T2.3) — the `users.id` row. */
    userId?: string;
    /** Returned by `authorizeStaffCredentials` at sign-in time only (for
     * tests / immediate post-login use); deliberately NOT persisted onto
     * the token/session — see the module doc comment above. Route
     * handlers must re-resolve this fresh via `resolveStaffPrincipal`. */
    scopedCampaignIds?: string[];
    /** Discriminates the session principal type. */
    principalType?: PrincipalType;
  }

  interface Session {
    playerId?: string;
    userId?: string;
    principalType?: PrincipalType;
  }
}

/**
 * `next-auth/jwt`'s `JWT` type isn't augmentable from this package (it's a
 * transitive dependency, not hoisted/resolvable as its own module
 * specifier under pnpm's strict `node_modules`) — the token/session
 * objects Auth.js passes into these callbacks are already
 * `Record<string, unknown>`-shaped (see `@auth/core`'s `JWT extends
 * Record<string, unknown>`), so these helpers work against that structural
 * shape directly rather than depending on a declared field.
 */
type MinimalUser = {
  playerId?: string;
  userId?: string;
  scopedCampaignIds?: string[];
  principalType?: PrincipalType;
};
type MinimalToken = {
  playerId?: string;
  userId?: string;
  principalType?: PrincipalType;
} & Record<string, unknown>;

/**
 * Pure jwt-callback logic, extracted so it's directly unit-testable
 * (`tests/auth/player-otp.test.ts`) without going through Auth.js's own
 * request-handling machinery. `user` is only present on the initial
 * sign-in call (Auth.js convention); on every later request it's
 * `undefined` and the previously-stamped token fields pass through as-is.
 *
 * Deliberately does NOT stamp `scopedCampaignIds` onto the token even
 * though `user.scopedCampaignIds` is available at sign-in — see the
 * module doc comment: authorization must be resolved fresh per request
 * (`resolveStaffPrincipal`), never trusted from a JWT that can outlive a
 * grant change by up to `maxAge`.
 */
export function tokenFromSignIn(
  token: Record<string, unknown>,
  user: MinimalUser | undefined,
): Record<string, unknown> {
  if (user?.principalType === "player" && user.playerId) {
    return { ...token, playerId: user.playerId, principalType: "player" };
  }
  if (
    (user?.principalType === "site_admin" || user?.principalType === "host") &&
    user.userId
  ) {
    return {
      ...token,
      userId: user.userId,
      principalType: user.principalType,
    };
  }
  return token;
}

/**
 * Pure session-callback logic, extracted for the same reason as
 * `tokenFromSignIn`: projects the player identity from the JWT onto the
 * session object every request reads (constitution §6: domain logic in
 * `lib/`, not buried inside a framework config object).
 */
export function sessionFromToken(
  session: Record<string, unknown>,
  token: MinimalToken,
): Record<string, unknown> {
  if (token.principalType === "player" && token.playerId) {
    return { ...session, playerId: token.playerId, principalType: "player" };
  }
  if (
    (token.principalType === "site_admin" || token.principalType === "host") &&
    token.userId
  ) {
    return {
      ...session,
      userId: token.userId,
      principalType: token.principalType,
    };
  }
  return session;
}

/**
 * The `player-otp` Credentials provider's `authorize()` logic, extracted
 * for direct unit testing. Verifies the OTP via `verifyPlayerOtp`
 * (`lib/auth/player.ts`) and maps a success into the shape Auth.js expects
 * a `User` to have; throws `InvalidOtpError` on a wrong/expired code or
 * malformed input, per Auth.js's Credentials contract (throw or return
 * `null` -> failed sign-in, no session).
 */
export async function authorizePlayerOtp(
  credentials: Partial<Record<"phone" | "code", unknown>>,
): Promise<{ id: string; playerId: string; principalType: "player" }> {
  const phone = credentials.phone;
  const code = credentials.code;
  if (typeof phone !== "string" || typeof code !== "string") {
    throw new InvalidOtpError();
  }

  const result = await verifyPlayerOtp(phone, code);
  if (!result) throw new InvalidOtpError();

  return {
    id: result.player.id,
    playerId: result.player.id,
    principalType: "player",
  };
}

/**
 * The `staff-credentials` Credentials provider's `authorize()` logic
 * (T2.3), extracted for direct unit testing (same pattern as
 * `authorizePlayerOtp`). Verifies email+password via `authenticateStaff`
 * (`lib/auth/staff.ts`) and maps a success into the shape Auth.js expects
 * a `User` to have; throws `InvalidStaffCredentialsError` on any failure
 * or malformed input.
 */
export async function authorizeStaffCredentials(
  credentials: Partial<Record<"email" | "password", unknown>>,
): Promise<{
  id: string;
  userId: string;
  scopedCampaignIds: string[];
  principalType: UserType;
}> {
  const email = credentials.email;
  const password = credentials.password;
  if (typeof email !== "string" || typeof password !== "string") {
    throw new InvalidStaffCredentialsError();
  }

  const principal = await authenticateStaff(email, password);
  if (!principal) throw new InvalidStaffCredentialsError();

  return {
    id: principal.userId,
    userId: principal.userId,
    scopedCampaignIds: principal.scopedCampaignIds,
    principalType: principal.type,
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      id: "player-otp",
      name: "Phone (OTP)",
      credentials: {
        phone: { label: "Phone number", type: "tel" },
        code: { label: "Verification code", type: "text" },
      },
      authorize: authorizePlayerOtp,
    }),
    Credentials({
      id: "staff-credentials",
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: authorizeStaffCredentials,
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      return tokenFromSignIn(token, user);
    },
    async session({ session, token }) {
      return sessionFromToken(
        session as unknown as Record<string, unknown>,
        token,
      ) as unknown as typeof session;
    },
  },
});
