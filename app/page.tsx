/**
 * Public landing page (T5.1) — PRD FR-L1/FR-L5: "Public landing page (no
 * login) — platform intro, player login/signup, host/admin login entry.
 * Campaign directory/list beside the map — browse live campaigns, see
 * coverage %, join."
 *
 * No auth check of any kind here — the whole page is public (anti-
 * requirement: "do NOT require auth to view the landing"). Player login
 * (`/login`, T2.2) and staff login (`/staff-login`, T2.3) are plain links;
 * the live-campaign directory (with its own "Join" action) is the
 * self-contained client component `components/landing/CampaignDirectory`
 * (constitution §6 — this page carries no domain logic itself).
 *
 * The universal aggregate map is T5.2's own card
 * (`docs/tasks/batch-5.md`), which doesn't exist in the tree yet as of
 * this card (T5.1 depends only on T4.4, not T5.2). Per this requirement's
 * own wording ("Link/embed"), this links to `/map` — T5.2's stated route
 * — rather than embedding a component that doesn't exist yet.
 */
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import CampaignDirectory from "@/components/landing/CampaignDirectory";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-1 flex-col items-center gap-10 p-6 sm:p-10">
      <header className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-3xl font-semibold">Flier Canvassing Platform</h1>
        <p className="max-w-xl text-muted-foreground">
          Claim a target, post a flier, snap a geotagged photo — get paid.
          Browse the live campaigns below or sign in to start canvassing.
        </p>
        <nav
          aria-label="Sign in"
          className="flex flex-wrap justify-center gap-3"
        >
          <Link
            href="/login"
            data-testid="player-login-link"
            className={buttonVariants({ variant: "default" })}
          >
            Player sign in
          </Link>
          <Link
            href="/staff-login"
            data-testid="staff-login-link"
            className={buttonVariants({ variant: "outline" })}
          >
            Host / admin sign in
          </Link>
          <Link
            href="/map"
            data-testid="universal-map-link"
            className={buttonVariants({ variant: "ghost" })}
          >
            View the live map
          </Link>
        </nav>
      </header>

      <section
        aria-label="Live campaigns"
        className="flex w-full flex-col items-center gap-4"
      >
        <h2 className="text-xl font-semibold">Live campaigns</h2>
        <CampaignDirectory />
      </section>
    </main>
  );
}
