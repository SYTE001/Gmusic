import { cleanTagText, parseTrackPair, type ParsedTags } from "./types";

/**
 * Minimal ID3v2.3 / ID3v2.4 reader for title/artist/album/track/APIC.
 * Returns {} when the buffer is not a usable ID3v2 tag; the caller falls back
 * to filename-derived metadata. Unsynchronized tags (rare) are skipped the
 * same way rather than risk corrupt reads.
 */

const LATIN1 = "windows-1252";

function decodeText(bytes: Uint8Array, encoding: number): string {
  try {
    switch (encoding) {
      case 0:
        return new TextDecoder(LATIN1).decode(bytes);
      case 1: {
        // UTF-16 with BOM; without BOM assume LE.
        if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
          return new TextDecoder("utf-16le").decode(bytes.subarray(2));
        }
        if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
          return new TextDecoder("utf-16be").decode(bytes.subarray(2));
        }
        return new TextDecoder("utf-16le").decode(bytes);
      }
      case 2:
        return new TextDecoder("utf-16be").decode(bytes);
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
    ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f)
  );
}

export function parseID3v2(buffer: ArrayBuffer): ParsedTags {
  const view = new Uint8Array(buffer);
  if (view.length < 10) return {};
  if (view[0] !== 0x49 || view[1] !== 0x44 || view[2] !== 0x33) return {}; // "ID3"
  const majorVersion = view[3];
  if (majorVersion !== 3 && majorVersion !== 4) return {};
  const flags = view[5];
  const tagSize = syncsafeToNumber(view, 6);
  if (tagSize <= 0 || tagSize + 10 > view.length) return {};
  const unsynchronized = (flags & 0x80) !== 0;
  const hasExtendedHeader = (flags & 0x40) !== 0;
  if (unsynchronized) return {}; // rare; fall back to filename metadata

  let offset = 10;
  const end = 10 + tagSize;
  if (hasExtendedHeader) {
    if (majorVersion === 4) {
      const extSize = syncsafeToNumber(view, offset);
      offset += extSize;
    } else {
      const extSize = new DataView(buffer).getUint32(offset);
      offset += 4 + extSize;
    }
    if (offset >= end) return {};
  }

  const tags: ParsedTags = {};
  const frameIdLength = 4;

  while (offset + frameIdLength + (majorVersion === 4 ? 4 + 2 : 3 + 2) <= end) {
    const id = String.fromCharCode(view[offset], view[offset + 1], view[offset + 2], view[offset + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding reached
    let size: number;
    let headerLength: number;
    if (majorVersion === 4) {
      size = syncsafeToNumber(view, offset + 4);
      headerLength = 10;
    } else {
      size = new DataView(buffer).getUint32(offset + 4);
      headerLength = 7;
    }
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
        if (tags.artwork) break;
        const parsed = parseAPIC(body, majorVersion);
        if (parsed) tags.artwork = parsed;
        break;
      }
      default:
        break;
    }
    offset += headerLength + size;
  }
  return tags;
}

function parseAPIC(body: Uint8Array, majorVersion: number): Blob | undefined {
  if (body.length < 4) return undefined;
  const encoding = body[0];
  let pos = 1;
  // MIME string: always latin-1 null-terminated.
  let mimeEnd = pos;
  while (mimeEnd < body.length && body[mimeEnd] !== 0) mimeEnd += 1;
  const mime = new TextDecoder(LATIN1).decode(body.subarray(pos, mimeEnd)) || "image/jpeg";
  pos = mimeEnd + 1;
  pos += 1; // picture type byte
  // Description: encoding-aware terminator (UTF-16 variants use a double 0x00).
  if (encoding === 1 || encoding === 2) {
    while (pos + 1 < body.length && !(body[pos] === 0 && body[pos + 1] === 0)) pos += 2;
    pos += 2;
  } else {
    while (pos < body.length && body[pos] !== 0) pos += 1;
    pos += 1;
  }
  if (majorVersion === 4) {
    // v2.4 APIC sizes exclude the terminator; nothing extra to skip here.
  }
  const imageBytes = body.subarray(pos);
  if (imageBytes.length < 100) return undefined;
  const normalizedMime = mime.includes("/") ? mime : `image/${mime}`;
  return new Blob([imageBytes.slice()], { type: normalizedMime });
}
