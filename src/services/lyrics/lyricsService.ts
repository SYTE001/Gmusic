import type { LyricLine, LyricOrigin, LyricWord, Track, TrackLyrics } from "../../types";
import { DB_SCHEMA_VERSION } from "../../types";
import { repository } from "../indexeddb/LibraryRepository";
import { CAPABILITY_RANK, detectLyricsCapability, recordCapability, type LyricCapabilityLevel } from "./capability";
import { describeLrcmuxError, LrcmuxError, lrcmuxGet, lrcmuxSearch, type LrcmuxQuery } from "./lrcmuxClient";
import { describeLrclibError, LrclibError, lrclibGet, lrclibSearch, type LrclibQuery } from "./lrclibClient";
import { describeLyricsDbError, LyricsDbError, lyricsDbGet, lyricsDbSearch, type LyricsDbQuery } from "./lyricsdbClient";
import { artistSimilarity, decideMatch, type LyricMatchRecord, rankCandidates, type RankedCandidate, similarity } from "./matching";
import { parseLyricsfile } from "./lyricsfile";
import { normalizeTrackMetadata } from "../metadata/normalization";
import { recordSearchDiagnostic, type ProviderDiagnostic } from "./lyricsDiagnostics";

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

/** True when at least one line carries usable per-word timestamps — a word
 * entry with a finite start and non-empty text. Provider or parser artifacts
 * (empty text, NaN starts) never enable word-by-word mode. */
