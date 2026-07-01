import { describe, expect, it } from "vitest";
import { classifySyncFailure, classifyUploadFailure } from "@/lib/offline/sync";
import { deriveOfflineSubmissionId } from "@/lib/capture/submit";

/**
 * Pure-logic unit tests for `lib/offline/sync.ts`'s `classifySyncFailure`
 * (T5.3). The rest of `lib/offline/sync.ts` (and all of `lib/offline/
 * queue.ts`) needs a real `indexedDB`/`fetch`, which Vitest's `node`
 * environment (`vitest.config.ts`) doesn't provide — verified for real
 * against a Chromium browser instead by `tests/e2e/offline-sync.spec.ts`
 * (same split `lib/capture/compress.ts`'s tests document).
 */
describe("classifySyncFailure", () => {
  it("classifies a 403 (no active claim) from the sign step as already_filled", () => {
    expect(classifySyncFailure(403, "forbidden")).toBe("already_filled");
  });

  it("classifies a 409 target_not_claimed from the submit step as already_filled", () => {
    expect(classifySyncFailure(409, "target_not_claimed")).toBe(
      "already_filled",
    );
  });

  it("classifies an unrelated 4xx as failed, not already_filled", () => {
    expect(classifySyncFailure(400, "invalid_submission_input")).toBe("failed");
    expect(classifySyncFailure(404, "not_found")).toBe("failed");
  });

  it("classifies a 5xx as retry (transient)", () => {
    expect(classifySyncFailure(502, undefined)).toBe("retry");
    expect(classifySyncFailure(500, "internal_error")).toBe("retry");
  });

  it("classifies an unparseable error body (code undefined) with a 4xx status as failed", () => {
    expect(classifySyncFailure(422, undefined)).toBe("failed");
  });
});

/**
 * `classifyUploadFailure` is the R2 signed-PUT step's own classifier
 * (Linus batch-5 review) — deliberately separate from `classifySyncFailure`
 * so a storage-layer 403 (bad/expired signature) is never confused with the
 * sign/submit steps' claim-aware 403/409 ("already filled").
 */
describe("classifyUploadFailure", () => {
  it("never classifies a 403 from the upload PUT as already_filled", () => {
    expect(classifyUploadFailure(403)).not.toBe("already_filled");
    expect(classifyUploadFailure(403)).toBe("failed");
  });

  it("classifies other 4xx as failed", () => {
    expect(classifyUploadFailure(400)).toBe("failed");
    expect(classifyUploadFailure(404)).toBe("failed");
  });

  it("classifies 5xx as retry (transient)", () => {
    expect(classifyUploadFailure(500)).toBe("retry");
    expect(classifyUploadFailure(503)).toBe("retry");
  });
});

/**
 * `deriveOfflineSubmissionId` (Liotta batch-5 review) — the offline-sync
 * idempotency key: every retry/concurrent sync pass for the same queued
 * item must resolve to the *same* submissionId, or it defeats
 * `submitCapture`'s (campaignId, submissionId) idempotency and can
 * double-pay a target.
 */
describe("deriveOfflineSubmissionId", () => {
  it("is deterministic for the same (campaignId, idempotencyKey) pair", () => {
    const a = deriveOfflineSubmissionId("campaign-1", "queue-item-1");
    const b = deriveOfflineSubmissionId("campaign-1", "queue-item-1");
    expect(a).toBe(b);
  });

  it("differs across different idempotency keys or campaigns", () => {
    const base = deriveOfflineSubmissionId("campaign-1", "queue-item-1");
    expect(deriveOfflineSubmissionId("campaign-1", "queue-item-2")).not.toBe(
      base,
    );
    expect(deriveOfflineSubmissionId("campaign-2", "queue-item-1")).not.toBe(
      base,
    );
  });

  it("returns a well-formed (v5-shaped) UUID string", () => {
    const id = deriveOfflineSubmissionId("campaign-1", "queue-item-1");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
