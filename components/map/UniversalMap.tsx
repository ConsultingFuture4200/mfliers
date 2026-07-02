"use client";

/**
 * Universal aggregate map (T5.2) — PRD FR-L2, FR-L3, FR-L4 / EC-4:
 * "Universal Mapbox map aggregating target pins across all live
 * campaigns, retaining red/amber/green states. Tapping a pin shows
 * campaign name + state... tapping into a campaign opens its dedicated
 * view. Mapbox clustering at low zoom."
 *
 * A self-contained, public (no-auth) client component (mirrors
 * `components/map/CampaignMap.tsx`, T4.4: never reads the DB/auth
 * directly, only via `fetch`). It loads every live campaign's pins once
 * from `/api/public/pins` (T5.2, backed by the one sanctioned
 * cross-campaign read, `lib/db/dal/universal-map.ts` via
 * `lib/campaign/universal-map.ts`) — no polling, unlike the per-campaign
 * map: this is a public browse surface, not a live claim/submission
 * board a canvasser is actively working against.
 *
 * ## Reuse of T4.4's config, not its component (requirement 5)
 * `CampaignMap.tsx` is wired one-to-one to a *player's own claim flow*
 * for a single campaign (its red-pin tap POSTs `.../claim`, which 401s
 * for anyone else — see `tasks/lessons.md`'s T4.5 entry on why that
 * component shouldn't be reused verbatim for a different purpose). This
 * component instead reuses T4.4's *config and degradation pattern*: the
 * same `NEXT_PUBLIC_MAPBOX_TOKEN` env var, the same "dynamically
 * `import()` mapbox-gl only inside effects, so this module has zero
 * import-time `window`/WebGL dependency" approach, and the same
 * no-token/no-WebGL/map-`error` fallback to a plain, keyboard-operable
 * `PinFallbackList` — this sandbox has no live Mapbox token (see
 * `.env.example`), so every automated run here exercises that fallback,
 * same as `tests/e2e/campaign-map.spec.ts` does for T4.4. The real
 * Mapbox clustering/rendering behavior needs a live token + a
 * WebGL-capable browser and is marked `unverified-here` in this task's
 * build report.
 *
 * ## Clustering (requirement 2)
 * Unlike T4.4 (one `Marker` per pin — fine for a single campaign's
 * handful of targets), this map can aggregate targets across ~25
 * concurrent campaigns (constitution §4 scale target), so pins are
 * rendered through a GeoJSON `Source` with Mapbox GL's own built-in
 * `cluster: true` support (circle + count layers), not hand-rolled
 * bucketing — clicking a cluster zooms in via
 * `getClusterExpansionZoom`/`easeTo`, Mapbox's own documented pattern,
 * until the individual pins beneath it are visible ("declusters on
 * zoom-in").
 *
 * ## Tap-through + privacy (requirements 3/4)
 * Tapping an individual (unclustered) pin opens `PinDetailPanel` with the
 * pin's campaign name + state (+ photo for a filled pin) and a "view this
 * campaign's map" link into `/campaigns/[id]/map` (T4.4) — never a
 * username, for any campaign, under any privacy setting; see
 * `lib/campaign/universal-map.ts`'s doc comment for why that's the
 * correct place for FR-L3/L4's privacy gate to live, not here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { GeoJSONSource } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { Button } from "@/components/ui/button";
import type { UniversalMapPin } from "@/lib/campaign/universal-map";

const PIN_COLORS: Record<UniversalMapPin["state"], string> = {
  red: "#dc2626",
  amber: "#d97706",
  green: "#16a34a",
};

const PIN_STATE_LABEL: Record<UniversalMapPin["state"], string> = {
  red: "Open",
  amber: "Claimed / pending",
  green: "Filled",
};

const CLUSTER_SOURCE_ID = "universal-pins";

interface ErrorBody {
  error?: { code?: string; message?: string };
}

export default function UniversalMap() {
  const router = useRouter();
  const [pins, setPins] = useState<UniversalMapPin[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<UniversalMapPin | null>(null);
  const [mapUnavailable, setMapUnavailable] = useState(false);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  // Same reasoning as `CampaignMap.tsx`: not worth a static `mapbox-gl`
  // import just for a ref's type.
  const mapRef = useRef<import("mapbox-gl").Map | null>(null);
  const selectRef = useRef<(pin: UniversalMapPin) => void>(() => {});

  // Initial (one-shot) load — see module doc comment on why this map
  // doesn't poll like `CampaignMap.tsx` does.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/public/pins");
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as ErrorBody | null;
          if (!cancelled) {
            setLoadError(
              body?.error?.message ?? "Could not load the live map.",
            );
          }
          return;
        }
        const body = (await res.json()) as { pins: UniversalMapPin[] };
        if (!cancelled) setPins(body.pins);
      } catch {
        if (!cancelled) {
          setLoadError(
            "Could not load the live map. Check your connection and try again.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelect = useCallback((pin: UniversalMapPin) => {
    setSelected(pin);
  }, []);
  // Same indirection `CampaignMap.tsx` uses: the cluster layer's click
  // listener is attached imperatively (mapbox-gl, not React) and would
  // otherwise close over a stale `handleSelect` across re-renders.
  useEffect(() => {
    selectRef.current = handleSelect;
  }, [handleSelect]);

  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? null;

  // Mount the Mapbox map + clustered source/layers once pins have loaded
  // (requirements 1/2/6). Dynamically imported — see module doc comment.
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
          zoom: 3,
        });
        map.on("error", () => setMapUnavailable(true));

        map.on("load", () => {
          if (cancelled) return;
          map.addSource(CLUSTER_SOURCE_ID, {
            type: "geojson",
            data: pinsToFeatureCollection(pins),
            cluster: true,
            clusterMaxZoom: 13,
            clusterRadius: 50,
          });

          map.addLayer({
            id: "clusters",
            type: "circle",
            source: CLUSTER_SOURCE_ID,
            filter: ["has", "point_count"],
            paint: {
              "circle-color": "#2563eb",
              "circle-radius": [
                "step",
                ["get", "point_count"],
                16,
                10,
                22,
                50,
                28,
              ],
              "circle-stroke-width": 2,
              "circle-stroke-color": "#ffffff",
            },
          });
          map.addLayer({
            id: "cluster-count",
            type: "symbol",
            source: CLUSTER_SOURCE_ID,
            filter: ["has", "point_count"],
            layout: {
              "text-field": ["get", "point_count_abbreviated"],
              "text-size": 12,
            },
            paint: { "text-color": "#ffffff" },
          });
          map.addLayer({
            id: "unclustered-point",
            type: "circle",
            source: CLUSTER_SOURCE_ID,
            filter: ["!", ["has", "point_count"]],
            paint: {
              "circle-color": [
                "match",
                ["get", "state"],
                "red",
                PIN_COLORS.red,
                "amber",
                PIN_COLORS.amber,
                "green",
                PIN_COLORS.green,
                "#6b7280",
              ],
              "circle-radius": 9,
              "circle-stroke-width": 2,
              "circle-stroke-color": "#ffffff",
            },
          });

          // Cluster tap: zoom in until it splits (requirement 2,
          // "declusters on zoom-in") — Mapbox's own documented
          // cluster-expansion pattern, not hand-rolled bucketing.
          map.on("click", "clusters", (e) => {
            const features = map.queryRenderedFeatures(e.point, {
              layers: ["clusters"],
            });
            const clusterId = features[0]?.properties?.cluster_id as
              number | undefined;
            if (clusterId === undefined) return;
            const source = map.getSource(CLUSTER_SOURCE_ID) as GeoJSONSource;
            source.getClusterExpansionZoom(clusterId, (err, zoom) => {
              if (err || zoom === null || zoom === undefined) return;
              const geometry = features[0]?.geometry;
              if (geometry?.type !== "Point") return;
              map.easeTo({
                center: geometry.coordinates as [number, number],
                zoom,
              });
            });
          });

          // Individual pin tap (requirement 3): resolve the tapped
          // feature back to its full pin object (campaign name + photo
          // aren't cheap to round-trip through GeoJSON string
          // properties) via its id.
          map.on("click", "unclustered-point", (e) => {
            const pinId = e.features?.[0]?.properties?.pinId as
              string | undefined;
            const pin = pins.find((p) => p.id === pinId);
            if (pin) selectRef.current(pin);
          });
          map.on(
            "mouseenter",
            "unclustered-point",
            () => (map.getCanvas().style.cursor = "pointer"),
          );
          map.on(
            "mouseleave",
            "unclustered-point",
            () => (map.getCanvas().style.cursor = ""),
          );
          map.on(
            "mouseenter",
            "clusters",
            () => (map.getCanvas().style.cursor = "pointer"),
          );
          map.on(
            "mouseleave",
            "clusters",
            () => (map.getCanvas().style.cursor = ""),
          );
        });

        mapRef.current = map;
      } catch {
        setMapUnavailable(true);
      }
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // Mounts once, on first pin load — pins don't change after the
    // one-shot fetch above (no polling), so there's no separate
    // reconciliation effect to keep in sync, unlike `CampaignMap.tsx`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins === null, mapboxToken]);

  if (pins === null) {
    if (loadError) {
      return (
        <main className="mx-auto flex max-w-sm flex-1 flex-col justify-center gap-4 p-6">
          <p
            className="text-sm text-destructive"
            data-testid="universal-map-load-error"
          >
            {loadError}
          </p>
        </main>
      );
    }
    return (
      <main className="mx-auto flex max-w-sm flex-1 flex-col justify-center p-6">
        <p className="text-sm text-muted-foreground">Loading live map…</p>
      </main>
    );
  }

  return (
    // Explicit height (not min-h + flex-1): the map container is
    // `absolute inset-0`, so it only has size if this positioned ancestor
    // has a real, resolved height. In a collapsing flex-column parent
    // (the landing section, or the standalone /map page) min-h-[70vh]
    // resolved to 0 and Mapbox rendered a blank 0-height canvas.
    <div className="relative h-[70vh] w-full">
      {/* Inline position:absolute — mapbox-gl.css sets `.mapboxgl-map {
          position: relative }` which (equal specificity, loaded later)
          overrides a Tailwind `.absolute` class and collapses the box to
          0 height. An inline style outranks the external stylesheet. */}
      <div
        ref={mapContainerRef}
        data-testid="universal-mapbox-container"
        style={{ position: "absolute", inset: 0 }}
      />

      {mapUnavailable ? (
        <PinFallbackList pins={pins} onTap={handleSelect} />
      ) : null}

      {selected ? (
        <PinDetailPanel
          pin={selected}
          onClose={() => setSelected(null)}
          onOpenCampaign={() => {
            router.push(`/campaigns/${selected.campaignId}/map`);
          }}
        />
      ) : null}
    </div>
  );
}

