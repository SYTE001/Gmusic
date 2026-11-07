import { cleanTagText, parseTrackPair, type ParsedTags } from "./types";

/**
 * Minimal MP4/M4A tag reader. Scans a buffer for the `moov` atom and reads
 * ©nam / ©ART / ©alb / trkn / covr from the ilst list. Works when moov is at
 * the start (typical) or the end of the file, as long as the atom is fully
 * inside the provided buffer.
 */

function readAtomHeader(view: DataView, offset: number): { size: number; type: string } | null {
  if (offset + 8 > view.byteLength) return null;
  let size = view.getUint32(offset);
  const type = String.fromCharCode(
    view.getUint8(offset + 4),
    view.getUint8(offset + 5),
    view.getUint8(offset + 6),
    view.getUint8(offset + 7),
  );
  if (size === 1) {
    // 64-bit size — reading the low 32 bits is sufficient for our bounded scan.
    if (offset + 16 > view.byteLength) return null;
    size = view.getUint32(offset + 12); // low half of the 64-bit size
    return size === 0 ? null : { size, type };
  }
  if (size === 0) return { size: view.byteLength - offset, type };
  return { size, type };
}

type AtomWalk = { type: string; start: number; contentStart: number; contentEnd: number };

function* walkAtoms(buffer: ArrayBuffer, start: number, end: number, depth = 0): Generator<AtomWalk> {
  if (depth > 6) return;
  const view = new DataView(buffer);
  let offset = start;
  while (offset + 8 <= end) {
    const header = readAtomHeader(view, offset);
    if (!header) return;
    const contentStart = offset + 8;
    const contentEnd = Math.min(offset + header.size, end);
    if (contentEnd <= contentStart) return;
    yield { type: header.type, start: offset, contentStart, contentEnd };
    offset = contentEnd;
  }
}

/** Reads a `data` atom payload inside an ilst entry and returns its bytes. */
function readDataPayload(buffer: ArrayBuffer, entry: AtomWalk): { dataType: number; bytes: Uint8Array } | null {
  const view = new DataView(buffer);
  for (const child of walkAtoms(buffer, entry.contentStart, entry.contentEnd, 5)) {
    if (child.type !== "data") continue;
    if (child.contentStart + 8 > child.contentEnd) return null;
    const dataType = view.getUint32(child.contentStart);
    const bytes = new Uint8Array(buffer, child.contentStart + 8, child.contentEnd - child.contentStart - 8);
    return { dataType, bytes };
  }
  return null;
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  return cleanTagText(new TextDecoder("utf-8").decode(bytes));
}

function findMoovRange(buffer: ArrayBuffer): { start: number; end: number } | null {
  const view = new DataView(buffer);
  const signature = [0x6d, 0x6f, 0x6f, 0x76]; // "moov"
  const limit = buffer.byteLength - 8;
  for (let offset = 0; offset <= limit; offset += 1) {
    if (
      view.getUint8(offset + 4) === signature[0] &&
      view.getUint8(offset + 5) === signature[1] &&
      view.getUint8(offset + 6) === signature[2] &&
      view.getUint8(offset + 7) === signature[3]
    ) {
      const header = readAtomHeader(view, offset);
      if (header && header.size > 8) {
        return { start: offset, end: Math.min(offset + header.size, buffer.byteLength) };
      }
    }
  }
  return null;
}

export function parseMp4Tags(buffer: ArrayBuffer): ParsedTags {
  const moovRange = findMoovRange(buffer);
  if (!moovRange) return {};
  const tags: ParsedTags = {};

  for (const level1 of walkAtoms(buffer, moovRange.start + 8, moovRange.end)) {
    if (level1.type !== "udta") continue;
    for (const level2 of walkAtoms(buffer, level1.contentStart, level1.contentEnd)) {
      if (level2.type !== "meta") continue;
      // meta atom starts with a 4-byte version/flags field.
      for (const level3 of walkAtoms(buffer, level2.contentStart + 4, level2.contentEnd)) {
        if (level3.type !== "ilst") continue;
        for (const entry of walkAtoms(buffer, level3.contentStart, level3.contentEnd, 5)) {
          const payload = readDataPayload(buffer, entry);
          if (!payload) continue;
          switch (entry.type) {
            case "\u00a9nam":
              tags.title = tags.title ?? decodeUtf8(payload.bytes);
              break;
            case "\u00a9ART":
              tags.artist = tags.artist ?? decodeUtf8(payload.bytes);
              break;
            case "\u00a9alb":
              tags.album = tags.album ?? decodeUtf8(payload.bytes);
              break;
            case "trkn": {
              if (tags.trackNumber === undefined && payload.bytes.length >= 4) {
                const trackNumber = (payload.bytes[2] << 8) | payload.bytes[3];
                const total = payload.bytes.length >= 6 ? (payload.bytes[4] << 8) | payload.bytes[5] : 0;
                if (trackNumber > 0) tags.trackNumber = trackNumber;
                if (total > 0) tags.albumTrackCount = total;
              }
              break;
            }
            case "covr": {
              if (tags.artwork) break;
              const mime = payload.dataType === 14 ? "image/png" : "image/jpeg";
              if (payload.bytes.length >= 100) {
                tags.artwork = new Blob([payload.bytes.slice()], { type: mime });
              }
              break;
            }
            default:
              break;
          }
        }
      }
    }
  }
  return tags;
}

export { parseTrackPair };
