/**
 * Provider-agnostic OTP email sender (ADR-0003).
 *
 * Replaces the Twilio Verify SMS path for player login. The transport is
 * resolved from environment variables **at call time** (not import time), so
 * the same build runs against Resend, SMTP, or a no-credentials dev fallback
 * depending only on which env vars are present:
 *
 *   1. `RESEND_API_KEY` (+ `EMAIL_FROM`)  -> POST to Resend's REST API via
 *      `fetch` (no SDK dependency).
 *   2. else `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` (+ `EMAIL_FROM`)
 *      -> send via `nodemailer`.
 *   3. else (no credentials) -> LOG the code server-side (info) and return
 *      success, so the whole login flow is testable without any provider.
 *
 * Security (constitution §5/§8): every credential is read from `process.env`
 * only, this module is server-only (never imported by a client component),
 * and the plaintext `code` is NEVER returned to a caller, put in an HTTP
 * response, or logged anywhere except the deliberate dev-fallback below.
 */

/** How `sendOtpEmail` will deliver the code, resolved fresh from env. */
export type EmailTransport =
  | { kind: "resend"; apiKey: string; from: string }
  | {
      kind: "smtp";
      from: string;
      host: string;
      port: number;
      user: string;
      pass: string;
    }
  | { kind: "log" };

/**
 * Resolves the active email transport from the current environment. Exported
 * so the resolution logic is unit-testable and self-documenting; callers
 * normally just use `sendOtpEmail`.
 */
export function resolveEmailTransport(): EmailTransport {
  const from = process.env.EMAIL_FROM;

  if (process.env.RESEND_API_KEY && from) {
    return { kind: "resend", apiKey: process.env.RESEND_API_KEY, from };
  }

  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (host && port && user && pass && from) {
    return { kind: "smtp", from, host, port: Number(port), user, pass };
  }

  return { kind: "log" };
}

const SUBJECT = "Your login code";

function bodyText(code: string): string {
  return `Your login code is ${code}. It expires in 10 minutes.`;
}

async function sendViaResend(
  transport: Extract<EmailTransport, { kind: "resend" }>,
  email: string,
  code: string,
): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${transport.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: transport.from,
      to: email,
      subject: SUBJECT,
      text: bodyText(code),
    }),
  });
  if (!res.ok) {
    // Never surface the upstream body (may echo the code/recipient) — the
    // caller only needs to know the send failed.
    throw new Error(`Resend email send failed with status ${res.status}`);
  }
}

async function sendViaSmtp(
  transport: Extract<EmailTransport, { kind: "smtp" }>,
  email: string,
  code: string,
): Promise<void> {
  // Dynamic import so `nodemailer` is only loaded when the SMTP transport is
  // actually selected (matches the lazy-client pattern used elsewhere; keeps
  // it out of a build that never sends over SMTP).
  const nodemailer = await import("nodemailer");
  const smtp = nodemailer.createTransport({
    host: transport.host,
    port: transport.port,
    secure: transport.port === 465,
    auth: { user: transport.user, pass: transport.pass },
  });
  await smtp.sendMail({
    from: transport.from,
    to: email,
    subject: SUBJECT,
    text: bodyText(code),
  });
}

/**
 * Sends the 6-digit login `code` to `email` over the resolved transport.
 * Resolves on success; rejects only on a genuine provider/transport failure
 * (the caller maps that to a 502-class response). The dev-fallback ("log")
 * transport is the ONE place the plaintext code is written to a log — every
 * other path keeps it out of persisted state and responses.
 */
export async function sendOtpEmail(email: string, code: string): Promise<void> {
  const transport = resolveEmailTransport();
  switch (transport.kind) {
    case "resend":
      return sendViaResend(transport, email, code);
    case "smtp":
      return sendViaSmtp(transport, email, code);
    case "log":
      // Deliberate dev fallback (no provider configured): structured info log
      // so the flow is fully exercisable without credentials.
      console.info(
        JSON.stringify({
          level: "info",
          msg: "player OTP email (dev fallback — no provider configured)",
          email,
          code,
        }),
      );
      return;
  }
}
