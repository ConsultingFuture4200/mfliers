"use client";

/**
 * Per-campaign Mapbox map (T4.4) — PRD FR-M2, FR-M3, FR-M4, FR-M7.
 *
 * A self-contained client component (mirrors T4.1's capture page,
 * `app/campaigns/[id]/submit/[targetId]/page.tsx`: never reads the
 * DB/auth directly, only via `fetch`). It loads `campaignId`'s pins from
 * `/api/campaigns/[id]/targets` on mount and polls the same endpoint
 * every `POLL_INTERVAL_MS` (5-10s band, requirement 5), reconciling
 * Mapbox markers by id in place (never tearing the whole map down on a
 * poll tick). Tapping a marker either claims it (red — requirement 2) or
 * opens its tap-through detail (amber/green — requirements 3/4) via
 * `/api/campaigns/[id]/targets/[targetId]`.
 *
 * Mapbox GL JS needs a real WebGL context and a real
 * `NEXT_PUBLIC_MAPBOX_TOKEN`, neither of which this sandbox can rely on
 * for automated verification (see `.env.example`/`docs/deploy.md`).
 * `mapbox-gl` itself is only ever imported dynamically, inside effects, so
 * this module has zero import-time dependency on `window`/WebGL and never
 * touches the DOM during SSR.
 *
 * Graceful degradation (not a v1-scope "list view" feature — see
 * `tasks/lessons.md`): when there's no token, WebGL is unsupported, or the
 * `Map` fails to construct/load, `PinFallbackList` renders the exact
 * same pins as a plain, keyboard-operable button list wired to the exact
 * same `handleTap`/`handleClaim` handlers the real markers use. This is
 * both the production no-token/no-WebGL fallback *and* this card's
 * primary automated-test surface (`tests/e2e/campaign-map.spec.ts`) for
 * the claim/detail/privacy/polling logic, since none of that depends on
 * Mapbox actually having rendered a basemap.
 *
 * Constitution §8 / card requirement 6: the only env var this file reads
 * is `NEXT_PUBLIC_MAPBOX_TOKEN` — the *public*, URL-restricted token (see
 * `docs/deploy.md`), which Next.js inlines into the client bundle by
 * design (the `NEXT_PUBLIC_` prefix means it isn't a secret). No other
 * env var is referenced here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import "mapbox-gl/dist/mapbox-gl.css";
import { Button } from "@/components/ui/button";
import { StateBadge } from "@/components/brand/StateBadge";
import { Pin } from "@/components/brand/Pin";
import { businessMapsUrl } from "@/lib/maps";
import type { MapPin, TargetDetail } from "@/lib/campaign/map";

/** Within the card's "5-10s" polling band (requirement 5). */
const POLL_INTERVAL_MS = 7_000;

// Field-guide pin hues (literal — Mapbox GL paint/markers can't read CSS vars;
// kept in sync with globals.css's --pin-* tokens).
const PIN_COLORS: Record<MapPin["state"], string> = {
  red: "#d2412e",
  amber: "#e0a32e",
  green: "#2f8f5b",
};

const PIN_STATE_LABEL: Record<MapPin["state"], string> = {
  red: "Open — tap to claim",
  amber: "Claimed / pending",
  green: "Filled",
};

interface ErrorBody {
  error?: { code?: string; message?: string };
}

