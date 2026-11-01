import type { LyricCapability, LyricLine } from "../../types";
import type { LrcmuxRecord } from "./lrcmuxClient";
import type { LrclibRecord } from "./lrclibClient";
import { parseLyricsfile } from "./lyricsfile";

/**
 * Normalized lyric-capability detection (task §3).
 *
 * Every quality decision — exact-lookup validation, candidate ranking,
 * auto-accept, and cache comparison — reads from this one scale. Detection
 * always inspects the actual payload: provider flags such as `hasWordSync`
 * or `syncedLyrics` are treated as hints, never as proof.
 *
 * "none" marks a payload with no usable lyric content; such records are
 * never attached or persisted.
 */
export type LyricCapabilityLevel = LyricCapability | "none";

export const CAPABILITY_RANK: Record<LyricCapabilityLevel, number> = {
  none: 0,
  instrumental: 0,
  plain: 1,
  line: 2,
  word: 3,
};

/**
 * Detects capability from lyric lines alone:
 * - "word": at least one line carries a usable word timestamp (finite start,
 *   non-empty word text).
 * - "line": at least one line has a usable line timestamp.
 * - "plain": non-empty lyric text exists but no valid timestamps.
 * - "none": no usable lyric content at all.
 */
export function detectCapability(lines: LyricLine[]): Exclude<LyricCapabilityLevel, "instrumental"> {
  for (const line of lines) {
    if (line.words?.some((word) => Number.isFinite(word.startMs) && word.text.trim().length > 0)) return "word";
  }
  if (lines.some((line) => line.timeMs !== null && Number.isFinite(line.timeMs))) return "line";
  if (lines.some((line) => line.text.trim().length > 0)) return "plain";
  return "none";
}

/**
 * Capability of a stored or imported lyrics document. The payload is the
 * authority — this also corrects legacy records whose `origin.capability`
 * marker is missing or inconsistent with the actual timestamps.
 */
export function detectLyricsCapability(lyrics: {
  lines: LyricLine[];
  origin?: { capability?: LyricCapability } | null;
}): LyricCapabilityLevel {
  const detected = detectCapability(lyrics.lines);
  if (detected === "none" && lyrics.origin?.capability === "instrumental") return "instrumental";
  return detected;
}

const WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/;
const LINE_TAG = /\[\d{1,3}:\d{1,2}(?:[.:,]\d{1,3})?\]/;

/**
 * Capability of a provider record, verified against its actual payload
 * rather than its flags. Used for candidate ranking; the resolver still
 * re-verifies the built document before attaching.
 */
export function recordCapability(record: LrcmuxRecord | LrclibRecord): LyricCapabilityLevel {
  if (record.instrumental) return "instrumental";
  if ("lines" in record && Array.isArray(record.lines) && record.lines.length > 0) {
    return detectCapability(record.lines);
  }
  const lyricsfile = record.lyricsfile?.trim();
  if (lyricsfile) {
    const parsed = parseLyricsfile(lyricsfile);
    if (parsed && parsed.lines.length > 0) return parsed.hasWordTiming ? "word" : "line";
  }
  const synced = record.syncedLyrics?.trim();
  if (synced) {
    // Enhanced LRC: line timestamps plus per-word `<mm:ss.xx>` tags.
    if (WORD_TAG.test(synced) && LINE_TAG.test(synced)) return "word";
    if (LINE_TAG.test(synced)) return "line";
    return "plain";
  }
  if (record.plainLyrics?.trim()) return "plain";
  return "none";
}
