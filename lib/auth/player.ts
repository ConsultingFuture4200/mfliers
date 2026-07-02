/**
 * Player email one-time-code (OTP) domain logic (ADR-0003; supersedes the
 * phone-OTP flow from T2.2, PRD FR-A1/FR-A3). Constitution §6: this is the
 * single place the OTP login flow lives — `app/api/auth/otp/*` route
 * handlers and the Auth.js Credentials provider (`lib/auth/config.ts`) are
 * thin callers into `requestPlayerOtp`/`verifyPlayerOtp`.
 *
 * Design intent (ADR-0003): email address -> a 6-digit code is generated
 * server-side, its HASH is stored (`player_email_otp`, never the plaintext),
 * and the code is emailed via a provider-agnostic sender (`lib/auth/email.ts`).
 * The user enters the code -> on a correct, unexpired, under-cap code, a
 * global `players` row is created on first success and reused thereafter
 * (`lib/db/dal/players.ts`).
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { sendOtpEmail } from "./email";
import {
  createEmailOtp,
  getLatestActiveOtp,
  incrementOtpAttempts,
  consumeOtpIfActive,
} from "@/lib/db/dal/email-otp";
import { getOrCreatePlayerByEmail } from "@/lib/db/dal/players";
import type { Player } from "@/types/domain";

/** Thrown by `requestPlayerOtp` when an email has exceeded the send rate
 * limit — the "basic rate-limiting / lockout" the flow requires. */
export class OtpRateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super("Too many OTP requests for this email address. Try again later.");
    this.name = "OtpRateLimitError";
  }
}

/** Thrown by `requestPlayerOtp` when the supplied email is malformed. */
export class InvalidEmailError extends Error {
  constructor() {
    super("A valid email address is required.");
    this.name = "InvalidEmailError";
  }
}

/** Max OTP sends allowed per email within `OTP_RATE_LIMIT_WINDOW_MS`. */
export const OTP_RATE_LIMIT_MAX_REQUESTS = 5;
/** Sliding window for the OTP send rate limit, in milliseconds (15 minutes). */
export const OTP_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
/** How long a generated code stays valid, in milliseconds (10 minutes). */
export const OTP_TTL_MS = 10 * 60 * 1000;
/** Max wrong-code verifications allowed against a single code before it is
 * treated as spent (defends the small 6-digit code space against guessing). */
export const OTP_MAX_VERIFY_ATTEMPTS = 5;

// Pragmatic email shape check — full RFC 5322 validation is out of scope and
// the real deliverability test is whether the emailed code arrives.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trims and lowercases an email so it is a stable identity key. Throws
 * `InvalidEmailError` if it does not look like an email. */
export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) throw new InvalidEmailError();
  return normalized;
}

/**
 * Hashes a code for storage/comparison. HMAC-SHA256 keyed by `AUTH_SECRET`
 * (throws if unset — an empty key would be guessable) and bound to the
 * normalized email, so a stored hash reveals neither the code nor matches a
 * bare code hash. Constitution §5: the plaintext code is never persisted.
 */
export function hashOtpCode(email: string, code: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    // A deterministic empty-string HMAC key is guessable — anyone could
    // precompute the hash of all 1,000,000 codes for a target email. Fail
    // loudly rather than silently degrade to a crackable digest (Linus review;
    // constitution §8 — secrets must be present, not absent). Auth.js also
    // requires AUTH_SECRET, so this only guards local/CI misconfiguration.
    throw new Error("AUTH_SECRET is required to hash OTP codes");
  }
  return createHmac("sha256", secret).update(`${email}:${code}`).digest("hex");
}

/** Generates a zero-padded 6-digit code from a CSPRNG. */
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * In-memory sliding-window request log, keyed by email address.
 *
 * NEEDS_CLARIFICATION: this is process-local state, so it resets on cold
 * start and doesn't share a limit across multiple serverless instances. This
 * is a deliberately lightweight first line of defense; a distributed limiter
 * (e.g. Redis/Upstash) would be needed to make it authoritative across
 * instances — flagging rather than guessing whether that's in scope.
 */
const sendLog = new Map<string, number[]>();

/** Test-only: clears the in-memory rate-limit state between test cases. */
export function _resetOtpRateLimitForTests(): void {
  sendLog.clear();
}

function checkAndRecordRateLimit(email: string, now: number): void {
  const recent = (sendLog.get(email) ?? []).filter(
    (ts) => now - ts < OTP_RATE_LIMIT_WINDOW_MS,
  );
  if (recent.length >= OTP_RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterMs = OTP_RATE_LIMIT_WINDOW_MS - (now - recent[0]);
    throw new OtpRateLimitError(retryAfterMs);
  }
  recent.push(now);
  sendLog.set(email, recent);
}

/**
 * Requests a fresh OTP for `email`, subject to the send-rate limit. Generates
 * a 6-digit code, stores its hash + expiry in `player_email_otp`, and emails
 * it via `lib/auth/email.ts`. Throws `InvalidEmailError` on a malformed
 * address, `OtpRateLimitError` when the email has sent too many requests
 * recently, or whatever `sendOtpEmail` throws on a genuine provider failure.
 */
export async function requestPlayerOtp(email: string): Promise<void> {
  const normalized = normalizeEmail(email);
  checkAndRecordRateLimit(normalized, Date.now());

  const code = generateCode();
  await createEmailOtp({
    email: normalized,
    codeHash: hashOtpCode(normalized, code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });
  await sendOtpEmail(normalized, code);
}

export interface VerifyPlayerOtpResult {
  player: Player;
  isNewPlayer: boolean;
}

/**
 * Verifies `code` for `email` against the latest active OTP record. On a
 * correct, unexpired, under-cap code: marks the code consumed, then gets or
 * creates the global player row and returns it. On a wrong/expired/over-cap
 * code: returns `null` — no session, no player mutation. Each wrong attempt
 * increments the record's attempts counter; once the cap is reached the code
 * is spent. Never throws for an incorrect code.
 */
export async function verifyPlayerOtp(
  email: string,
  code: string,
): Promise<VerifyPlayerOtpResult | null> {
  // Loose normalization here (no validation throw): a malformed email simply
  // matches no active record and yields `null`, keeping "never throws for an
  // incorrect code". The stored record's email was already validated at
  // request time.
  const normalized = email.trim().toLowerCase();

  const record = await getLatestActiveOtp(normalized);
  if (!record) return null;

  // Over the attempts cap — treat the code as spent, no further comparison.
  if (record.attempts >= OTP_MAX_VERIFY_ATTEMPTS) return null;

  const expected = Buffer.from(record.codeHash, "hex");
  const actual = Buffer.from(hashOtpCode(normalized, code), "hex");
  // Constant-time compare (both are fixed-length HMAC digests) to avoid a
  // timing side-channel on the hash comparison (Linus review).
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    await incrementOtpAttempts(record.id);
    return null;
  }

  // Atomic single-use gate: only the racer whose UPDATE actually flips
  // consumed_at from NULL wins. Concurrent verifies of the same valid code
  // all pass the hash check above, but only ONE consumes the row — the rest
  // get null here and must NOT authenticate (prevents replay → N sessions).
  const consumed = await consumeOtpIfActive(record.id);
  if (!consumed) return null;

  return getOrCreatePlayerByEmail(normalized);
}
