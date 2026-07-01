/**
 * Client-side image compression before upload (T4.1).
 *
 * Constitution §3 / this card's anti-requirement: "Do NOT compress on the
 * server (client compresses; server stores original via R2)." The client
 * downsizes/re-encodes the captured photo *before* requesting a signed R2
 * URL (`lib/storage/r2.ts`'s `createSignedUploadUrl`) and uploads that
 * compressed blob directly to R2 — the server never touches image bytes
 * (`lib/storage/r2.ts`'s module doc comment), so what R2 stores as the
 * "original" is exactly what this module produced.
 *
 * `computeScaledDimensions` is the pure resize math, exported separately so
 * it's unit-testable under Vitest's `node` environment
 * (`tests/capture/compress.test.ts`) without a DOM/canvas. `compressImage`
 * itself is Canvas-API-based (browser-only) — this repo's Vitest config has
 * no jsdom/canvas polyfill (`vitest.config.ts`'s `environment: "node"`), so
 * it's verified via the real-browser Playwright e2e spec
 * (`tests/e2e/submit-flow.spec.ts`) instead. Importing this module has no
 * side effects at module scope (no `document`/`window` reference until
 * `compressImage` is actually called), so it stays safe to import from a
 * client component without breaking `pnpm build`'s server-side render pass.
 */

/** Longest-edge cap (pixels) — generous enough to keep a flier + surrounding
 * context legible for a human reviewer (T4.2) while keeping upload size (and
 * therefore EC-2's ≤20s submit-time budget) reasonable on a cellular
 * connection. */
export const DEFAULT_MAX_DIMENSION_PX = 1600;

/** JPEG re-encode quality (0–1). 0.8 is a standard "visually lossless enough
 * for review, meaningfully smaller than source" tradeoff. */
export const DEFAULT_JPEG_QUALITY = 0.8;

/**
 * Pure resize math: scales `{width, height}` down (never up) so neither
 * dimension exceeds `maxDimensionPx`, preserving aspect ratio. Returns the
 * original dimensions unchanged if already within bounds.
 */
export function computeScaledDimensions(
  width: number,
  height: number,
  maxDimensionPx: number = DEFAULT_MAX_DIMENSION_PX,
): { width: number; height: number } {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(
      "computeScaledDimensions: width and height must be positive finite numbers",
    );
  }
  if (!Number.isFinite(maxDimensionPx) || maxDimensionPx <= 0) {
    throw new Error(
      "computeScaledDimensions: maxDimensionPx must be a positive finite number",
    );
  }
  const largest = Math.max(width, height);
  if (largest <= maxDimensionPx) return { width, height };
  const scale = maxDimensionPx / largest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export interface CompressImageOptions {
  maxDimensionPx?: number;
  quality?: number;
}

/**
 * Compresses `file` (the captured/selected photo) to a JPEG `Blob` no
 * larger than `maxDimensionPx` on its longest edge, at `quality`.
 * Browser-only (Canvas API) — see module doc comment for why this isn't
 * unit-tested here.
 */
export async function compressImage(
  file: Blob,
  options: CompressImageOptions = {},
): Promise<Blob> {
  const maxDimensionPx = options.maxDimensionPx ?? DEFAULT_MAX_DIMENSION_PX;
  const quality = options.quality ?? DEFAULT_JPEG_QUALITY;

  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = computeScaledDimensions(
      bitmap.width,
      bitmap.height,
      maxDimensionPx,
    );

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("compressImage: 2D canvas context unavailable");
    }
    ctx.drawImage(bitmap, 0, 0, width, height);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("compressImage: canvas.toBlob returned null"));
        },
        "image/jpeg",
        quality,
      );
    });
  } finally {
    bitmap.close();
  }
}
