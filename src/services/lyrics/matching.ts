import type { Track } from "../../types";
import { normalizeForSearch } from "../../utils/misc";
import { extractPrimaryArtist, extractVersionQualifiers } from "../metadata/normalization";
import { CAPABILITY_RANK, recordCapability, type LyricCapabilityLevel } from "./capability";
import type { LrclibRecord } from "./lrclibClient";
import type { LrcmuxRecord } from "./lrcmuxClient";

export type LyricMatchRecord = LrcmuxRecord | LrclibRecord;

/**
 * Pure matching logic (PRD §5): score candidates against the local track
 * and decide between auto-accept, showing a chooser, or continuing discovery.
 * Never assumes the first result is right; confidence thresholds are explicit.
 */

export type MatchQuality = {
  score: number; // 0..100
  titleSimilarity: number; // 0..1
  artistSimilarity: number | null; // null when the local track has no artist
  albumSimilarity: number | null;
  durationDeltaSeconds: number | null;
  versionMismatch?: boolean;
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

/**
 * Configurable decision thresholds (PRD §5).
 * - 90–100: Strong match (auto-accept).
 * - 80–89: Accept only after additional identity validation.
 * - Below 80: Continue searching; do not automatically attach lyrics.
 */
export const MATCH_THRESHOLDS = {
  STRONG_MATCH_SCORE: 90,
  VALIDATED_MATCH_SCORE: 80,
  AUTO_ACCEPT_SCORE: 80, // legacy alias pointing to validated floor
  AUTO_ACCEPT_TITLE: 0.85,
  AUTO_ACCEPT_ARTIST: 0.75,
  CANDIDATE_SCORE: 40,
  CANDIDATE_TITLE: 0.55,
};

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

/** Bracketed qualifiers: "(Remastered 2011)", "[Live]", "{Deluxe}". */
const BRACKETED_SEGMENT = /\([^()]*\)|\[[^\][]*\]|\{[^{}]*\}/g;
const FEAT_SEGMENT = /\s*\b(?:feat|ft|featuring)\.?\s+.*$/i;
const PUNCTUATION = /[\p{P}\p{S}]+/gu;
const WHITESPACE = /\s+/g;

/**
 * Canonical form used for basic normalization comparison — strips release
 * qualifiers, featured credits, punctuation, and diacritics.
 */
function canonicalizeForMatch(input: string): string {
  let text = normalizeForSearch(input);
  const plain = text;
  text = text.replace(BRACKETED_SEGMENT, " ");
  text = text.replace(FEAT_SEGMENT, " ");
  const dashSplit = text.split(/\s+-\s+/);
  if (
    dashSplit.length > 1 &&
    /(remaster|live|deluxe|version|edit|mono|stereo|anniversary|edition|single|album|explicit|bonus|acoustic|demo|instrumental|remix|extended|\d{4})/.test(
      dashSplit[dashSplit.length - 1],
    )
  ) {
    text = dashSplit.slice(0, -1).join(" - ");
  }
  text = text.replace(PUNCTUATION, " ").replace(WHITESPACE, " ").trim();
  return text.length > 0 ? text : plain;
}

export function rawSimilarity(a: string, b: string): number {
  const left = normalizeForSearch(a);
  const right = normalizeForSearch(b);
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  if (left.includes(right) || right.includes(left)) return 0.95;
  const distance = levenshtein(left, right);
  return Math.max(0, 1 - distance / Math.max(left.length, right.length));
}

export function similarity(a: string, b: string): number {
  const canonical = rawSimilarity(canonicalizeForMatch(a), canonicalizeForMatch(b));
  if (canonical >= 0.95) return canonical;
  return Math.max(canonical, rawSimilarity(a, b) * 0.98);
}

/**
 * Compares artist strings accounting for artist aliases, featured artists,
 * and topic channels (PRD §5).
 */
export function artistSimilarity(a: string, b: string): number {
  const rawSim = similarity(a, b);
  if (rawSim >= 0.9) return rawSim;

  const primaryA = extractPrimaryArtist(a);
  const primaryB = extractPrimaryArtist(b);
  if (primaryA && primaryB) {
    const primarySim = similarity(primaryA, primaryB);
    if (primarySim >= 0.9) return Math.max(rawSim, 0.95);
  }

  return rawSim;
}

/**
 * Computes duration compatibility score (PRD §5: 15% weight).
 * Treats duration as a compatibility signal rather than an absolute rejection,
 * smoothly accommodating video intros, outros, and alternate edits.
 */
export function durationScore(deltaSeconds: number): number {
  if (deltaSeconds <= 3) return 1.0;
  if (deltaSeconds <= 15) return Math.max(0.75, 1 - (deltaSeconds - 3) / 48);
  if (deltaSeconds <= 60) return Math.max(0.25, 0.75 - ((deltaSeconds - 15) / 45) * 0.5);
  if (deltaSeconds <= 120) return Math.max(0.05, 0.25 - ((deltaSeconds - 60) / 60) * 0.2);
  return 0;
}

export function evaluateMatch(
  track: Pick<Track, "title" | "artist" | "album" | "durationMs">,
  record: Pick<LyricMatchRecord, "trackName" | "artistName" | "albumName" | "duration">,
): MatchQuality {
  let titleSim = similarity(track.title, record.trackName ?? "");
  const artistSim =
    track.artist && record.artistName ? artistSimilarity(track.artist, record.artistName) : null;
  const albumSim =
    track.album && record.albumName ? similarity(track.album, record.albumName) : null;
  const durationDeltaSeconds =
    track.durationMs != null && record.duration != null
      ? Math.abs(track.durationMs / 1000 - record.duration)
      : null;

  // Check version qualifiers (Case D: Live Acoustic vs Studio)
  const trackQualifiers = extractVersionQualifiers(track.title);
  const recordQualifiers = extractVersionQualifiers(record.trackName ?? "");
  let versionMismatch = false;

  if (trackQualifiers.size > 0) {
    const hasSharedQualifier = Array.from(trackQualifiers).some((q) => recordQualifiers.has(q));
    if (!hasSharedQualifier) {
      // The local track is an alternate version (e.g. Live or Acoustic),
      // but the candidate does not have this distinction.
      versionMismatch = true;
      titleSim = Math.min(titleSim, 0.6);
    }
  }

  // PRD §5 Weights:
  // Track title: 40%
  // Artist identity: 35%
  // Duration compatibility: 15%
  // Album: 10%
  let score = titleSim * 40;
  let maxScore = 40;

  if (artistSim !== null) {
    score += artistSim * 35;
    maxScore += 35;
  }
  if (albumSim !== null) {
    score += albumSim * 10;
    maxScore += 10;
  }
  if (durationDeltaSeconds !== null) {
    score += durationScore(durationDeltaSeconds) * 15;
    maxScore += 15;
  }

  const rawTitleSimilarity = rawSimilarity(track.title, record.trackName ?? "");
  let rejected = false;
  let rejectReason: string | undefined;

  if (titleSim < 0.5) {
    rejected = true;
    rejectReason = "Title does not match.";
  } else if (titleSim < 0.75 && artistSim !== null && artistSim < 0.4) {
    rejected = true;
    rejectReason = "Neither title nor artist matches.";
  } else if (durationDeltaSeconds !== null && durationDeltaSeconds > 60 && rawTitleSimilarity < 0.98) {
    rejected = true;
    rejectReason = "Duration differs by more than 60 seconds.";
  }

  const finalScore = Math.round(Math.min(100, (score / maxScore) * 100) * 10) / 10;

  return {
    score: finalScore,
    titleSimilarity: titleSim,
    artistSimilarity: artistSim,
    albumSimilarity: albumSim,
    durationDeltaSeconds,
    versionMismatch,
    rejected,
    rejectReason,
  };
}

export function decideMatch(
  track: Pick<Track, "title" | "artist" | "album" | "durationMs">,
  record: LyricMatchRecord,
): MatchDecision {
  const quality = evaluateMatch(track, record);

  // Auto-accept only if not rejected, no version mismatch, and passes decision thresholds
  const autoAccept =
    !quality.rejected &&
    !quality.versionMismatch &&
    ((quality.score >= MATCH_THRESHOLDS.STRONG_MATCH_SCORE &&
      quality.titleSimilarity >= MATCH_THRESHOLDS.AUTO_ACCEPT_TITLE &&
      (quality.artistSimilarity === null || quality.artistSimilarity >= MATCH_THRESHOLDS.AUTO_ACCEPT_ARTIST)) ||
      (quality.score >= MATCH_THRESHOLDS.VALIDATED_MATCH_SCORE &&
        quality.titleSimilarity >= MATCH_THRESHOLDS.AUTO_ACCEPT_TITLE &&
        (quality.artistSimilarity === null || quality.artistSimilarity >= MATCH_THRESHOLDS.AUTO_ACCEPT_ARTIST)));

  const candidate =
    !quality.rejected &&
    quality.titleSimilarity >= MATCH_THRESHOLDS.CANDIDATE_TITLE &&
    quality.score >= MATCH_THRESHOLDS.CANDIDATE_SCORE;

  return { quality, autoAccept, candidate };
}

export type RankedCandidate = {
  record: LyricMatchRecord;
  quality: MatchQuality;
  /** Payload-verified lyric capability (never the provider's own flag). */
  capability: LyricCapabilityLevel;
  hasSynced: boolean;
  hasPlain: boolean;
  /** True when the record passes the strict auto-accept thresholds. */
  autoAcceptable: boolean;
};

/**
 * Ranks search candidates (PRD §5, §6). Order: safe-to-attach records first,
 * then by lyric capability (word > line > plain), then by metadata score.
 * Records with no usable lyric content are dropped.
 */
export function rankCandidates(
  track: Pick<Track, "title" | "artist" | "album" | "durationMs">,
  records: LyricMatchRecord[],
): RankedCandidate[] {
  return records
    .map((record) => {
      const decision = decideMatch(track, record);
      return {
        record,
        quality: decision.quality,
        autoAcceptable: decision.autoAccept,
        capability: recordCapability(record),
        hasSynced: Boolean(record.syncedLyrics),
        hasPlain: Boolean(record.plainLyrics),
      };
    })
    .filter((entry) => !entry.quality.rejected && entry.capability !== "none")
    .sort((a, b) => {
      const acceptDiff = Number(b.autoAcceptable) - Number(a.autoAcceptable);
      if (acceptDiff !== 0) return acceptDiff;
      const capabilityDiff = CAPABILITY_RANK[b.capability] - CAPABILITY_RANK[a.capability];
      if (capabilityDiff !== 0) return capabilityDiff;
      return b.quality.score - a.quality.score;
    })
    .slice(0, 12);
}
