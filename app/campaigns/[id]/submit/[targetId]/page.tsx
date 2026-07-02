"use client";

/**
 * Submission capture page (T4.1) — PRD FR-S1…FR-S5.
 *
 * Rear-camera-only by default (`<input capture="environment">`); a
 * secondary, visually de-emphasized "choose from gallery" input is the
 * fallback path, which auto-flags the resulting submission for human
 * review (`lib/capture/submit.ts`'s `forceGalleryReview`) — never the
 * default. GPS permission is requested up front and blocks capture on
 * denial (constitution: hiding a button is not security, but here it's the
 * opposite direction — the button is deliberately hidden/disabled until a
 * *client-side* precondition is met; the server independently requires
 * `deviceGps` on every submission regardless of what this UI does).
 *
 * EC-2 instrumentation ("median submit time, camera open → confirmation, ≤
 * 20s"): `captureOpenedAt` is stamped once, at mount — the browser has no
 * hook into the native camera app's own open/close lifecycle when
 * `capture="environment"` triggers an OS camera intent, so "this page
 * became interactive" is the closest available proxy for "camera open."
 * The measured duration is rendered on the confirmation screen with a
 * `data-testid` so `tests/e2e/submit-flow.spec.ts` can assert a value was
 * recorded (card acceptance criterion 5).
 *
 * Offline queue-and-sync (T5.3): capture itself never blocks on
 * connectivity (card anti-requirement 3) — compression and EXIF parsing
 * are local. Only the network leg (sign -> upload -> submit) is
 * connectivity-gated: `isOffline()` (`lib/offline/sync.ts`) short-circuits
 * straight to `enqueueSubmission` (`lib/offline/queue.ts`) instead of
 * hitting the network, and the page shows a "queued" confirmation rather
 * than the real fraud-pipeline decision. `registerAutoSync` posts anything
 * queued as soon as the browser reports `online` (or immediately, if
 * already online on mount — covers a reload after reconnecting); this page
 * listens for its `OFFLINE_SYNC_EVENT` to refresh its own state if the sync
 * pass resolves *this* target's queued item while the page happens to
 * still be mounted. `findQueuedSubmissionForTarget` restores the
 * queued/already-filled state on reload (card requirement 5 — the queue
 * persists in IndexedDB, not memory).
 */
import { use, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/brand/StatCard";
import { parseJpegExif } from "@/lib/capture/exif";
import { compressImage } from "@/lib/capture/compress";
import {
  enqueueSubmission,
  findQueuedSubmissionForTarget,
} from "@/lib/offline/queue";
import {
  isOffline,
  OFFLINE_SYNC_EVENT,
  registerAutoSync,
  type SyncSummary,
} from "@/lib/offline/sync";

interface PageParams {
  id: string;
  targetId: string;
}

interface PageProps {
  params: Promise<PageParams>;
}

type Phase =
  | "requesting-location"
  | "location-denied"
  | "ready"
  | "processing"
  | "done"
  | "queued"
  | "queued-synced"
  | "already-filled"
  | "error";

interface ConfirmationState {
  decision: string;
  runningApprovedTotal: number;
  targetState: string;
  submitDurationMs: number;
}

interface SignUploadResponse {
  uploadUrl: string;
  key: string;
  submissionId: string;
}

interface SubmissionErrorBody {
  error?: { code?: string; message?: string };
}

async function readAsArrayBuffer(file: Blob): Promise<ArrayBuffer> {
  return await file.arrayBuffer();
}

function getCurrentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Geolocation is not available in this browser."));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15_000,
    });
  });
}

/**
 * Shared centered card wrapper for every capture-flow screen — keeps the
 * mobile-first, thumb-reachable vertical centering the flow had while giving
 * each state the field-guide bordered-card surface.
 */
function CaptureCard({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center p-6">
      <div className="flex flex-col gap-4 rounded-2xl border-2 border-foreground/15 bg-card p-6">
        {children}
      </div>
    </main>
  );
}

