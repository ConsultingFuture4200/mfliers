/**
 * POST /api/auth/otp/request — requests a fresh email one-time-code for an
 * email address (ADR-0003). Thin route handler; the actual code generation,
 * hashing, storage, send, and rate-limit logic lives in `lib/auth/player.ts`
 * (constitution §6: domain logic in `lib/`, never in route handlers). The
 * code itself is delivered only by email and is never included in this
 * response.
 */
import { NextResponse } from "next/server";
import {
  requestPlayerOtp,
  OtpRateLimitError,
  InvalidEmailError,
} from "@/lib/auth/player";

interface RequestOtpBody {
  email?: unknown;
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

  const email = body.email;
  if (typeof email !== "string" || email.trim().length === 0) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_email",
          message: "A non-empty `email` string is required.",
        },
      },
      { status: 400 },
    );
  }

  try {
    await requestPlayerOtp(email);
  } catch (err) {
    if (err instanceof InvalidEmailError) {
      return NextResponse.json(
        { error: { code: "invalid_email", message: err.message } },
        { status: 400 },
      );
    }
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
    // A genuine email-provider/upstream failure — never leak upstream error
    // detail (may include account-level info) to the client.
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
