/**
 * Review landing (`/host`) — campaigns the signed-in staff member can review,
 * linking into each campaign's review queue. Server-guarded: staff only. A host
 * sees only its scoped campaigns; a site admin (platform-wide) sees all live
 * campaigns (constitution §5).
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/config";
import { resolveStaffPrincipal } from "@/lib/auth/staff";
import { getCampaignById } from "@/lib/db/dal/campaigns";
import { getLiveCampaignDirectory } from "@/lib/campaign/directory";
import { PageShell } from "@/components/brand/PageShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";

export default async function HostHome() {
  const session = await auth();
  const isAdmin = session?.principalType === "site_admin";
  if (!session?.userId || (session.principalType !== "host" && !isAdmin)) {
    redirect("/staff-login");
  }

  let campaigns: { id: string; name: string }[];
  if (isAdmin) {
    campaigns = (await getLiveCampaignDirectory()).map((c) => ({
      id: c.id,
      name: c.name,
    }));
  } else {
    const principal = await resolveStaffPrincipal(session.userId);
    if (!principal) redirect("/staff-login");
    const resolved = await Promise.all(
      principal.scopedCampaignIds.map((id) => getCampaignById(id)),
    );
    campaigns = resolved
      .filter((c): c is NonNullable<typeof c> => c != null)
      .map((c) => ({ id: c.id, name: c.name }));
  }

  return (
    <PageShell
      title="Review"
      description="Campaigns you can review submissions for."
      width="lg"
    >
      {campaigns.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No campaigns are assigned to you yet.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {campaigns.map((c) => (
            <Card key={c.id} className="border-2 border-foreground/15">
              <CardHeader>
                <CardTitle className="font-heading">{c.name}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Link
                  href={`/host/campaigns/${c.id}/review`}
                  className={buttonVariants({ variant: "default", size: "sm" })}
                >
                  Review queue
                </Link>
                {isAdmin ? (
                  <Link
                    href={`/admin/campaigns/${c.id}/targets`}
                    className={buttonVariants({
                      variant: "outline",
                      size: "sm",
                    })}
                  >
                    Manage targets
                  </Link>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </PageShell>
  );
}
