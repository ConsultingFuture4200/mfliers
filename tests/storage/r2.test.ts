/**
 * R2 storage tests (T2.4). Runs against a real S3-compatible mock (MinIO)
 * rather than mocking the AWS SDK — same "verify for real" preference
 * `tests/isolation/isolation.test.ts` and `tests/fixtures/seed-two-
 * campaigns.test.ts` establish for DB-backed tests, applied to object
 * storage: a presigned-URL bug (wrong signature, wrong key, wrong bucket)
 * is exactly the kind of thing a mocked `S3Client` would hide.
 *
 * Skips gracefully (not fail) when no test endpoint is configured, the
 * same pattern `tests/setup.ts`'s `hasTestDatabase()` uses — set
 * `R2_TEST_ENDPOINT` (e.g. `http://127.0.0.1:9010` for a local
 * `minio/minio` container) to run these for real.
 */
import { Buffer } from "node:buffer";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { R2Config } from "@/lib/storage/r2";
import {
  createSignedUploadUrl,
  deleteCampaignObjects,
  submissionPhotoKey,
} from "@/lib/storage/r2";

const TEST_ENDPOINT = process.env.R2_TEST_ENDPOINT;

function hasTestR2(): boolean {
  return Boolean(TEST_ENDPOINT);
}

const testConfig: R2Config = {
  accountId: "test-account",
  accessKeyId: process.env.R2_TEST_ACCESS_KEY_ID ?? "minioadmin",
  secretAccessKey: process.env.R2_TEST_SECRET_ACCESS_KEY ?? "minioadmin",
  bucket: "mfliers-test-bucket",
  endpoint: TEST_ENDPOINT,
};

describe.skipIf(!hasTestR2())(
  "lib/storage/r2 (live S3-compatible mock)",
  () => {
    let rawClient: S3Client;

    beforeAll(async () => {
      rawClient = new S3Client({
        region: "auto",
        endpoint: TEST_ENDPOINT,
        forcePathStyle: true,
        credentials: {
          accessKeyId: testConfig.accessKeyId,
          secretAccessKey: testConfig.secretAccessKey,
        },
      });
      try {
        await rawClient.send(
          new HeadBucketCommand({ Bucket: testConfig.bucket }),
        );
      } catch {
        await rawClient.send(
          new CreateBucketCommand({ Bucket: testConfig.bucket }),
        );
      }
    });

    afterAll(async () => {
      rawClient.destroy();
    });

    it("follows the `campaignId/submissionId.jpg` key convention", () => {
      expect(submissionPhotoKey("camp-a", "sub-1")).toBe("camp-a/sub-1.jpg");
    });

    it("rejects an empty campaignId or submissionId", () => {
      expect(() => submissionPhotoKey("", "sub-1")).toThrow();
      expect(() => submissionPhotoKey("camp-a", "")).toThrow();
    });

    it("issues a signed URL scoped to exactly the expected key, and the uploaded object is retrievable by that key", async () => {
      const campaignId = `camp-${Date.now()}-a`;
      const submissionId = "sub-1";
      const expectedKey = submissionPhotoKey(campaignId, submissionId);

      const signed = await createSignedUploadUrl(
        campaignId,
        submissionId,
        testConfig,
      );

      expect(signed.key).toBe(expectedKey);
      expect(signed.url).toContain(
        encodeURIComponent(expectedKey).replace(/%2F/g, "/"),
      );

      const body = Buffer.from("fake-jpeg-bytes");
      const putResponse = await fetch(signed.url, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body,
      });
      expect(putResponse.ok).toBe(true);

      const getResult = await rawClient.send(
        new GetObjectCommand({ Bucket: testConfig.bucket, Key: expectedKey }),
      );
      const retrieved = await getResult.Body?.transformToByteArray();
      expect(Buffer.from(retrieved ?? [])).toEqual(body);
    });

    it("a signed URL cannot be used to write to a different key than the one it was issued for", async () => {
      const campaignId = `camp-${Date.now()}-b`;
      const signed = await createSignedUploadUrl(
        campaignId,
        "sub-1",
        testConfig,
      );

      // Swap the signed key for a sibling key in the same campaign — the
      // signature only covers the exact key/host/params it was issued for,
      // so this must be rejected by the store, not silently accepted.
      const tamperedUrl = signed.url.replace("sub-1.jpg", "sub-2.jpg");
      const response = await fetch(tamperedUrl, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: Buffer.from("should-not-land"),
      });
      expect(response.ok).toBe(false);
    });

    it("the prefix-delete helper removes only the targeted campaign's objects", async () => {
      const campaignA = `camp-${Date.now()}-purge-a`;
      const campaignB = `camp-${Date.now()}-purge-b`;

      for (const [campaignId, submissionId] of [
        [campaignA, "s1"],
        [campaignA, "s2"],
        [campaignB, "s1"],
      ] as const) {
        const signed = await createSignedUploadUrl(
          campaignId,
          submissionId,
          testConfig,
        );
        const res = await fetch(signed.url, {
          method: "PUT",
          headers: { "Content-Type": "image/jpeg" },
          body: Buffer.from("x"),
        });
        expect(res.ok).toBe(true);
      }

      const result = await deleteCampaignObjects(campaignA, testConfig);
      expect(result.deletedKeys.sort()).toEqual(
        [
          submissionPhotoKey(campaignA, "s1"),
          submissionPhotoKey(campaignA, "s2"),
        ].sort(),
      );

      const remainingA = await rawClient.send(
        new ListObjectsV2Command({
          Bucket: testConfig.bucket,
          Prefix: `${campaignA}/`,
        }),
      );
      expect(remainingA.Contents ?? []).toHaveLength(0);

      const remainingB = await rawClient.send(
        new ListObjectsV2Command({
          Bucket: testConfig.bucket,
          Prefix: `${campaignB}/`,
        }),
      );
      expect(remainingB.Contents ?? []).toHaveLength(1);
      expect(remainingB.Contents?.[0]?.Key).toBe(
        submissionPhotoKey(campaignB, "s1"),
      );
    });

    it("loadR2ConfigFromEnv throws when a required R2_* var is missing (no secret silently defaults)", async () => {
      const { loadR2ConfigFromEnv } = await import("@/lib/storage/r2");
      const saved = process.env.R2_ACCOUNT_ID;
      delete process.env.R2_ACCOUNT_ID;
      try {
        expect(() => loadR2ConfigFromEnv()).toThrow(/R2_ACCOUNT_ID/);
      } finally {
        if (saved !== undefined) process.env.R2_ACCOUNT_ID = saved;
      }
    });
  },
);
