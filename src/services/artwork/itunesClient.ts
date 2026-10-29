import { normalizeForSearch } from "../../utils/misc";

export type ItunesTrackResult = {
  trackId: number;
  trackName: string;
  artistName: string;
  collectionName?: string;
  artworkUrl100?: string;
  artworkUrl60?: string;
  trackTimeMillis?: number;
};

export type ItunesSearchResponse = {
  resultCount: number;
  results: ItunesTrackResult[];
};

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

export function computeStringSimilarity(a: string, b: string): number {
  const left = normalizeForSearch(a);
  const right = normalizeForSearch(b);
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  // Substring match counts as strong similarity
  if (left.includes(right) || right.includes(left)) return 0.92;
  const distance = levenshteinDistance(left, right);
  return Math.max(0, 1 - distance / Math.max(left.length, right.length));
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
  const candidates: RankedItunesCandidate[] = [];

  for (const item of results) {
    if (!item.trackName || !item.artworkUrl100) continue;

    const titleSim = computeStringSimilarity(track.title, item.trackName);
    const hasTrackArtist = Boolean(track.artist && track.artist.trim());
    const artistSim = hasTrackArtist && item.artistName
      ? computeStringSimilarity(track.artist!, item.artistName)
      : 1;

    // Reject if title is clearly a different song
    if (titleSim < 0.62) {
      continue;
    }

    // Reject if artist is provided but clearly a different artist
    if (hasTrackArtist && artistSim < 0.4) {
      continue;
    }

    // Optional duration check if both are present
    let durationDeltaSec: number | null = null;
    let durationBonus = 0;
    if (track.durationMs != null && item.trackTimeMillis != null) {
      durationDeltaSec = Math.abs(track.durationMs - item.trackTimeMillis) / 1000;
      if (durationDeltaSec > 45 && titleSim < 0.9) {
        continue;
      }
      durationBonus = Math.max(0, 1 - durationDeltaSec / 25) * 10;
    }

    // Optional album bonus
    let albumBonus = 0;
    if (track.album && item.collectionName) {
      const albumSim = computeStringSimilarity(track.album, item.collectionName);
      if (albumSim > 0.75) albumBonus = 10;
    }

    // Calculate overall match score (0..100)
    const baseScore = hasTrackArtist
      ? titleSim * 50 + artistSim * 30 + durationBonus + albumBonus
      : titleSim * 70 + durationBonus + albumBonus;

    // Prefer 600x600 high-res artwork over 100x100 thumbnail
    const highResArtworkUrl = item.artworkUrl100.replace(/\/\d+x\d+bb\./, "/600x600bb.");

    candidates.push({
      result: item,
      titleSimilarity: titleSim,
      artistSimilarity: artistSim,
      score: Math.round(baseScore * 10) / 10,
      artworkUrl: highResArtworkUrl,
    });
  }

  // Sort candidates by score descending
  return candidates.sort((a, b) => b.score - a.score);
}

/**
 * Searches the Apple iTunes Search API for matching album artwork.
 * Strictly adheres to non-paid Apple Search API specs:
 * https://itunes.apple.com/search
 */
export async function searchItunesArtwork(
  track: { title: string; artist?: string; album?: string; durationMs?: number | null },
  signal?: AbortSignal,
): Promise<string | null> {
  const cleanTitle = track.title?.trim();
  if (!cleanTitle) return null;

  const cleanArtist = track.artist?.trim();
  const queryParts = [cleanArtist, cleanTitle].filter(Boolean);
  const term = queryParts.join(" ");

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), 8000);

  // Link caller signal if provided
  const onCallerAbort = () => timeoutController.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeoutId);
      return null;
    }
    signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=10`;
    const response = await fetch(url, {
      signal: timeoutController.signal,
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as ItunesSearchResponse;
    if (!data.results || !Array.isArray(data.results) || data.results.length === 0) {
      return null;
    }

    const candidates = validateAndRankItunesResults(track, data.results);
    if (candidates.length === 0) {
      return null;
    }

    return candidates[0].artworkUrl;
  } catch {
    // Network errors, aborts, JSON errors fail gracefully with null
    return null;
  } finally {
    clearTimeout(timeoutId);
    if (signal) {
      signal.removeEventListener("abort", onCallerAbort);
    }
  }
}
