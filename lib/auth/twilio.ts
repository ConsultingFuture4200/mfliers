/**
 * Twilio Verify client (T2.2) — PRD FR-A1, constitution §2 (auth provider:
 * Auth.js + Twilio Verify).
 *
 * Thin wrapper around the Twilio SDK's Verify API. `sendOtp`/`checkOtp` are
 * the only two operations this module exposes, matching Verify's own
 * two-step API (start a verification, check a code) — deliberately NOT a
 * generic Twilio client, so there's one obvious place OTP logic lives.
 *
 * Anti-requirement: "do NOT store OTP codes in plaintext in the DB — rely
 * on Twilio Verify's own verification." This module never persists a code
 * anywhere; Twilio Verify holds and validates it server-side on Twilio's
 * infrastructure, and `checkOtp` returns only a boolean-ish status.
 *
 * Secrets (constitution §5, §8): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
 * `TWILIO_VERIFY_SERVICE_SID` are read from `process.env` only, inside
 * server-only modules (this file is never imported by a client component).
 * The Twilio client is constructed lazily so importing this module doesn't
 * throw in contexts where the env vars aren't set yet (e.g. `pnpm build`'s
 * static analysis pass), and so tests can `vi.mock("twilio")` before the
 * first call constructs it.
 */
import Twilio from "twilio";

export type VerificationChannel = "sms";

let cachedClient: ReturnType<typeof Twilio> | undefined;

function getClient(): ReturnType<typeof Twilio> {
  if (cachedClient) return cachedClient;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error(
      "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required (env only — " +
        "constitution §5/§8). See .env.example.",
    );
  }
  cachedClient = Twilio(accountSid, authToken);
  return cachedClient;
}

function getVerifyServiceSid(): string {
  const sid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!sid) {
    throw new Error(
      "TWILIO_VERIFY_SERVICE_SID is required (env only). See .env.example.",
    );
  }
  return sid;
}

/** Starts a Verify OTP send to `phone` over SMS. Throws on Twilio API error. */
export async function sendOtp(phone: string): Promise<void> {
  const client = getClient();
  await client.verify.v2
    .services(getVerifyServiceSid())
    .verifications.create({ to: phone, channel: "sms" });
}

/**
 * Checks `code` against the most recent pending verification for `phone`.
 * Returns `true` only when Twilio reports the verification `status` as
 * `"approved"` — any other status (wrong code, expired, already consumed)
 * returns `false` rather than throwing, since "wrong code" is an expected,
 * non-exceptional outcome the caller must handle (reject the login
 * attempt), not a system error.
 */
export async function checkOtp(phone: string, code: string): Promise<boolean> {
  const client = getClient();
  try {
    const check = await client.verify.v2
      .services(getVerifyServiceSid())
      .verificationChecks.create({ to: phone, code });
    return check.status === "approved";
  } catch (err: unknown) {
    // Twilio returns a 404 (resource not found) when there's no pending
    // verification to check (expired / never started / already consumed) —
    // treat that as "not approved" rather than a hard failure.
    const status = (err as { status?: number } | undefined)?.status;
    if (status === 404) return false;
    throw err;
  }
}
