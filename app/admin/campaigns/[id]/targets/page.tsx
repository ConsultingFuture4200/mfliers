/**
 * Site-admin target import page (T4.5) — PRD FR-M1.
 *
 * Server Component (mirrors `app/host/campaigns/[id]/review/page.tsx`,
 * T4.2): resolves a fresh `StaffPrincipal` per request and denies access
 * before rendering anything for a non-staff or non-site-admin visitor
 * (constitution §2 — the actual enforcement is server-side on the import
 * route via `requireSiteAdmin`; this page-level check is defense in
 * depth so a host doesn't even see the import tool, not the security
 * boundary itself).
 *
 * Composition: `TargetImportForm` (client island, requirement 1/2 — CSV
 * upload + pin-drop) plus the reused `CampaignMap` (T4.4, requirement 5 —
 * "show the resulting target set on the map"). `CampaignMap` already
 * polls `/api/campaigns/[id]/targets` every 5-10s on its own, so newly
 * imported targets appear without this page wiring any extra state
 * between the two client islands.
 */
import { auth } from "@/lib/auth/config";
import { resolveStaffPrincipal } from "@/lib/auth/staff";
import { getCampaignById } from "@/lib/db/dal/campaigns";
import CampaignMap from "@/components/map/CampaignMap";
import { PageShell } from "@/components/brand/PageShell";
import { Card, CardContent } from "@/components/ui/card";
import { TargetImportForm } from "./TargetImportForm";

interface PageParams {
  id: string;
}

interface PageProps {
  params: Promise<PageParams>;
}

function DeniedMessage({ message }: { message: string }) {
  return (
    <PageShell width="sm">
      <Card className="border-2 border-foreground/15">
        <CardContent>
          <p className="text-sm text-destructive" data-testid="targets-denied">
            {message}
          </p>
        </CardContent>
      </Card>
    </PageShell>
  );
}

export default async function AdminTargetsPage({ params }: PageProps) {
  const { id: campaignId } = await params;
  const session = await auth();

  if (
    !session ||
    (session.principalType !== "site_admin" &&
      session.principalType !== "host") ||
    !session.userId
  ) {
    return (
      <DeniedMessage message="A staff (host/site-admin) session is required." />
    );
  }

  const principal = await resolveStaffPrincipal(session.userId);
  if (!principal) {
    return <DeniedMessage message="This staff account no longer exists." />;
  }

  // Card requirement 4 / constitution §5: import is site-admin-guarded.
  // A host that's otherwise scoped to this campaign still can't reach the
  // import tool — same denial a stranger gets, not a hidden button.
  if (principal.type !== "site_admin") {
    return <DeniedMessage message="Only a site admin can import targets." />;
  }

  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    return <DeniedMessage message="Campaign not found." />;
  }

  return (
    <PageShell
      title={`Import targets — ${campaign.name}`}
      description="Upload a CSV or drop a pin, then confirm the target set on the map."
      width="lg"
    >
      <div className="flex flex-col gap-6">
        <TargetImportForm campaignId={campaignId} />
        <div className="min-h-[60vh] overflow-hidden rounded-2xl border-2 border-foreground/15 bg-card">
          <CampaignMap campaignId={campaignId} />
        </div>
      </div>
    </PageShell>
  );
}
