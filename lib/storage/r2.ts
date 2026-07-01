/**
 * Cloudflare R2 storage client + signed-upload helpers (T2.4).
 *
 * Constitution §2 storage: Cloudflare R2 (zero egress on repeated audit
 * reads). Constitution §5: object storage encrypted at rest (provider-
 * managed); secrets in env only, nothing secret in a client bundle.
 *
 * R2 is S3-compatible, so this uses the AWS SDK v3 S3 client pointed at
 * R2's S3-compatible endpoint (`https://<account>.r2.cloudflarestorage.com`)
 * rather than a Cloudflare-specific SDK — R2's own docs recommend this.
 *
 * Design intent (card): the client requests a signed PUT URL, uploads the
 * already client-compressed image directly to R2 (this module never
 * touches image bytes — no server-side compression here, that's T4.1's
 * capture flow), and the resulting key is stored as the submission's
 * `photo_url`. Keys are `${campaignId}/${submissionId}.jpg` so a 90-day
 * retention purge (a future scheduler, out of scope here) is a single
 * prefix-delete per campaign.
 *
 * Every exported function accepts an optional `S3Client`/config override
 * so callers (and tests, against a local S3-compatible mock such as MinIO)
 * never have to mutate `process.env` to substitute a client — mirrors the
 * lazy, injectable-client pattern `lib/auth/twilio.ts` uses for the same
 * reason (importing this module must not throw before env vars are set,
 * e.g. during `pnpm build`'s static analysis pass).
 */
import { Buffer } from "node:buffer";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/** Explicit R2 client configuration. See `.env.example` for the matching
 * `R2_*` env vars this is normally built from (`loadR2ConfigFromEnv`). */
export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /**
   * Overrides the derived `https://<accountId>.r2.cloudflarestorage.com`
   * endpoint. Not part of `.env.example` (R2 doesn't need it in
   * production) — exists solely so tests can point this client at a local
   * S3-compatible mock instead of live Cloudflare infrastructure.
   */
  endpoint?: string;
}

/** How long a signed PUT URL remains valid for. Short-lived per the card
 * ("short-lived signed PUT URL") — long enough for a client to complete a
 * single already-compressed photo upload, short enough that a leaked URL
 * (e.g. in a proxy log) is a narrow window, not a standing credential. */
export const SIGNED_UPLOAD_URL_TTL_SECONDS = 5 * 60;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required (env only — constitution §5/§8). See .env.example.`,
    );
  }
  return value;
}

/** Builds an `R2Config` from `process.env`. Throws if any required `R2_*`
 * var is missing — called lazily (only when a client is actually needed),
 * never at module load, so importing this module is side-effect-free. */
export function loadR2ConfigFromEnv(): R2Config {
  return {
    accountId: requiredEnv("R2_ACCOUNT_ID"),
    accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    bucket: requiredEnv("R2_BUCKET_NAME"),
  };
}

let cachedClient: S3Client | undefined;
let cachedConfig: R2Config | undefined;

/**
 * Returns an S3-compatible client for R2, constructed from `config` (or
 * lazily from env on first call with no `config`). Caches the env-derived
 * client across calls the same way `lib/auth/twilio.ts` does; an explicit
 * `config` (used by tests) always builds a fresh, uncached client so tests
 * can point at different mock endpoints without cross-contaminating a
 * shared singleton.
 */
export function getR2Client(config?: R2Config): S3Client {
  if (config) {
    return new S3Client({
      region: "auto",
      endpoint:
        config.endpoint ??
        `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // R2 (and most S3-compatible mocks like MinIO) require path-style
      // addressing rather than the AWS-default virtual-hosted-style.
      forcePathStyle: true,
      // AWS SDK v3 >=3.729 defaults to the newer flexible-checksum
      // ("WHEN_SUPPORTED", trailer-based CRC32) request behavior, but R2
      // and older S3-compatible stores (e.g. the MinIO build these tests
      // run against) still expect the classic `Content-MD5` header for
      // operations like `DeleteObjects` that mandate body-integrity
      // checksums. "WHEN_REQUIRED" restores the pre-3.729 default (only
      // compute a checksum when the operation's spec requires one, via
      // the classic mechanism), which both R2 and MinIO understand.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  if (cachedClient) return cachedClient;
  cachedConfig = loadR2ConfigFromEnv();
  cachedClient = getR2Client(cachedConfig);
  return cachedClient;
}

function resolveBucket(config?: R2Config): string {
  return config?.bucket ?? cachedConfig?.bucket ?? loadR2ConfigFromEnv().bucket;
}

/** The retention-friendly key convention (card requirement 3): every
 * submission photo lives at `${campaignId}/${submissionId}.jpg`, so a
 * per-campaign purge (constitution §5: "purge photos + location 90 days
 * after campaign close") is a single prefix-delete. */
export function submissionPhotoKey(
  campaignId: string,
  submissionId: string,
): string {
  if (!campaignId)
    throw new Error("submissionPhotoKey: campaignId is required");
  if (!submissionId) {
    throw new Error("submissionPhotoKey: submissionId is required");
  }
  return `${campaignId}/${submissionId}.jpg`;
}

