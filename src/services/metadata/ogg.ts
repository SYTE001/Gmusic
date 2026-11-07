import { cleanTagText, parseTrackPair, type ParsedTags } from "./types";

/**
 * Minimal Ogg Vorbis / Opus comment reader. Vorbis comment headers live near
 * the start of the file (usually within the first 64 KB); we scan the first
 * 512 KB of Ogg pages for the "\x03vorbis" or "OpusTags" magic and parse the
 * key=value list. Falls back to {} silently.
 */

const SCAN_LIMIT = 512 * 1024;

export async function parseOggTags(file: File): Promise<ParsedTags> {
  const scanLength = Math.min(file.size, SCAN_LIMIT);
  const data = new Uint8Array(await file.slice(0, scanLength).arrayBuffer());
  const decoder = new TextDecoder("utf-8");

  let cursor = 0;
  while (cursor < data.length) {
    const pageStart = findOggPage(data, cursor);
    if (pageStart === -1) break;
    const segmentTableOffset = pageStart + 26;
    if (segmentTableOffset >= data.length) break;
    const pageSegments = data[segmentTableOffset];
    if (segmentTableOffset + 1 + pageSegments > data.length) break;
    let payloadLength = 0;
    for (let i = 0; i < pageSegments; i += 1) {
      payloadLength += data[segmentTableOffset + 1 + i];
    }
    const payloadStart = segmentTableOffset + 1 + pageSegments;
    const payloadEnd = Math.min(payloadStart + payloadLength, data.length);
    const payload = data.subarray(payloadStart, payloadEnd);

    const tags = parseVorbisCommentBlock(payload, decoder);
    if (tags !== null) return tags;

    cursor = payloadEnd;
  }
  return {};
}

function findOggPage(data: Uint8Array, from: number): number {
  for (let i = from; i + 4 <= data.length; i += 1) {
    if (data[i] === 0x4f && data[i + 1] === 0x67 && data[i + 2] === 0x67 && data[i + 3] === 0x53) return i; // "OggS"
  }
  return -1;
}

/** Returns parsed tags when this page contains a comment header, else null. */
function parseVorbisCommentBlock(payload: Uint8Array, decoder: TextDecoder): ParsedTags | null {
  let pos = -1;
  if (payload.length > 7 && payload[0] === 0x03 && String.fromCharCode(payload[1], payload[2], payload[3], payload[4], payload[5], payload[6]) === "vorbis") {
    pos = 7;
  } else if (payload.length > 8 && String.fromCharCode(...payload.subarray(0, 8)) === "OpusTags") {
    pos = 8;
  }
  if (pos < 0 || pos + 4 > payload.length) return null;

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const vendorLength = view.getUint32(pos, true);
  pos += 4 + vendorLength;
  if (pos + 4 > payload.length) return null;
  const commentCount = view.getUint32(pos, true);
  pos += 4;

  const tags: ParsedTags = {};
  for (let i = 0; i < commentCount && pos + 4 <= payload.length; i += 1) {
    const length = view.getUint32(pos, true);
    pos += 4;
    if (pos + length > payload.length) break;
    const comment = decoder.decode(payload.subarray(pos, pos + length));
    pos += length;
    const eq = comment.indexOf("=");
    if (eq <= 0) continue;
    const key = comment.slice(0, eq).toUpperCase();
    const value = cleanTagText(comment.slice(eq + 1));
    if (!value) continue;
    if (key === "TITLE" && !tags.title) tags.title = value;
    else if (key === "ARTIST" && !tags.artist) tags.artist = value;
    else if (key === "ALBUM" && !tags.album) tags.album = value;
    else if (key === "TRACKNUMBER" && tags.trackNumber === undefined) {
      const pair = parseTrackPair(value);
      tags.trackNumber = pair.trackNumber;
      tags.albumTrackCount = pair.albumTrackCount;
    }
  }
  return tags;
}