export function hasWordTimestamps(lines: LyricLine[]): boolean {
  return lines.some((line) =>
    line.words?.some((word) => Number.isFinite(word.startMs) && word.text.trim().length > 0),
  );
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
/** Negative-cache duration for tracks genuine not-found upstream (1 hour). */
export const LYRICS_NOT_FOUND_TTL_MS = 60 * 60 * 1000;

export type LyricsResolution =
  | { outcome: "cached"; lyrics: TrackLyrics }
  | { outcome: "attached"; lyrics: TrackLyrics }
  | { outcome: "needs-selection"; candidates: RankedCandidate[] }
  | { outcome: "not-found" }
  | { outcome: "skipped-recently" }
  | { outcome: "offline" }
  | { outcome: "error"; message: string };

/**
 * Converts an LRCLIB record into a TrackLyrics document. Capability
 * precedence: word sync (lyricsfile with per-word timing, or enhanced LRC
 * word tags) → line sync (syncedLyrics) → plain text → instrumental.
 * The caller's existing per-track offset is preserved.
 */
export function buildLyricsFromRecord(
  trackId: string,
  record: LyricMatchRecord,
  previousOffsetMs: number = 0,
): TrackLyrics {
  let providerKind: "lrcmux" | "lrclib" | "lyricsdb" = "lrcmux";
  if ("provider" in record && record.provider) {
    providerKind = record.provider;
  } else if ("source" in record && typeof record.source === "string" && record.source.includes("lyricsdb")) {
    providerKind = "lyricsdb";
  } else if ("source" in record && typeof record.source === "string" && record.source.includes("lrclib")) {
    providerKind = "lrclib";
  } else if (typeof record.id === "number") {
    providerKind = "lrclib";
  }

  const origin: LyricOrigin = {
    kind: providerKind,
    recordId: record.id != null ? (typeof record.id === "number" ? record.id : String(record.id)) : null,
    fetchedAt: Date.now(),
    matchedTitle: record.trackName ?? undefined,
    matchedArtist: record.artistName ?? undefined,
    matchedAlbum: record.albumName ?? undefined,
    capability: "plain",
  };

  const sourceLabel =
    providerKind === "lyricsdb"
      ? ("source" in record && record.source ? record.source : "lyricsdb")
      : providerKind === "lrclib"
        ? "lrclib"
        : "source" in record && record.source
          ? `lrcmux (${record.source})`
          : "lrcmux";

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

  // Pre-parsed structured lines (direct from lrcmux native /get endpoint or LyricsDB)
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

  // Records with no payload at all carry no lyrics: capability "none" — the
  // resolver never attaches them (they are not instrumental; that requires
  // the provider to say so explicitly).
  return {
    trackId,
    format: "txt",
    lines: [],
    offsetMs: 0,
    updatedAt: Date.now(),
    skippedLines: 0,
    sourceName: sourceLabel,
    origin: { ...origin, capability: "none" },
    schemaVersion: DB_SCHEMA_VERSION,
  };
}

/** Persists an accepted record and its cache meta. */
export async function attachLrcmuxRecord(track: Track, record: LyricMatchRecord): Promise<TrackLyrics> {
  const existing = await repository.getLyrics(track.id);
  const lyrics = buildLyricsFromRecord(track.id, record, existing?.offsetMs ?? 0);
  await repository.putLyrics(lyrics);
  await repository.putLyricsCacheMeta({
    trackId: track.id,
    status: "accepted",
    checkedAt: Date.now(),
    recordId: record.id != null ? (typeof record.id === "number" ? record.id : null) : null,
    schemaVersion: DB_SCHEMA_VERSION,
  });
  return lyrics;
}

export const attachLrclibRecord = attachLrcmuxRecord;
export const attachLyricsDbRecord = attachLrcmuxRecord;

/**
 * Full discovery flow for one track (task §6):
 *
 * 1. Local lyrics + cache metadata are read first.
 * 2. Manual/imported lyrics are returned untouched (never silently replaced).
 * 3. Cached word sync returns immediately — already the best quality.
 * 4. Cached line sync allows a bounded upgrade lookup for word sync only.
 * 5. Cached plain text allows a bounded upgrade lookup for line/word sync.
 * 6. With no cache: exact /api/get lookup (metadata- AND capability-
 *    validated) → /api/search ranking → auto-accept or candidate list.
 *
 * An attach is only ever a strict quality upgrade (or an explicit force
 * refresh with at least equal quality). If nothing better exists — including
 * API failures or empty payloads — the existing lyrics are kept and reported
 * as "cached", so the UI never loses visible lyrics.
 * Never blocks or touches playback; all failures return typed outcomes.
 */

/** Upgrade attempts back off for a day after finding nothing better. */
export const LYRICS_UPGRADE_RETRY_MS = 24 * 60 * 60 * 1000;

function roundDurationForApi(durationMs: number): number {
  return Math.round(durationMs / 1000);
}

/**
 * Validates one record against the track and the currently cached lyrics.
 * Returns the built document only when it is metadata-validated (strict
 * thresholds), carries a usable payload, and satisfies the quality floor:
 * - fresh (no cache): any usable capability,
 * - force refresh: equal or better than the cache,
 * - upgrade: strictly better than the cache.
 */
function considerRecord(
  track: Track,
  record: LyricMatchRecord,
  cached: TrackLyrics | null,
  minCapabilityRank: number,
): { lyrics: TrackLyrics; capability: LyricCapabilityLevel } | null {
  if (!decideMatch(track, record).autoAccept) return null;
  const lyrics = buildLyricsFromRecord(track.id, record, cached?.offsetMs ?? 0);
  const capability = detectLyricsCapability(lyrics);
  if (capability === "none") return null; // empty or malformed payload
  if (CAPABILITY_RANK[capability] < minCapabilityRank) return null;
  return { lyrics, capability };
}

async function persistAttached(
  track: Track,
  lyrics: TrackLyrics,
  record: LyricMatchRecord,
  onProgress?: (phase: ResolutionPhase) => void,
): Promise<TrackLyrics> {
  onProgress?.("saving");
  await repository.putLyrics(lyrics);
  await repository.putLyricsCacheMeta({
    trackId: track.id,
    status: "accepted",
    checkedAt: Date.now(),
    recordId: typeof record.id === "number" ? record.id : null,
    schemaVersion: DB_SCHEMA_VERSION,
  });
  notifyLyricsResolved(track.id, lyrics);
  return lyrics;
}

export type LyricsResolvedListener = (trackId: string, lyrics: TrackLyrics) => void;
const lyricsResolvedListeners = new Set<LyricsResolvedListener>();

export function onLyricsResolved(listener: LyricsResolvedListener): () => void {
  lyricsResolvedListeners.add(listener);
  return () => {
    lyricsResolvedListeners.delete(listener);
  };
}

function notifyLyricsResolved(trackId: string, lyrics: TrackLyrics): void {
  for (const listener of lyricsResolvedListeners) {
    try {
      listener(trackId, lyrics);
    } catch {
      // listener error non-fatal
    }
  }
}

/** Fresh accepted marker used as the upgrade backoff; never touches lyrics. */
async function markUpgradeChecked(trackId: string): Promise<void> {
  const meta = await repository.getLyricsCacheMeta(trackId);
  await repository.putLyricsCacheMeta({
    trackId,
    status: "accepted",
    checkedAt: Date.now(),
    recordId: meta?.recordId ?? null,
    schemaVersion: DB_SCHEMA_VERSION,
  });
}

async function upgradeBackoffActive(trackId: string): Promise<boolean> {
  const meta = await repository.getLyricsCacheMeta(trackId);
  return meta?.status === "accepted" && Date.now() - meta.checkedAt < LYRICS_UPGRADE_RETRY_MS;
}

export type LyricsProvider = "lrcmux" | "lrclib" | "lyricsdb";

let defaultProviders: LyricsProvider[] = ["lrcmux", "lrclib", "lyricsdb"];

function describeLyricsError(error: unknown): string {
  if (error instanceof LrcmuxError) return describeLrcmuxError(error);
  if (error instanceof LrclibError) return describeLrclibError(error);
  if (error instanceof LyricsDbError) return describeLyricsDbError(error);
  return describeLrcmuxError(error);
}

function deduplicateRecords(records: LyricMatchRecord[]): LyricMatchRecord[] {
  const result: LyricMatchRecord[] = [];
  for (const record of records) {
    const existingIndex = result.findIndex((existing) => {
      if (existing.id === record.id && existing.provider === record.provider) return true;
      const titleMatch = similarity(record.trackName ?? "", existing.trackName ?? "") >= 0.9;
      const artistMatch =
        !record.artistName || !existing.artistName
          ? true
          : artistSimilarity(record.artistName, existing.artistName) >= 0.8;
      const durationDelta =
        record.duration != null && existing.duration != null
          ? Math.abs(record.duration - existing.duration)
          : 0;
      return titleMatch && artistMatch && durationDelta <= 5;
    });

    if (existingIndex === -1) {
      result.push(record);
    } else {
      // If multiple providers return the same song, choose the highest-quality valid result
      const existing = result[existingIndex];
      const existingCap = CAPABILITY_RANK[recordCapability(existing)];
      const newCap = CAPABILITY_RANK[recordCapability(record)];
      if (newCap > existingCap) {
        result[existingIndex] = record;
      }
    }
  }
  return result;
}

async function fetchFromLrcmux(
  canonicalTrack: Track,
  normalized: ReturnType<typeof normalizeTrackMetadata>,
  signal: AbortSignal | undefined,
): Promise<{ records: LyricMatchRecord[]; exactRecord: LyricMatchRecord | null }> {
  const collected: LyricMatchRecord[] = [];
  let exactRecord: LyricMatchRecord | null = null;
  let lastError: unknown = null;
  const seenQueries = new Set<string>();
  const markQueryKey = (q: LrcmuxQuery) =>
    `${q.trackName ?? ""}|${q.artistName ?? ""}|${q.albumName ?? ""}|${q.q ?? ""}`;

  // Stage A — Exact identity
  const queryA: LrcmuxQuery = {
    trackName: normalized.title || undefined,
    artistName: normalized.artist || undefined,
    albumName: normalized.album || undefined,
    duration: canonicalTrack.durationMs != null ? roundDurationForApi(canonicalTrack.durationMs) : undefined,
  };

  try {
    const exact = await lrcmuxGet(queryA, signal);
    if (exact) {
      exactRecord = { ...exact, provider: "lrcmux" };
      collected.push(exactRecord);
    }
  } catch (error) {
    if (isAborted(error)) throw error;
    lastError = error;
  }

  if (exactRecord) {
    const cap = recordCapability(exactRecord);
    if (cap === "word" || cap === "line") {
      return { records: collected, exactRecord };
    }
  }

  // Stage B — Structured discovery
  const queryB: LrcmuxQuery = {
    trackName: normalized.title || undefined,
    artistName: normalized.artist || undefined,
    albumName: normalized.album || undefined,
  };
  seenQueries.add(markQueryKey(queryB));

  try {
    const resultsB = await lrcmuxSearch(queryB, signal);
    if (resultsB && resultsB.length > 0) {
      for (const r of resultsB) {
        collected.push({ ...r, provider: "lrcmux" });
      }
      return { records: collected, exactRecord };
    }
  } catch (error) {
    if (isAborted(error)) throw error;
    lastError = error;
  }

  // Stage C — Alternative queries
  for (const alt of normalized.alternateQueries) {
    if (signal?.aborted) throw new DOMException("AbortError", "AbortError");
    const altQuery: LrcmuxQuery = {
      trackName: alt.trackName || undefined,
      artistName: alt.artistName || undefined,
      q: alt.q || undefined,
    };
    const key = markQueryKey(altQuery);
    if (seenQueries.has(key)) continue;
    seenQueries.add(key);

    try {
      const altResults = await lrcmuxSearch(altQuery, signal);
      if (altResults && altResults.length > 0) {
        for (const r of altResults) {
          collected.push({ ...r, provider: "lrcmux" });
        }
        return { records: collected, exactRecord };
      }
    } catch (error) {
      if (isAborted(error)) throw error;
      lastError = error;
    }
  }

  if (collected.length === 0 && lastError) {
    throw lastError;
  }

  return { records: collected, exactRecord };
}

async function fetchFromLrclib(
  canonicalTrack: Track,
  normalized: ReturnType<typeof normalizeTrackMetadata>,
  signal: AbortSignal | undefined,
): Promise<{ records: LyricMatchRecord[]; exactRecord: LyricMatchRecord | null }> {
  const collected: LyricMatchRecord[] = [];
  let exactRecord: LyricMatchRecord | null = null;
  let lastError: unknown = null;

  // Stage A — Exact identity
  const queryA: LrclibQuery = {
    trackName: normalized.title || undefined,
    artistName: normalized.artist || undefined,
    albumName: normalized.album || undefined,
    duration: canonicalTrack.durationMs != null ? roundDurationForApi(canonicalTrack.durationMs) : undefined,
  };

  try {
    const exact = await lrclibGet(queryA, signal);
    if (exact) {
      exactRecord = { ...exact, provider: "lrclib" };
      collected.push(exactRecord);
    }
  } catch (error) {
    if (isAborted(error)) throw error;
    lastError = error;
  }

  if (exactRecord) {
    const cap = recordCapability(exactRecord);
    if (cap === "word" || cap === "line") {
      return { records: collected, exactRecord };
    }
  }

  // Stage B — Structured search
  const queryB: LrclibQuery = {
    trackName: normalized.title || undefined,
    artistName: normalized.artist || undefined,
    albumName: normalized.album || undefined,
  };

  try {
    const resultsB = await lrclibSearch(queryB, signal);
    if (resultsB && resultsB.length > 0) {
      for (const r of resultsB) {
        collected.push({ ...r, provider: "lrclib" });
      }
      return { records: collected, exactRecord };
    }
  } catch (error) {
    if (isAborted(error)) throw error;
    lastError = error;
  }

  // Stage C — Alternative queries (e.g. Primary artist without collaboration or swapped title/artist)
  for (const alt of normalized.alternateQueries) {
    if (signal?.aborted) throw new DOMException("AbortError", "AbortError");
    const altQuery: LrclibQuery = {
      trackName: alt.trackName || undefined,
      artistName: alt.artistName || undefined,
    };
    try {
      const altExact = await lrclibGet(altQuery, signal);
      if (altExact) {
        exactRecord = { ...altExact, provider: "lrclib" };
        collected.push(exactRecord);
        const cap = recordCapability(exactRecord);
        if (cap === "word" || cap === "line") {
          return { records: collected, exactRecord };
        }
      }
      const altResults = await lrclibSearch(altQuery, signal);
      if (altResults && altResults.length > 0) {
        for (const r of altResults) {
          collected.push({ ...r, provider: "lrclib" });
        }
        return { records: collected, exactRecord };
      }
    } catch (error) {
      if (isAborted(error)) throw error;
      lastError = error;
    }
  }

  if (collected.length === 0 && lastError) {
    throw lastError;
  }

  return { records: collected, exactRecord };
}

async function fetchFromLyricsDb(
  canonicalTrack: Track,
  normalized: ReturnType<typeof normalizeTrackMetadata>,
  signal: AbortSignal | undefined,
): Promise<{ records: LyricMatchRecord[]; exactRecord: LyricMatchRecord | null }> {
  const collected: LyricMatchRecord[] = [];
  let exactRecord: LyricMatchRecord | null = null;
  let lastError: unknown = null;

  const query: LyricsDbQuery = {
    trackName: normalized.title || undefined,
    artistName: normalized.artist || undefined,
    albumName: normalized.album || undefined,
    duration: canonicalTrack.durationMs != null ? roundDurationForApi(canonicalTrack.durationMs) : undefined,
  };

  try {
    const exact = await lyricsDbGet(query, signal);
    if (exact) {
      exactRecord = exact;
      collected.push(exact);
    }
  } catch (error) {
    if (isAborted(error)) throw error;
    lastError = error;
  }

  if (exactRecord) {
    const cap = recordCapability(exactRecord);
    if (cap === "word" || cap === "line") {
      return { records: collected, exactRecord };
    }
  }

  try {
    const results = await lyricsDbSearch(query, signal);
    if (results && results.length > 0) {
      for (const r of results) {
        collected.push(r);
      }
      return { records: collected, exactRecord };
    }
  } catch (error) {
    if (isAborted(error)) throw error;
    lastError = error;
  }

  if (collected.length === 0 && lastError) {
    throw lastError;
  }

  return { records: collected, exactRecord };
}

export type ResolutionPhase =
  | "identifying"
  | "searching"
  | "searching-lrcmux"
  | "searching-lrclib"
  | "searching-lyricsdb"
  | "validating"
  | "saving";

export type ResolveLyricsOptions = {
  force?: boolean;
  signal?: AbortSignal;
  onProgress?: (phase: ResolutionPhase) => void;
  libraryTracks?: Track[];
  providers?: LyricsProvider[];
};

/** Initial total search budget: up to 14 seconds (12-15s per requirement). */
export const TOTAL_SEARCH_BUDGET_MS = 14_000;
let totalSearchBudgetMs = TOTAL_SEARCH_BUDGET_MS;

async function resolveLyrics(
  track: Track,
  options: ResolveLyricsOptions,
  context: {
    cached: TrackLyrics | null;
    /** Quality floor for an attach, as a capability rank. */
    minCapabilityRank: number;
    /** When true, an unsuccessful search keeps existing lyrics instead of a chooser. */
    keepOnMiss: boolean;
  },
): Promise<LyricsResolution> {
  const { cached, minCapabilityRank, keepOnMiss } = context;
  const startTime = Date.now();

  // 0. Metadata Normalization Layer (PRD §1, §3)
  options.onProgress?.("identifying");
  const normalized = normalizeTrackMetadata(track, { libraryTracks: options.libraryTracks });
  const canonicalTrack: Track = {
    ...track,
    title: normalized.title,
    artist: normalized.artist,
    album: normalized.album ?? track.album,
  };

  options.onProgress?.("searching");

  const activeProviders = options.providers ?? defaultProviders;
  const allCollectedRecords: LyricMatchRecord[] = [];
  const exactRecords: LyricMatchRecord[] = [];
  const providerErrors: unknown[] = [];
  const providerDiagnostics: Partial<Record<LyricsProvider, ProviderDiagnostic>> = {};
  let foundWordSyncAutoAccept = false;

  const providerTasks = activeProviders.map(async (p) => {
    const pStart = Date.now();
    options.onProgress?.(`searching-${p}` as ResolutionPhase);
    try {
      let result: { records: LyricMatchRecord[]; exactRecord: LyricMatchRecord | null };
      if (p === "lrcmux") {
        result = await fetchFromLrcmux(canonicalTrack, normalized, options.signal);
      } else if (p === "lrclib") {
        result = await fetchFromLrclib(canonicalTrack, normalized, options.signal);
      } else {
        result = await fetchFromLyricsDb(canonicalTrack, normalized, options.signal);
      }
      if (result.exactRecord) {
        exactRecords.push(result.exactRecord);
      }
      allCollectedRecords.push(...result.records);

      let usableCount = 0;
      let highestScore = 0;
      let lastRejection: string | undefined;

      for (const r of result.records) {
        const decision = decideMatch(canonicalTrack, r);
        if (decision.quality.score > highestScore) {
          highestScore = decision.quality.score;
        }
        if (!decision.autoAccept && decision.quality.rejectReason) {
          lastRejection = decision.quality.rejectReason;
        }
        const consideration = considerRecord(canonicalTrack, r, cached, minCapabilityRank);
        if (consideration) {
          usableCount += 1;
          if (consideration.capability === "word") {
            foundWordSyncAutoAccept = true;
          }
        }
      }

      providerDiagnostics[p] = {
        provider: p,
        startedAt: pStart,
        durationMs: Date.now() - pStart,
        status: 200,
        recordsReturned: result.records.length,
        usableLyricsPayloads: usableCount,
        bestScore: highestScore > 0 ? highestScore : null,
        rejectionReason: lastRejection ?? null,
      };
    } catch (err) {
      const pDur = Date.now() - pStart;
      let errStatus: number | string = 500;
      if (err instanceof LrcmuxError || err instanceof LrclibError || err instanceof LyricsDbError) {
        errStatus = err.status ?? err.kind;
      }
      providerDiagnostics[p] = {
        provider: p,
        startedAt: pStart,
        durationMs: pDur,
        status: errStatus,
        recordsReturned: 0,
        usableLyricsPayloads: 0,
        bestScore: null,
        rejectionReason: null,
        error: String((err as Error)?.message || err),
      };
      if (!isAborted(err)) {
        providerErrors.push(err);
      }
    }
  });

  let timedOut = false;

  // Concurrent execution: resolves as soon as:
  // 1. All providers settle, OR
  // 2. An auto-acceptable word-sync match is found (top quality capability), OR
  // 3. The caller signal aborts (UI navigating), OR
  // 4. The total search budget expires (12-15s).
  await Promise.race([
    Promise.allSettled(providerTasks),
    new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const interval = setInterval(() => {
        if (foundWordSyncAutoAccept || options.signal?.aborted) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve();
        }
      }, 50);
      timer = setTimeout(() => {
        clearInterval(interval);
        timedOut = true;
        resolve();
      }, totalSearchBudgetMs);
    }),
  ]);

  // Safe background processing of late provider results without track mismatch
  void Promise.allSettled(providerTasks).then(async () => {
    if (!timedOut && !options.signal?.aborted) return;
    try {
      const lateDeduplicated = deduplicateRecords(allCollectedRecords);
      const lateRanked = rankCandidates(canonicalTrack, lateDeduplicated);
      for (const candidate of lateRanked) {
        const currentLyrics = (await repository.getLyrics(track.id)) ?? null;
        const currentCap = currentLyrics ? detectLyricsCapability(currentLyrics) : "none";
        const consideration = considerRecord(canonicalTrack, candidate.record, currentLyrics, CAPABILITY_RANK[currentCap] + 1);
        if (consideration && consideration.capability !== "plain" && decideMatch(canonicalTrack, candidate.record).autoAccept) {
          await persistAttached(track, consideration.lyrics, candidate.record);
          break;
        }
      }
    } catch {
      // background late persistence non-fatal
    }
  });

  let plainFallback: { lyrics: TrackLyrics; record: LyricMatchRecord } | null = null;

  // 1. Evaluate exact records first (PRD Stage A)
  const evaluatedExact = exactRecords
    .map((record) => {
      const consideration = considerRecord(canonicalTrack, record, cached, minCapabilityRank);
      return consideration ? { record, ...consideration } : null;
    })
    .filter(Boolean) as { record: LyricMatchRecord; lyrics: TrackLyrics; capability: LyricCapabilityLevel }[];

  evaluatedExact.sort((a, b) => CAPABILITY_RANK[b.capability] - CAPABILITY_RANK[a.capability]);

  if (evaluatedExact.length > 0) {
    const bestExact = evaluatedExact[0];
    if (bestExact.capability === "word" || bestExact.capability === "line") {
      options.onProgress?.("validating");
      const lyrics = await persistAttached(track, bestExact.lyrics, bestExact.record, options.onProgress);
      recordSearchDiagnostic({
        trackId: track.id,
        title: canonicalTrack.title,
        artist: canonicalTrack.artist,
        album: canonicalTrack.album,
        durationSeconds: canonicalTrack.durationMs ? Math.round(canonicalTrack.durationMs / 1000) : undefined,
        totalDurationMs: Date.now() - startTime,
        providers: providerDiagnostics,
        finalSelectedProvider: bestExact.record.provider ?? "lrcmux",
        finalCapability: bestExact.capability,
      });
      return { outcome: "attached", lyrics };
    }
    plainFallback = { lyrics: bestExact.lyrics, record: bestExact.record };
  }

  // 2. Evaluate search candidates: auto-accept if synchronized
  const deduplicated = deduplicateRecords(allCollectedRecords);
  const ranked = rankCandidates(canonicalTrack, deduplicated);

  for (const candidate of ranked) {
    const consideration = considerRecord(canonicalTrack, candidate.record, cached, minCapabilityRank);
    if (!consideration) continue;
    if (consideration.capability === "plain") continue;
    options.onProgress?.("validating");
    const lyrics = await persistAttached(track, consideration.lyrics, candidate.record, options.onProgress);
    recordSearchDiagnostic({
      trackId: track.id,
      title: canonicalTrack.title,
      artist: canonicalTrack.artist,
      album: canonicalTrack.album,
      durationSeconds: canonicalTrack.durationMs ? Math.round(canonicalTrack.durationMs / 1000) : undefined,
      totalDurationMs: Date.now() - startTime,
      providers: providerDiagnostics,
      finalSelectedProvider: candidate.record.provider ?? "lrcmux",
      finalCapability: consideration.capability,
    });
    return { outcome: "attached", lyrics };
  }

  // Fallbacks & results evaluation
  if (plainFallback) {
    options.onProgress?.("validating");
    const lyrics = await persistAttached(track, plainFallback.lyrics, plainFallback.record, options.onProgress);
    recordSearchDiagnostic({
      trackId: track.id,
      title: canonicalTrack.title,
      artist: canonicalTrack.artist,
      album: canonicalTrack.album,
      durationSeconds: canonicalTrack.durationMs ? Math.round(canonicalTrack.durationMs / 1000) : undefined,
      totalDurationMs: Date.now() - startTime,
      providers: providerDiagnostics,
      finalSelectedProvider: plainFallback.record.provider ?? "lrcmux",
      finalCapability: recordCapability(plainFallback.record),
    });
    return { outcome: "attached", lyrics };
  }

  if (keepOnMiss && cached) {
    recordSearchDiagnostic({
      trackId: track.id,
      title: canonicalTrack.title,
      artist: canonicalTrack.artist,
      album: canonicalTrack.album,
      durationSeconds: canonicalTrack.durationMs ? Math.round(canonicalTrack.durationMs / 1000) : undefined,
      totalDurationMs: Date.now() - startTime,
      providers: providerDiagnostics,
      finalSelectedProvider: "cached",
      finalCapability: detectLyricsCapability(cached),
    });
    return { outcome: "cached", lyrics: cached };
  }

  const finalCandidates = ranked;

  if (finalCandidates.length === 0) {
    recordSearchDiagnostic({
      trackId: track.id,
      title: canonicalTrack.title,
      artist: canonicalTrack.artist,
      album: canonicalTrack.album,
      durationSeconds: canonicalTrack.durationMs ? Math.round(canonicalTrack.durationMs / 1000) : undefined,
      totalDurationMs: Date.now() - startTime,
      providers: providerDiagnostics,
      finalSelectedProvider: "none",
      finalCapability: "none",
    });
    if (providerErrors.length > 0 && allCollectedRecords.length === 0) {
      return { outcome: "error", message: describeLyricsError(providerErrors[0]) };
    }
    await repository.putLyricsCacheMeta({
      trackId: track.id,
      status: "not-found",
      checkedAt: Date.now(),
      recordId: null,
      schemaVersion: DB_SCHEMA_VERSION,
    });
    return { outcome: "not-found" };
  }

  // Ambiguous or plain-only best match: offer in chooser
  recordSearchDiagnostic({
    trackId: track.id,
    title: canonicalTrack.title,
    artist: canonicalTrack.artist,
    album: canonicalTrack.album,
    durationSeconds: canonicalTrack.durationMs ? Math.round(canonicalTrack.durationMs / 1000) : undefined,
    totalDurationMs: Date.now() - startTime,
    providers: providerDiagnostics,
    finalSelectedProvider: "none",
    finalCapability: "none",
  });
  await repository.putLyricsCacheMeta({
    trackId: track.id,
    status: "needs-selection",
    checkedAt: Date.now(),
    recordId: null,
    schemaVersion: DB_SCHEMA_VERSION,
  });
  return { outcome: "needs-selection", candidates: finalCandidates };
}

