/**
 * POST /api/auth/otp/request — requests a fresh Twilio Verify OTP for a
 * phone number (T2.2). Thin route handler; the actual send + rate-limit
 * logic lives in `lib/auth/player.ts` (constitution §6: domain logic in
 * `lib/`, never in route handlers).
 */
import { NextResponse } from "next/server";
import { requestPlayerOtp, OtpRateLimitError } from "@/lib/auth/player";

interface RequestOtpBody {
  phone?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  let body: RequestOtpBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "bad_request", message: "Invalid JSON body." } },
      { status: 400 },
    );
  }

  const phone = body.phone;
  if (typeof phone !== "string" || phone.trim().length === 0) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_phone",
          message: "A non-empty `phone` string is required.",
        },
      },
      { status: 400 },
    );
  }

  try {
    await requestPlayerOtp(phone);
  } catch (err) {
    if (err instanceof OtpRateLimitError) {
      return NextResponse.json(
        { error: { code: "rate_limited", message: err.message } },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(err.retryAfterMs / 1000)),
          },
        },
      );
    }
    // A genuine Twilio/upstream failure — never leak upstream error detail
    // (may include account-level info) to the client.
    return NextResponse.json(
      {
        error: {
          code: "otp_send_failed",
          message: "Could not send verification code. Try again shortly.",
        },
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}
