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
      <main className="mx-auto flex max-w-sm flex-1 flex-col justify-center gap-4 p-6">
        <h1 className="text-lg font-semibold">You&apos;re in.</h1>
        <p className="text-sm text-muted-foreground">Logged in as {email}.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-sm flex-1 flex-col justify-center gap-6 p-6">
      <h1 className="text-lg font-semibold">Host / admin login</h1>

      <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </label>
        <Button type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </main>
  );
}
