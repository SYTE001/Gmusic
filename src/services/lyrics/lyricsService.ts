import type { LyricLine, LyricWord, Track, TrackLyrics } from "../../types";
import { DB_SCHEMA_VERSION } from "../../types";
import { repository } from "../indexeddb/LibraryRepository";
import { describeLrcmuxError, lrcmuxGet, lrcmuxSearch, type LrcmuxRecord } from "./lrcmuxClient";
import type { LrclibRecord } from "./lrclibClient";
import { decideMatch, rankCandidates, type RankedCandidate } from "./matching";
import { parseLyricsfile } from "./lyricsfile";

/**
 * LyricsService — parses .lrc / .txt lyrics, applies per-track offsets, and
 * selects the active line from the real audio clock (rules §8).
 *
 * LRC dialects supported:
 * - `[mm:ss.xx]` and `[mm:ss,xxx]` line timestamps, several per line
 * - enhanced word-level tags `<mm:ss.xx>` (rendered only when present —
 *   word highlighting is never fabricated from line-only files)
 * - file-level `[offset:±ms]`; positive values shift lyrics earlier
 *
 * The original imported data is never rewritten to apply an offset.
 */

export type ParseLyricsResult = {
  lyrics: TrackLyrics;
  /** Non-empty source lines skipped because they had no usable timestamp. */
  skippedLines: number;
};

const LEADING_TIMESTAMP = /^\[(\d{1,3}):(\d{1,2})(?:[.:,](\d{1,3}))?\]/;
const WORD_TIMESTAMP = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const METADATA_TAG = /^\[([a-z]+):([^\]]*)\]$/i;

function fractionToMs(fraction: string | undefined): number {
  if (!fraction) return 0;
  // ".xx" is centiseconds, ".xxx" is milliseconds, longer is truncated to ms.
  if (fraction.length === 1) return Number(fraction) * 100;
  if (fraction.length === 2) return Number(fraction) * 10;
  return Number(fraction.slice(0, 3));
}

function timestampToMs(minutes: string, seconds: string, fraction: string | undefined): number {
  return Number(minutes) * 60000 + Number(seconds) * 1000 + fractionToMs(fraction);
}

function parseWordSpans(text: string): { text: string; words?: LyricWord[] } {
  WORD_TIMESTAMP.lastIndex = 0;
  const words: LyricWord[] = [];
  let match: RegExpExecArray | null;
  const marks: { startMs: number; index: number; length: number }[] = [];
  while ((match = WORD_TIMESTAMP.exec(text)) !== null) {
    marks.push({
      startMs: timestampToMs(match[1], match[2], match[3]),
      index: match.index,
      length: match[0].length,
    });
  }
  if (marks.length === 0) return { text };

  let plain = "";
  let cursor = 0;
  for (const mark of marks) {
    plain += text.slice(cursor, mark.index);
    const contentStart = mark.index + mark.length;
    const nextMark = marks.find((m) => m.index >= contentStart);
    const contentEnd = nextMark ? nextMark.index : text.length;
    const wordText = text.slice(contentStart, contentEnd);
    words.push({
      text: wordText,
      startMs: mark.startMs,
      endMs: null,
    });
    plain += wordText;
    cursor = contentEnd;
  }
  plain += text.slice(cursor);

  // Close each word span at the next word's start.
  for (let i = 0; i < words.length; i += 1) {
    words[i].endMs = i + 1 < words.length ? words[i + 1].startMs : null;
  }
  const hasContent = words.some((word) => word.text.trim().length > 0);
  return hasContent ? { text: plain, words } : { text: plain };
}

