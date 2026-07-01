/**
 * `lib/capture/exif.ts` unit tests (T4.1).
 *
 * `parseJpegExif` is a pure byte-level parser with no DOM dependency, so
 * these run under Vitest's plain `node` environment. Rather than shipping a
 * real captured JPEG fixture, `buildJpegWithExif` hand-constructs a minimal
 * but spec-correct JPEG APP1/TIFF/EXIF byte sequence per test case — this
 * exercises the *real* parser against the *real* on-wire byte layout
 * (little-endian TIFF, big-endian JPEG segment length, GPS DMS rationals,
 * the Exif SubIFD indirection for `DateTimeOriginal`), not a mocked
 * abstraction of it. GPS test coordinates are chosen to decompose into
 * exact integer degrees/minutes/seconds (e.g. 46.5° = 46°30'0") so the
 * round-trip assertion can use `toBeCloseTo` without fighting DMS rounding
 * noise unrelated to what's being tested.
 */
import { describe, expect, it } from "vitest";
import { parseJpegExif } from "@/lib/capture/exif";

const TAG_GPS_IFD_POINTER = 0x8825;
const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_DATE_TIME = 0x0132;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_GPS_LAT_REF = 0x0001;
const TAG_GPS_LAT = 0x0002;
const TAG_GPS_LONG_REF = 0x0003;
const TAG_GPS_LONG = 0x0004;

function u16le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function u32le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
}
function asciiBytes(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}
function rational(num: number, den: number): number[] {
  return [...u32le(num), ...u32le(den)];
}

interface GpsSpec {
  lat: number;
  long: number;
}

function decomposeDms(value: number): [number, number, number] {
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minFull = (abs - deg) * 60;
  const min = Math.floor(minFull);
  const sec = Math.round((minFull - min) * 60);
  return [deg, min, sec];
}

/** Hand-builds a little-endian TIFF/EXIF block (the bytes that follow
 * "Exif\0\0" in a JPEG APP1 segment) with any combination of a GPS IFD, an
 * Exif SubIFD `DateTimeOriginal`, and/or a plain IFD0 `DateTime` tag. */
function buildExifTiff(opts: {
  gps?: GpsSpec;
  dateTimeOriginal?: string;
  plainDateTime?: string;
}): number[] {
  const ifd0Entries: { tag: number; type: number; count: number }[] = [];
  if (opts.gps) {
    ifd0Entries.push({ tag: TAG_GPS_IFD_POINTER, type: 4, count: 1 });
  }
  if (opts.dateTimeOriginal) {
    ifd0Entries.push({ tag: TAG_EXIF_IFD_POINTER, type: 4, count: 1 });
  }
  if (opts.plainDateTime) {
    ifd0Entries.push({
      tag: TAG_DATE_TIME,
      type: 2,
      count: opts.plainDateTime.length + 1,
    });
  }

  const ifd0Start = 8;
  const ifd0TableSize = 2 + 12 * ifd0Entries.length + 4;
  let cursor = ifd0Start + ifd0TableSize;

  let plainDateTimeOffset = 0;
  if (opts.plainDateTime) {
    plainDateTimeOffset = cursor;
    cursor += opts.plainDateTime.length + 1;
  }

  let gpsIfdStart = 0;
  let gpsLatOffset = 0;
  let gpsLongOffset = 0;
  if (opts.gps) {
    gpsIfdStart = cursor;
    const gpsTableSize = 2 + 12 * 4 + 4;
    cursor = gpsIfdStart + gpsTableSize;
    gpsLatOffset = cursor;
    cursor += 24;
    gpsLongOffset = cursor;
    cursor += 24;
  }

  let exifSubIfdStart = 0;
  let dtoOffset = 0;
  if (opts.dateTimeOriginal) {
    exifSubIfdStart = cursor;
    const exifTableSize = 2 + 12 * 1 + 4;
    cursor = exifSubIfdStart + exifTableSize;
    dtoOffset = cursor;
    cursor += opts.dateTimeOriginal.length + 1;
  }

  const bytes: number[] = [];

  // TIFF header: "II" (little-endian), magic 42, offset to IFD0.
  bytes.push(0x49, 0x49);
  bytes.push(...u16le(42));
  bytes.push(...u32le(ifd0Start));

  // IFD0
  bytes.push(...u16le(ifd0Entries.length));
  for (const e of ifd0Entries) {
    bytes.push(...u16le(e.tag), ...u16le(e.type), ...u32le(e.count));
    if (e.tag === TAG_GPS_IFD_POINTER) bytes.push(...u32le(gpsIfdStart));
    else if (e.tag === TAG_EXIF_IFD_POINTER) {
      bytes.push(...u32le(exifSubIfdStart));
    } else if (e.tag === TAG_DATE_TIME) {
      bytes.push(...u32le(plainDateTimeOffset));
    }
  }
  bytes.push(...u32le(0)); // no next IFD

  if (opts.plainDateTime) {
    bytes.push(...asciiBytes(opts.plainDateTime), 0);
  }

  if (opts.gps) {
    const [latDeg, latMin, latSec] = decomposeDms(opts.gps.lat);
    const [longDeg, longMin, longSec] = decomposeDms(opts.gps.long);

    bytes.push(...u16le(4)); // GPS IFD entry count
    bytes.push(
      ...u16le(TAG_GPS_LAT_REF),
      ...u16le(2),
      ...u32le(2),
      opts.gps.lat < 0 ? 0x53 : 0x4e, // 'S' / 'N'
      0x00,
      0x00,
      0x00,
    );
    bytes.push(
      ...u16le(TAG_GPS_LAT),
      ...u16le(5),
      ...u32le(3),
      ...u32le(gpsLatOffset),
    );
    bytes.push(
      ...u16le(TAG_GPS_LONG_REF),
      ...u16le(2),
      ...u32le(2),
      opts.gps.long < 0 ? 0x57 : 0x45, // 'W' / 'E'
      0x00,
      0x00,
      0x00,
    );
    bytes.push(
      ...u16le(TAG_GPS_LONG),
      ...u16le(5),
      ...u32le(3),
      ...u32le(gpsLongOffset),
    );
    bytes.push(...u32le(0)); // no next IFD

    bytes.push(
      ...rational(latDeg, 1),
      ...rational(latMin, 1),
      ...rational(latSec, 1),
    );
    bytes.push(
      ...rational(longDeg, 1),
      ...rational(longMin, 1),
      ...rational(longSec, 1),
    );
  }

  if (opts.dateTimeOriginal) {
    bytes.push(...u16le(1));
    bytes.push(
      ...u16le(TAG_DATE_TIME_ORIGINAL),
      ...u16le(2),
      ...u32le(opts.dateTimeOriginal.length + 1),
      ...u32le(dtoOffset),
    );
    bytes.push(...u32le(0));
    bytes.push(...asciiBytes(opts.dateTimeOriginal), 0);
  }

  return bytes;
}

