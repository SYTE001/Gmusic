import { repository } from "../indexeddb/LibraryRepository";
import { normalizeForSearch } from "../../utils/misc";
import { searchItunesArtwork } from "./itunesClient";

const CACHE_PREFIX = "artwork_itunes_v1:";
const POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CachedArtworkEntry {
  url: string | null;
  timestamp: number;
}

const memoryCache = new Map<string, { url: string | null; timestamp: number }>();
const inFlightRequests = new Map<string, Promise<string | null>>();

export function getArtworkCacheKey(track: { title: string; artist?: string }): string {
  const normArtist = normalizeForSearch(track.artist ?? "");
  const normTitle = normalizeForSearch(track.title ?? "");
  return `${normArtist}::${normTitle}`;
}

function readLocalCache(key: string): { url: string | null; valid: boolean } | null {
  // Check memory first
  const mem = memoryCache.get(key);
  if (mem) {
    const ttl = mem.url ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (Date.now() - mem.timestamp < ttl) {
      return { url: mem.url, valid: true };
    }
    memoryCache.delete(key);
  }

  // Check localStorage
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${key}`);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CachedArtworkEntry;
    if (!entry || typeof entry.timestamp !== "number") return null;
    const ttl = entry.url ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (Date.now() - entry.timestamp < ttl) {
      memoryCache.set(key, entry);
      return { url: entry.url, valid: true };
    }
    localStorage.removeItem(`${CACHE_PREFIX}${key}`);
    return null;
  } catch {
    return null;
  }
}

function writeLocalCache(key: string, url: string | null): void {
  const entry: CachedArtworkEntry = {
    url,
    timestamp: Date.now(),
  };
  memoryCache.set(key, entry);

  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify(entry));
  } catch {
    // Quota exceeded or private browsing restrictions are non-fatal
  }
}

/**
 * Resolves artwork for a track following the strict priority order:
 * 1. Embedded MP3 artwork (ID3 / metadata in IndexedDB)
 * 2. Matching iTunes Search API artwork (with local caching)
 * 3. Neutral fallback (undefined)
 */
export async function resolveArtworkForTrack(
  track: { id?: string; title: string; artist?: string; album?: string; durationMs?: number | null },
  signal?: AbortSignal,
): Promise<{ url: string | undefined; source: "embedded" | "itunes" | "none" }> {
  // 1. Check embedded artwork in IndexedDB
  if (track.id) {
    try {
      const blob = await repository.getArtwork(track.id);
      if (blob) {
        // Blob exists in IndexedDB; the caller / Artwork component wraps it in an object URL.
        return { url: undefined, source: "embedded" };
      }
    } catch {
      // IndexedDB error: proceed to online lookup
    }
  }

  // 2. Online iTunes Search API lookup with local caching
  const cacheKey = getArtworkCacheKey(track);
  if (!cacheKey || cacheKey === "::") {
    return { url: undefined, source: "none" };
  }

  const cached = readLocalCache(cacheKey);
  if (cached && cached.valid) {
    return {
      url: cached.url ?? undefined,
      source: cached.url ? "itunes" : "none",
    };
  }

  // Deduplicate in-flight requests for the same track
  let requestPromise = inFlightRequests.get(cacheKey);
  if (!requestPromise) {
    requestPromise = (async () => {
      try {
        const foundUrl = await searchItunesArtwork(track, signal);
        writeLocalCache(cacheKey, foundUrl);
        return foundUrl;
      } catch {
        return null;
      } finally {
        inFlightRequests.delete(cacheKey);
      }
    })();
    inFlightRequests.set(cacheKey, requestPromise);
  }

  const itunesUrl = await requestPromise;
  return {
    url: itunesUrl ?? undefined,
    source: itunesUrl ? "itunes" : "none",
  };
}

/** Clear in-memory cache and localStorage mappings (useful for tests) */
export function clearArtworkServiceCache(): void {
  memoryCache.clear();
  inFlightRequests.clear();
  if (typeof localStorage === "undefined") return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(CACHE_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  } catch {
    // Ignore
  }
}