export function parseLyricFile(trackId: string, fileName: string, content: string): ParseLyricsResult {
  const sourceLines = content.split(/\r\n|\r|\n/);
  const collected: LyricLine[] = [];
  let skippedLines = 0;
  let fileOffsetMs = 0;
  let sawTimestampedLine = false;

  for (const rawLine of sourceLines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const metadataMatch = line.match(METADATA_TAG);
    if (metadataMatch) {
      const key = metadataMatch[1].toLowerCase();
      const value = metadataMatch[2].trim();
      if (key === "offset") {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) fileOffsetMs = parsed;
      }
      continue;
    }

    // Collect every timestamp tag at the start of the line (LRC allows several),
    // leaving the rest of the line — including brackets in the lyric text — intact.
    const timestamps: number[] = [];
    let rest = line;
    let match: RegExpMatchArray | null;
    while ((match = rest.match(LEADING_TIMESTAMP)) !== null) {
      timestamps.push(timestampToMs(match[1], match[2], match[3]));
      rest = rest.slice(match[0].length).trimStart();
    }

    if (timestamps.length === 0) {
      skippedLines += 1;
      continue;
    }

    sawTimestampedLine = true;
    const { text, words } = parseWordSpans(rest);
    for (const timeMs of timestamps) {
      // LRC offset semantics: positive = lyrics shift earlier.
      collected.push({ timeMs: Math.max(0, timeMs - fileOffsetMs), text: text.trim(), words });
    }
  }

  if (!sawTimestampedLine) {
    // No usable timestamps anywhere: treat as plain text lyrics.
    const lines: LyricLine[] = sourceLines
      .map((raw) => ({ timeMs: null, text: raw.trim() }))
      .filter((entry) => entry.text.length > 0);
    if (lines.length === 0) {
      return {
        lyrics: { trackId, format: "txt", lines: [], offsetMs: 0, updatedAt: Date.now(), skippedLines: 0, sourceName: fileName },
        skippedLines: 0,
      };
    }
    return {
      lyrics: { trackId, format: "txt", lines, offsetMs: 0, updatedAt: Date.now(), skippedLines: 0, sourceName: fileName },
      skippedLines: 0,
    };
  }

  // Stable sort: equal timestamps keep source order (rules §8).
  collected.sort((a, b) => (a.timeMs as number) - (b.timeMs as number));

  return {
    lyrics: {
      trackId,
      format: "lrc",
      lines: collected,
      offsetMs: 0,
      updatedAt: Date.now(),
      skippedLines,
      sourceName: fileName,
    },
    skippedLines,
  };
}

/** True when at least one line carries per-word timestamps. */
export function hasWordTimestamps(lines: LyricLine[]): boolean {
  return lines.some((line) => line.words !== undefined && line.words.length > 0);
}

/**
 * Timed-line index cached per lines array, so active-line lookup is a binary
 * search instead of a scan (feature spec §3.3). Lines arrays are immutable
 * per lyrics document, which makes a WeakMap key safe.
 */
const timedIndexCache = new WeakMap<object, { times: number[]; indices: number[] }>();

function getTimedIndex(lines: LyricLine[]): { times: number[]; indices: number[] } {
  let entry = timedIndexCache.get(lines as unknown as object);
  if (!entry) {
    const times: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const timeMs = lines[i].timeMs;
      if (timeMs !== null) {
        times.push(timeMs);
        indices.push(i);
      }
    }
    entry = { times, indices };
    timedIndexCache.set(lines as unknown as object, entry);
  }
  return entry;
}

/**
 * Index of the active line: the last line whose (offset-adjusted) time is
 * <= positionMs. Returns -1 before the first line. Untimed (txt) lines have
 * no active concept; callers render them statically. For equal timestamps the
 * last occurrence wins, matching source order.
 */
export function findActiveLineIndex(lines: LyricLine[], positionMs: number, offsetMs: number): number {
  const { times, indices } = getTimedIndex(lines);
  if (times.length === 0) return -1;
  // Upper bound: first entry whose adjusted time exceeds the position.
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] + offsetMs <= positionMs) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? -1 : indices[lo - 1];
}

/** Active word inside an enhanced line, or null when line-level only. */
export function findActiveWordIndex(line: LyricLine, positionMs: number, offsetMs: number): number {
  if (!line.words || line.words.length === 0) return -1;
  for (let i = line.words.length - 1; i >= 0; i -= 1) {
    if (line.words[i].startMs + offsetMs <= positionMs) return i;
  }
  return -1;
}

export const MIN_LYRIC_OFFSET_MS = -10000;
export const MAX_LYRIC_OFFSET_MS = 10000;

export function clampLyricOffset(offsetMs: number): number {
  return Math.min(MAX_LYRIC_OFFSET_MS, Math.max(MIN_LYRIC_OFFSET_MS, Math.round(offsetMs)));
}

/** Reads a lyric File as text, tolerating a UTF-8 BOM. */
export async function readLyricFileText(file: File): Promise<string> {
  const text = await file.text();
  return text.replace(/^\uFEFF/, "");
}

// ---------------------------------------------------------------------------
// LRCLIB discovery pipeline (feature spec §1, §6)
// ---------------------------------------------------------------------------

