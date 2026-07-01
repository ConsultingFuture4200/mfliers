/**
 * Player phone-OTP domain logic (T2.2) — PRD FR-A1/FR-A3, constitution §2.
 *
 * This is the one place the OTP login flow lives; `app/api/auth/otp/*`
 * route handlers and the Auth.js Credentials provider (`lib/auth/config.ts`)
 * are thin callers into `requestPlayerOtp`/`verifyPlayerOtp` — per
 * constitution §3/§6, domain logic lives in `lib/`, never in route
 * handlers.
 *
 * Design intent (card): phone number -> Twilio Verify sends a code -> user
 * enters it -> on a correct code, a global `players` row is created on
 * first success and reused thereafter (`lib/db/dal/players.ts`).
 */
import { sendOtp, checkOtp } from "./twilio";
import { getOrCreatePlayerByPhone } from "@/lib/db/dal/players";
import type { Player } from "@/types/domain";

/** Thrown by `requestPlayerOtp` when a phone has exceeded the send rate
 * limit — the "basic rate-limiting / lockout" the card requires. */
export class OtpRateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super("Too many OTP requests for this phone number. Try again later.");
    this.name = "OtpRateLimitError";
  }
}

/** Max OTP sends allowed per phone number within `OTP_RATE_LIMIT_WINDOW_MS`. */
export const OTP_RATE_LIMIT_MAX_REQUESTS = 5;
/** Sliding window for the OTP send rate limit, in milliseconds (15 minutes). */
export const OTP_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * In-memory sliding-window request log, keyed by phone number.
 *
 * NEEDS_CLARIFICATION: this is process-local state, so it resets on cold
 * start and doesn't share a limit across multiple serverless instances.
 * The card only asks for "basic rate-limiting / lockout" and Twilio Verify
 * itself also enforces its own send-rate guards server-side, so this is a
 * deliberately lightweight first line of defense, not the sole control.
 * A distributed limiter (e.g. Redis/Upstash) would be needed to make this
 * authoritative across instances — flagging rather than guessing whether
 * that's in scope for a later task.
 */
const sendLog = new Map<string, number[]>();

/** Test-only: clears the in-memory rate-limit state between test cases. */
export function _resetOtpRateLimitForTests(): void {
  sendLog.clear();
}

function checkAndRecordRateLimit(phone: string, now: number): void {
  const recent = (sendLog.get(phone) ?? []).filter(
    (ts) => now - ts < OTP_RATE_LIMIT_WINDOW_MS,
  );
  if (recent.length >= OTP_RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterMs = OTP_RATE_LIMIT_WINDOW_MS - (now - recent[0]);
    throw new OtpRateLimitError(retryAfterMs);
  }
  recent.push(now);
  sendLog.set(phone, recent);
}

/**
 * Requests a fresh OTP for `phone` via Twilio Verify, subject to the
 * send-rate limit. Throws `OtpRateLimitError` if the phone has sent too
 * many requests recently; otherwise throws whatever `sendOtp` throws on a
 * genuine Twilio API failure.
 */
export async function requestPlayerOtp(phone: string): Promise<void> {
  checkAndRecordRateLimit(phone, Date.now());
  await sendOtp(phone);
}

export interface VerifyPlayerOtpResult {
  player: Player;
  isNewPlayer: boolean;
}

/**
 * Verifies `code` for `phone` against Twilio Verify. On success, gets or
 * creates the global player row and returns it. On a wrong/expired code,
 * returns `null` — no session, no player mutation. Never throws for an
 * incorrect code; only for a genuine upstream (Twilio) failure.
 */
export async function verifyPlayerOtp(
  phone: string,
  code: string,
): Promise<VerifyPlayerOtpResult | null> {
  const approved = await checkOtp(phone, code);
  if (!approved) return null;
  return getOrCreatePlayerByPhone(phone);
}
