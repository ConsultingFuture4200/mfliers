/**
 * Synthetic flier-photo generator (T3.3 seeded adversarial set).
 *
 * No real device photos exist in this sandbox, so this renders deterministic
 * synthetic "photos" with `sharp`: a fixed flier artwork (pixel-identical
 * every call — standing in for the fact that every campaign's players are
 * photographing the *same printed design*) composited onto a background that
 * varies per call (color + the flier's position/scale within the frame) —
 * standing in for a different real-world placement photographed
 * independently (different wall/backdrop, different framing/distance).
 *
 * `reencodePhoto` simulates the *fraud* case instead: not a fresh photograph,
 * but the same image file resized/requantized (a re-save/re-upload of the
 * exact same shot).
 */
import sharp from "sharp";

const WIDTH = 400;
const HEIGHT = 300;

export interface PlacementOptions {
  /** Background color behind the flier — stands in for a different wall,
   * backdrop, or lighting at a different real-world target. */
  background: { r: number; g: number; b: number };
  /** 0..1 fraction of the available horizontal slack; where the flier's
   * left edge sits — stands in for different camera framing. */
  flierX: number;
  /** 0..1 fraction of the available vertical slack. */
  flierY: number;
  /** 0.35..0.9 fraction of the frame width the flier occupies — stands in
   * for photographing from a different distance. */
  flierScale: number;
}

/** Renders one synthetic "photo" of the identical flier artwork at a given
 * placement. Returns JPEG bytes. */
export async function renderFlierPhoto(
  opts: PlacementOptions,
): Promise<Buffer> {
  const flierW = Math.round(WIDTH * opts.flierScale);
  const flierH = Math.round(flierW * 0.75);
  const left = Math.round(opts.flierX * Math.max(WIDTH - flierW, 0));
  const top = Math.round(opts.flierY * Math.max(HEIGHT - flierH, 0));

  // The identical flier artwork every campaign prints — fixed regardless of
  // `opts`, so only the background/placement varies between calls.
  const flierSvg = Buffer.from(`
    <svg width="${flierW}" height="${flierH}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#f4e9d8"/>
      <rect x="0" y="0" width="100%" height="${flierH * 0.3}" fill="#1b4332"/>
      <text x="50%" y="${flierH * 0.2}" font-size="${flierH * 0.16}" text-anchor="middle" fill="#ffffff" font-family="sans-serif">MYCOFEST</text>
      <circle cx="${flierW * 0.5}" cy="${flierH * 0.62}" r="${flierH * 0.24}" fill="#d9a441"/>
      <line x1="0" y1="${flierH}" x2="${flierW}" y2="0" stroke="#1b4332" stroke-width="${flierH * 0.04}"/>
    </svg>
  `);

  return sharp({
    create: {
      width: WIDTH,
      height: HEIGHT,
      channels: 3,
      background: opts.background,
    },
  })
    .composite([{ input: flierSvg, left, top }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** Re-encodes an existing photo at a different size/quality — the "same
 * photo file reused" fraud case (a re-save/re-upload), not a fresh
 * photograph of the same flier. */
export async function reencodePhoto(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer).resize(388, 291).jpeg({ quality: 65 }).toBuffer();
}

/** A spread of 12 distinct, deterministic placements — different
 * background colors and different flier framing/position/scale — used as
 * the "legitimate distinct placement" half of the seeded adversarial set. */
export const SEED_PLACEMENTS: PlacementOptions[] = [
  {
    background: { r: 200, g: 60, b: 40 },
    flierX: 0.1,
    flierY: 0.1,
    flierScale: 0.5,
  },
  {
    background: { r: 40, g: 90, b: 200 },
    flierX: 0.9,
    flierY: 0.1,
    flierScale: 0.55,
  },
  {
    background: { r: 60, g: 160, b: 60 },
    flierX: 0.1,
    flierY: 0.9,
    flierScale: 0.6,
  },
  {
    background: { r: 230, g: 210, b: 40 },
    flierX: 0.9,
    flierY: 0.9,
    flierScale: 0.45,
  },
  {
    background: { r: 120, g: 60, b: 160 },
    flierX: 0.5,
    flierY: 0.5,
    flierScale: 0.85,
  },
  {
    background: { r: 30, g: 30, b: 30 },
    flierX: 0.3,
    flierY: 0.2,
    flierScale: 0.4,
  },
  {
    background: { r: 240, g: 240, b: 240 },
    flierX: 0.7,
    flierY: 0.8,
    flierScale: 0.7,
  },
  {
    background: { r: 90, g: 200, b: 200 },
    flierX: 0.2,
    flierY: 0.6,
    flierScale: 0.5,
  },
  {
    background: { r: 210, g: 130, b: 40 },
    flierX: 0.8,
    flierY: 0.3,
    flierScale: 0.55,
  },
  {
    background: { r: 50, g: 50, b: 150 },
    flierX: 0.4,
    flierY: 0.05,
    flierScale: 0.65,
  },
  {
    background: { r: 170, g: 220, b: 100 },
    flierX: 0.05,
    flierY: 0.4,
    flierScale: 0.35,
  },
  {
    background: { r: 100, g: 40, b: 40 },
    flierX: 0.6,
    flierY: 0.95,
    flierScale: 0.9,
  },
];