/** Re-check "not found" tracks weekly; accepted/ambiguous states never auto-retry. */
export const LYRICS_NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type LyricsResolution =
  | { outcome: "cached"; lyrics: TrackLyrics }
  | { outcome: "attached"; lyrics: TrackLyrics }
  | { outcome: "needs-selection"; candidates: RankedCandidate[] }
  | { outcome: "not-found" }
  | { outcome: "skipped-recently" }
  | { outcome: "offline" }
  | { outcome: "error"; message: string };

function roundDurationForApi(durationMs: number): number {
  return Math.round(durationMs / 1000);
}

/**
 * Converts an LRCLIB record into a TrackLyrics document. Capability
 * precedence: word sync (lyricsfile with per-word timing, or enhanced LRC
 * word tags) → line sync (syncedLyrics) → plain text → instrumental.
 * The caller's existing per-track offset is preserved.
 */
export function buildLyricsFromRecord(
  trackId: string,
  record: LrcmuxRecord | LrclibRecord,
  previousOffsetMs: number = 0,
): TrackLyrics {
  const origin = {
    kind: "lrcmux" as const,
    recordId: typeof record.id === "number" ? record.id : null,
    fetchedAt: Date.now(),
    matchedTitle: record.trackName ?? undefined,
    matchedArtist: record.artistName ?? undefined,
    matchedAlbum: record.albumName ?? undefined,
    capability: "plain" as const,
  };

  const sourceLabel = "source" in record && record.source ? `lrcmux (${record.source})` : "lrcmux";

  if (record.instrumental) {
    return {
      trackId,
      format: "txt",
      lines: [],
      offsetMs: 0,
      updatedAt: Date.now(),
      skippedLines: 0,
      sourceName: sourceLabel,
      origin: { ...origin, capability: "instrumental" },
      schemaVersion: DB_SCHEMA_VERSION,
    };
  }

  // Pre-parsed structured lines (direct from lrcmux native /get endpoint)
  if ("lines" in record && Array.isArray(record.lines) && record.lines.length > 0) {
    const wordTimed = hasWordTimestamps(record.lines);
    const hasTime = record.lines.some((l) => l.timeMs !== null);
    return {
      trackId,
      format: hasTime ? "lrc" : "txt",
      lines: record.lines,
      offsetMs: previousOffsetMs,
      updatedAt: Date.now(),
      skippedLines: 0,
      sourceName: sourceLabel,
      origin: { ...origin, capability: wordTimed ? "word" : hasTime ? "line" : "plain" },
      schemaVersion: DB_SCHEMA_VERSION,
    };
  }

  // Word-level: prefer the structured lyricsfile when it actually carries
  // per-word timing; enhanced-LRC word tags inside syncedLyrics are handled by
  // the LRC parser below.
  if (record.hasWordSync && record.lyricsfile) {
    const parsed = parseLyricsfile(record.lyricsfile);
    if (parsed?.hasWordTiming) {
      return {
        trackId,
        format: "lrc",
        lines: parsed.lines,
        offsetMs: previousOffsetMs,
        updatedAt: Date.now(),
        skippedLines: 0,
        sourceName: sourceLabel,
        origin: { ...origin, capability: "word" },
        schemaVersion: DB_SCHEMA_VERSION,
      };
    }
  }

  if (record.syncedLyrics) {
    const { lyrics } = parseLyricFile(trackId, sourceLabel, record.syncedLyrics);
    const wordTimed = hasWordTimestamps(lyrics.lines);
    return {
      ...lyrics,
      offsetMs: previousOffsetMs,
      origin: { ...origin, capability: wordTimed ? "word" : "line" },
      schemaVersion: DB_SCHEMA_VERSION,
    };
  }

  if (record.plainLyrics) {
    const { lyrics } = parseLyricFile(trackId, sourceLabel, record.plainLyrics);
    return {
      ...lyrics,
      offsetMs: previousOffsetMs,
      origin: { ...origin, capability: "plain" },
      schemaVersion: DB_SCHEMA_VERSION,
    };
  }

  // Records with no payload at all behave like instrumental: nothing to show.
  return {
    trackId,
    format: "txt",
    lines: [],
    offsetMs: 0,
    updatedAt: Date.now(),
    skippedLines: 0,
    sourceName: sourceLabel,
    origin: { ...origin, capability: "instrumental" },
    schemaVersion: DB_SCHEMA_VERSION,
  };
}

