"use client";

/**
 * Live-campaign directory (T5.1) — PRD FR-L1/FR-L5: "Campaign
 * directory/list beside the map — browse live campaigns, see coverage %,
 * join." A self-contained client component (mirrors
 * `components/map/CampaignMap.tsx`, T4.4): never reads the DB/auth
 * directly, only via `fetch` to `/api/public/campaigns` (no-auth, T5.1)
 * and `/api/campaigns/[id]/join` (player-session-required, T5.1
 * carry-forward).
 *
 * The landing page itself is public (no session read at all — see
 * `app/page.tsx`), so "Join" is always shown; the join action itself is
 * still authorized server-side (constitution §2/§5 — "hiding a button is
 * not security" cuts both ways, showing one isn't a security decision
 * either). An unauthenticated click is redirected to `/login` rather than
 * failing silently.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/brand/StatCard";

interface DirectoryCampaign {
  id: string;
  name: string;
  blurb: string;
  totalTargets: number;
  greenTargets: number;
  coveragePercent: number;
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

type JoinState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "joined" }
  | { status: "error"; message: string };

export default function CampaignDirectory() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<DirectoryCampaign[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [joinState, setJoinState] = useState<Record<string, JoinState>>({});

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/public/campaigns");
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as ErrorBody | null;
          if (!cancelled) {
            setLoadError(
              body?.error?.message ?? "Could not load live campaigns.",
            );
          }
          return;
        }
        const body = (await res.json()) as { campaigns: DirectoryCampaign[] };
        if (!cancelled) setCampaigns(body.campaigns);
      } catch {
        if (!cancelled) {
          setLoadError("Could not load live campaigns.");
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleJoin = useCallback(
    async (campaignId: string) => {
      setJoinState((prev) => ({
        ...prev,
        [campaignId]: { status: "pending" },
      }));
      try {
        const res = await fetch(`/api/campaigns/${campaignId}/join`, {
          method: "POST",
        });
        if (res.status === 401) {
          router.push("/login");
          return;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as ErrorBody | null;
          setJoinState((prev) => ({
            ...prev,
            [campaignId]: {
              status: "error",
              message: body?.error?.message ?? "Could not join this campaign.",
            },
          }));
          return;
        }
        setJoinState((prev) => ({
          ...prev,
          [campaignId]: { status: "joined" },
        }));
      } catch {
        setJoinState((prev) => ({
          ...prev,
          [campaignId]: {
            status: "error",
            message: "Could not join this campaign.",
          },
        }));
      }
    },
    [router],
  );

  if (loadError) {
    return (
      <p
        data-testid="campaign-directory-error"
        className="text-sm text-destructive"
      >
        {loadError}
      </p>
    );
  }

  if (!campaigns) {
    return (
      <p
        data-testid="campaign-directory-loading"
        className="text-sm text-muted-foreground"
      >
        Loading live campaigns…
      </p>
    );
  }

  if (campaigns.length === 0) {
    return (
      <p
        data-testid="campaign-directory-empty"
        className="text-sm text-muted-foreground"
      >
        No live campaigns right now — check back soon.
      </p>
    );
  }

  return (
    <ul
      data-testid="campaign-directory"
      className="grid w-full max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2"
    >
      {campaigns.map((campaign) => {
        const join = joinState[campaign.id] ?? { status: "idle" };
        return (
          <li
            key={campaign.id}
            data-testid="campaign-card"
            data-campaign-id={campaign.id}
            className="flex flex-col gap-3 rounded-2xl border-2 border-foreground/15 bg-card p-5 text-left transition-opacity duration-300 ease-out motion-reduce:transition-none motion-reduce:duration-0"
          >
            <div className="flex flex-col gap-1">
              <h3 className="font-heading text-lg font-bold">
                {campaign.name}
              </h3>
              <p className="text-sm text-muted-foreground">{campaign.blurb}</p>
            </div>

            <StatCard
              label="Coverage"
              value={
                <span data-testid="campaign-coverage">
                  {campaign.coveragePercent}%
                </span>
              }
              hint={`${campaign.greenTargets}/${campaign.totalTargets} posted`}
            />

            {join.status === "joined" ? (
              <p
                data-testid="join-success"
                className="text-sm font-medium text-primary"
              >
                Joined — head to the campaign map to start claiming targets.
              </p>
            ) : (
              <Button
                data-testid="join-button"
                type="button"
                className="w-full"
                disabled={join.status === "pending"}
                onClick={() => void handleJoin(campaign.id)}
              >
                {join.status === "pending" ? "Joining…" : "Join"}
              </Button>
            )}
            {join.status === "error" ? (
              <p data-testid="join-error" className="text-sm text-destructive">
                {join.message}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
