"use client";

/**
 * Location list for a campaign landing page. Fetches the same per-campaign pin
 * list the map uses (`/api/campaigns/[id]/targets` → `{ pins }`), which is
 * player/staff-scoped (labels are player-visible, not fully public). A
 * logged-out visitor gets a 401 and a sign-in prompt instead of the list.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { StateBadge } from "@/components/brand/StateBadge";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { businessMapsUrl } from "@/lib/maps";
import type { TargetState } from "@/types/domain";

interface Pin {
  id: string;
  label: string;
  lat: number;
  long: number;
  state: TargetState;
}

type Status = "loading" | "ready" | "signed-out" | "error";

export function TargetList({ campaignId }: { campaignId: string }) {
  const [pins, setPins] = useState<Pin[]>([]);
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/campaigns/${campaignId}/targets`);
        if (cancelled) return;
        if (res.status === 401) {
          setStatus("signed-out");
          return;
        }
        if (!res.ok) {
          setStatus("error");
          return;
        }
        const body = (await res.json()) as { pins: Pin[] };
        setPins(body.pins);
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  if (status === "loading") {
    return (
      <div className="flex flex-col gap-2" data-testid="target-list-loading">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (status === "signed-out") {
    return (
      <div className="rounded-xl border-2 border-foreground/15 bg-card p-4 text-sm text-muted-foreground">
        <p className="mb-3">
          Sign in to see the full list of locations to hit.
        </p>
        <Link
          href={`/login?callbackUrl=/campaigns/${campaignId}`}
          className={buttonVariants({ variant: "default", size: "sm" })}
        >
          Player sign in
        </Link>
      </div>
    );
  }

  if (status === "error") {
    return (
      <p className="text-sm text-destructive" data-testid="target-list-error">
        Couldn&apos;t load the locations. Try again.
      </p>
    );
  }

  if (pins.length === 0) {
    return <p className="text-sm text-muted-foreground">No locations yet.</p>;
  }

  const remaining = pins.filter((p) => p.state !== "green").length;

  return (
    <div className="flex flex-col gap-2" data-testid="target-list">
      <p className="font-mono text-xs text-muted-foreground">
        {pins.length} locations · {remaining} still open
      </p>
      <ul className="flex flex-col gap-2">
        {pins.map((pin) => (
          <li
            key={pin.id}
            data-testid="target-list-item"
            data-state={pin.state}
            className="flex items-center gap-3 rounded-xl border-2 border-foreground/15 bg-card p-3"
          >
            <span className="flex-1 text-sm font-medium">{pin.label}</span>
            <a
              href={businessMapsUrl(pin.label, pin.lat, pin.long)}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs text-muted-foreground underline"
            >
              Google Maps ↗
            </a>
            <StateBadge state={pin.state} />
          </li>
        ))}
      </ul>
    </div>
  );
}
