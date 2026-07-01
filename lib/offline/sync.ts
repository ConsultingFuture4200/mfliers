/**
 * Offline queue sync — posts queued submissions (`lib/offline/queue.ts`) to
 * the existing T4.1 submit flow on reconnect (T5.3).
 *
 * Design intent (`docs/tasks/batch-5.md`'s T5.3 context): a queued item
 * skipped the signed-upload step at capture time (no network), so syncing
 * an item replays the *whole* online path in order — `POST /api/uploads/
 * sign` (T2.4), `PUT` the compressed photo to the signed URL, then `POST
 * /api/campaigns/[id]/submissions` (T4.1) — rather than assuming a
 * still-valid signed URL or a server that already knows about the photo.
 *
 * Conflict detection (card requirement 3 — "target already filled"):
 * `/api/uploads/sign` 403s when the caller no longer holds an active claim
 * on the target (`app/api/uploads/sign/route.ts`'s `isActivelyClaimedBy`
 * check — the claim can have lapsed or the target can have been filled by
 * someone else while this device was offline), and `/api/campaigns/[id]/
 * submissions` 409s with `code: "target_not_claimed"` for the identical
 * reason (`lib/capture/submit.ts`'s `TargetNotClaimedError`) if a sync
 * lands after the sign step but the claim expires in between. Both are
 * treated as the same terminal outcome — `"already_filled"` — never
 * retried, never re-POSTed (constitution §3 anti-double-pay; card
 * anti-requirement: "do NOT allow a sync to double-pay a target that was
 * filled offline").
 *
 * `classifySyncFailure` is pure (status/code in, outcome out) and unit-
 * tested under Vitest (`tests/offline/sync.test.ts`) without a DOM.
 * `syncQueuedSubmissions` itself needs `fetch`/`indexedDB` and is verified
 * against a real Chromium browser by `tests/e2e/offline-sync.spec.ts` (the
 * same split `lib/offline/queue.ts`'s module doc comment describes).
 */
import {
  deleteQueuedSubmission,
  listQueuedSubmissions,
  updateQueuedSubmissionStatus,
  type QueuedSubmission,
} from "@/lib/offline/queue";

/** What a single sync attempt against one queued item resolved to.
 * `"synced"` — the submission was accepted (whatever fraud decision it
 * got — that's the normal post-submit flow's business, not this module's).
 * `"already_filled"` — see module doc comment; terminal.
 * `"retry"` — a connectivity-shaped failure (network error, 5xx); the item
 * stays `"queued"` for the next sync pass, and — since items must sync "in
 * order" (card requirement 2) — the whole run stops here rather than
 * skipping ahead to a later item out of order.
 * `"failed"` — the server rejected the item for a reason that isn't going
 * to resolve itself on retry (e.g. malformed input); terminal, but distinct
 * from `"already_filled"` so the UI can tell the two apart. */
export type SyncOutcome = "synced" | "already_filled" | "retry" | "failed";

/** Pure classifier for a non-OK HTTP response from either the sign step or
 * the submit step. `code` is the parsed `error.code` field this repo's
 * route handlers always return (see `app/api/campaigns/[id]/submissions/
 * route.ts`'s `KNOWN_ERRORS` shape) — `undefined` when the body couldn't be
 * parsed at all (typically itself a connectivity/5xx situation). */
export function classifySyncFailure(
  status: number,
  code: string | undefined,
): SyncOutcome {
  // The sign step's 403 ("no active claim") and the submit step's 409
  // (`target_not_claimed`) are the two ways this flow discovers "the
  // target moved on without you" — see module doc comment.
  if (status === 403 || code === "target_not_claimed") {
    return "already_filled";
  }
  // Any other 4xx is a real, non-connectivity problem with this specific
  // item (bad input, campaign no longer live, etc.) — retrying it
  // unmodified will never succeed.
  if (status >= 400 && status < 500) {
    return "failed";
  }
  // 5xx (or anything else unexpected) is treated as transient.
  return "retry";
}

