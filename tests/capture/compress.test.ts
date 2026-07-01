/**
 * `lib/capture/compress.ts` unit tests (T4.1).
 *
 * Only `computeScaledDimensions` (pure resize math) is exercised here —
 * `compressImage` itself is Canvas-API-based and browser-only (see that
 * module's doc comment); it's verified via the real-browser Playwright e2e
 * spec (`tests/e2e/submit-flow.spec.ts`) instead.
 */
import { describe, expect, it } from "vitest";
import {
  computeScaledDimensions,
  DEFAULT_MAX_DIMENSION_PX,
} from "@/lib/capture/compress";

describe("computeScaledDimensions", () => {
  it("leaves dimensions unchanged when already within the max", () => {
    expect(computeScaledDimensions(800, 600, 1600)).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("leaves dimensions unchanged when exactly at the max", () => {
    expect(computeScaledDimensions(1600, 900, 1600)).toEqual({
      width: 1600,
      height: 900,
    });
  });

  it("downscales a landscape image, preserving aspect ratio", () => {
    // 4000x3000 (4:3) capped to 1600 on the longest edge -> 1600x1200.
    expect(computeScaledDimensions(4000, 3000, 1600)).toEqual({
      width: 1600,
      height: 1200,
    });
  });

  it("downscales a portrait image, preserving aspect ratio", () => {
    // 3000x4000 (3:4) capped to 1600 on the longest edge -> 1200x1600.
    expect(computeScaledDimensions(3000, 4000, 1600)).toEqual({
      width: 1200,
      height: 1600,
    });
  });

  it("defaults to DEFAULT_MAX_DIMENSION_PX when no cap is given", () => {
    const result = computeScaledDimensions(4000, 4000);
    expect(Math.max(result.width, result.height)).toBe(
      DEFAULT_MAX_DIMENSION_PX,
    );
  });

  it("never returns a dimension below 1px for an extreme aspect ratio", () => {
    const result = computeScaledDimensions(10_000, 1, 100);
    expect(result.width).toBe(100);
    expect(result.height).toBeGreaterThanOrEqual(1);
  });

  it("rejects non-positive width/height", () => {
    expect(() => computeScaledDimensions(0, 100)).toThrow();
    expect(() => computeScaledDimensions(100, -1)).toThrow();
  });

  it("rejects a non-positive maxDimensionPx", () => {
    expect(() => computeScaledDimensions(100, 100, 0)).toThrow();
  });
});
