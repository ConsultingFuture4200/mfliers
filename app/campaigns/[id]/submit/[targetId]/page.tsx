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
 */
import { use, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { parseJpegExif } from "@/lib/capture/exif";
import { compressImage } from "@/lib/capture/compress";

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
      setPhase("ready");
    } catch {
      // Requirement 3: GPS denial hard-blocks submission with a clear
      // message — never silently proceeds without device GPS.
      setPhase("location-denied");
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

  const submitPhoto = useCallback(
    async (file: File, isGalleryFallback: boolean) => {
      if (!position) {
        setPhase("location-denied");
        return;
      }
      setPhase("processing");
      setError(null);

      try {
        const [rawBytes, compressedBlob] = await Promise.all([
          readAsArrayBuffer(file),
          compressImage(file),
        ]);
        const exif = parseJpegExif(rawBytes);

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
      <main className="mx-auto flex max-w-sm flex-1 flex-col justify-center gap-4 p-6">
        <h1 className="text-lg font-semibold">Location access required</h1>
        <p className="text-sm text-muted-foreground">
          This platform verifies your placement with your device&apos;s
          location. Please allow location access to submit a photo.
        </p>
        <Button onClick={handleRetryLocation}>Try again</Button>
      </main>
    );
  }

  if (phase === "done" && confirmation) {
    return (
      <main className="mx-auto flex max-w-sm flex-1 flex-col justify-center gap-3 p-6">
        <h1 className="text-lg font-semibold">
          {confirmation.decision === "approved"
            ? "Placement approved!"
            : confirmation.decision === "rejected"
              ? "Submission rejected"
              : "Submitted — under review"}
        </h1>
        <p className="text-sm text-muted-foreground">
          Target status: {confirmation.targetState}
        </p>
        <p className="text-sm text-muted-foreground">
          Your approved total: {confirmation.runningApprovedTotal}
        </p>
        <p
          data-testid="submit-duration-ms"
          data-value={Math.round(confirmation.submitDurationMs)}
          className="text-xs text-muted-foreground"
        >
          Submitted in {Math.round(confirmation.submitDurationMs)}ms
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-sm flex-1 flex-col justify-center gap-4 p-6">
      <h1 className="text-lg font-semibold">Post your flier</h1>

      {phase === "requesting-location" ? (
        <p className="text-sm text-muted-foreground">Getting your location…</p>
      ) : null}

      <label
        data-testid="camera-capture-input"
        className="flex h-10 cursor-pointer items-center justify-center rounded-lg bg-primary text-sm font-medium text-primary-foreground data-disabled:pointer-events-none data-disabled:opacity-50"
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
        className="flex h-9 cursor-pointer items-center justify-center rounded-lg border border-input text-sm text-muted-foreground data-disabled:pointer-events-none data-disabled:opacity-50"
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
    </main>
  );
}