export default function SubmitCapturePage({ params }: PageProps) {
  const { id: campaignId, targetId } = use(params);

  const [phase, setPhase] = useState<Phase>("requesting-location");
  const [position, setPosition] = useState<GeolocationPosition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(
    null,
  );
  // Requirement 7 (EC-2 instrumentation): stamped once, at mount — see
  // module doc comment for why this is the "camera open" proxy. Set inside
  // an effect (not during render) per React's rules-of-hooks purity rule.
  const captureOpenedAtRef = useRef<number>(0);

  // No synchronous `setState` before the first `await` (react-hooks'
  // set-state-in-effect rule) so this is safe to invoke directly from the
  // mount effect below; `handleRetryLocation` is the synchronous-setState
  // variant used by the "Try again" button's click handler.
  const attemptGetLocation = useCallback(async () => {
    try {
      const pos = await getCurrentPosition();
      setPosition(pos);
      // Functional update, guarded: the offline-queue "restore" effect
      // (below) resolves from IndexedDB concurrently and may already have
      // moved `phase` to `"queued"`/`"already-filled"` for this exact
      // target — geolocation resolving afterward must not stomp that
      // terminal state back to the fresh-capture screen.
      setPhase((prev) => (prev === "requesting-location" ? "ready" : prev));
    } catch {
      // Requirement 3: GPS denial hard-blocks submission with a clear
      // message — never silently proceeds without device GPS.
      setPhase((prev) =>
        prev === "requesting-location" ? "location-denied" : prev,
      );
    }
  }, []);

  const handleRetryLocation = useCallback(() => {
    setPhase("requesting-location");
    setError(null);
    void attemptGetLocation();
  }, [attemptGetLocation]);

  // Kick off the timestamp + permission request once, on mount. The
  // `set-state-in-effect` rule flags this on the (correct, general)
  // assumption that an effect shouldn't drive component state directly —
  // but `attemptGetLocation` only calls a setter after its `await`
  // resolves, which is the standard, React-docs-sanctioned "fetch once on
  // mount" shape; there is no *synchronous* setState here for the rule's
  // cascading-render concern to apply to.
  useEffect(() => {
    captureOpenedAtRef.current = performance.now();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void attemptGetLocation();
  }, [attemptGetLocation]);

  // Offline queue (T5.3), part 1: restore a "queued"/"already-filled" state
  // left over from a previous mount of *this exact target* (card
  // requirement 5 — the queue survives a reload; without this check, a
  // reload after an offline capture would silently drop back to the
  // camera-ready screen even though a submission is sitting in IndexedDB).
  useEffect(() => {
    let cancelled = false;
    void findQueuedSubmissionForTarget(campaignId, targetId).then(
      (existing) => {
        if (cancelled || !existing) return;
        if (existing.status === "already_filled") {
          setPhase("already-filled");
        } else if (existing.status === "queued") {
          // Batch-5 review fix (Linus): "syncing" is no longer a
          // persisted status (see `QueuedSubmissionStatus`'s doc
          // comment) — an in-flight item is still "queued" in
          // IndexedDB, so this single branch covers both "never
          // synced yet" and "a sync pass is currently working on it".
          setPhase("queued");
        }
        // status "failed": leave the normal capture flow to load below —
        // nothing terminal to restore, and the player should be able to
        // just try again.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [campaignId, targetId]);

  // Offline queue (T5.3), part 2: sync whatever's queued as soon as the
  // browser reports `online` (or immediately, if already online — covers a
  // reload after reconnecting while the app was closed), and react if
  // *this* target's queued item is the one a sync pass just resolved.
  useEffect(() => {
    function handleSyncEvent(event: Event) {
      const { detail } = event as CustomEvent<SyncSummary>;
      const match = detail.results.find(
        (r) => r.campaignId === campaignId && r.targetId === targetId,
      );
      if (!match) return;
      if (match.outcome === "already_filled") {
        setPhase("already-filled");
      } else if (match.outcome === "synced") {
        setPhase("queued-synced");
      }
      // "failed": nothing to restore here either — same reasoning as above.
    }
    window.addEventListener(OFFLINE_SYNC_EVENT, handleSyncEvent);
    const unregisterAutoSync = registerAutoSync();
    return () => {
      window.removeEventListener(OFFLINE_SYNC_EVENT, handleSyncEvent);
      unregisterAutoSync();
    };
  }, [campaignId, targetId]);

  const submitPhoto = useCallback(
    async (file: File, isGalleryFallback: boolean) => {
      if (!position) {
        setPhase("location-denied");
        return;
      }
      setPhase("processing");
      setError(null);

      try {
        // Capture never blocks on connectivity (card anti-requirement 3):
        // compression/EXIF parsing run regardless, and only the network leg
        // below branches on `isOffline()`.
        const [rawBytes, compressedBlob] = await Promise.all([
          readAsArrayBuffer(file),
          compressImage(file),
        ]);
        const exif = parseJpegExif(rawBytes);

        if (isOffline()) {
          await enqueueSubmission({
            campaignId,
            targetId,
            photoBlob: compressedBlob,
            deviceGps: {
              lat: position.coords.latitude,
              long: position.coords.longitude,
            },
            exifGps: exif.gps,
            exifTs: exif.timestamp ? exif.timestamp.toISOString() : null,
            clientTs: new Date().toISOString(),
            isGalleryFallback,
          });
          setPhase("queued");
          return;
        }

        const signRes = await fetch("/api/uploads/sign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campaignId, targetId }),
        });
        if (!signRes.ok) {
          throw new Error("Could not prepare the photo upload. Try again.");
        }
        const signed = (await signRes.json()) as SignUploadResponse;

        const uploadRes = await fetch(signed.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "image/jpeg" },
          body: compressedBlob,
        });
        if (!uploadRes.ok) {
          throw new Error("The photo upload failed. Try again.");
        }

        const submitRes = await fetch(
          `/api/campaigns/${campaignId}/submissions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              targetId,
              submissionId: signed.submissionId,
              photoKey: signed.key,
              deviceGps: {
                lat: position.coords.latitude,
                long: position.coords.longitude,
              },
              exifGps: exif.gps,
              exifTs: exif.timestamp ? exif.timestamp.toISOString() : null,
              clientTs: new Date().toISOString(),
              isGalleryFallback,
            }),
          },
        );

        if (!submitRes.ok) {
          const body = (await submitRes
            .json()
            .catch(() => null)) as SubmissionErrorBody | null;
          throw new Error(
            body?.error?.message ?? "The submission could not be processed.",
          );
        }

        const result = (await submitRes.json()) as {
          decision: string;
          runningApprovedTotal: number;
          targetState: string;
        };

        const submitDurationMs =
          (typeof performance !== "undefined"
            ? performance.now()
            : Date.now()) - captureOpenedAtRef.current;

        setConfirmation({
          decision: result.decision,
          runningApprovedTotal: result.runningApprovedTotal,
          targetState: result.targetState,
          submitDurationMs,
        });
        setPhase("done");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
        setPhase("error");
      }
    },
    [campaignId, targetId, position],
  );

  if (phase === "location-denied") {
    return (
      <CaptureCard>
        <h1 className="font-heading text-xl font-bold">
          Location access required
        </h1>
        <p className="text-sm text-muted-foreground">
          This platform verifies your placement with your device&apos;s
          location. Please allow location access to submit a photo.
        </p>
        <Button className="h-11 w-full text-base" onClick={handleRetryLocation}>
          Try again
        </Button>
      </CaptureCard>
    );
  }

  if (phase === "queued") {
    return (
      <CaptureCard>
        <h1 className="font-heading text-xl font-bold">
          Queued — will submit when online
        </h1>
        <p
          data-testid="offline-queued-message"
          className="text-sm text-muted-foreground"
        >
          You&apos;re offline. Your photo is saved on this device and will be
          submitted automatically as soon as you&apos;re back online.
        </p>
      </CaptureCard>
    );
  }

  if (phase === "queued-synced") {
    return (
      <CaptureCard>
        <h1 className="font-heading text-xl font-bold">Submitted</h1>
        <p
          data-testid="offline-synced-message"
          className="text-sm text-muted-foreground"
        >
          Your queued flier photo was submitted now that you&apos;re back
          online, and is in the normal review flow.
        </p>
      </CaptureCard>
    );
  }

  if (phase === "already-filled") {
    return (
      <CaptureCard>
        <h1 className="font-heading text-xl font-bold">
          Target already filled
        </h1>
        <p
          data-testid="offline-already-filled-message"
          className="text-sm text-muted-foreground"
        >
          While you were offline, this target was filled or closed by someone
          else. Your queued photo was not submitted or paid — please claim a
          different target.
        </p>
      </CaptureCard>
    );
  }

  if (phase === "done" && confirmation) {
    return (
      <CaptureCard>
        <h1 className="font-heading text-xl font-bold">
          {confirmation.decision === "approved"
            ? "Placement approved!"
            : confirmation.decision === "rejected"
              ? "Submission rejected"
              : "Submitted — under review"}
        </h1>
        <p className="text-sm text-muted-foreground">
          Target status:{" "}
          <span className="font-mono text-foreground">
            {confirmation.targetState}
          </span>
        </p>
        <StatCard
          label="Your approved total"
          value={confirmation.runningApprovedTotal}
        />
        <p
          data-testid="submit-duration-ms"
          data-value={Math.round(confirmation.submitDurationMs)}
          className="font-mono text-xs text-muted-foreground"
        >
          Submitted in {Math.round(confirmation.submitDurationMs)}ms
        </p>
      </CaptureCard>
    );
  }

  return (
    <CaptureCard>
      <h1 className="font-heading text-xl font-bold">Post your flier</h1>

      {phase === "requesting-location" ? (
        <p className="text-sm text-muted-foreground">Getting your location…</p>
      ) : null}

      <label
        data-testid="camera-capture-input"
        className="flex h-14 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-foreground/15 bg-primary text-base font-medium text-primary-foreground transition-transform active:translate-y-px data-disabled:pointer-events-none data-disabled:opacity-50"
        data-disabled={phase !== "ready" ? "" : undefined}
      >
        {phase === "processing" ? "Submitting…" : "Take a photo"}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          disabled={phase !== "ready"}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void submitPhoto(file, false);
          }}
        />
      </label>

      <label
        data-testid="gallery-fallback-input"
        className="flex h-11 w-full cursor-pointer items-center justify-center rounded-xl border-2 border-foreground/15 bg-card text-sm text-muted-foreground data-disabled:pointer-events-none data-disabled:opacity-50"
        data-disabled={phase !== "ready" ? "" : undefined}
      >
        Choose from gallery instead
        <input
          type="file"
          accept="image/*"
          disabled={phase !== "ready"}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void submitPhoto(file, true);
          }}
        />
      </label>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </CaptureCard>
  );
}
