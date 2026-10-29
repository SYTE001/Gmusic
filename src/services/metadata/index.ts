import { fileExtension } from "../../utils/misc";
import type { ParsedTags } from "./types";
import { parseID3v2 } from "./id3";
import { parseMp4Tags } from "./mp4";
import { parseFlacTags } from "./flac";
import { parseOggTags } from "./ogg";

/**
 * Tag parsing dispatcher. Every parser is best-effort: failures degrade to
 * filename-derived metadata rather than failing the import (PRD §7.1).
 * WAV files carry no tags we parse, so they use filename fallbacks.
 */

const ID3_MAX_BYTES = 24 * 1024 * 1024; // guard against pathological embedded art
const MP4_SCAN_BYTES = 4 * 1024 * 1024; // moov is within head or tail for typical files

export async function parseAudioTags(file: File): Promise<ParsedTags> {
  try {
    const extension = fileExtension(file.name);
    if (extension === "flac" || file.type === "audio/flac") {
      return await parseFlacTags(file);
    }
    if (extension === "ogg" || extension === "oga" || extension === "opus" || file.type === "audio/ogg") {
      return await parseOggTags(file);
    }

    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
      // ID3v2: syncsafe tag size lets us read exactly the tag.
      const tagSize = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
      const readLength = Math.min(tagSize + 10, ID3_MAX_BYTES, file.size);
      const buffer = await file.slice(0, readLength).arrayBuffer();
      return parseID3v2(buffer);
    }

    const isMp4 =
      file.type === "audio/mp4" ||
      file.type === "video/mp4" ||
      ["m4a", "m4b", "mp4", "aac"].includes(extension) ||
      (head.length >= 8 &&
        String.fromCharCode(head[4], head[5], head[6], head[7]) === "ftyp");
    if (isMp4) {
      const headBuffer = await file.slice(0, Math.min(MP4_SCAN_BYTES, file.size)).arrayBuffer();
      let tags = parseMp4Tags(headBuffer);
      if (!tags.title && !tags.artist && file.size > MP4_SCAN_BYTES) {
        // moov might be at the end of the file.
        const tailBuffer = await file.slice(Math.max(0, file.size - MP4_SCAN_BYTES)).arrayBuffer();
        tags = parseMp4Tags(tailBuffer);
      }
      return tags;
    }
  } catch (error) {
    console.warn(`Metadata parsing skipped for ${file.name}`, error);
  }
  return {};
}

/**
 * Probes a file with a detached audio element to learn the real duration and
 * whether this browser can decode it. Never uploads or transcodes anything.
 */
export function probeAudioFile(file: File): Promise<{ supported: boolean; durationMs: number | null }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    let settled = false;
    const finish = (supported: boolean, durationMs: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
      resolve({ supported, durationMs });
    };
    const timer = setTimeout(() => finish(false, null), 15000);
    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : null;
      finish(duration !== null, duration !== null ? Math.round(duration * 1000) : null);
    });
    audio.addEventListener("error", () => finish(false, null));
    audio.src = url;
  });
}
