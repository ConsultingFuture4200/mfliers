"use client";

/**
 * Role-aware header navigation.
 *
 * Logged OUT: the sign-in + map entry points render inline and visible on all
 * viewports (single DOM instance each) — the e2e suite clicks
 * `player-login-link` / `staff-login-link` and reads `universal-map-link`'s
 * href, so they must not be hidden behind a menu.
 *
 * Logged IN: primary links inline on desktop, everything in a hamburger Sheet
 * on mobile, plus a role-specific account dropdown. (No test constraints here.)
 */
import Link from "next/link";
import { useState } from "react";
import {
  Menu,
  Map as MapIcon,
  LayoutGrid,
  Trophy,
  ClipboardCheck,
  Settings,
  User,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { ThemeToggle } from "./ThemeToggle";
import SignOutButton from "./SignOutButton";

export type Role = "player" | "site_admin" | "host" | null;

interface NavLink {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

function linksFor(role: Role): NavLink[] {
  const base: NavLink[] = [
    { href: "/map", label: "Map", icon: MapIcon },
    { href: "/campaigns", label: "Campaigns", icon: LayoutGrid },
  ];
  if (role === "host") {
    return [
      ...base,
      { href: "/host", label: "Review queue", icon: ClipboardCheck },
    ];
  }
  if (role === "site_admin") {
    return [
      ...base,
      { href: "/host", label: "Review queue", icon: ClipboardCheck },
      { href: "/admin", label: "Admin", icon: Settings },
    ];
  }
  // player
  return base;
}

const roleLabel: Record<Exclude<Role, null>, string> = {
  player: "Player",
  site_admin: "Site admin",
  host: "Host",
};

export function HeaderNav({ role }: { role: Role }) {
  const [open, setOpen] = useState(false);

  if (role === null) {
    return (
      <nav
        aria-label="Primary"
        className="flex flex-wrap items-center justify-end gap-2"
      >
        <Link
          href="/map"
          data-testid="universal-map-link"
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          Map
        </Link>
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
        <ThemeToggle />
      </nav>
    );
  }

  const links = linksFor(role);

  return (
    <div className="flex items-center gap-2">
      {/* Desktop inline primary links */}
      <nav aria-label="Primary" className="hidden items-center gap-1 sm:flex">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            {l.label}
          </Link>
        ))}
      </nav>

      <ThemeToggle />

      {/* Desktop account dropdown (base-nova = Base UI: style the trigger
          directly and use `render` for link items — no `asChild`). */}
      <div className="hidden sm:block">
        <DropdownMenu>
          <DropdownMenuTrigger
            data-testid="account-menu"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <User className="size-4" />
            {roleLabel[role]}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>Signed in · {roleLabel[role]}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {role === "player" ? (
              <DropdownMenuItem render={<Link href="/campaigns" />}>
                <Trophy className="size-4" /> My campaigns
              </DropdownMenuItem>
            ) : null}
            {links.map((l) => (
              <DropdownMenuItem key={l.href} render={<Link href={l.href} />}>
                <l.icon className="size-4" /> {l.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <div className="p-1">
              <SignOutButton />
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Mobile hamburger sheet */}
      <div className="sm:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger
            aria-label="Open menu"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <Menu className="size-4" />
          </SheetTrigger>
          <SheetContent side="right" className="w-72">
            <SheetHeader>
              <SheetTitle>Signed in · {roleLabel[role]}</SheetTitle>
            </SheetHeader>
            <nav className="flex flex-col gap-1 px-4">
              {links.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className={buttonVariants({
                    variant: "ghost",
                    size: "sm",
                    className: "justify-start",
                  })}
                >
                  <l.icon className="size-4" /> {l.label}
                </Link>
              ))}
              <div className="mt-2">
                <SignOutButton />
              </div>
            </nav>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}
