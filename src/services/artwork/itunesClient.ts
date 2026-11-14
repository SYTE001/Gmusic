import {
  cleanNoiseFromText,
  extractVersionQualifiers,
  isYearOnly,
  normalizeForMatching,
} from "../metadata/normalization";
import {
  isAbortError,
  type CandidateScoreDiagnostic,
  type ProviderStageClassification,
} from "./artworkDiagnostics";

export type ItunesTrackResult = {
  trackId: number;
  trackName: string;
  artistName: string;
  collectionName?: string;
  artworkUrl100?: string;
  artworkUrl60?: string;
  trackTimeMillis?: number;
};

export type ItunesAlbumResult = {
  collectionId?: number;
  collectionName?: string;
  artistName?: string;
  artworkUrl100?: string;
  artworkUrl60?: string;
  trackCount?: number;
};

export type ItunesSearchResponse = {
  resultCount: number;
  results: Array<ItunesTrackResult & ItunesAlbumResult>;
};

const DEFAULT_ITUNES_RATE_LIMIT_MS = import.meta.env.MODE === "test" ? 0 : 350;
const DEFAULT_ITUNES_RETRY_DELAY_MS = import.meta.env.MODE === "test" ? 0 : 1000;
let itunesMinIntervalMs = DEFAULT_ITUNES_RATE_LIMIT_MS;
let itunesRetryDelayMs = DEFAULT_ITUNES_RETRY_DELAY_MS;
let itunesNextAllowedAtMs = 0;

export function __configureItunesForTests(options?: {
  rateLimitMs?: number;
  retryDelayMs?: number;
}): void {
  itunesMinIntervalMs = options?.rateLimitMs ?? DEFAULT_ITUNES_RATE_LIMIT_MS;
  itunesRetryDelayMs = options?.retryDelayMs ?? DEFAULT_ITUNES_RETRY_DELAY_MS;
  itunesNextAllowedAtMs = 0;
}

