/**
 * Global site header — on every page (rendered in the root layout). Auth-aware
 * server component: reads the Auth.js session, resolves a role, and delegates
 * the interactive menu to the client `HeaderNav`. Logged-out sign-in/map entry
 * points stay directly visible (the e2e suite depends on them).
 */
import Link from "next/link";
import { auth } from "@/lib/auth/config";
import { Logo } from "@/components/brand/Logo";
import { HeaderNav, type Role } from "./HeaderNav";

export default async function SiteHeader() {
  const session = await auth();
  const role: Role =
    session?.principalType === "player"
      ? "player"
      : session?.principalType === "site_admin"
        ? "site_admin"
        : session?.principalType === "host"
          ? "host"
          : null;

  return (
    <header className="sticky top-0 z-50 flex items-center justify-between gap-3 border-b-2 border-foreground/15 bg-background/85 px-4 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-6">
      <Link href="/" aria-label="Mycofest home">
        <Logo />
      </Link>
      <HeaderNav role={role} />
    </header>
  );
}