const inFlightResolutions = new Map<string, Promise<LyricsResolution>>();

export async function resolveLyricsForTrack(
  track: Track,
  options: ResolveLyricsOptions = {},
): Promise<LyricsResolution> {
  const { force = false } = options;

  if (!force) {
    const pending = inFlightResolutions.get(track.id);
    if (pending) {
      return pending;
    }
  }

  const runResolution = async (): Promise<LyricsResolution> => {
    // 1. Local lyrics are the starting point.
    const cached = (await repository.getLyrics(track.id)) ?? null;
    const cachedCapability = cached ? detectLyricsCapability(cached) : null;
    // Explicit manual origin marks user-imported lyrics — the API must never
    // silently replace them. Records without any origin are legacy API caches:
    // their capability is inferred from the payload and they remain upgradable.
    const cachedIsManual = cached?.origin?.kind === "manual";

    if (cached && !force) {
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return { outcome: "cached", lyrics: cached };
      }
      // Manual lyrics and already-best-quality caches never touch the network.
      if (cachedIsManual || cachedCapability === "word" || cachedCapability === "instrumental") {
        return { outcome: "cached", lyrics: cached };
      }
      if (cachedCapability === "line" || cachedCapability === "plain") {
        // Quality-upgrade lookup, bounded by a daily backoff so replaying a
        // track does not re-query the API every time.
        if (await upgradeBackoffActive(track.id)) {
          return { outcome: "cached", lyrics: cached };
        }
        const upgraded = await resolveLyrics(track, options, {
          cached,
          minCapabilityRank: CAPABILITY_RANK[cachedCapability] + 1,
          keepOnMiss: true,
        });
        if (upgraded.outcome === "attached") return upgraded;
        // Nothing better exists (or the attempt failed): keep the cache, and
        // back off so replaying the track does not re-query.
        await markUpgradeChecked(track.id);
        return { outcome: "cached", lyrics: cached };
      }
      // "none": the cached document has no usable content — fall through to a
      // full discovery below.
    }

    // 2. Negative cache: skip recently failed lookups instead of hammering the
    //    API. Only meaningful when there are no (usable) lyrics to protect.
    if (!force) {
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

    // 3. Full discovery. Force refreshes must reach at least the quality the
    //    user already has; a fresh (cache-less) track accepts any usable result.
    return resolveLyrics(track, options, {
      cached,
      minCapabilityRank: cached ? CAPABILITY_RANK[cachedCapability!] : CAPABILITY_RANK.plain,
      keepOnMiss: Boolean(cached),
    });
  };

  const promise = runResolution();
  inFlightResolutions.set(track.id, promise);
  try {
    return await promise;
  } finally {
    inFlightResolutions.delete(track.id);
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

/** Test hook for configuring default providers in test suites. */
export const __testHooks = {
  setDefaultProviders(providers: LyricsProvider[]): void {
    defaultProviders = providers;
  },
  getDefaultProviders(): LyricsProvider[] {
    return [...defaultProviders];
  },
  setTotalSearchBudgetMs(budgetMs: number): void {
    totalSearchBudgetMs = budgetMs;
  },
  getTotalSearchBudgetMs(): number {
    return totalSearchBudgetMs;
  },
};
