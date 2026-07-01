/**
 * Universal (cross-campaign) map page (T5.2) — PRD FR-L2/FR-L3/FR-L4,
 * EC-4. A thin wrapper, mirroring `app/campaigns/[id]/map/page.tsx`
 * (T4.4): the actual map (`components/map/UniversalMap.tsx`) is a
 * self-contained, public (no-auth) client component that loads
 * `/api/public/pins` — this page has no server-side data fetching of its
 * own.
 */
import UniversalMap from "@/components/map/UniversalMap";

export default function UniversalMapPage() {
  return <UniversalMap />;
}
