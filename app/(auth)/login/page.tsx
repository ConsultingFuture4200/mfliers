"use client";

/**
 * Player login page (ADR-0003) — email one-time-code, no password. Two-step
 * form: request a code, then submit email+code, which calls Auth.js's
 * `player-otp` Credentials provider via `signIn()` (see `lib/auth/config.ts`).
 * All domain logic (rate limiting, code generation/send, player creation)
 * lives server-side in `lib/auth/`; this component only calls the two HTTP
 * entry points (constitution §6).
 */
import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/brand/Logo";

type Step = "email" | "code";

/**
 * Returns a safe internal redirect target from `?callbackUrl=`, defaulting to
 * the landing page. Only same-origin relative paths are honored (must start
 * with a single "/" — rejects "//host" and absolute URLs) to avoid an
 * open-redirect through the login flow.
 */
function safeCallbackUrl(): string {
  if (typeof window === "undefined") return "/";
  const raw = new URLSearchParams(window.location.search).get("callbackUrl");
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/";
}

export default function PlayerLoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
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
        body: JSON.stringify({ email }),
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
        email,
        code,
        redirect: false,
      });
      if (!result || result.error) {
        setError("That code didn't work. Check it and try again.");
        return;
      }
      setSuccess(true);
      // Land the player somewhere useful (where they came from, or the
      // campaign directory) instead of a dead-end confirmation. refresh()
      // re-runs Server Components so the new session is reflected.
      const dest = safeCallbackUrl();
      router.replace(dest);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  if (success) {
    return (
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 p-6">
        <div className="flex justify-center">
          <Logo />
        </div>
        <Card className="rounded-2xl border-2 border-foreground/15">
          <CardHeader>
            <h1 className="font-heading text-xl font-semibold">
              You&apos;re in.
            </h1>
            <CardDescription>
              Logged in as {email}. Taking you to the campaigns…
            </CardDescription>
          </CardHeader>
          <CardContent>
            <a
              href={safeCallbackUrl()}
              className="text-sm text-primary underline underline-offset-4"
            >
              Continue
            </a>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 p-6">
      <div className="flex justify-center">
        <Logo />
      </div>
      <Card className="rounded-2xl border-2 border-foreground/15">
        <CardHeader>
          <h1 className="font-heading text-xl font-semibold">Player login</h1>
          <CardDescription>Sign in with a one-time code.</CardDescription>
        </CardHeader>
        <CardContent>
          {step === "email" ? (
            <form className="flex flex-col gap-4" onSubmit={handleRequestCode}>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              <Button type="submit" className="w-full" disabled={pending}>
                {pending ? "Sending…" : "Send code"}
              </Button>
            </form>
          ) : (
            <form className="flex flex-col gap-4" onSubmit={handleVerifyCode}>
              <p className="text-sm text-muted-foreground">
                Enter the code sent to {email}.
              </p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="code">Verification code</Label>
                <Input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  required
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </div>
              <Button type="submit" className="w-full" disabled={pending}>
                {pending ? "Verifying…" : "Verify"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => setStep("email")}
                disabled={pending}
              >
                Use a different email
              </Button>
            </form>
          )}

          {error ? (
            <p className="mt-4 text-sm text-destructive">{error}</p>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
