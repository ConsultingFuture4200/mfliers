/**
 * Client-side EXIF GPS + capture-timestamp extraction (T4.1).
 *
 * PRD FR-S2 (quoted in `docs/tasks/batch-4.md`): "Records photo, device GPS
 * + accuracy, client timestamp, EXIF GPS, EXIF timestamp." This module
 * implements the "EXIF GPS, EXIF timestamp" half — the device-GPS half is
 * the browser's own Geolocation API, read directly by the capture page.
 *
 * Deliberately a hand-rolled, dependency-free JPEG/TIFF/EXIF reader rather
 * than a library: this module ships in the client bundle (constitution §8 —
 * nothing here is server-only), and the parsing need is narrow (one GPS
 * coordinate, one timestamp) — pulling in a general-purpose EXIF library
 * for that is more bundle weight than the problem warrants. Every function
 * here is pure (`ArrayBuffer`/`Uint8Array` in, plain values out) and has no
 * DOM dependency, so it's directly unit-testable under Vitest's `node`
 * environment (`tests/capture/exif.test.ts`) without a browser.
 *
 * Reference: JEITA CP-3451 (Exif 2.x) / TIFF 6.0. Only the tags this
 * platform's fraud checks (`lib/fraud/geo.ts`'s `checkGpsAgreement`,
 * `lib/fraud/time.ts`'s `checkTimestamps`) actually consume are parsed:
 * GPSLatitude/GPSLatitudeRef/GPSLongitude/GPSLongitudeRef (tags 2/1/4/3 in
 * the GPS IFD) and DateTimeOriginal (tag 0x9003 in the Exif SubIFD, falling
 * back to the plain IFD0 DateTime tag 0x0132 if that's all a camera wrote).
 * Never throws on a JPEG with no EXIF segment, or an EXIF segment missing
 * one/both fields — a missing tag is the normal case (many phones strip
 * GPS from EXIF unless location permission was granted to the camera app
 * itself), not a parse error.
 */
import type { Coordinate } from "@/types/domain";

export interface ExifData {
  gps: Coordinate | null;
  /** EXIF's `DateTimeOriginal`/`DateTime` carries no timezone offset (a
   * known EXIF limitation — see `parseExifDateTime`'s doc comment), so this
   * is parsed as UTC. Never treated as authoritative — `checkTimestamps`
   * only uses it as a secondary sanity input against server `receivedAt`. */
  timestamp: Date | null;
}

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

const TAG_GPS_IFD_POINTER = 0x8825;
const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_DATE_TIME = 0x0132; // IFD0's plain "DateTime" (last-modified, per spec, but the only timestamp some cameras write)
const TAG_DATE_TIME_ORIGINAL = 0x9003; // Exif SubIFD's "when the shutter fired" — preferred over TAG_DATE_TIME when present
const TAG_GPS_LAT_REF = 0x0001;
const TAG_GPS_LAT = 0x0002;
const TAG_GPS_LONG_REF = 0x0003;
const TAG_GPS_LONG = 0x0004;

/** Byte size of one value of each TIFF field `type` this module reads.
 * (2 = ASCII, 5 = unsigned RATIONAL, 4 = unsigned LONG — the only types the
 * tags above ever use.) */
const TYPE_SIZE: Record<number, number> = { 2: 1, 4: 4, 5: 8 };

interface IfdEntry {
  type: number;
  count: number;
  /** Byte offset, within the TIFF block, of this entry's 4-byte
   * value/offset field (inline value if it fits in 4 bytes, else an offset
   * to the real value elsewhere in the block). */
  valueField: number;
}

