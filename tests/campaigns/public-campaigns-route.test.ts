/**
 * `GET /api/public/campaigns` — route orchestration only (T5.1). Mocks
 * `lib/campaign/directory.ts`'s `getLiveCampaignDirectory`; the directory
 * assembly itself is covered against a live PostGIS DB by
 * `tests/campaign/directory.test.ts`. This suite only proves the route
 * requires no session and passes the lib result straight through.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/campaign/directory", () => ({
  getLiveCampaignDirectory: vi.fn(),
}));

import { getLiveCampaignDirectory } from "@/lib/campaign/directory";
import { GET } from "@/app/api/public/campaigns/route";

describe("GET /api/public/campaigns", () => {
  it("requires no session and returns the directory as-is", async () => {
    vi.mocked(getLiveCampaignDirectory).mockResolvedValue([
      {
        id: "campaign-1",
        name: "Campaign One",
        blurb: "Grand prize: A trophy",
        totalTargets: 4,
        greenTargets: 2,
        coveragePercent: 50,
      },
    ]);

    const res = await GET();
    const body = (await res.json()) as {
      campaigns: { id: string; coveragePercent: number }[];
    };

    expect(res.status).toBe(200);
    expect(body.campaigns).toHaveLength(1);
    expect(body.campaigns[0].coveragePercent).toBe(50);
  });
});
