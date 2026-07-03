/**
 * Public landing page (T5.1 + operator direction) — the front door. No auth to
 * view. Explains the platform for both audiences (canvassers + hosts), shows
 * the live universal map, the live-campaign directory, and a featured
 * leaderboard. Navigation (sign-in links, Map) lives in the global SiteHeader;
 * this page's own CTA links are plain (no `data-testid` — the header owns the
 * `player-login-link`/`staff-login-link` test ids, which must stay single).
 */
import Link from "next/link";
import {
  MapPin,
  Camera,
  DollarSign,
  LayoutGrid,
  Upload,
  Trophy,
} from "lucide-react";
import CampaignDirectory from "@/components/landing/CampaignDirectory";
import UniversalMap from "@/components/map/UniversalMap";
import { getLiveCampaignDirectory } from "@/lib/campaign/directory";
import { getLeaderboardForCampaign } from "@/lib/leaderboard/rank";
import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { Pill } from "@/components/brand/Pill";

const CANVASSER_STEPS = [
  { icon: MapPin, text: "Sign in with your email and join a live campaign." },
  { icon: MapPin, text: "Open the map and claim a red pin near you." },
  {
    icon: Camera,
    text: "Post the flier, then snap a geotagged photo to prove it.",
  },
  {
    icon: DollarSign,
    text: "Get paid per approved flier — the payout rises as you place more.",
  },
];

const HOST_STEPS = [
  { icon: LayoutGrid, text: "Sign in as host/admin and create a campaign." },
  { icon: Upload, text: "Import your target locations (CSV or drop pins)." },
  {
    icon: DollarSign,
    text: "Set the payout tiers, budget cap, and grand prize.",
  },
  {
    icon: Trophy,
    text: "Review fraud-screened submissions and track what's owed.",
  },
];

function Steps({
  steps,
}: {
  steps: { icon: React.ComponentType<{ className?: string }>; text: string }[];
}) {
  return (
    <ol className="flex flex-col gap-3">
      {steps.map((s, i) => (
        <li key={i} className="flex items-start gap-3">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-foreground/15 bg-card font-mono text-xs">
            {i + 1}
          </span>
          <span className="flex items-center gap-2 text-sm">
            <s.icon className="size-4 shrink-0 text-primary" />
            {s.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

export default async function Home() {
  // Featured leaderboard: the first live campaign (best-effort; the landing
  // must still render if there are none or the read fails).
  const live = await getLiveCampaignDirectory().catch(() => []);
  const featured = live[0] ?? null;
  const leaderboard = featured
    ? await getLeaderboardForCampaign(featured.id, null).catch(() => null)
    : null;

  return (
    <main className="flex min-h-screen w-full flex-1 flex-col">
      {/* Hero / intro (above the map) */}
      <section className="border-b-2 border-foreground/15 px-4 py-10 sm:px-6">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-4 text-center">
          <h1 className="font-heading text-3xl font-bold leading-tight sm:text-4xl">
            Post fliers. Drop pins. Get paid.
          </h1>
          <p className="max-w-xl text-muted-foreground">
            Mycofest Canvassing turns street promotion into a game. Campaigns
            put targets on a map; canvassers claim them, post the flier, and
            submit a geotagged photo that&apos;s fraud-screened and paid on a
            rising tier curve. Settlement is manual — the platform just tracks
            what&apos;s owed.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link
              href="/login"
              className={buttonVariants({ variant: "default" })}
            >
              Start canvassing
            </Link>
            <Link
              href="/staff-login"
              className={buttonVariants({ variant: "outline" })}
            >
              Run a campaign
            </Link>
          </div>
        </div>
      </section>

      {/* Live map */}
      <section aria-label="Live map" className="flex flex-col">
        <div className="px-4 pt-6 sm:px-6">
          <h2 className="font-heading text-xl font-bold">Live coverage</h2>
          <p className="text-sm text-muted-foreground">
            Every target across every live campaign. Red = open · amber =
            claimed · green = posted.
          </p>
        </div>
        <UniversalMap />
      </section>

      {/* How it works — both perspectives (below the map) */}
      <section
        aria-label="How it works"
        className="border-t-2 border-foreground/15 px-4 py-10 sm:px-6"
      >
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-6 text-center font-heading text-2xl font-bold">
            How it works
          </h2>
          <div className="grid gap-6 md:grid-cols-2">
            <Card className="border-2 border-foreground/15">
              <CardContent className="flex flex-col gap-4 py-6">
                <div className="flex items-center gap-2">
                  <MapPin className="size-5 text-primary" />
                  <h3 className="font-heading text-lg font-bold">
                    For canvassers
                  </h3>
                </div>
                <Steps steps={CANVASSER_STEPS} />
                <Link
                  href="/login"
                  className={buttonVariants({
                    variant: "default",
                    size: "sm",
                    className: "w-fit",
                  })}
                >
                  Start canvassing
                </Link>
              </CardContent>
            </Card>

            <Card className="border-2 border-foreground/15">
              <CardContent className="flex flex-col gap-4 py-6">
                <div className="flex items-center gap-2">
                  <LayoutGrid className="size-5 text-primary" />
                  <h3 className="font-heading text-lg font-bold">For hosts</h3>
                </div>
                <Steps steps={HOST_STEPS} />
                <Link
                  href="/staff-login"
                  className={buttonVariants({
                    variant: "outline",
                    size: "sm",
                    className: "w-fit",
                  })}
                >
                  Run a campaign
                </Link>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Live campaigns directory */}
      <section
        aria-label="Live campaigns"
        className="flex w-full flex-col items-center gap-4 border-t-2 border-foreground/15 px-4 py-10 sm:px-6"
      >
        <h2 className="font-heading text-2xl font-bold">Live campaigns</h2>
        <CampaignDirectory />
      </section>

      {/* Featured leaderboard */}
      {featured ? (
        <section
          aria-label="Leaderboard"
          className="border-t-2 border-foreground/15 px-4 py-10 sm:px-6"
        >
          <div className="mx-auto max-w-2xl">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-heading text-2xl font-bold">Leaderboard</h2>
                <p className="text-sm text-muted-foreground">
                  Top canvassers · {featured.name}
                </p>
              </div>
              <Link
                href={`/campaigns/${featured.id}/leaderboard`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Full leaderboard
              </Link>
            </div>
            {leaderboard && leaderboard.top.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {leaderboard.top.map((entry) => (
                  <li
                    key={entry.playerId}
                    data-testid="landing-leaderboard-row"
                    className="flex items-center justify-between gap-3 rounded-xl border-2 border-foreground/15 bg-card px-4 py-3"
                  >
                    <Pill>#{entry.rank}</Pill>
                    <span className="font-mono text-sm">
                      {entry.approvedCount} approved
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Card className="border-2 border-foreground/15">
                <CardContent className="py-6 text-center text-sm text-muted-foreground">
                  No approved placements yet — be the first on the board.
                </CardContent>
              </Card>
            )}
          </div>
        </section>
      ) : null}
    </main>
  );
}
