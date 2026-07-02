/**
 * Admin landing (`/admin`) — site-admin-only. Lists live campaigns with links
 * to manage each campaign's targets (CSV import / pin-drop) and its review
 * queue. Server-guarded: redirects non-admins to staff login.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/config";
import { getLiveCampaignDirectory } from "@/lib/campaign/directory";
import { PageShell } from "@/components/brand/PageShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { Pill } from "@/components/brand/Pill";

export default async function AdminHome() {
  const session = await auth();
  if (session?.principalType !== "site_admin") {
    redirect("/staff-login");
  }

  const campaigns = await getLiveCampaignDirectory();

  return (
    <PageShell
      title="Admin"
      description="Manage live campaigns, targets, and review."
      width="lg"
    >
      {campaigns.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No live campaigns yet. Seed or activate a campaign to get started.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {campaigns.map((c) => (
            <Card key={c.id} className="border-2 border-foreground/15">
              <CardHeader className="flex-row items-center justify-between gap-2">
                <CardTitle className="font-heading">{c.name}</CardTitle>
                <Pill>{c.coveragePercent}% covered</Pill>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Link
                  href={`/admin/campaigns/${c.id}/targets`}
                  className={buttonVariants({ variant: "default", size: "sm" })}
                >
                  Manage targets
                </Link>
                <Link
                  href={`/host/campaigns/${c.id}/review`}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Review queue
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </PageShell>
  );
}
