/**
 * Global site header — appears on every page (rendered in the root layout)
 * so there's always a way to navigate. Auth-aware server component: reads the
 * Auth.js session and shows sign-in links when logged out, or the principal +
 * a sign-out control when logged in.
 *
 * Carries the `player-login-link` / `staff-login-link` / `universal-map-link`
 * entry points (previously inline on the landing page) so they're reachable
 * from anywhere. No domain logic here (constitution §6) — just the session
 * read and navigation.
 */
import Link from "next/link";
import { auth } from "@/lib/auth/config";
import { buttonVariants } from "@/components/ui/button";
import SignOutButton from "./SignOutButton";

export default async function SiteHeader() {
  const session = await auth();
  const principalType = session?.principalType;
  const signedIn = principalType != null;
  const label =
    principalType === "player"
      ? "Player"
      : principalType === "site_admin"
        ? "Site admin"
        : principalType === "host"
          ? "Host"
          : null;

  return (
    <header className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-3 border-b border-input bg-background/95 px-4 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-6">
      <Link href="/" className="text-sm font-semibold">
        Flier Canvassing
      </Link>
      <nav
        aria-label="Primary"
        className="flex flex-wrap items-center gap-2 text-sm"
      >
        <Link
          href="/map"
          data-testid="universal-map-link"
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          Map
        </Link>
        {signedIn ? (
          <>
            <span className="text-xs text-muted-foreground" aria-live="polite">
              Signed in{label ? ` · ${label}` : ""}
            </span>
            <SignOutButton />
          </>
        ) : (
          <>
            <Link
              href="/login"
              data-testid="player-login-link"
              className={buttonVariants({ variant: "default", size: "sm" })}
            >
              Player sign in
            </Link>
            <Link
              href="/staff-login"
              data-testid="staff-login-link"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Host / admin sign in
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}
