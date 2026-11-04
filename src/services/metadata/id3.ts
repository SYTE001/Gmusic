import { cleanTagText, parseTrackPair, type ParsedTags } from "./types";

/**
 * ID3 tag parser supporting:
 * - ID3v2.2 (3-char frame IDs: TT2, TP1, TAL, TRK, PIC, 6-byte header)
 * - ID3v2.3 (4-char frame IDs: TIT2, TPE1, TALB, TRCK, APIC, 10-byte header, uint32 size)
 * - ID3v2.4 (4-char frame IDs, 10-byte header, syncsafe size)
 * - ID3v1 / ID3v1.1 (128-byte trailer fallback)
 */

const LATIN1 = "windows-1252";

function decodeText(bytes: Uint8Array, encoding: number): string {
  if (bytes.length === 0) return "";
  try {
    switch (encoding) {
      case 0: {
        // ISO-8859-1 / Windows-1252.
        // Check if bytes contain valid multi-byte UTF-8 sequences (common tagger anomaly).
        const hasHighBytes = bytes.some((b) => b >= 0x80);
        if (hasHighBytes) {
          try {
            return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            // Not valid UTF-8, fall through to Windows-1252
          }
        }
        return new TextDecoder(LATIN1).decode(bytes);
      }
      case 1: {
        // UTF-16 with BOM; without BOM infer or assume LE.
        if (bytes.length < 2) return "";
        const evenLen = bytes.length - (bytes.length % 2);
        if (bytes[0] === 0xff && bytes[1] === 0xfe) {
          return new TextDecoder("utf-16le").decode(bytes.subarray(2, evenLen));
        }
        if (bytes[0] === 0xfe && bytes[1] === 0xff) {
          return new TextDecoder("utf-16be").decode(bytes.subarray(2, evenLen));
        }
        // Without BOM: if byte 0 is NUL and byte 1 is ASCII, it's BE
        if (bytes[0] === 0x00 && bytes[1] !== 0x00) {
          return new TextDecoder("utf-16be").decode(bytes.subarray(0, evenLen));
        }
        return new TextDecoder("utf-16le").decode(bytes.subarray(0, evenLen));
      }
      case 2: {
        const evenLen = bytes.length - (bytes.length % 2);
        return new TextDecoder("utf-16be").decode(bytes.subarray(0, evenLen));
      }
      case 3:
        return new TextDecoder("utf-8").decode(bytes);
      default:
        return new TextDecoder(LATIN1).decode(bytes);
    }
  } catch {
    return "";
  }
}

