import { cleanTagText, parseTrackPair, type ParsedTags } from "./types";

/**
 * Minimal FLAC metadata reader: VORBIS_COMMENT (block type 4) and PICTURE
 * (block type 6). Blocks are read sequentially with bounded slice reads so a
 * huge embedded picture never loads the whole file.
 */

export async function parseFlacTags(file: File): Promise<ParsedTags> {
  const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (header[0] !== 0x66 || header[1] !== 0x4c || header[2] !== 0x61 || header[3] !== 0x43) return {}; // "fLaC"

  const tags: ParsedTags = {};
  const decoder = new TextDecoder("utf-8");
  let offset = 4;

  for (let blockIndex = 0; blockIndex < 64; blockIndex += 1) {
    const blockHeader = new Uint8Array(await file.slice(offset, offset + 4).arrayBuffer());
    if (blockHeader.length < 4) break;
    const isLast = (blockHeader[0] & 0x80) !== 0;
    const blockType = blockHeader[0] & 0x7f;
    const blockLength = (blockHeader[1] << 16) | (blockHeader[2] << 8) | blockHeader[3];
    const dataStart = offset + 4;

    if (blockType === 0 && blockLength >= 34) {
      const data = new Uint8Array(await file.slice(dataStart, dataStart + 34).arrayBuffer());
      if (data.length >= 34) {
        const b10 = data[10];
        const b11 = data[11];
        const b12 = data[12];
        const b13 = data[13];
        const b14 = data[14];
        const b15 = data[15];
        const b16 = data[16];
        const b17 = data[17];

        const sampleRate = (b10 << 12) | (b11 << 4) | (b12 >> 4);
        const high4 = b13 & 0x0f;
        const low32 = ((b14 << 24) >>> 0) + (b15 << 16) + (b16 << 8) + b17;
        const totalSamples = high4 * 0x100000000 + low32;

        if (sampleRate > 0 && totalSamples > 0) {
          const durationMs = Math.round((totalSamples / sampleRate) * 1000);
          if (Number.isFinite(durationMs) && durationMs > 0) {
            tags.durationMs = durationMs;
          }
        }
      }
    } else if (blockType === 4 && blockLength < 4 * 1024 * 1024) {
      const data = new Uint8Array(await file.slice(dataStart, dataStart + blockLength).arrayBuffer());
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      let pos = 0;
      const vendorLength = view.getUint32(pos, true);
      pos += 4 + vendorLength;
      if (pos + 4 <= data.length) {
        const commentCount = view.getUint32(pos, true);
        pos += 4;
        for (let i = 0; i < commentCount && pos + 4 <= data.length; i += 1) {
          const length = view.getUint32(pos, true);
          pos += 4;
          if (pos + length > data.length) break;
          const comment = decoder.decode(data.subarray(pos, pos + length));
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
      }
    } else if (blockType === 6 && !tags.artwork && blockLength < 24 * 1024 * 1024) {
      const data = new Uint8Array(await file.slice(dataStart, dataStart + Math.min(blockLength, 1024)).arrayBuffer());
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      // pictureType(4) + mimeLen(4) + mime + descLen(4) + desc + w(4) h(4) depth(4) colors(4) + dataLen(4)
      let pos = 4;
      const mimeLength = view.getUint32(pos);
      pos += 4;
      if (pos + mimeLength + 4 > data.length) break;
      const mime = decoder.decode(data.subarray(pos, pos + mimeLength)) || "image/jpeg";
      pos += mimeLength;
      const descLength = view.getUint32(pos);
      pos += 4 + descLength + 16; // skip description and w/h/depth/colors
      if (pos + 4 <= data.length) {
        const imageLength = view.getUint32(pos);
        pos += 4;
        if (imageLength >= 100) {
          const blob = file.slice(dataStart + pos, dataStart + pos + imageLength, mime.includes("/") ? mime : `image/${mime}`);
          tags.artwork = blob;
        }
      }
    }

    offset = dataStart + blockLength;
    if (isLast || offset >= file.size) break;
  }
  return tags;
}
