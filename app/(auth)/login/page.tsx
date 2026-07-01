"use client";

/**
 * Player login page (T2.2) — PRD FR-A1: phone-OTP, no password. Two-step
 * form: request a code, then submit phone+code, which calls Auth.js's
 * `player-otp` Credentials provider via `signIn()` (see
 * `lib/auth/config.ts`). All domain logic (rate limiting, Twilio, player
 * creation) lives server-side in `lib/auth/`; this component only calls
 * the two HTTP entry points (constitution §6).
 */
import { useState } from "react";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";

type Step = "phone" | "code";

export default function PlayerLoginPage() {
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/auth/otp/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? "Could not send a code. Try again.");
        return;
      }
      setStep("code");
    } finally {
      setPending(false);
    }
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const result = await signIn("player-otp", {
        phone,
        code,
        redirect: false,
      });
      if (!result || result.error) {
        setError("That code didn't work. Check it and try again.");
        return;
      }
      setSuccess(true);
    } finally {
      setPending(false);
    }
  }

  if (success) {
    return (
      <main className="mx-auto flex max-w-sm flex-1 flex-col justify-center gap-4 p-6">
        <h1 className="text-lg font-semibold">You&apos;re in.</h1>
        <p className="text-sm text-muted-foreground">Logged in as {phone}.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-sm flex-1 flex-col justify-center gap-6 p-6">
      <h1 className="text-lg font-semibold">Player login</h1>

      {step === "phone" ? (
        <form className="flex flex-col gap-3" onSubmit={handleRequestCode}>
          <label className="flex flex-col gap-1 text-sm">
            Phone number
            <input
              type="tel"
              required
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+15555550123"
              className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </label>
          <Button type="submit" disabled={pending}>
            {pending ? "Sending…" : "Send code"}
          </Button>
        </form>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={handleVerifyCode}>
          <p className="text-sm text-muted-foreground">
            Enter the code sent to {phone}.
          </p>
          <label className="flex flex-col gap-1 text-sm">
            Verification code
            <input
              type="text"
              inputMode="numeric"
              required
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </label>
          <Button type="submit" disabled={pending}>
            {pending ? "Verifying…" : "Verify"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setStep("phone")}
            disabled={pending}
          >
            Use a different number
          </Button>
        </form>
      )}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </main>
  );
}