async function waitForItunesRateLimitSlot(signal?: AbortSignal): Promise<void> {
  if (itunesMinIntervalMs <= 0) return;
  const now = Date.now();
  const scheduled = Math.max(now, itunesNextAllowedAtMs);
  const waitMs = scheduled - now;
  itunesNextAllowedAtMs = scheduled + itunesMinIntervalMs;
  if (waitMs > 0) {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, waitMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export type RankedItunesCandidate = {
  result: ItunesTrackResult;
  titleSimilarity: number;
  artistSimilarity: number;
  score: number;
  artworkUrl: string;
};

export function levenshteinDistance(a: string, b: string): number {
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

function stripTrailingBracketsAndSuffixes(raw: string): string {
  return cleanNoiseFromText(raw)
    .cleaned
    .replace(/\s*[([][^)\]]*\b(feat\.?|ft\.?|featuring|with|deluxe|expanded|special|anniversary|remaster(?:ed)?|explicit|clean|edition|version|single|ep|from\s+"[^"]*")\b[^)\]]*[)\]]/gi, "")
    .replace(/\s+[-–—:]\s*(single|ep|deluxe.*|remaster(?:ed)?.*)$/i, "")
    .replace(/\s+(?:feat|ft|featuring)\.?\s+.+$/i, "")
    .trim();
}

export function computeStringSimilarity(a: string, b: string): number {
  const left = normalizeForMatching(a);
  const right = normalizeForMatching(b);
  if (left === right) return left.length > 0 ? 1 : 0;
  if (left.length === 0 || right.length === 0) return 0;
  if (left.includes(right) || right.includes(left)) return 0.92;

  const leftCore = normalizeForMatching(stripTrailingBracketsAndSuffixes(a));
  const rightCore = normalizeForMatching(stripTrailingBracketsAndSuffixes(b));
  if (leftCore && rightCore && leftCore.length >= 4 && rightCore.length >= 4) {
    if (leftCore === rightCore) return 0.94;
    if (leftCore.includes(rightCore) || rightCore.includes(leftCore)) {
      // Only treat core containment as high when shorter string isn't a tiny word
      const shorterLen = Math.min(leftCore.length, rightCore.length);
      if (shorterLen >= 6) return 0.88;
    }
  }

  const distance = levenshteinDistance(left, right);
  return Math.max(0, 1 - distance / Math.max(left.length, right.length));
}

const COLLAB_JOIN_TOKENS = new Set(["and", "feat", "ft", "featuring", "with", "vs", "x", "dan"]);

function computeArtistMatchSimilarity(queryArtist: string, candidateArtist: string): number {
  const baseSim = computeStringSimilarity(queryArtist, candidateArtist);
  if (baseSim >= 0.9) return baseSim;

  const tokenize = (value: string) =>
    normalizeForMatching(value)
      .split(" ")
      .filter((t) => t.length > 0 && !COLLAB_JOIN_TOKENS.has(t));

  const tokensA = tokenize(queryArtist);
  const tokensB = tokenize(candidateArtist);
  if (tokensA.length === 0 || tokensB.length === 0) return baseSim;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let overlap = 0;
  for (const t of setA) {
    if (setB.has(t)) overlap += 1;
  }
  if (overlap === 0) return baseSim;

  const union = new Set([...setA, ...setB]).size;
  const jaccard = overlap / union;
  // Reordered collaborations (e.g., "Calvin Harris & Dua Lipa" vs "Dua Lipa, Calvin Harris")
  if (setA.size >= 2 && setB.size >= 2 && jaccard >= 0.7) {
    return Math.max(baseSim, jaccard * 0.96);
  }

  // Individual credited artist exact match (split by collab separators)
  const splitParts = (value: string) =>
    value
      .split(/\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|x)\s+|\s*[,;&/]\s*/i)
      .map((p) => normalizeForMatching(p))
      .filter((p) => p.length >= 3);

  const qParts = splitParts(queryArtist);
  const cParts = splitParts(candidateArtist);
  for (const qp of qParts) {
    for (const cp of cParts) {
      if (qp === cp) {
        return Math.max(baseSim, 0.88);
      }
    }
  }

  return baseSim;
}

export interface ItunesArtworkDetails {
  artworkUrl: string;
  collectionName?: string;
  artistName?: string;
  score: number;
}

export interface ItunesSearchOutcomeDiagnostic {
  httpStatus: number | null;
  classification: ProviderStageClassification;
  resultCount: number;
  acceptedCount: number;
  rejectedCount: number;
  candidateScores: CandidateScoreDiagnostic[];
  searchType: "song" | "album";
  failedRequests: number;
}

export interface ItunesSearchOptions {
  signal?: AbortSignal;
  excludeUrl?: (url: string) => boolean;
  onTransientError?: () => void;
  onSearchOutcome?: (outcome: ItunesSearchOutcomeDiagnostic) => void;
  searchType?: "song" | "album";
  maxRetries?: number;
  retryDelayMs?: number;
}

function inspectAndRankItunesResults(
  track: { title: string; artist?: string; album?: string; durationMs?: number | null },
  results: ItunesTrackResult[],
): { candidates: RankedItunesCandidate[]; candidateScores: CandidateScoreDiagnostic[] } {
  const candidates: RankedItunesCandidate[] = [];
  const candidateScores: CandidateScoreDiagnostic[] = [];
  const queryFlags = extractVersionQualifiers(track.title);

  for (const item of results) {
    if (!item.trackName || !item.artworkUrl100) continue;

    const titleSim = computeStringSimilarity(track.title, item.trackName);
    const hasTrackArtist = Boolean(track.artist && track.artist.trim());
    const artistSim = hasTrackArtist && item.artistName
      ? computeArtistMatchSimilarity(track.artist!, item.artistName)
      : 1;

    // Reject if title is clearly a different song
    if (titleSim < 0.62) {
      if (candidateScores.length < 6) {
        candidateScores.push({
          title: item.trackName,
          artist: item.artistName,
          confidence: Math.round(titleSim * 100),
          accepted: false,
          rejectionReason: `Title similarity too low (${Math.round(titleSim * 100)}%)`,
        });
      }
      continue;
    }

    // Reject if artist is provided but clearly a different artist
    if (hasTrackArtist && artistSim < 0.45) {
      if (candidateScores.length < 6) {
        candidateScores.push({
          title: item.trackName,
          artist: item.artistName,
          confidence: Math.round(artistSim * 100),
          accepted: false,
          rejectionReason: `Artist similarity too low (${Math.round(artistSim * 100)}%)`,
        });
      }
      continue;
    }

    // Version qualifier penalty: prefer studio versions when query is not live/remix
    const candidateMeta = `${item.trackName} ${item.collectionName ?? ""}`;
    const candidateFlags = extractVersionQualifiers(candidateMeta);
    let versionPenalty = 0;
    if (candidateFlags.has("live") && !queryFlags.has("live")) {
      versionPenalty -= 20;
    }
    if (candidateFlags.has("remix") && !queryFlags.has("remix")) {
      versionPenalty -= 20;
    }
    if (candidateFlags.has("acoustic") && !queryFlags.has("acoustic")) {
      versionPenalty -= 15;
    }
    if (candidateFlags.has("instrumental") && !queryFlags.has("instrumental")) {
      versionPenalty -= 25;
    }

    // Optional duration check if both are present (allow moderate intro/outro gaps on YouTube rips
    // when title + artist are strong, while penalizing wrong extended/live mixes)
    let durationDeltaSec: number | null = null;
    let durationBonus = 0;
    if (track.durationMs != null && item.trackTimeMillis != null) {
      durationDeltaSec = Math.abs(track.durationMs - item.trackTimeMillis) / 1000;
      if (
        (durationDeltaSec > 90 && titleSim < 0.92) ||
        (durationDeltaSec > 45 && titleSim < 0.78)
      ) {
        if (candidateScores.length < 6) {
          candidateScores.push({
            title: item.trackName,
            artist: item.artistName,
            confidence: Math.round((titleSim * 50 + artistSim * 30)),
            accepted: false,
            rejectionReason: `Duration delta ${Math.round(durationDeltaSec)}s exceeds threshold`,
          });
        }
        continue;
      }
      if (durationDeltaSec > 45) {
        durationBonus = -10;
      } else {
        durationBonus = Math.max(0, 1 - durationDeltaSec / 25) * 10;
      }
    }

    // Optional album bonus (ignore pure release years)
    let albumBonus = 0;
    const hasMeaningfulAlbum = Boolean(track.album && !isYearOnly(track.album));
    if (hasMeaningfulAlbum && item.collectionName) {
      const albumSim = computeStringSimilarity(track.album!, item.collectionName);
      if (albumSim > 0.75) albumBonus = 10;
    }

    // Calculate overall match score (0..100)
    const baseScore = hasTrackArtist
      ? titleSim * 50 + artistSim * 30 + durationBonus + albumBonus + versionPenalty
      : titleSim * 70 + durationBonus + albumBonus + versionPenalty;

    if (baseScore < 40) {
      if (candidateScores.length < 6) {
        candidateScores.push({
          title: item.trackName,
          artist: item.artistName,
          confidence: Math.max(0, Math.round(baseScore)),
          accepted: false,
          rejectionReason: `Score ${Math.round(baseScore)} below minimum 40`,
        });
      }
      continue;
    }

    // Prefer 600x600 high-res artwork over 100x100 thumbnail
    const highResArtworkUrl = item.artworkUrl100.replace(/\/\d+x\d+bb\./, "/600x600bb.");
    const roundedScore = Math.max(0, Math.round(baseScore * 10) / 10);

    if (candidateScores.length < 6) {
      candidateScores.push({
        title: item.trackName,
        artist: item.artistName,
        confidence: Math.round(roundedScore),
        accepted: true,
      });
    }

    candidates.push({
      result: item,
      titleSimilarity: titleSim,
      artistSimilarity: artistSim,
      score: roundedScore,
      artworkUrl: highResArtworkUrl,
    });
  }

  // Sort candidates by score descending
  candidates.sort((a, b) => b.score - a.score);
  return { candidates, candidateScores };
}

/**
 * Validates and ranks search results from the iTunes Search API against
 * the track title and artist. Rejects mismatched songs or remixes when an
 * exact title/artist match is available.
 */
export function validateAndRankItunesResults(
  track: { title: string; artist?: string; album?: string; durationMs?: number | null },
  results: ItunesTrackResult[],
): RankedItunesCandidate[] {
  return inspectAndRankItunesResults(track, results).candidates;
}

function inspectAndRankItunesAlbumResults(
  track: { album?: string; artist?: string },
  results: ItunesAlbumResult[],
): {
  candidates: Array<{ artworkUrl: string; collectionName?: string; artistName?: string; score: number }>;
  candidateScores: CandidateScoreDiagnostic[];
} {
  const targetAlbum = track.album?.trim() ?? "";
  if (!targetAlbum || isYearOnly(targetAlbum)) {
    return { candidates: [], candidateScores: [] };
  }

  const queryFlags = extractVersionQualifiers(targetAlbum);
  const candidates: Array<{ artworkUrl: string; collectionName?: string; artistName?: string; score: number }> = [];
  const candidateScores: CandidateScoreDiagnostic[] = [];

  for (const item of results) {
    if (!item.collectionName || !item.artworkUrl100) continue;
    const albumSim = computeStringSimilarity(targetAlbum, item.collectionName);
    const hasArtist = Boolean(track.artist && track.artist.trim());
    const artistSim = hasArtist && item.artistName
      ? computeArtistMatchSimilarity(track.artist!, item.artistName)
      : 1;

    if (albumSim < 0.68 || (hasArtist && artistSim < 0.55)) {
      if (candidateScores.length < 6) {
        candidateScores.push({
          title: item.collectionName,
          artist: item.artistName,
          confidence: Math.round(Math.min(albumSim, artistSim) * 100),
          accepted: false,
          rejectionReason:
            hasArtist && artistSim < 0.55
              ? `Artist similarity too low (${Math.round(artistSim * 100)}%)`
              : `Album similarity too low (${Math.round(albumSim * 100)}%)`,
        });
      }
      continue;
    }

    const candidateFlags = extractVersionQualifiers(item.collectionName);
    let penalty = 0;
    if (candidateFlags.has("live") && !queryFlags.has("live")) penalty -= 20;
    if (candidateFlags.has("remix") && !queryFlags.has("remix")) penalty -= 20;
    if (candidateFlags.has("instrumental") && !queryFlags.has("instrumental")) penalty -= 25;

    const score = (hasArtist ? albumSim * 52 + artistSim * 38 : albumSim * 80) + penalty;
    if (score < 50) {
      if (candidateScores.length < 6) {
        candidateScores.push({
          title: item.collectionName,
          artist: item.artistName,
          confidence: Math.max(0, Math.round(score)),
          accepted: false,
          rejectionReason: `Album score ${Math.round(score)} below minimum 50`,
        });
      }
      continue;
    }

    const rounded = Math.max(0, Math.round(score * 10) / 10);
    if (candidateScores.length < 6) {
      candidateScores.push({
        title: item.collectionName,
        artist: item.artistName,
        confidence: Math.round(rounded),
        accepted: true,
      });
    }
    candidates.push({
      artworkUrl: item.artworkUrl100.replace(/\/\d+x\d+bb\./, "/600x600bb."),
      collectionName: item.collectionName,
      artistName: item.artistName,
      score: rounded,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return { candidates, candidateScores };
}

/**
 * Searches the Apple iTunes Search API for matching album artwork with verified metadata.
 */
export async function searchItunesArtworkDetails(
  track: { title: string; artist?: string; album?: string; durationMs?: number | null },
  signalOrOptions?: AbortSignal | ItunesSearchOptions,
): Promise<ItunesArtworkDetails | null> {
  const options: ItunesSearchOptions =
    signalOrOptions instanceof AbortSignal ? { signal: signalOrOptions } : (signalOrOptions ?? {});
  const { signal, excludeUrl, onTransientError, onSearchOutcome } = options;
  const searchType = options.searchType ?? "song";

  const targetText =
    searchType === "album"
      ? track.album && !isYearOnly(track.album)
        ? track.album.trim()
        : ""
      : track.title?.trim() ?? "";

  if (!targetText) {
    onSearchOutcome?.({
      httpStatus: null,
      classification: "skipped",
      resultCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      candidateScores: [],
      searchType,
      failedRequests: 0,
    });
    return null;
  }

  const cleanArtist = track.artist?.trim();
  const queryParts = [cleanArtist, targetText].filter(Boolean);
  const term = queryParts.join(" ");

  const maxRetries = Math.max(0, options.maxRetries ?? 0);
  const retryDelayBase = options.retryDelayMs ?? itunesRetryDelayMs;
  let failedRequests = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0 && retryDelayBase > 0) {
      await new Promise((r) => setTimeout(r, retryDelayBase * attempt));
    }

    if (signal?.aborted) {
      onSearchOutcome?.({
        httpStatus: null,
        classification: "not-queried",
        resultCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        candidateScores: [],
        searchType,
        failedRequests,
      });
      return null;
    }

    try {
      await waitForItunesRateLimitSlot(signal);
    } catch {
      onSearchOutcome?.({
        httpStatus: null,
        classification: "not-queried",
        resultCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        candidateScores: [],
        searchType,
        failedRequests,
      });
      return null;
    }

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), 8000);
    const onCallerAbort = () => timeoutController.abort();
    if (signal) {
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    try {
      const entity = searchType === "album" ? "album" : "song";
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=${entity}&limit=10`;
      const response = await fetch(url, {
        signal: timeoutController.signal,
        headers: { Accept: "application/json" },
      });

      if (response.status === 429) {
        failedRequests += 1;
        if (attempt < maxRetries) continue;
        onTransientError?.();
        onSearchOutcome?.({
          httpStatus: 429,
          classification: "rate-limited",
          resultCount: 0,
          acceptedCount: 0,
          rejectedCount: 0,
          candidateScores: [],
          searchType,
          failedRequests,
        });
        return null;
      }

      if (response.status === 503 || response.status >= 500) {
        failedRequests += 1;
        if (attempt < maxRetries) continue;
        onTransientError?.();
        onSearchOutcome?.({
          httpStatus: response.status,
          classification: "http-error",
          resultCount: 0,
          acceptedCount: 0,
          rejectedCount: 0,
          candidateScores: [],
          searchType,
          failedRequests,
        });
        return null;
      }

      if (!response.ok) {
        failedRequests += 1;
        onSearchOutcome?.({
          httpStatus: response.status,
          classification: "http-error",
          resultCount: 0,
          acceptedCount: 0,
          rejectedCount: 0,
          candidateScores: [],
          searchType,
          failedRequests,
        });
        return null;
      }

      const data = (await response.json()) as ItunesSearchResponse;
      if (!data.results || !Array.isArray(data.results) || data.results.length === 0) {
        onSearchOutcome?.({
          httpStatus: response.status,
          classification: "no-results",
          resultCount: 0,
          acceptedCount: 0,
          rejectedCount: 0,
          candidateScores: [],
          searchType,
          failedRequests,
        });
        return null;
      }

      if (searchType === "album") {
        const rankedAlbums = inspectAndRankItunesAlbumResults(
          { album: targetText, artist: cleanArtist },
          data.results,
        );
        if (rankedAlbums.candidates.length === 0) {
          onSearchOutcome?.({
            httpStatus: response.status,
            classification: "candidates-rejected",
            resultCount: data.results.length,
            acceptedCount: 0,
            rejectedCount: data.results.length,
            candidateScores: rankedAlbums.candidateScores,
            searchType,
            failedRequests,
          });
          return null;
        }
        const available = rankedAlbums.candidates.find((c) => !excludeUrl?.(c.artworkUrl));
        if (!available) {
          onSearchOutcome?.({
            httpStatus: response.status,
            classification: "candidates-rejected",
            resultCount: data.results.length,
            acceptedCount: 0,
            rejectedCount: data.results.length,
            candidateScores: rankedAlbums.candidateScores,
            searchType,
            failedRequests,
          });
          return null;
        }
        onSearchOutcome?.({
          httpStatus: response.status,
          classification: "ok",
          resultCount: data.results.length,
          acceptedCount: rankedAlbums.candidates.length,
          rejectedCount: data.results.length - rankedAlbums.candidates.length,
          candidateScores: rankedAlbums.candidateScores,
          searchType,
          failedRequests,
        });
        return {
          artworkUrl: available.artworkUrl,
          collectionName: available.collectionName,
          artistName: available.artistName,
          score: available.score,
        };
      }

      const { candidates, candidateScores } = inspectAndRankItunesResults(track, data.results);
      if (candidates.length === 0) {
        onSearchOutcome?.({
          httpStatus: response.status,
          classification: "candidates-rejected",
          resultCount: data.results.length,
          acceptedCount: 0,
          rejectedCount: data.results.length,
          candidateScores,
          searchType,
          failedRequests,
        });
        return null;
      }

      const best = candidates.find((c) => !excludeUrl?.(c.artworkUrl));
      if (!best) {
        onSearchOutcome?.({
          httpStatus: response.status,
          classification: "candidates-rejected",
          resultCount: data.results.length,
          acceptedCount: 0,
          rejectedCount: data.results.length,
          candidateScores: candidates.map((c) => ({
            title: c.result.trackName,
            artist: c.result.artistName,
            confidence: Math.round(c.score),
            accepted: false,
            rejectionReason: "Candidate artwork URL previously failed download or decode",
          })),
          searchType,
          failedRequests,
        });
        return null;
      }

      onSearchOutcome?.({
        httpStatus: response.status,
        classification: "ok",
        resultCount: data.results.length,
        acceptedCount: candidates.length,
        rejectedCount: data.results.length - candidates.length,
        candidateScores,
        searchType,
        failedRequests,
      });

      return {
        artworkUrl: best.artworkUrl,
        collectionName: best.result.collectionName,
        artistName: best.result.artistName,
        score: best.score,
      };
    } catch (err) {
      const callerAborted = Boolean(signal?.aborted);
      if (!callerAborted) {
        failedRequests += 1;
        const isTimeout =
          timeoutController.signal.aborted || isAbortError(err);
        if (attempt < maxRetries) continue;
        onTransientError?.();
        onSearchOutcome?.({
          httpStatus: null,
          classification: isTimeout ? "timeout" : "network-error",
          resultCount: 0,
          acceptedCount: 0,
          rejectedCount: 0,
          candidateScores: [],
          searchType,
          failedRequests,
        });
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener("abort", onCallerAbort);
      }
    }
  }

  return null;
}

/**
 * Searches the Apple iTunes Search API for matching album artwork.
 * Strictly adheres to non-paid Apple Search API specs:
 * https://itunes.apple.com/search
 */
export async function searchItunesArtwork(
  track: { title: string; artist?: string; album?: string; durationMs?: number | null },
  signalOrOptions?: AbortSignal | ItunesSearchOptions,
): Promise<string | null> {
  const details = await searchItunesArtworkDetails(track, signalOrOptions);
  return details?.artworkUrl ?? null;
}
