/**
 * Per-campaign map page (T4.4) — PRD FR-M2, FR-M3, FR-M4, FR-M7.
 *
 * A thin wrapper, mirroring `app/campaigns/[id]/submit/[targetId]/page.tsx`
 * (T4.1): the actual map (`components/map/CampaignMap.tsx`) is a
 * self-contained client component that loads/polls
 * `/api/campaigns/[id]/targets` and calls
 * `/api/campaigns/[id]/targets/[targetId]` / `.../claim` for tap-through
 * actions — this page has no server-side data fetching of its own.
 * Authorization (constitution §5) is enforced by those API routes, not
 * here; an unauthenticated/unauthorized visitor sees the map component's
 * own load-error state (`data-testid="map-load-error"`), the same pattern
 * T4.1's capture page uses for its own protected calls.
 */
import CampaignMap from "@/components/map/CampaignMap";

interface PageParams {
  id: string;
}

interface PageProps {
  params: Promise<PageParams>;
}

export default async function CampaignMapPage({ params }: PageProps) {
  const { id: campaignId } = await params;
  return <CampaignMap campaignId={campaignId} />;
}