function readIfd(
  view: DataView,
  tiffStart: number,
  ifdOffset: number,
  little: boolean,
): Map<number, IfdEntry> {
  const entries = new Map<number, IfdEntry>();
  const base = tiffStart + ifdOffset;
  if (base + 2 > view.byteLength) return entries;
  const entryCount = view.getUint16(base, little);
  let cursor = base + 2;
  for (let i = 0; i < entryCount && cursor + 12 <= view.byteLength; i++) {
    const tag = view.getUint16(cursor, little);
    const type = view.getUint16(cursor + 2, little);
    const count = view.getUint32(cursor + 4, little);
    entries.set(tag, { type, count, valueField: cursor + 8 });
    cursor += 12;
  }
  return entries;
}

/** Resolves where an entry's actual data lives: inline in the 4-byte value
 * field if it fits, otherwise at the offset that field points to. */
function entryDataOffset(
  view: DataView,
  tiffStart: number,
  entry: IfdEntry,
  little: boolean,
): number {
  const size = (TYPE_SIZE[entry.type] ?? 1) * entry.count;
  if (size <= 4) return entry.valueField;
  return tiffStart + view.getUint32(entry.valueField, little);
}

function readAscii(
  view: DataView,
  tiffStart: number,
  entry: IfdEntry,
  little: boolean,
): string {
  const offset = entryDataOffset(view, tiffStart, entry, little);
  let str = "";
  for (let i = 0; i < entry.count && offset + i < view.byteLength; i++) {
    const code = view.getUint8(offset + i);
    if (code === 0) break;
    str += String.fromCharCode(code);
  }
  return str;
}

function readRational(view: DataView, offset: number, little: boolean): number {
  const numerator = view.getUint32(offset, little);
  const denominator = view.getUint32(offset + 4, little);
  return denominator === 0 ? 0 : numerator / denominator;
}

/** GPS coordinates are stored as three RATIONALs (degrees, minutes,
 * seconds), per the Exif spec. */
function readDmsTriplet(
  view: DataView,
  tiffStart: number,
  entry: IfdEntry,
  little: boolean,
): number {
  const offset = entryDataOffset(view, tiffStart, entry, little);
  const degrees = readRational(view, offset, little);
  const minutes = readRational(view, offset + 8, little);
  const seconds = readRational(view, offset + 16, little);
  return degrees + minutes / 60 + seconds / 3600;
}

function readLongValue(
  view: DataView,
  entry: IfdEntry,
  little: boolean,
): number {
  return view.getUint32(entry.valueField, little);
}

function parseGpsIfd(
  view: DataView,
  tiffStart: number,
  gpsIfdOffset: number,
  little: boolean,
): Coordinate | null {
  const entries = readIfd(view, tiffStart, gpsIfdOffset, little);
  const latEntry = entries.get(TAG_GPS_LAT);
  const latRefEntry = entries.get(TAG_GPS_LAT_REF);
  const longEntry = entries.get(TAG_GPS_LONG);
  const longRefEntry = entries.get(TAG_GPS_LONG_REF);
  if (!latEntry || !latRefEntry || !longEntry || !longRefEntry) return null;

  const lat = readDmsTriplet(view, tiffStart, latEntry, little);
  const long = readDmsTriplet(view, tiffStart, longEntry, little);
  const latRef = readAscii(view, tiffStart, latRefEntry, little).toUpperCase();
  const longRef = readAscii(
    view,
    tiffStart,
    longRefEntry,
    little,
  ).toUpperCase();

  return {
    lat: latRef.startsWith("S") ? -lat : lat,
    long: longRef.startsWith("W") ? -long : long,
  };
}

/**
 * Parses EXIF's `"YYYY:MM:DD HH:MM:SS"` datetime string format.
 *
 * NEEDS_CLARIFICATION-adjacent known limitation (documented rather than
 * silently assumed away): the base `DateTimeOriginal`/`DateTime` tags carry
 * no timezone offset (a separate `OffsetTimeOriginal` tag, 0x9011, exists in
 * newer Exif revisions for this, but isn't written by every camera and
 * isn't parsed here). Parsed as UTC. `lib/fraud/time.ts`'s
 * `DEFAULT_TIMESTAMP_SKEW_MINUTES` (15 minutes) tolerates a same-timezone
 * photo fine, but a submission captured in a meaningfully different
 * timezone than the server could show a spurious multi-hour skew against
 * `checkTimestamps`. Flagged in `tasks/lessons.md` for a future card if
 * this proves to cause real false positives at scale.
 */
