/**
 * Public landing page (T5.1) — PRD FR-L1/FR-L5: "Public landing page (no
 * login) — platform intro, player login/signup, host/admin login entry.
 * Campaign directory/list beside the map — browse live campaigns, see
 * coverage %, join."
 *
 * Map-first layout (operator direction): the universal aggregate map
 * (T5.2's `components/map/UniversalMap`, the single sanctioned cross-campaign
 * read via `/api/public/pins`) is the primary element — the whole live-pin
 * picture greets a visitor immediately, with a slim header above and the
 * live-campaign directory below. No auth of any kind (anti-requirement: "do
 * NOT require auth to view the landing"); this page carries no domain logic
 * (constitution §6). The player/staff sign-in links stay first in DOM so the
 * keyboard-focus order (and the a11y test) lands on the player link first.
 *
 * NOTE: the visual Mapbox tiles require `NEXT_PUBLIC_MAPBOX_TOKEN`; without
 * it, `UniversalMap` degrades to a keyboard-operable pin list (same fallback
 * as `/map`).
 */
import CampaignDirectory from "@/components/landing/CampaignDirectory";
import UniversalMap from "@/components/map/UniversalMap";

export default function Home() {
  return (
    <main className="flex min-h-screen w-full flex-1 flex-col">
      {/* Navigation (sign-in links, Map) lives in the global SiteHeader
          (app/layout.tsx). This slim strip is just the landing's title. */}
      <div className="flex flex-col gap-0.5 px-4 py-3 sm:px-6">
        <h1 className="text-lg font-semibold leading-tight">
          Flier Canvassing Platform
        </h1>
        <p className="text-xs text-muted-foreground">
          Claim a target, post a flier, snap a geotagged photo — get paid.
        </p>
      </div>

      {/* The live map is the landing: all campaigns' pins, front and center. */}
      <section
        aria-label="Live map"
        className="flex min-h-[62vh] flex-1 flex-col"
      >
        <UniversalMap />
      </section>

      <section
        aria-label="Live campaigns"
        className="flex w-full flex-col items-center gap-4 border-t border-input px-4 py-8 sm:px-6"
      >
        <h2 className="text-xl font-semibold">Live campaigns</h2>
        <CampaignDirectory />
      </section>
    </main>
  );
}
