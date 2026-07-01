/**
 * Host/admin auth + role-scoping suite (T2.3).
 *
 * `requireCampaignAccess`/`requireSiteAdmin` (`lib/auth/guards.ts`) are
 * pure functions over an already-resolved `StaffPrincipal`, so most of
 * this suite exercises them directly. The "host scoped to Campaign A is
 * denied Campaign B" criterion is proven against the real two-campaign
 * fixture (T1.4) on a live PostGIS database — same pattern as
 * `tests/isolation/isolation.test.ts` — so `scopedCampaignIds` genuinely
 * comes from a `user_campaigns` read, not a hand-built stub.
 *
 * Skips (rather than fails) when `DATABASE_URL` isn't configured.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { closeTestDb, getTestDb, hasTestDatabase, resetTestDb } from "../setup";
import { seedTwoCampaigns } from "../fixtures/seed-two-campaigns";
import {
  requireCampaignAccess,
  requireSiteAdmin,
  ForbiddenError,
} from "@/lib/auth/guards";
import type { StaffPrincipal } from "@/lib/auth/staff";
import {
  hashPassword,
  verifyPassword,
  authenticateStaff,
  resolveStaffPrincipal,
} from "@/lib/auth/staff";
import {
  authorizeStaffCredentials,
  tokenFromSignIn,
  sessionFromToken,
} from "@/lib/auth/config";
import { CredentialsSignin } from "next-auth";

describe.skipIf(!hasTestDatabase())("host/admin auth + role scoping", () => {
  const db = hasTestDatabase() ? getTestDb() : undefined;

  beforeEach(async () => {
    await resetTestDb(db!);
  });

  afterEach(async () => {
    // no-op; kept for symmetry with tests/auth/player-otp.test.ts.
  });

  afterAll(async () => {
    await closeTestDb();
  });

  describe("password hashing", () => {
    it("hashes a password (not plaintext) and verifies correctly", async () => {
      const plain = "correct horse battery staple";
      const stored = await hashPassword(plain);

      expect(stored).not.toBe(plain);
      expect(stored).not.toContain(plain);
      expect(stored.startsWith("scrypt:")).toBe(true);

      await expect(verifyPassword(plain, stored)).resolves.toBe(true);
      await expect(verifyPassword("wrong password", stored)).resolves.toBe(
        false,
      );
    });

    it("persists only the hash to the database, never the plaintext", async () => {
      const plain = "s3cret-admin-pw";
      const stored = await hashPassword(plain);

      const [row] = await db!
        .insert(schema.users)
        .values({
          type: "site_admin",
          email: "admin@example.com",
          passwordHash: stored,
        })
        .returning();

      expect(row.passwordHash).toBe(stored);
      expect(row.passwordHash).not.toBe(plain);
      // No plaintext column exists on the row at all.
      expect(Object.keys(row)).not.toContain("password");
    });
  });

  describe("requireCampaignAccess", () => {
    it("denies (403) a host principal scoped to Campaign A when accessing Campaign B", async () => {
      const { campaignA, campaignB } = await seedTwoCampaigns(db!);

      const plain = "host-A-password";
      await db!
        .update(schema.users)
        .set({
          email: "host-a@example.com",
          passwordHash: await hashPassword(plain),
        })
        .where(eq(schema.users.id, campaignA.hostId));

      const principal = await authenticateStaff("host-a@example.com", plain);
      expect(principal).not.toBeNull();
      expect(principal!.type).toBe("host");
      // Genuinely resolved from `user_campaigns`, not a hand-built stub.
      expect(principal!.scopedCampaignIds).toEqual([campaignA.campaignId]);

      // Allowed for its own campaign.
      expect(() =>
        requireCampaignAccess(principal!, campaignA.campaignId),
      ).not.toThrow();

      // Denied for the other campaign — the core assertion.
      let thrown: unknown;
      try {
        requireCampaignAccess(principal!, campaignB.campaignId);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ForbiddenError);
      expect((thrown as ForbiddenError).status).toBe(403);
    });

    it("allows a site_admin principal to access any campaign", async () => {
      const { campaignA, campaignB } = await seedTwoCampaigns(db!);

      const admin: StaffPrincipal = {
        userId: "00000000-0000-0000-0000-000000000000",
        type: "site_admin",
        scopedCampaignIds: [],
      };

      expect(() =>
        requireCampaignAccess(admin, campaignA.campaignId),
      ).not.toThrow();
      expect(() =>
        requireCampaignAccess(admin, campaignB.campaignId),
      ).not.toThrow();
      expect(() => requireSiteAdmin(admin)).not.toThrow();
    });
  });

  describe("requireSiteAdmin", () => {
    it("rejects a host principal", () => {
      const host: StaffPrincipal = {
        userId: "11111111-1111-1111-1111-111111111111",
        type: "host",
        scopedCampaignIds: ["some-campaign-id"],
      };

      let thrown: unknown;
      try {
        requireSiteAdmin(host);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ForbiddenError);
      expect((thrown as ForbiddenError).status).toBe(403);
    });
  });

  describe("login establishes a session with the correct principal type", () => {
    it("staff-credentials sign-in produces a host session end to end", async () => {
      const { campaignA } = await seedTwoCampaigns(db!);
      const plain = "another-host-password";
      await db!
        .update(schema.users)
        .set({
          email: "host-b@example.com",
          passwordHash: await hashPassword(plain),
        })
        .where(eq(schema.users.id, campaignA.hostId));

      const authResult = await authorizeStaffCredentials({
        email: "host-b@example.com",
        password: plain,
      });
      expect(authResult.principalType).toBe("host");
      expect(authResult.userId).toBe(campaignA.hostId);
      expect(authResult.scopedCampaignIds).toEqual([campaignA.campaignId]);

      const token = tokenFromSignIn({}, authResult);
      expect(token).toMatchObject({
        userId: campaignA.hostId,
        principalType: "host",
      });
      // Constitution §5: authorization is resolved server-side per
      // request, never trusted from a JWT that can outlive a grant
      // change — the token must NOT carry scopedCampaignIds.
      expect(token).not.toHaveProperty("scopedCampaignIds");

      const session = sessionFromToken({}, token);
      expect(session).toMatchObject({
        userId: campaignA.hostId,
        principalType: "host",
      });
      expect(session).not.toHaveProperty("scopedCampaignIds");

      // Route handlers resolve a fresh StaffPrincipal from `session.userId`
      // instead of trusting anything cached on the session.
      const freshPrincipal = await resolveStaffPrincipal(
        session.userId as string,
      );
      expect(freshPrincipal?.scopedCampaignIds).toEqual([campaignA.campaignId]);
    });

    it("rejects an unknown email / wrong password — no session", async () => {
      await expect(
        authorizeStaffCredentials({
          email: "nobody@example.com",
          password: "whatever",
        }),
      ).rejects.toBeInstanceOf(CredentialsSignin);

      const [{ id: siteAdminId }] = await db!
        .insert(schema.users)
        .values({
          type: "site_admin",
          email: "admin2@example.com",
          passwordHash: await hashPassword("real-password"),
        })
        .returning({ id: schema.users.id });

      await expect(
        authorizeStaffCredentials({
          email: "admin2@example.com",
          password: "wrong-password",
        }),
      ).rejects.toBeInstanceOf(CredentialsSignin);

      // Sanity: the row exists and is untouched by the failed attempt.
      const rows = await db!
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, siteAdminId));
      expect(rows).toHaveLength(1);
    });
  });

  describe("resolveStaffPrincipal freshness (Liotta finding)", () => {
    it("reflects a revoked grant immediately, unlike a value cached at login time", async () => {
      const { campaignA } = await seedTwoCampaigns(db!);

      // A principal resolved at "login time" — captures the grant as it
      // stood then, the same shape a stale JWT would have baked in.
      const principalAtLogin = await resolveStaffPrincipal(campaignA.hostId);
      expect(principalAtLogin?.scopedCampaignIds).toEqual([
        campaignA.campaignId,
      ]);

      // The grant is revoked out-of-band (e.g. an admin reassigns/removes
      // the host) — no new login, no new token.
      await db!
        .delete(schema.userCampaigns)
        .where(eq(schema.userCampaigns.userId, campaignA.hostId));

      // A stale cached principal would still authorize campaignA...
      expect(() =>
        requireCampaignAccess(principalAtLogin!, campaignA.campaignId),
      ).not.toThrow();

      // ...but resolving fresh per this request reflects the revocation,
      // and `requireCampaignAccess` denies it — proving the guard is only
      // as fresh as its caller: route handlers MUST call
      // `resolveStaffPrincipal` per request rather than reusing a
      // previously-resolved (or session-cached) principal.
      const principalNow = await resolveStaffPrincipal(campaignA.hostId);
      expect(principalNow?.scopedCampaignIds).toEqual([]);
      expect(() =>
        requireCampaignAccess(principalNow!, campaignA.campaignId),
      ).toThrow(ForbiddenError);
    });

    it("returns null for a user id that no longer exists", async () => {
      await expect(
        resolveStaffPrincipal("00000000-0000-0000-0000-0000000000ff"),
      ).resolves.toBeNull();
    });
  });
});