export interface SignedUploadUrl {
  /** The short-lived, presigned PUT URL the client uploads directly to. */
  url: string;
  /** The object key the upload will land at (`campaignId/submissionId.jpg`). */
  key: string;
  expiresInSeconds: number;
}

/**
 * Issues a short-lived signed PUT URL scoped to exactly one object key
 * (`${campaignId}/${submissionId}.jpg`) — card requirement 2. The caller
 * (a route handler) is responsible for authorizing the request before
 * calling this; this function only knows about object storage, not
 * players/sessions (constitution §6: domain logic in `lib/`, but storage
 * logic doesn't need to know about auth to do its one job).
 */
export async function createSignedUploadUrl(
  campaignId: string,
  submissionId: string,
  config?: R2Config,
): Promise<SignedUploadUrl> {
  const client = getR2Client(config);
  const bucket = resolveBucket(config);
  const key = submissionPhotoKey(campaignId, submissionId);

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: "image/jpeg",
  });

  const url = await getSignedUrl(client, command, {
    expiresIn: SIGNED_UPLOAD_URL_TTL_SECONDS,
  });

  return { url, key, expiresInSeconds: SIGNED_UPLOAD_URL_TTL_SECONDS };
}

/** How long a signed GET (read) URL remains valid for (T4.2's host review
 * queue: long enough for a host to review one queue page without the link
 * expiring mid-review, short enough that a leaked URL isn't a standing
 * credential — same "narrow window" reasoning as
 * `SIGNED_UPLOAD_URL_TTL_SECONDS`, just longer since this is a read, not a
 * one-shot upload). */
export const SIGNED_GET_URL_TTL_SECONDS = 15 * 60;

/**
 * Issues a short-lived signed GET URL for `${campaignId}/${submissionId}.jpg`
 * (T4.2 card requirement 2: the review queue card renders the submission's
 * photo). Submission photos are private R2 objects — there is no public
 * bucket URL — so a host-facing UI needs a presigned read link the same
 * way the capture flow needs a presigned write link. The caller (a route
 * handler / server component) is responsible for authorizing the request
 * (`requireCampaignAccess`) before calling this.
 */
export async function createSignedGetUrl(
  campaignId: string,
  submissionId: string,
  config?: R2Config,
): Promise<string> {
  const client = getR2Client(config);
  const bucket = resolveBucket(config);
  const key = submissionPhotoKey(campaignId, submissionId);

  const command = new GetObjectCommand({ Bucket: bucket, Key: key });

  return getSignedUrl(client, command, {
    expiresIn: SIGNED_GET_URL_TTL_SECONDS,
  });
}

/**
 * Fetches the object at `${campaignId}/${submissionId}.jpg` as a `Buffer`
 * (T4.1's capture flow: the client uploads the compressed photo directly to
 * R2 via a signed PUT — this server never sees those bytes in-flight — so
 * the submit handler needs to read them back to compute the server-side
 * perceptual hash, `lib/fraud/dedupe.ts`'s `computePhash`, before persisting
 * the submission). Throws (e.g. `NoSuchKey`) if the object doesn't exist —
 * the caller treats that as "the client's upload hasn't landed yet / never
 * happened," not a storage-layer bug to swallow.
 */
export async function getObjectBytes(
  campaignId: string,
  submissionId: string,
  config?: R2Config,
): Promise<Buffer> {
  const client = getR2Client(config);
  const bucket = resolveBucket(config);
  const key = submissionPhotoKey(campaignId, submissionId);

  const result = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!result.Body) {
    throw new Error(`getObjectBytes: empty body for ${key}`);
  }
  const bytes = await result.Body.transformToByteArray();
  return Buffer.from(bytes);
}

/**
 * Deletes every object under the `${campaignId}/` prefix — card
 * requirement 4, the primitive a future 90-day retention scheduler will
 * call (that scheduler is explicitly out of scope for this card; this is
 * just the function). Paginates through `ListObjectsV2` and batches
 * deletes in groups of up to 1000 keys (S3/R2's `DeleteObjects` limit).
 *
 * Scoped strictly to `campaignId`'s own prefix — never touches another
 * campaign's objects, since every key under a different campaign's prefix
 * can never match this `Prefix` filter (tenant isolation, constitution §3,
 * applied to object storage rather than SQL rows).
 */
export async function deleteCampaignObjects(
  campaignId: string,
  config?: R2Config,
): Promise<{ deletedKeys: string[] }> {
  if (!campaignId) {
    throw new Error("deleteCampaignObjects: campaignId is required");
  }
  const client = getR2Client(config);
  const bucket = resolveBucket(config);
  const prefix = `${campaignId}/`;

  const deletedKeys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    const keys = (page.Contents ?? [])
      .map((obj) => obj.Key)
      .filter((key): key is string => Boolean(key));

    if (keys.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })) },
        }),
      );
      deletedKeys.push(...keys);
    }

    continuationToken = page.IsTruncated
      ? page.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return { deletedKeys };
}

/** Test-only: clears the cached env-derived client/config singleton so a
 * test that mutates `process.env.R2_*` between cases (or asserts the
 * "missing env var throws" path) doesn't observe a stale cached client. */
export function _resetR2ClientForTests(): void {
  cachedClient = undefined;
  cachedConfig = undefined;
}