/** Persists an accepted record and its cache meta. */
export async function attachLrcmuxRecord(track: Track, record: LrcmuxRecord | LrclibRecord): Promise<TrackLyrics> {
  const existing = await repository.getLyrics(track.id);
  const lyrics = buildLyricsFromRecord(track.id, record, existing?.offsetMs ?? 0);
  await repository.putLyrics(lyrics);
  await repository.putLyricsCacheMeta({
    trackId: track.id,
    status: "accepted",
    checkedAt: Date.now(),
    recordId: typeof record.id === "number" ? record.id : null,
    schemaVersion: DB_SCHEMA_VERSION,
  });
  return lyrics;
}

export const attachLrclibRecord = attachLrcmuxRecord;

/**
 * Full discovery flow for one track: local cache → negative cache →
 * /api/get (validated) → /api/search (ranked) → auto-accept or candidate list.
 * Never blocks or touches playback; all failures return typed outcomes.
 */
export async function resolveLyricsForTrack(
  track: Track,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<LyricsResolution> {
  // 1. Cached lyrics win — no network (feature spec §6.1).
  const cached = await repository.getLyrics(track.id);
  if (cached && !options.force) {
    return { outcome: "cached", lyrics: cached };
  }

  // 2. Negative cache: skip recently failed lookups instead of hammering the API.
  if (!options.force) {
    const meta = await repository.getLyricsCacheMeta(track.id);
    if (meta) {
      if (meta.status === "accepted" && !cached) {
        // Accepted marker without lyrics (e.g. cleared separately) — fall through.
      } else if (meta.status === "not-found") {
        if (Date.now() - meta.checkedAt < LYRICS_NOT_FOUND_TTL_MS) return { outcome: "skipped-recently" };
      } else if (meta.status === "needs-selection") {
        return { outcome: "skipped-recently" };
      }
    }
  }

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { outcome: "offline" };
  }

  const query = {
    trackName: track.title || undefined,
    artistName: track.artist || undefined,
    albumName: track.album || undefined,
    duration: track.durationMs != null ? roundDurationForApi(track.durationMs) : undefined,
  };

  // 3. Exact lookup — still validated client-side (the API's duration
  //    matching is loose and can return a different recording).
  try {
    const exact = await lrcmuxGet(query, options.signal);
    if (exact) {
      const decision = decideMatch(track, exact);
      if (decision.autoAccept) {
        const lyrics = await attachLrcmuxRecord(track, exact);
        return { outcome: "attached", lyrics };
      }
    }
  } catch (error) {
    if (isAborted(error)) throw error;
    // Fall through to search; both paths share error reporting below.
  }

  // 4. Search + rank.
  try {
    const results = await lrcmuxSearch(query, options.signal);
    const candidates = rankCandidates(track, results);
    if (candidates.length === 0) {
      await repository.putLyricsCacheMeta({
        trackId: track.id,
        status: "not-found",
        checkedAt: Date.now(),
        recordId: null,
        schemaVersion: DB_SCHEMA_VERSION,
      });
      return { outcome: "not-found" };
    }
    const best = decideMatch(track, candidates[0].record);
    if (best.autoAccept && candidates[0].hasSynced) {
      const lyrics = await attachLrcmuxRecord(track, candidates[0].record as LrcmuxRecord);
      return { outcome: "attached", lyrics };
    }
    // Ambiguous or plain-only best match: let the user choose.
    await repository.putLyricsCacheMeta({
      trackId: track.id,
      status: "needs-selection",
      checkedAt: Date.now(),
      recordId: null,
      schemaVersion: DB_SCHEMA_VERSION,
    });
    return { outcome: "needs-selection", candidates };
  } catch (error) {
    if (isAborted(error)) throw error;
    return { outcome: "error", message: describeLrcmuxError(error) };
  }
}

function isAborted(error: unknown): boolean {
  return (error as { kind?: string } | null)?.kind === "aborted" || (error instanceof DOMException && error.name === "AbortError");
}

/** Clears the "needs-selection" marker so the next playback retries discovery. */
export async function resetLyricsCacheMeta(trackId: string): Promise<void> {
  await repository.putLyricsCacheMeta({
    trackId,
    status: "not-found",
    checkedAt: 0,
    recordId: null,
    schemaVersion: DB_SCHEMA_VERSION,
  });
}
