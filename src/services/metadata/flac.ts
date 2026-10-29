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

    if (blockType === 4 && blockLength < 4 * 1024 * 1024) {
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