/** Pure classifier for a non-OK HTTP response from the signed-upload PUT
 * to R2 — deliberately *not* `classifySyncFailure` (Linus batch-5 review).
 * That function's "403 -> already_filled" rule has real domain meaning for
 * the sign/submit steps, which actually know about claim/target state; an
 * R2 PUT 403 (or any other non-2xx) is a storage-layer error (bad/expired
 * signature, bucket policy, clock skew) with no relationship to claim
 * state, and misreporting it as "already filled" would wrongly tell the
 * player someone else took their target. A 4xx here most likely means the
 * fresh signed URL itself was somehow bad and won't fix itself by retrying
 * the *same* URL, but a later sync pass re-signs (a new URL/signature) and
 * may well succeed, so this is intentionally never `"already_filled"` and
 * mirrors `classifySyncFailure`'s general 4xx/5xx split without the
 * claim-specific 403 special case. */
export function classifyUploadFailure(status: number): SyncOutcome {
  if (status >= 400 && status < 500) {
    return "failed";
  }
  return "retry";
}

interface SignUploadResponseBody {
  uploadUrl: string;
  key: string;
  submissionId: string;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as ApiErrorBody;
    return body.error?.code;
  } catch {
    return undefined;
  }
}

/** One queued item's outcome, returned to the caller for UI/telemetry —
 * matched back to the page's own (campaignId, targetId) via
 * `findQueuedSubmissionForTarget` rather than carried directly, since the
 * page that queued an item may not be the page that's mounted when it
 * finally syncs. */
export interface SyncItemResult {
  queueId: string;
  campaignId: string;
  targetId: string;
  outcome: SyncOutcome;
}

export interface SyncSummary {
  results: SyncItemResult[];
  /** True if the run stopped early on a `"retry"` outcome (still offline,
   * or a transient server error) — some queued items were left untouched. */
  stoppedEarly: boolean;
}

/** The browser event this module dispatches on `window` after a sync pass
 * completes, so a mounted capture page can refresh its own state even
 * though the sync loop has no reference to any particular page (card
 * requirement: reconnect syncs automatically, not "only if you're staring
 * at the right tab"). */
export const OFFLINE_SYNC_EVENT = "mfliers:offline-sync";

function dispatchSyncEvent(summary: SyncSummary): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<SyncSummary>(OFFLINE_SYNC_EVENT, { detail: summary }),
  );
}

/** Posts one queued item through the sign -> upload -> submit sequence.
 * Returns the outcome; never throws for an ordinary HTTP error response
 * (only for something unexpected like a network exception, which the
 * caller treats identically to a 5xx — "retry"). */
