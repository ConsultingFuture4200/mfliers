/**
 * Public campaign directory (`/campaigns`) — the "Campaigns" nav destination.
 * Reuses the same client directory component the landing uses (fetches
 * `/api/public/campaigns`); no auth required.
 */
import { PageShell } from "@/components/brand/PageShell";
import CampaignDirectory from "@/components/landing/CampaignDirectory";

export default function CampaignsPage() {
  return (
    <PageShell
      title="Live campaigns"
      description="Browse active campaigns, see coverage, and join to start canvassing."
      width="lg"
    >
      <CampaignDirectory />
    </PageShell>
  );
}
