import type { Track } from "../../types";
import { normalizeForSearch } from "../../utils/misc";
import type { LrclibRecord } from "./lrclibClient";
import type { LrcmuxRecord } from "./lrcmuxClient";

export type LyricMatchRecord = LrcmuxRecord | LrclibRecord;

/**
 * Pure matching logic (feature spec §1): score LRCLIB candidates against the
 * local track and decide between auto-accept, showing a chooser, or not-found.
 * Never assumes the first result is right; confidence thresholds are explicit.
 */

export type MatchQuality = {
  score: number; // 0..100
  titleSimilarity: number; // 0..1
  artistSimilarity: number | null; // null when the local track has no artist
  albumSimilarity: number | null;
  durationDeltaSeconds: number | null;
  rejected: boolean;
  rejectReason?: string;
};

export type MatchDecision = {
  quality: MatchQuality;
  /** True when the match is safe to attach without asking the user. */
  autoAccept: boolean;
  /** True when the record is plausible enough to offer in the chooser. */
  candidate: boolean;
};

const AUTO_ACCEPT_SCORE = 72;
const AUTO_ACCEPT_TITLE = 0.85;
const CANDIDATE_SCORE = 40;
const CANDIDATE_TITLE = 0.55;

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

function similarity(a: string, b: string): number {
  const left = normalizeForSearch(a);
  const right = normalizeForSearch(b);
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  // Substring containment counts as a full match: LRCLIB artist strings often
  // carry extra cruft ("The Beatles - Remastered 2009").
  if (left.includes(right) || right.includes(left)) return 0.95;
  const distance = levenshtein(left, right);
  return Math.max(0, 1 - distance / Math.max(left.length, right.length));
}

function durationScore(deltaSeconds: number): number {
  // 0 s apart is perfect; decays to 0 at 15 s.
  return Math.max(0, 1 - deltaSeconds / 15);
}

export function evaluateMatch(
  track: Pick<Track, "title" | "artist" | "album" | "durationMs">,
  record: Pick<LyricMatchRecord, "trackName" | "artistName" | "albumName" | "duration">,
): MatchQuality {
  const titleSimilarity = similarity(track.title, record.trackName ?? "");
  const artistSimilarity = track.artist && record.artistName ? similarity(track.artist, record.artistName) : null;
  const albumSimilarity = track.album && record.albumName ? similarity(track.album, record.albumName) : null;
  const durationDeltaSeconds =
    track.durationMs != null && record.duration != null
      ? Math.abs(track.durationMs / 1000 - record.duration)
      : null;

  // Normalize by the weights actually available, so a track without album or
  // artist metadata can still reach a full score on title + duration.
  let score = titleSimilarity * 45;
  let maxScore = 45;
  if (artistSimilarity !== null) {
    score += artistSimilarity * 25;
    maxScore += 25;
  }
  if (albumSimilarity !== null) {
    score += albumSimilarity * 12;
    maxScore += 12;
  }
  if (durationDeltaSeconds !== null) {
    score += durationScore(durationDeltaSeconds) * 18;
    maxScore += 18;
  }

  // Hard rejects are for records that clearly describe a different song. A
  // same-title/different-artist record (covers, features) stays as a chooser
  // candidate — it just never auto-accepts.
  let rejected = false;
  let rejectReason: string | undefined;
  if (titleSimilarity < 0.5) {
    rejected = true;
    rejectReason = "Title does not match.";
  } else if (titleSimilarity < 0.75 && artistSimilarity !== null && artistSimilarity < 0.4) {
    rejected = true;
    rejectReason = "Neither title nor artist matches.";
  } else if (durationDeltaSeconds !== null && durationDeltaSeconds > 20 && titleSimilarity < 0.98) {
    rejected = true;
    rejectReason = "Duration differs by more than 20 seconds.";
  }

  return {
    score: Math.round(Math.min(100, (score / maxScore) * 100) * 10) / 10,
    titleSimilarity,
    artistSimilarity,
    albumSimilarity,
    durationDeltaSeconds,
    rejected,
    rejectReason,
  };
}

export function decideMatch(track: Pick<Track, "title" | "artist" | "album" | "durationMs">, record: LyricMatchRecord): MatchDecision {
  const quality = evaluateMatch(track, record);
  const autoAccept =
    !quality.rejected &&
    quality.score >= AUTO_ACCEPT_SCORE &&
    quality.titleSimilarity >= AUTO_ACCEPT_TITLE &&
    (quality.artistSimilarity === null || quality.artistSimilarity >= 0.7);
  const candidate = !quality.rejected && quality.titleSimilarity >= CANDIDATE_TITLE && quality.score >= CANDIDATE_SCORE;
  return { quality, autoAccept, candidate };
}

export type RankedCandidate = {
  record: LyricMatchRecord;
  quality: MatchQuality;
  hasSynced: boolean;
  hasPlain: boolean;
};

export function rankCandidates(
  track: Pick<Track, "title" | "artist" | "album" | "durationMs">,
  records: LyricMatchRecord[],
): RankedCandidate[] {
  return records
    .map((record) => {
      const quality = evaluateMatch(track, record);
      return {
        record,
        quality,
        hasSynced: Boolean(record.syncedLyrics),
        hasPlain: Boolean(record.plainLyrics),
      };
    })
    .filter((entry) => !entry.quality.rejected)
    // Synchronized lyrics rank above plain; word-sync above line-sync.
    .sort((a, b) => {
      const syncDiff = Number(b.hasSynced) - Number(a.hasSynced);
      if (syncDiff !== 0) return syncDiff;
      const wordDiff = Number(b.record.hasWordSync) - Number(a.record.hasWordSync);
      if (wordDiff !== 0) return wordDiff;
      return b.quality.score - a.quality.score;
    })
    .slice(0, 12);
}

export const MATCH_THRESHOLDS = { AUTO_ACCEPT_SCORE, AUTO_ACCEPT_TITLE, CANDIDATE_SCORE, CANDIDATE_TITLE };