function buildJpegWithExif(tiffBytes: number[]): Uint8Array {
  const exifHeader = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
  const segmentLen = 2 + exifHeader.length + tiffBytes.length;
  const bytes: number[] = [
    0xff,
    0xd8, // SOI
    0xff,
    0xe1, // APP1
    (segmentLen >> 8) & 0xff,
    segmentLen & 0xff, // JPEG segment lengths are big-endian
    ...exifHeader,
    ...tiffBytes,
    0xff,
    0xd9, // EOI
  ];
  return new Uint8Array(bytes);
}

describe("parseJpegExif", () => {
  it("extracts GPS and DateTimeOriginal from a well-formed EXIF segment", () => {
    const jpeg = buildJpegWithExif(
      buildExifTiff({
        gps: { lat: 46.5, long: -123.75 },
        dateTimeOriginal: "2026:06:30 12:00:00",
      }),
    );

    const result = parseJpegExif(jpeg);

    expect(result.gps).not.toBeNull();
    expect(result.gps!.lat).toBeCloseTo(46.5, 6);
    expect(result.gps!.long).toBeCloseTo(-123.75, 6);
    expect(result.timestamp).toEqual(new Date(Date.UTC(2026, 5, 30, 12, 0, 0)));
  });

  it("handles southern/eastern hemisphere refs (negative lat, positive long)", () => {
    const jpeg = buildJpegWithExif(
      buildExifTiff({ gps: { lat: -33.25, long: 151.5 } }),
    );

    const result = parseJpegExif(jpeg);

    expect(result.gps!.lat).toBeCloseTo(-33.25, 6);
    expect(result.gps!.long).toBeCloseTo(151.5, 6);
  });

  it("falls back to IFD0's plain DateTime tag when there's no Exif SubIFD", () => {
    const jpeg = buildJpegWithExif(
      buildExifTiff({ plainDateTime: "2026:01:15 08:30:00" }),
    );

    const result = parseJpegExif(jpeg);

    expect(result.gps).toBeNull();
    expect(result.timestamp).toEqual(new Date(Date.UTC(2026, 0, 15, 8, 30, 0)));
  });

  it("prefers DateTimeOriginal over the plain IFD0 DateTime when both are present", () => {
    const jpeg = buildJpegWithExif(
      buildExifTiff({
        plainDateTime: "2020:01:01 00:00:00",
        dateTimeOriginal: "2026:06:30 12:00:00",
      }),
    );

    const result = parseJpegExif(jpeg);

    expect(result.timestamp).toEqual(new Date(Date.UTC(2026, 5, 30, 12, 0, 0)));
  });

  it("returns null/null for a JPEG with no EXIF (APP1) segment", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    expect(parseJpegExif(jpeg)).toEqual({ gps: null, timestamp: null });
  });

  it("returns null/null for a non-JPEG buffer, without throwing", () => {
    const notJpeg = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
    expect(() => parseJpegExif(notJpeg)).not.toThrow();
    expect(parseJpegExif(notJpeg)).toEqual({ gps: null, timestamp: null });
  });

  it("returns null/null for a truncated EXIF segment, without throwing", () => {
    // A JPEG whose APP1/Exif header is present but cut off before a full
    // 8-byte TIFF header — malformed input, not a fraud-relevant photo, but
    // must not crash the capture flow.
    const truncated = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe1, 0x00, 0x0a, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    ]);
    expect(() => parseJpegExif(truncated)).not.toThrow();
    expect(parseJpegExif(truncated)).toEqual({ gps: null, timestamp: null });
  });
});
