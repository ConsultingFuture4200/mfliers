/**
 * Offline submission queue — client-side IndexedDB persistence (T5.3).
 *
 * PRD risk note quoted in `docs/tasks/batch-5.md`: "offline-sync conflict
 * path surfaces 'already filled' cleanly." Canvassers work in cell dead
 * zones — a captured photo (T4.1's capture page) must be queued locally
 * when the device is offline, and that queue must survive an app
 * reload (card requirement 5: "queue survives app reload (persisted, not
 * in-memory)"). `localStorage`/an in-memory array can't hold a `Blob`
 * (the compressed photo) without a lossy base64 round-trip, and every
 * modern browser's `IndexedDB` stores `Blob`s natively — so this module is
 * a thin, dependency-free wrapper around the browser's `indexedDB` global,
 * not a third-party queue library (matches this repo's `lib/capture/
 * exif.ts` precedent of a narrow, dependency-free browser module).
 *
 * Browser-only (the `indexedDB` global doesn't exist under Node/Vitest's
 * `environment: "node"`, per `vitest.config.ts`) — verified for real against
 * a real Chromium `IndexedDB` by `tests/e2e/offline-sync.spec.ts`, the same
 * "browser-only module -> Playwright e2e, not Vitest" split
 * `lib/capture/compress.ts` already documents. Pure decision logic that
 * *doesn't* need a real IndexedDB (ordering, conflict classification) lives
 * in `lib/offline/sync.ts` and is unit-tested under Vitest instead.
 */
import type { Coordinate } from "@/types/domain";

const DB_NAME = "mfliers-offline-queue";
const DB_VERSION = 1;
const STORE_NAME = "queued-submissions";

/** A queued submission's lifecycle. `"queued"` — waiting for reconnect (or
 * a durable resume point: see below); `"already_filled"` — the sync
 * discovered the target was filled/closed while this item was queued (card
 * requirement 3 — terminal, never retried); `"failed"` — the server
 * rejected the submission for a reason unrelated to connectivity (terminal;
 * surfaced, never silently retried forever). A synced-successfully item is
 * deleted from the store outright rather than kept with a `"synced"`
 * status — nothing in this card's acceptance criteria needs a persisted
 * synced-history log, and keeping the store small keeps every
 * `listQueuedSubmissions` scan cheap.
 *
 * Deliberately no persisted `"syncing"` status (Linus batch-5 review): an
 * item marked `"syncing"` in IndexedDB and then orphaned by a crash/
 * backgrounding mid-sync would never be picked up again by any future sync
 * pass, since every pass only ever looks at `"queued"` items — permanently
 * losing the submission on the exact "canvasser in a dead zone, phone dies
 * mid-sync" scenario this whole feature exists for. `lib/offline/sync.ts`
 * now keeps its "don't double-POST an in-flight item" guard as an
 * in-memory `Set<queueId>` instead — naturally cleared on reload, so a
 * crash mid-sync always resumes as `"queued"` on the next pass. */
export type QueuedSubmissionStatus = "queued" | "already_filled" | "failed";

/** Everything the capture page (T4.1) captured, minus the already-sent
 * signed-upload step — the signed URL is requested fresh at *sync* time
 * (`lib/offline/sync.ts`), since it's short-lived and, per `app/api/
 * uploads/sign/route.ts`, requires the caller to currently hold the claim —
 * exactly the check that surfaces the "already filled" conflict on
 * reconnect. */
export interface QueuedSubmissionInput {
  campaignId: string;
  targetId: string;
  /** The already-compressed photo (`lib/capture/compress.ts`'s
   * `compressImage` output) — compression happens at capture time,
   * regardless of connectivity, so the queued payload is exactly what an
   * online submit would have uploaded. */
  photoBlob: Blob;
  deviceGps: Coordinate;
  exifGps: Coordinate | null;
  /** ISO 8601, or `null` — mirrors `SubmitCaptureInput.exifTs`. */
  exifTs: string | null;
  /** ISO 8601 client capture time, stamped once at enqueue (never
   * re-stamped at sync time — the server's `receivedAt` is the only
   * authoritative clock per constitution §4, this is purely the same
   * best-effort diagnostic field the online path already sends). */
  clientTs: string;
  isGalleryFallback: boolean;
}

/** A persisted queue record — `QueuedSubmissionInput` plus the fields this
 * module owns. */
export interface QueuedSubmission extends QueuedSubmissionInput {
  /** Client-minted primary key for this queue row (distinct from the
   * server submission id, which isn't minted until sync time asks `/api/
   * uploads/sign` for one — see module doc comment). */
  queueId: string;
  /** ISO 8601 — when this item was enqueued; `listQueuedSubmissions` orders
   * by this ascending so sync posts in capture order (card requirement 2:
   * "in order"). */
  queuedAt: string;
  status: QueuedSubmissionStatus;
  /** Set when `status` is `"failed"` — the server's error message, so the
   * UI/logs can show why. */
  lastError?: string;
}

function openQueueDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "queueId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openQueueDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        const request = fn(store);
        tx.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? request.error);
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error("offline queue transaction aborted"));
        };
      }),
  );
}

/** Persists a newly-captured offline submission and returns the stored
 * record (card requirement 1). Never throws away a photo that couldn't be
 * uploaded live — this is the fallback path itself. */
export async function enqueueSubmission(
  input: QueuedSubmissionInput,
): Promise<QueuedSubmission> {
  const record: QueuedSubmission = {
    ...input,
    queueId:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    queuedAt: new Date().toISOString(),
    status: "queued",
  };
  await runTransaction("readwrite", (store) => store.add(record));
  return record;
}

/** All queued submissions, oldest-first (card requirement 2: sync "in
 * order"). Includes every status, not just `"queued"` — the capture page
 * uses this to show an `"already_filled"`/`"failed"` outcome for a target
 * it's currently displaying even after a sync pass already resolved it. */
export async function listQueuedSubmissions(): Promise<QueuedSubmission[]> {
  const all = await runTransaction<QueuedSubmission[]>("readonly", (store) =>
    store.getAll(),
  );
  return [...all].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

/** Convenience read for a single (campaignId, targetId) pair — the capture
 * page uses this on mount to restore a `"queued"`/`"already_filled"` UI
 * state after a reload (card requirement 5), without needing to scan every
 * queued item itself. Returns the newest matching record, if more than one
 * ever queues for the same target. */
export async function findQueuedSubmissionForTarget(
  campaignId: string,
  targetId: string,
): Promise<QueuedSubmission | null> {
  const all = await listQueuedSubmissions();
  const matches = all.filter(
    (item) => item.campaignId === campaignId && item.targetId === targetId,
  );
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

/** Updates a queued record's status (and optional `lastError`) in place.
 * Used by `lib/offline/sync.ts` as it works through the queue. */
export async function updateQueuedSubmissionStatus(
  queueId: string,
  status: QueuedSubmissionStatus,
  lastError?: string,
): Promise<void> {
  await runTransaction("readwrite", (store) => {
    const getRequest = store.get(queueId);
    getRequest.onsuccess = () => {
      const existing = getRequest.result as QueuedSubmission | undefined;
      if (!existing) return;
      store.put({ ...existing, status, lastError });
    };
    return getRequest;
  });
}

/** Removes a queue record outright — used once a submission has
 * successfully synced (see `QueuedSubmissionStatus` doc comment for why a
 * synced item isn't kept around). */
export async function deleteQueuedSubmission(queueId: string): Promise<void> {
  await runTransaction("readwrite", (store) => store.delete(queueId));
}