function syncsafeToNumber(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

export function parseID3v2(buffer: ArrayBuffer): ParsedTags {
  const view = new Uint8Array(buffer);
  if (view.length < 10) return {};
  if (view[0] !== 0x49 || view[1] !== 0x44 || view[2] !== 0x33) return {}; // "ID3"
  const majorVersion = view[3];
  if (majorVersion !== 2 && majorVersion !== 3 && majorVersion !== 4) return {};
  const flags = view[5];
  const tagSize = syncsafeToNumber(view, 6);
  if (tagSize <= 0 || tagSize + 10 > view.length) return {};
  const unsynchronized = (flags & 0x80) !== 0;
  const hasExtendedHeader = (flags & 0x40) !== 0;
  if (unsynchronized && majorVersion !== 4) return {}; // rare

  let offset = 10;
  const end = Math.min(10 + tagSize, view.length);
  if (hasExtendedHeader) {
    if (majorVersion === 4) {
      const extSize = syncsafeToNumber(view, offset);
      offset += extSize;
    } else if (majorVersion === 3) {
      const extSize = new DataView(buffer).getUint32(offset);
      offset += 4 + extSize;
    }
    if (offset >= end) return {};
  }

  const tags: ParsedTags = {};

  if (majorVersion === 2) {
    // ID3v2.2: 3-char frame IDs, 3-byte size, no flags (headerLength = 6)
    while (offset + 6 <= end) {
      const id = String.fromCharCode(view[offset], view[offset + 1], view[offset + 2]);
      if (!/^[A-Z0-9]{3}$/.test(id)) break;
      const size = (view[offset + 3] << 16) | (view[offset + 4] << 8) | view[offset + 5];
      if (size <= 0 || offset + 6 + size > end) break;
      const body = view.subarray(offset + 6, offset + 6 + size);

      switch (id) {
        case "TT2":
          tags.title = tags.title ?? cleanTagText(decodeText(body.subarray(1), body[0]));
          break;
        case "TP1":
          tags.artist = tags.artist ?? cleanTagText(decodeText(body.subarray(1), body[0]));
          break;
        case "TAL":
          tags.album = tags.album ?? cleanTagText(decodeText(body.subarray(1), body[0]));
          break;
        case "TRK": {
          const pair = parseTrackPair(cleanTagText(decodeText(body.subarray(1), body[0])));
          if (tags.trackNumber === undefined) {
            tags.trackNumber = pair.trackNumber;
            tags.albumTrackCount = pair.albumTrackCount;
          }
          break;
        }
        case "PIC": {
          if (!tags.artwork) {
            const parsed = parsePIC2(body);
            if (parsed) tags.artwork = parsed;
          }
          break;
        }
      }
      offset += 6 + size;
    }
    return tags;
  }

  // ID3v2.3 / ID3v2.4: 4-char frame IDs, 4-byte size, 2-byte flags (headerLength = 10)
  while (offset + 10 <= end) {
    const id = String.fromCharCode(view[offset], view[offset + 1], view[offset + 2], view[offset + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding reached
    let size: number;
    if (majorVersion === 4) {
      size = syncsafeToNumber(view, offset + 4);
    } else {
      size = new DataView(buffer).getUint32(offset + 4);
    }
    const headerLength = 10;
    if (size <= 0 || offset + headerLength + size > end) break;
    const body = view.subarray(offset + headerLength, offset + headerLength + size);

    switch (id) {
      case "TIT2":
        tags.title = tags.title ?? cleanTagText(decodeText(body.subarray(1), body[0]));
        break;
      case "TPE1":
        tags.artist = tags.artist ?? cleanTagText(decodeText(body.subarray(1), body[0]));
        break;
      case "TALB":
        tags.album = tags.album ?? cleanTagText(decodeText(body.subarray(1), body[0]));
        break;
      case "TRCK": {
        const pair = parseTrackPair(cleanTagText(decodeText(body.subarray(1), body[0])));
        if (tags.trackNumber === undefined) {
          tags.trackNumber = pair.trackNumber;
          tags.albumTrackCount = pair.albumTrackCount;
        }
        break;
      }
      case "APIC": {
        if (!tags.artwork) {
          const parsed = parseAPIC(body, majorVersion);
          if (parsed) tags.artwork = parsed;
        }
        break;
      }
      default:
        break;
    }
    offset += headerLength + size;
  }
  return tags;
}

function parsePIC2(body: Uint8Array): Blob | undefined {
  if (body.length < 6) return undefined;
  const encoding = body[0];
  const format = String.fromCharCode(body[1], body[2], body[3]).toUpperCase();
  let pos = 5; // after encoding (1) + format (3) + pictureType (1)
  if (encoding === 1 || encoding === 2) {
    while (pos + 1 < body.length && !(body[pos] === 0 && body[pos + 1] === 0)) pos += 2;
    pos += 2;
  } else {
    while (pos < body.length && body[pos] !== 0) pos += 1;
    pos += 1;
  }
  const imageBytes = body.subarray(pos);
  if (imageBytes.length < 100) return undefined;
  const mime = format === "PNG" ? "image/png" : "image/jpeg";
  return new Blob([imageBytes.slice()], { type: mime });
}

function parseAPIC(body: Uint8Array, _majorVersion: number): Blob | undefined {
  if (body.length < 4) return undefined;
  const encoding = body[0];
  let pos = 1;
  // MIME string: Latin-1 null-terminated
  let mimeEnd = pos;
  while (mimeEnd < body.length && body[mimeEnd] !== 0) mimeEnd += 1;
  const mime = new TextDecoder(LATIN1).decode(body.subarray(pos, mimeEnd)) || "image/jpeg";
  pos = mimeEnd + 1;
  if (pos >= body.length) return undefined;
  pos += 1; // picture type byte
  // Description: encoding-aware terminator (UTF-16 variants use double 0x00)
  if (encoding === 1 || encoding === 2) {
    while (pos + 1 < body.length && !(body[pos] === 0 && body[pos + 1] === 0)) pos += 2;
    pos += 2;
  } else {
    while (pos < body.length && body[pos] !== 0) pos += 1;
    pos += 1;
  }
  const imageBytes = body.subarray(pos);
  if (imageBytes.length < 100) return undefined;
  const normalizedMime = mime.includes("/") ? mime : `image/${mime}`;
  return new Blob([imageBytes.slice()], { type: normalizedMime });
}

/**
 * ID3v1 / ID3v1.1 parser for 128-byte trailer at the end of an MP3 file.
 */
export function parseID3v1(buffer: ArrayBuffer): ParsedTags {
  if (buffer.byteLength < 128) return {};
  const view = new Uint8Array(buffer, buffer.byteLength - 128, 128);
  // Must start with "TAG" (0x54, 0x41, 0x47)
  if (view[0] !== 0x54 || view[1] !== 0x41 || view[2] !== 0x47) return {};

  const decodeField = (start: number, end: number): string | undefined => {
    let last = end;
    while (last > start && (view[last - 1] === 0 || view[last - 1] === 32)) {
      last--;
    }
    if (last <= start) return undefined;
    const raw = view.subarray(start, last);
    try {
      const utf8 = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      return cleanTagText(utf8);
    } catch {
      return cleanTagText(new TextDecoder(LATIN1).decode(raw));
    }
  };

  const title = decodeField(3, 33);
  const artist = decodeField(33, 63);
  const album = decodeField(63, 93);
  let trackNumber: number | undefined;
  // ID3v1.1: if byte 125 is 0 and byte 126 is non-zero, byte 126 is trackNumber
  if (view[125] === 0 && view[126] !== 0) {
    trackNumber = view[126];
  }

  const tags: ParsedTags = {};
  if (title) tags.title = title;
  if (artist) tags.artist = artist;
  if (album) tags.album = album;
  if (trackNumber !== undefined && Number.isFinite(trackNumber) && trackNumber > 0) {
    tags.trackNumber = trackNumber;
  }
  return tags;
}