export default function CampaignMap({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [pins, setPins] = useState<MapPin[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [selected, setSelected] = useState<TargetDetail | null>(null);
  const [mapUnavailable, setMapUnavailable] = useState(false);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  // `mapbox-gl`'s own types (imported only dynamically, see below) aren't
  // worth a static import just for a ref's type — the map/marker
  // instances are only ever touched inside the effects that create them.
  const mapRef = useRef<import("mapbox-gl").Map | null>(null);
  const markersRef = useRef<Map<string, import("mapbox-gl").Marker>>(new Map());
  const handleTapRef = useRef<(pin: MapPin) => void>(() => {});

  const fetchPins = useCallback(async () => {
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/targets`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ErrorBody | null;
        setLoadError(
          body?.error?.message ?? "Could not load this campaign's map.",
        );
        return;
      }
      const body = (await res.json()) as { pins: MapPin[] };
      setLoadError(null);
      setPins(body.pins);
    } catch {
      // A missed poll tick just retries next interval (requirement 5 is
      // "near-real-time," not guaranteed delivery of any single tick) —
      // but the *first* load has nothing to show yet, so it does surface.
      setPins((current) => {
        if (current === null) {
          setLoadError(
            "Could not load this campaign's map. Check your connection and try again.",
          );
        }
        return current;
      });
    }
  }, [campaignId]);

  // Initial load + poll (requirement 5). `fetchPins` only ever calls a
  // setter after its first `await` resolves (same "fetch once on mount"
  // shape `app/campaigns/[id]/submit/[targetId]/page.tsx`'s
  // `attemptGetLocation` uses) — there's no *synchronous* setState here
  // for the set-state-in-effect rule's cascading-render concern to apply
  // to.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchPins();
    const interval = setInterval(() => void fetchPins(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchPins]);

  // Claim a red target, then go straight to the capture screen to post the
  // flier. Invoked from the pin detail sheet's "Claim & post flier" button
  // (the submit option surfaced in the pin view) rather than on bare tap.
  const handleClaim = useCallback(
    async (targetId: string) => {
      setBanner(null);
      try {
        const res = await fetch(
          `/api/campaigns/${campaignId}/targets/${targetId}/claim`,
          { method: "POST" },
        );
        if (res.ok) {
          router.push(`/campaigns/${campaignId}/submit/${targetId}`);
          return;
        }
        const body = (await res.json().catch(() => null)) as ErrorBody | null;
        // Requirement 2: a lost claim race surfaces as a clear message,
        // never a crash/silent no-op.
        setBanner(
          res.status === 409
            ? "Someone else already claimed this target."
            : (body?.error?.message ?? "Could not claim this target."),
        );
        void fetchPins();
      } catch {
        setBanner(
          "Could not claim this target. Check your connection and try again.",
        );
      }
    },
    [campaignId, router, fetchPins],
  );

  // Tapping any pin opens its detail sheet (Google-Maps style). The sheet then
  // surfaces the state-appropriate action (claim+post for red, info for
  // amber, the posted flier for green) — see PinDetailPanel.
  const handleTap = useCallback(
    (pin: MapPin) => {
      void (async () => {
        setBanner(null);
        try {
          const res = await fetch(
            `/api/campaigns/${campaignId}/targets/${pin.id}`,
          );
          if (!res.ok) {
            setBanner("Could not load this pin's details.");
            return;
          }
          const body = (await res.json()) as { target: TargetDetail };
          setSelected(body.target);
        } catch {
          setBanner("Could not load this pin's details.");
        }
      })();
    },
    [campaignId],
  );
  // Kept in a ref so the marker-sync effect (below) doesn't need
  // `handleTap` in its dependency array — the marker DOM elements' click
  // listeners are attached imperatively (mapbox-gl, not React), so they'd
  // otherwise go stale across re-renders without this indirection. Refs
  // are only ever written outside render (here, in an effect) — React's
  // rules-of-hooks flags a direct render-body write.
  useEffect(() => {
    handleTapRef.current = handleTap;
  }, [handleTap]);

  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? null;

  // Mount the Mapbox map once pins have loaded (requirements 1/6).
  // Dynamically imported — see module doc comment (no import-time
  // `window`/WebGL dependency).
  useEffect(() => {
    if (pins === null) return;
    if (!mapboxToken || !mapContainerRef.current) {
      setMapUnavailable(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      if (cancelled) return;
      // mapbox-gl v3 removed `mapboxgl.supported()`; a WebGL-unsupported
      // browser now throws in `new Map(...)` (caught below) or fires the map
      // `error` event — both route to the fallback. Only guard the container.
      if (!mapContainerRef.current) {
        setMapUnavailable(true);
        return;
      }
      try {
        mapboxgl.accessToken = mapboxToken;
        const center = averageCenter(pins);
        const map = new mapboxgl.Map({
          container: mapContainerRef.current,
          style: "mapbox://styles/mapbox/streets-v12",
          center: [center.long, center.lat],
          zoom: 14,
        });
        map.on("error", () => setMapUnavailable(true));
        mapRef.current = map;
      } catch {
        setMapUnavailable(true);
      }
    })();
    const markers = markersRef.current;
    return () => {
      cancelled = true;
      for (const marker of markers.values()) marker.remove();
      markers.clear();
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // Only ever mounts the map once pins have first loaded; `pins`'
    // subsequent updates are handled by the marker-sync effect below, not
    // by remounting the whole map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins === null, mapboxToken]);

  // Reconcile markers whenever `pins` changes (requirement 5: "update pins
  // without a full reload" — reuse marker instances keyed by id instead of
  // tearing the map down each poll tick).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapUnavailable || !pins) return;
    let cancelled = false;
    void (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      if (cancelled) return;
      const seen = new Set<string>();
      for (const pin of pins) {
        seen.add(pin.id);
        let marker = markersRef.current.get(pin.id);
        if (!marker) {
          const el = document.createElement("button");
          el.type = "button";
          el.setAttribute("aria-label", pin.label);
          el.style.width = "18px";
          el.style.height = "18px";
          el.style.borderRadius = "9999px";
          el.style.border = "2px solid white";
          el.style.cursor = "pointer";
          el.style.padding = "0";
          marker = new mapboxgl.Marker({ element: el })
            .setLngLat([pin.long, pin.lat])
            .addTo(map);
          markersRef.current.set(pin.id, marker);
        }
        const el = marker.getElement();
        el.style.backgroundColor = PIN_COLORS[pin.state];
        el.dataset.testid = `map-pin-${pin.id}`;
        el.dataset.state = pin.state;
        el.onclick = () => handleTapRef.current(pin);
      }
      for (const [id, marker] of markersRef.current) {
        if (!seen.has(id)) {
          marker.remove();
          markersRef.current.delete(id);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pins, mapUnavailable]);

  if (pins === null) {
    if (loadError) {
      return (
        <main className="mx-auto flex max-w-sm flex-1 flex-col justify-center gap-4 p-6">
          <p className="text-sm text-destructive" data-testid="map-load-error">
            {loadError}
          </p>
        </main>
      );
    }
    return (
      <main className="mx-auto flex max-w-sm flex-1 flex-col justify-center p-6">
        <p className="text-sm text-muted-foreground">Loading map…</p>
      </main>
    );
  }

  return (
    // Explicit height (not min-h + flex-1): the `absolute inset-0` map
    // container only has size if this positioned ancestor has a resolved
    // height; a collapsing flex-column parent left it 0-height (blank map).
    <div className="relative h-[70vh] w-full">
      {/* Inline position:absolute — mapbox-gl.css's `.mapboxgl-map {
          position: relative }` overrides a Tailwind `.absolute` class and
          collapses the box to 0 height; inline style outranks it. */}
      <div
        ref={mapContainerRef}
        data-testid="mapbox-container"
        style={{ position: "absolute", inset: 0 }}
      />

      {banner ? (
        <div
          data-testid="map-banner"
          className="relative z-10 bg-background/95 p-2 text-center text-sm text-destructive"
        >
          {banner}
        </div>
      ) : null}

      {mapUnavailable ? (
        <PinFallbackList pins={pins} onTap={handleTap} />
      ) : null}

      {selected ? (
        <PinDetailPanel
          detail={selected}
          onClose={() => setSelected(null)}
          onClaim={handleClaim}
        />
      ) : null}
    </div>
  );
}

function averageCenter(pins: MapPin[]): { lat: number; long: number } {
  if (pins.length === 0) return { lat: 0, long: 0 };
  const lat = pins.reduce((sum, p) => sum + p.lat, 0) / pins.length;
  const long = pins.reduce((sum, p) => sum + p.long, 0) / pins.length;
  return { lat, long };
}

/** The no-Mapbox fallback (see module doc comment) — every pin as a
 * plain, clickable list item, colored by state, wired to the same
 * `onTap` the real markers use. */
function PinFallbackList({
  pins,
  onTap,
}: {
  pins: MapPin[];
  onTap: (pin: MapPin) => void;
}) {
  return (
    <ul
      data-testid="pin-fallback-list"
      className="relative z-10 flex flex-1 flex-col gap-2 overflow-auto p-4"
    >
      {pins.map((pin) => (
        <li key={pin.id}>
          <button
            type="button"
            data-testid={`map-pin-${pin.id}`}
            data-state={pin.state}
            onClick={() => onTap(pin)}
            className="flex w-full items-center gap-3 rounded-xl border-2 border-foreground/15 bg-card p-3 text-left text-sm transition-colors hover:bg-accent"
          >
            <Pin state={pin.state} size={26} />
            <span className="flex-1 font-medium">{pin.label}</span>
            <StateBadge state={pin.state} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function PinDetailPanel({
  detail,
  onClose,
  onClaim,
}: {
  detail: TargetDetail;
  onClose: () => void;
  onClaim: (targetId: string) => void;
}) {
  return (
    <div
      data-testid="pin-detail-panel"
      className="absolute inset-x-0 bottom-0 z-10 mx-auto max-h-[70vh] w-full max-w-md overflow-auto rounded-t-2xl border-2 border-foreground/15 bg-card p-4 shadow-lg sm:inset-x-auto sm:right-4 sm:bottom-4 sm:rounded-2xl"
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 className="font-heading text-base font-bold">{detail.label}</h2>
          <StateBadge state={detail.state} className="w-fit" />
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      <p className="sr-only" data-testid="pin-detail-state">
        Status: {PIN_STATE_LABEL[detail.state]}
      </p>

      <a
        href={businessMapsUrl(detail.label, detail.lat, detail.long)}
        target="_blank"
        rel="noopener noreferrer"
        className="block font-mono text-xs text-muted-foreground underline"
      >
        View on Google Maps ↗
      </a>

      {detail.state === "red" ? (
        <Button
          className="mt-3 w-full"
          data-testid="pin-claim-button"
          onClick={() => onClaim(detail.id)}
        >
          Claim &amp; post flier
        </Button>
      ) : null}

      {detail.state === "amber" ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Claimed by a canvasser — awaiting a posted flier.
        </p>
      ) : null}

      {detail.state === "green" ? (
        <>
          {detail.photoUrl ? (
            // Signed R2 URLs are short-lived and per-request, same reasoning
            // as the T4.2 review-queue card's photo (`ReviewCard`).
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={detail.photoUrl}
              alt={`Posted flier at ${detail.label}`}
              className="mt-3 aspect-video w-full rounded-lg border-2 border-foreground/15 object-cover"
            />
          ) : null}
          {detail.submissionGps ? (
            <p
              className="mt-2 font-mono text-xs text-muted-foreground"
              data-testid="pin-detail-gps"
            >
              {detail.submissionGps.lat.toFixed(5)},{" "}
              {detail.submissionGps.long.toFixed(5)}
            </p>
          ) : null}
          <p className="mt-2 text-sm" data-testid="pin-detail-username">
            {detail.username ?? "Canvasser (hidden)"}
          </p>
        </>
      ) : null}
    </div>
  );
}
