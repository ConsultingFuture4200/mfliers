/**
 * Player email one-time-code auth suite (ADR-0003; supersedes the T2.2
 * phone-OTP suite).
 *
 * The email sender (`lib/auth/email.ts`) is mocked so the 6-digit code the
 * flow generates can be captured from the "sent" call and fed back into
 * verify — no live email provider is exercised (nor needed: the real send is
 * a thin provider POST/SMTP call). Player creation/reuse and the OTP store
 * are verified against a real Postgres+PostGIS database (same pattern as
 * `tests/isolation/isolation.test.ts`), so "first verify creates exactly one
 * player row; second reuses it" and "wrong/expired code creates no player"
 * are genuine DB assertions, not mocks.
 *
 * Skips (rather than fails) when `DATABASE_URL` isn't configured.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { closeTestDb, getTestDb, hasTestDatabase, resetTestDb } from "../setup";

vi.mock("@/lib/auth/email", () => ({
  sendOtpEmail: vi.fn(async () => undefined),
}));

import { sendOtpEmail } from "@/lib/auth/email";
import {
  requestPlayerOtp,
  verifyPlayerOtp,
  OtpRateLimitError,
  InvalidEmailError,
  OTP_RATE_LIMIT_MAX_REQUESTS,
  OTP_MAX_VERIFY_ATTEMPTS,
  _resetOtpRateLimitForTests,
} from "@/lib/auth/player";
import {
  authorizePlayerOtp,
  tokenFromSignIn,
  sessionFromToken,
} from "@/lib/auth/config";
import { CredentialsSignin } from "next-auth";

const mockedSend = vi.mocked(sendOtpEmail);

/** A code guaranteed different from `code` (avoids a 1-in-1e6 false match). */
function wrongCodeFor(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

describe.skipIf(!hasTestDatabase())("player email-OTP auth", () => {
  const db = hasTestDatabase() ? getTestDb() : undefined;

  /** Requests an OTP and returns the plaintext code captured from the
   * (mocked) email send — the only place the code is ever exposed. */
  async function requestAndCaptureCode(email: string): Promise<string> {
    mockedSend.mockClear();
    await requestPlayerOtp(email);
    const call = mockedSend.mock.calls.at(-1);
    if (!call) throw new Error("sendOtpEmail was not called");
    return call[1];
  }

  async function countPlayers(email: string): Promise<number> {
    const rows = await db!
      .select()
      .from(schema.players)
      .where(eq(schema.players.email, email));
    return rows.length;
  }

  beforeEach(async () => {
    await resetTestDb(db!);
    _resetOtpRateLimitForTests();
    mockedSend.mockClear();
  });

  afterEach(() => {
    mockedSend.mockReset();
    mockedSend.mockImplementation(async () => undefined);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  describe("requestPlayerOtp", () => {
    it("emails a 6-digit code and stores only its hash (never the plaintext)", async () => {
      const email = "sender@example.com";
      const code = await requestAndCaptureCode(email);

      expect(mockedSend).toHaveBeenCalledTimes(1);
      expect(mockedSend).toHaveBeenCalledWith(email, code);
      expect(code).toMatch(/^\d{6}$/);

      const rows = await db!
        .select()
        .from(schema.playerEmailOtp)
        .where(eq(schema.playerEmailOtp.email, email));
      expect(rows).toHaveLength(1);
      // The plaintext code must never be what we persisted.
      expect(rows[0].codeHash).not.toBe(code);
      expect(rows[0].codeHash.length).toBeGreaterThan(code.length);
    });

    it("normalizes the email (trim + lowercase) before storing", async () => {
      await requestAndCaptureCode("  MixedCase@Example.COM ");
      const rows = await db!.select().from(schema.playerEmailOtp);
      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBe("mixedcase@example.com");
    });

    it("rejects a malformed email with InvalidEmailError", async () => {
      await expect(requestPlayerOtp("not-an-email")).rejects.toBeInstanceOf(
        InvalidEmailError,
      );
    });

    it("rate-limits repeated requests for the same email", async () => {
      const email = "limited@example.com";
      for (let i = 0; i < OTP_RATE_LIMIT_MAX_REQUESTS; i++) {
        await requestPlayerOtp(email);
      }
      await expect(requestPlayerOtp(email)).rejects.toBeInstanceOf(
        OtpRateLimitError,
      );
      // A different email is unaffected by another email's limit.
      await expect(
        requestPlayerOtp("other@example.com"),
      ).resolves.toBeUndefined();
    });
  });

  describe("request OTP -> verify correct code -> session created with a player_id", () => {
    it("creates a session-ready principal carrying a player_id on a correct code", async () => {
      const email = "correct@example.com";
      const code = await requestAndCaptureCode(email);

      const authResult = await authorizePlayerOtp({ email, code });

      expect(authResult.principalType).toBe("player");
      expect(authResult.playerId).toEqual(expect.any(String));
      expect(authResult.id).toBe(authResult.playerId);

      // The code (a secret) must never leak into the auth result / session.
      expect(JSON.stringify(authResult)).not.toContain(code);

      // jwt/session callbacks (extracted, pure — lib/auth/config.ts) project
      // the player identity through exactly as a real sign-in would.
      const token = tokenFromSignIn({}, authResult);
      expect(token).toMatchObject({
        playerId: authResult.playerId,
        principalType: "player",
      });
      expect(JSON.stringify(token)).not.toContain(code);

      const session = sessionFromToken({}, token);
      expect(session).toMatchObject({
        playerId: authResult.playerId,
        principalType: "player",
      });
      expect(JSON.stringify(session)).not.toContain(code);

      // And the player genuinely exists in the DB.
      const rows = await db!
        .select()
        .from(schema.players)
        .where(eq(schema.players.email, email));
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(authResult.playerId);
    });

    it("a token/session with no signed-in user passes through unchanged", () => {
      const token = tokenFromSignIn({ existing: "value" }, undefined);
      expect(token).toEqual({ existing: "value" });

      const session = sessionFromToken({ existing: "value" }, {});
      expect(session).toEqual({ existing: "value" });
    });
  });

  describe("wrong / expired code", () => {
    it("wrong code is rejected — no session, no player row created", async () => {
      const email = "wrong@example.com";
      const code = await requestAndCaptureCode(email);

      await expect(
        authorizePlayerOtp({ email, code: wrongCodeFor(code) }),
      ).rejects.toBeInstanceOf(CredentialsSignin);

      expect(await countPlayers(email)).toBe(0);
    });

    it("verifyPlayerOtp returns null (not a session) on a wrong code", async () => {
      const email = "wrong2@example.com";
      const code = await requestAndCaptureCode(email);
      const result = await verifyPlayerOtp(email, wrongCodeFor(code));
      expect(result).toBeNull();
      expect(await countPlayers(email)).toBe(0);
    });

    it("an expired code is rejected — no session, no player row", async () => {
      const email = "expired@example.com";
      const code = await requestAndCaptureCode(email);

      // Age the stored code past its expiry.
      await db!
        .update(schema.playerEmailOtp)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.playerEmailOtp.email, email));

      const result = await verifyPlayerOtp(email, code);
      expect(result).toBeNull();
      expect(await countPlayers(email)).toBe(0);
    });

    it("spends the code after too many wrong attempts (cap enforced)", async () => {
      const email = "capped@example.com";
      const code = await requestAndCaptureCode(email);
      const wrong = wrongCodeFor(code);

      for (let i = 0; i < OTP_MAX_VERIFY_ATTEMPTS; i++) {
        expect(await verifyPlayerOtp(email, wrong)).toBeNull();
      }
      // Even the correct code is now rejected — the record is spent.
      expect(await verifyPlayerOtp(email, code)).toBeNull();
      expect(await countPlayers(email)).toBe(0);
    });
  });

  describe("player identity reuse", () => {
    it("first verify creates exactly one player row; a second verify for the same email reuses it", async () => {
      const email = "reuse@example.com";

      const firstCode = await requestAndCaptureCode(email);
      const first = await verifyPlayerOtp(email, firstCode);
      expect(first?.isNewPlayer).toBe(true);

      const secondCode = await requestAndCaptureCode(email);
      const second = await verifyPlayerOtp(email, secondCode);
      expect(second?.isNewPlayer).toBe(false);

      expect(first?.player.id).toBe(second?.player.id);
      expect(await countPlayers(email)).toBe(1);
    });
  });

  describe("single-use under concurrency (replay-race regression, Linus review)", () => {
    it("N concurrent verifies of the same valid code yield exactly one success", async () => {
      const email = "race@example.com";
      const code = await requestAndCaptureCode(email);

      // Fire many verifies of the same valid code simultaneously. Before the
      // atomic consumeOtpIfActive fix, the SELECT->compare->UPDATE window let
      // most of these succeed (one code -> N sessions). Now the conditional
      // UPDATE gates it: exactly one wins, and only one player row exists.
      const results = await Promise.all(
        Array.from({ length: 20 }, () => verifyPlayerOtp(email, code)),
      );

      const successes = results.filter((r) => r !== null);
      expect(successes).toHaveLength(1);
      expect(await countPlayers(email)).toBe(1);
    });
  });
});