async function syncOne(
  item: QueuedSubmission,
  fetchImpl: typeof fetch,
): Promise<SyncOutcome> {
  let signRes: Response;
  try {
    signRes = await fetchImpl("/api/uploads/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        campaignId: item.campaignId,
        targetId: item.targetId,
        // Idempotency key (Liotta batch-5 review): the client-minted
        // `queueId` is stable across every retry/concurrent sync attempt
        // for *this* queued item, unlike a freshly `randomUUID()`-minted
        // submissionId. The sign route derives a deterministic
        // `submissionId` from `(campaignId, idempotencyKey)` when this is
        // present (see `lib/capture/submit.ts`'s
        // `deriveOfflineSubmissionId`), so a retried or concurrently-
        // synced offline item always lands on the *same* submissionId and
        // rides the existing `submitCapture`/`accrue` idempotency-by-
        // `(campaignId, submissionId)` guarantees end-to-end, instead of
        // minting a second submission (and a second ledger accrual) for
        // the same target.
        idempotencyKey: item.queueId,
      }),
    });
  } catch {
    return "retry"; // no network — still offline
  }
  if (!signRes.ok) {
    return classifySyncFailure(signRes.status, await readErrorCode(signRes));
  }
  const signed = (await signRes.json()) as SignUploadResponseBody;

  let uploadRes: Response;
  try {
    uploadRes = await fetchImpl(signed.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: item.photoBlob,
    });
  } catch {
    return "retry";
  }
  if (!uploadRes.ok) {
    return classifyUploadFailure(uploadRes.status);
  }

  let submitRes: Response;
  try {
    submitRes = await fetchImpl(
      `/api/campaigns/${item.campaignId}/submissions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetId: item.targetId,
          submissionId: signed.submissionId,
          photoKey: signed.key,
          deviceGps: item.deviceGps,
          exifGps: item.exifGps,
          exifTs: item.exifTs,
          clientTs: item.clientTs,
          isGalleryFallback: item.isGalleryFallback,
        }),
      },
    );
  } catch {
    return "retry";
  }
  if (!submitRes.ok) {
    return classifySyncFailure(
      submitRes.status,
      await readErrorCode(submitRes),
    );
  }
  return "synced";
}

/** In-memory guard against double-posting an item that a concurrent
 * in-tab sync pass (e.g. the `online` listener racing `registerAutoSync`'s
 * immediate run) is already working on. Deliberately *not* persisted to
 * IndexedDB (Linus batch-5 review — see `lib/offline/queue.ts`'s
 * `QueuedSubmissionStatus` doc comment for why a durable `"syncing"` status
 * can permanently orphan a queued item): a module-level `Set` is scoped to
 * this tab's lifetime and is naturally cleared on reload, so a crash mid-
 * sync always resumes from the still-`"queued"` IndexedDB record on the
 * next pass rather than being silently excluded forever. */
const inFlightQueueIds = new Set<string>();

/**
 * Works through every queued submission, oldest-first (card requirement 2),
 * posting each through the real submit flow. Stops as soon as an item
 * comes back `"retry"` (still offline / transient) so later items stay
 * queued in order rather than syncing out of sequence. A `"synced"` item is
 * deleted from the queue; `"already_filled"`/`"failed"` items are marked
 * terminal in place (never retried — see `classifySyncFailure`'s doc
 * comment). Safe to call repeatedly/concurrently: an item already being
 * worked on by an in-flight call (tracked in `inFlightQueueIds`, not
 * persisted — see that constant's doc comment) is skipped, not
 * double-posted.
 */
export async function syncQueuedSubmissions(
  fetchImpl: typeof fetch = fetch,
): Promise<SyncSummary> {
  const queued = (await listQueuedSubmissions()).filter(
    (item) => item.status === "queued" && !inFlightQueueIds.has(item.queueId),
  );

  const results: SyncItemResult[] = [];
  let stoppedEarly = false;

  for (const item of queued) {
    inFlightQueueIds.add(item.queueId);
    let outcome: SyncOutcome;
    try {
      outcome = await syncOne(item, fetchImpl);
    } finally {
      inFlightQueueIds.delete(item.queueId);
    }

    if (outcome === "retry") {
      // Already still "queued" in IndexedDB — nothing to persist. Don't
      // touch later items either, preserving submit order on the next
      // sync attempt.
      stoppedEarly = true;
      break;
    }

    if (outcome === "synced") {
      await deleteQueuedSubmission(item.queueId);
    } else {
      await updateQueuedSubmissionStatus(item.queueId, outcome);
    }

    results.push({
      queueId: item.queueId,
      campaignId: item.campaignId,
      targetId: item.targetId,
      outcome,
    });
  }

  const summary: SyncSummary = { results, stoppedEarly };
  dispatchSyncEvent(summary);
  return summary;
}

/** True when the browser reports no network connectivity. Guarded for a
 * non-browser context (SSR module import) the same way `lib/capture/
 * compress.ts` guards its own DOM access — importing this module must stay
 * safe from a server render pass. */
export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Registers a `window` `online` listener that triggers a sync pass, and
 * runs one immediately if the browser is already online (covers "the app
 * was reloaded after reconnecting while it was closed" — the queue
 * persisted, but no `online` event will ever fire again for a connection
 * that was already up when the page loaded). Returns an unsubscribe
 * function for the caller's effect cleanup.
 */
export function registerAutoSync(fetchImpl: typeof fetch = fetch): () => void {
  const run = () => {
    void syncQueuedSubmissions(fetchImpl);
  };
  if (typeof window === "undefined") {
    return () => {};
  }
  if (!isOffline()) {
    run();
  }
  window.addEventListener("online", run);
  return () => window.removeEventListener("online", run);
}
