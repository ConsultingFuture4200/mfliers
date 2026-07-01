/**
 * Player phone-OTP auth suite (T2.2).
 *
 * Twilio Verify is mocked (`lib/auth/twilio.ts` is not exercised for real —
 * no live Twilio account exists in this environment; see `.env.example` /
 * `docs/tasks/batch-2.md`'s sandbox notes). Player creation/reuse is
 * verified against a real Postgres+PostGIS database (the same pattern as
 * `tests/isolation/isolation.test.ts`), so "first verify creates exactly
 * one player row; second verify reuses it" is a genuine DB assertion, not
 * a mock.
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

vi.mock("@/lib/auth/twilio", () => ({
  sendOtp: vi.fn(async () => undefined),
  checkOtp: vi.fn(async () => false),
}));

import { sendOtp, checkOtp } from "@/lib/auth/twilio";
import {
  requestPlayerOtp,
  verifyPlayerOtp,
  OtpRateLimitError,
  OTP_RATE_LIMIT_MAX_REQUESTS,
  _resetOtpRateLimitForTests,
} from "@/lib/auth/player";
import {
  authorizePlayerOtp,
  tokenFromSignIn,
  sessionFromToken,
} from "@/lib/auth/config";
import { CredentialsSignin } from "next-auth";

const mockedSendOtp = vi.mocked(sendOtp);
const mockedCheckOtp = vi.mocked(checkOtp);

describe.skipIf(!hasTestDatabase())("player phone-OTP auth", () => {
  const db = hasTestDatabase() ? getTestDb() : undefined;

  beforeEach(async () => {
    await resetTestDb(db!);
    _resetOtpRateLimitForTests();
    mockedSendOtp.mockClear();
    mockedCheckOtp.mockClear();
  });

  afterEach(() => {
    mockedSendOtp.mockReset();
    mockedCheckOtp.mockReset();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  describe("requestPlayerOtp", () => {
    it("sends an OTP via Twilio Verify for the given phone", async () => {
      mockedSendOtp.mockResolvedValueOnce(undefined);
      await requestPlayerOtp("+15555550100");
      expect(mockedSendOtp).toHaveBeenCalledTimes(1);
      expect(mockedSendOtp).toHaveBeenCalledWith("+15555550100");
    });

    it("rate-limits repeated requests for the same phone", async () => {
      mockedSendOtp.mockResolvedValue(undefined);
      const phone = "+15555550101";
      for (let i = 0; i < OTP_RATE_LIMIT_MAX_REQUESTS; i++) {
        await requestPlayerOtp(phone);
      }
      await expect(requestPlayerOtp(phone)).rejects.toBeInstanceOf(
        OtpRateLimitError,
      );
      // A different phone number is unaffected by another phone's limit.
      await expect(requestPlayerOtp("+15555550102")).resolves.toBeUndefined();
    });
  });

  describe("request OTP -> verify correct code -> session created with a player_id", () => {
    it("creates a session-ready principal carrying a player_id on a correct code", async () => {
      const phone = "+15555550200";
      mockedSendOtp.mockResolvedValueOnce(undefined);
      await requestPlayerOtp(phone);

      mockedCheckOtp.mockResolvedValueOnce(true);
      const authResult = await authorizePlayerOtp({ phone, code: "123456" });

      expect(authResult.principalType).toBe("player");
      expect(authResult.playerId).toEqual(expect.any(String));
      expect(authResult.id).toBe(authResult.playerId);

      // jwt/session callbacks (extracted, pure — lib/auth/config.ts) project
      // the player identity through exactly as a real sign-in would.
      const token = tokenFromSignIn({}, authResult);
      expect(token).toMatchObject({
        playerId: authResult.playerId,
        principalType: "player",
      });

      const session = sessionFromToken({}, token);
      expect(session).toMatchObject({
        playerId: authResult.playerId,
        principalType: "player",
      });

      // And the player genuinely exists in the DB.
      const rows = await db!
        .select()
        .from(schema.players)
        .where(eq(schema.players.phone, phone));
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

  describe("wrong/expired code", () => {
    it("is rejected — no session, no player row created", async () => {
      const phone = "+15555550300";
      mockedCheckOtp.mockResolvedValueOnce(false);

      await expect(
        authorizePlayerOtp({ phone, code: "000000" }),
      ).rejects.toBeInstanceOf(CredentialsSignin);

      const rows = await db!
        .select()
        .from(schema.players)
        .where(eq(schema.players.phone, phone));
      expect(rows).toHaveLength(0);
    });

    it("verifyPlayerOtp itself returns null (not a session) on a bad code", async () => {
      mockedCheckOtp.mockResolvedValueOnce(false);
      const result = await verifyPlayerOtp("+15555550301", "999999");
      expect(result).toBeNull();
    });
  });

  describe("player identity reuse", () => {
    it("first verify creates exactly one player row; a second verify for the same phone reuses it", async () => {
      const phone = "+15555550400";

      mockedCheckOtp.mockResolvedValueOnce(true);
      const first = await verifyPlayerOtp(phone, "111111");
      expect(first?.isNewPlayer).toBe(true);

      mockedCheckOtp.mockResolvedValueOnce(true);
      const second = await verifyPlayerOtp(phone, "222222");
      expect(second?.isNewPlayer).toBe(false);

      expect(first?.player.id).toBe(second?.player.id);

      const rows = await db!
        .select()
        .from(schema.players)
        .where(eq(schema.players.phone, phone));
      expect(rows).toHaveLength(1);
    });
  });
});
