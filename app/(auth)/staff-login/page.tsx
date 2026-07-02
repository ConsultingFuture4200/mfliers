"use client";

/**
 * Host/admin login page (T2.3) — PRD FR-A2: email + password, distinct
 * from the player login (`app/(auth)/login/page.tsx`, phone-OTP). Calls
 * Auth.js's `staff-credentials` Credentials provider via `signIn()` (see
 * `lib/auth/config.ts`). All domain logic (password verification, role
 * resolution) lives server-side in `lib/auth/staff.ts`; this component
 * only calls the one Auth.js entry point (constitution §6).
 */
import { useState } from "react";
import { signIn } from "next-auth/react";
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

export default function StaffLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const result = await signIn("staff-credentials", {
        email,
        password,
        redirect: false,
      });
      if (!result || result.error) {
        setError("Incorrect email or password.");
        return;
      }
      setSuccess(true);
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
            <CardDescription>Logged in as {email}.</CardDescription>
          </CardHeader>
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
          <h1 className="font-heading text-xl font-semibold">
            Host / admin login
          </h1>
          <CardDescription>
            Sign in with your email and password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? "Signing in…" : "Sign in"}
            </Button>
          </form>

          {error ? (
            <p className="mt-4 text-sm text-destructive">{error}</p>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