function averageCenter(pins: UniversalMapPin[]): {
  lat: number;
  long: number;
} {
  if (pins.length === 0) return { lat: 0, long: 0 };
  const lat = pins.reduce((sum, p) => sum + p.lat, 0) / pins.length;
  const long = pins.reduce((sum, p) => sum + p.long, 0) / pins.length;
  return { lat, long };
}

function pinsToFeatureCollection(pins: UniversalMapPin[]) {
  return {
    type: "FeatureCollection" as const,
    features: pins.map((pin) => ({
      type: "Feature" as const,
      properties: { pinId: pin.id, state: pin.state },
      geometry: {
        type: "Point" as const,
        coordinates: [pin.long, pin.lat],
      },
    })),
  };
}

/** The no-Mapbox fallback (see module doc comment) — every pin as a
 * plain, clickable list item, colored by state and labeled with its
 * campaign name, wired to the same `onTap` the real clustered layer
 * uses. No clustering in this view (a graceful-degradation list, not a
 * feature this card asks for) — every campaign's live pins are simply
 * listed. */
function PinFallbackList({
  pins,
  onTap,
}: {
  pins: UniversalMapPin[];
  onTap: (pin: UniversalMapPin) => void;
}) {
  return (
    <ul
      data-testid="universal-pin-fallback-list"
      className="relative z-10 flex flex-1 flex-col gap-2 overflow-auto p-4"
    >
      {pins.map((pin) => (
        <li key={pin.id}>
          <button
            type="button"
            data-testid={`universal-map-pin-${pin.id}`}
            data-state={pin.state}
            data-campaign-id={pin.campaignId}
            onClick={() => onTap(pin)}
            className="flex w-full items-center gap-3 rounded-lg border border-input p-3 text-left text-sm"
          >
            <span
              aria-hidden
              className="size-3 shrink-0 rounded-full"
              style={{ backgroundColor: PIN_COLORS[pin.state] }}
            />
            <span className="flex-1">
              <span className="block font-medium">{pin.campaignName}</span>
              <span className="text-xs text-muted-foreground">
                {PIN_STATE_LABEL[pin.state]}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function PinDetailPanel({
  pin,
  onClose,
  onOpenCampaign,
}: {
  pin: UniversalMapPin;
  onClose: () => void;
  onOpenCampaign: () => void;
}) {
  return (
    <div
      data-testid="universal-pin-detail-panel"
      className="relative z-10 mt-auto max-h-[60vh] overflow-auto rounded-t-xl border-t border-input bg-background p-4"
    >
      <div className="mb-2 flex items-center justify-between">
        <h2
          className="text-sm font-semibold"
          data-testid="universal-pin-detail-campaign-name"
        >
          {pin.campaignName}
        </h2>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <p
        className="text-xs text-muted-foreground"
        data-testid="universal-pin-detail-state"
      >
        Status: {PIN_STATE_LABEL[pin.state]}
      </p>
      {pin.state === "green" && pin.photoUrl ? (
        // Requirement 4: this is the public-safe photo the sanctioned
        // universal read already exposes (T2.1) — never a username, see
        // module/lib doc comments.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={pin.photoUrl}
          alt={`Submitted flier placement for ${pin.campaignName}`}
          className="mt-2 w-full rounded-md object-cover"
        />
      ) : null}
      <Button
        className="mt-3 w-full"
        data-testid="universal-pin-open-campaign"
        onClick={onOpenCampaign}
      >
        View this campaign&apos;s map
      </Button>
    </div>
  );
}