function parseExifDateTime(raw: string): Date | null {
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(
    raw.trim(),
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const ts = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  );
  return Number.isNaN(ts) ? null : new Date(ts);
}

function hasExifHeader(view: DataView, offset: number): boolean {
  if (offset + EXIF_HEADER.length > view.byteLength) return false;
  return EXIF_HEADER.every((byte, i) => view.getUint8(offset + i) === byte);
}

function parseTiffBlock(view: DataView, tiffStart: number): ExifData {
  if (tiffStart + 8 > view.byteLength) return { gps: null, timestamp: null };

  const byteOrderMarker = view.getUint16(tiffStart);
  const little = byteOrderMarker === 0x4949; // "II"
  if (!little && byteOrderMarker !== 0x4d4d /* "MM" */) {
    return { gps: null, timestamp: null };
  }

  const firstIfdOffset = view.getUint32(tiffStart + 4, little);
  const ifd0 = readIfd(view, tiffStart, firstIfdOffset, little);

  let gps: Coordinate | null = null;
  const gpsPointer = ifd0.get(TAG_GPS_IFD_POINTER);
  if (gpsPointer) {
    const gpsIfdOffset = readLongValue(view, gpsPointer, little);
    gps = parseGpsIfd(view, tiffStart, gpsIfdOffset, little);
  }

  let timestamp: Date | null = null;
  const dateTimeEntry = ifd0.get(TAG_DATE_TIME);
  if (dateTimeEntry) {
    timestamp = parseExifDateTime(
      readAscii(view, tiffStart, dateTimeEntry, little),
    );
  }
  const exifIfdPointer = ifd0.get(TAG_EXIF_IFD_POINTER);
  if (exifIfdPointer) {
    const exifIfdOffset = readLongValue(view, exifIfdPointer, little);
    const exifIfd = readIfd(view, tiffStart, exifIfdOffset, little);
    const dateTimeOriginalEntry = exifIfd.get(TAG_DATE_TIME_ORIGINAL);
    if (dateTimeOriginalEntry) {
      const parsed = parseExifDateTime(
        readAscii(view, tiffStart, dateTimeOriginalEntry, little),
      );
      // DateTimeOriginal ("when the shutter fired") wins over IFD0's plain
      // DateTime ("last modified") when both are present.
      if (parsed) timestamp = parsed;
    }
  }

  return { gps, timestamp };
}

/**
 * Parses GPS + capture timestamp out of a JPEG's EXIF (APP1) segment.
 * Returns `{ gps: null, timestamp: null }` for a non-JPEG buffer, a JPEG
 * with no EXIF segment, or an EXIF segment missing both fields — never
 * throws.
 */
export function parseJpegExif(bytes: ArrayBuffer | Uint8Array): ExifData {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (buffer.byteLength < 4) return { gps: null, timestamp: null };
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );

  if (view.getUint16(0) !== 0xffd8 /* SOI */) {
    return { gps: null, timestamp: null };
  }

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    if ((marker & 0xff00) !== 0xff00) break; // not a marker — malformed/truncated
    if (marker === 0xffd9 /* EOI */ || marker === 0xffda /* SOS */) break;
    const segmentLength = view.getUint16(offset + 2);
    if (marker === 0xffe1 /* APP1 */) {
      const segmentStart = offset + 4;
      if (hasExifHeader(view, segmentStart)) {
        return parseTiffBlock(view, segmentStart + EXIF_HEADER.length);
      }
    }
    offset += 2 + segmentLength;
  }
  return { gps: null, timestamp: null };
}
