import { repository } from "../indexeddb/LibraryRepository";
import { cleanNoiseFromText, extractPrimaryArtist, isYearOnly, normalizeTrackMetadata } from "../metadata/normalization";
import { normalizeForSearch } from "../../utils/misc";
import { searchItunesArtworkDetails } from "./itunesClient";
import {
  fetchReleaseCoverArt,
  fetchReleaseGroupCoverArt,
  sanitizeArtworkUrl,
  type ArtworkThumbnailSize,
} from "./coverArtClient";
import {
  fetchReleasesForReleaseGroup,
  searchMusicBrainzReleaseGroups,
  searchMusicBrainzReleases,
  type MusicBrainzTrackQuery,
  type ScoredReleaseGroupCandidate,
} from "./musicbrainzClient";

export type ArtworkProviderSource = "embedded" | "cache" | "musicbrainz-caa" | "itunes" | "none";

export interface ArtworkResolution {
  url?: string;
  source: ArtworkProviderSource;
  releaseGroupMbid?: string | null;
  releaseMbid?: string | null;
  confidence?: number;
  album?: string;
  artist?: string;
  title?: string;
}

export interface UnifiedArtworkCacheEntry {
  key: string;
  artist: string;
  album: string;
  releaseGroupMbid: string | null;
  releaseMbid: string | null;
  url: string | null;
  provider: "musicbrainz-caa" | "itunes" | "none";
  confidence: number;
  timestamp: number;
  negative: boolean;
}

export interface ArtworkTrackInput {
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationMs?: number | null;
}

const LEGACY_CACHE_PREFIX = "artwork_cache_v1:";
const UNIFIED_CACHE_PREFIX = "artwork_cache_v2:";

/** Successful artwork mappings expire after 30 days. */
export const POSITIVE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Confirmed negative lookups expire after 24 hours. */
export const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Transient network errors use a short in-memory retry backoff (never persisted as 24h negative cache). */
export const TRANSIENT_BACKOFF_MS = 30 * 1000;

const MAX_MEMORY_CACHE_SIZE = 500;
const memoryCache = new Map<string, UnifiedArtworkCacheEntry>();
const transientBackoffUntil = new Map<string, number>();
const inFlightRequests = new Map<string, Promise<ArtworkResolution>>();

const PLACEHOLDER_ALBUMS = new Set([
  "",
  "unknown",
  "unknown album",
  "untitled",
  "none",
  "n a",
  "na",
  "null",
  "undefined",
]);

function hasMeaningfulAlbum(album: string | undefined | null): boolean {
  if (!album) return false;
  if (isYearOnly(album)) return false;
  const cleaned = normalizeForSearch(cleanNoiseFromText(album).cleaned);
  return Boolean(cleaned && !PLACEHOLDER_ALBUMS.has(cleaned) && !isYearOnly(cleaned));
}

/**
 * Generates a normalized track-level cache key (`artist::title`).
 */
export function getArtworkCacheKey(track: { title: string; artist: string }): string {
  const norm = normalizeTrackMetadata({
    title: track.title,
    artist: track.artist,
    album: "",
    durationMs: null,
    fileName: "",
  });
  const primaryArtist = extractPrimaryArtist(norm.artist);
  const cleanTitle = cleanNoiseFromText(norm.title).cleaned;

  const artistKey = normalizeForSearch(primaryArtist);
  const titleKey = normalizeForSearch(cleanTitle);

  if (!artistKey && !titleKey) return "";
  return `${artistKey}::${titleKey}`;
}

/**
 * Generates a normalized album-level cache key (`album::artist::album`) when album metadata
 * is present, or falls back to the track-level key (`artist::title`) when album is missing.
 */
export function getAlbumArtworkCacheKey(track: {
  title: string;
  artist: string;
  album?: string;
}): string {
  if (!hasMeaningfulAlbum(track.album)) {
    return getArtworkCacheKey(track);
  }
  const norm = normalizeTrackMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album ?? "",
    durationMs: null,
    fileName: "",
  });
  const primaryArtist = extractPrimaryArtist(norm.artist || track.artist);
  const cleanAlbum = cleanNoiseFromText(norm.album || track.album || "").cleaned;

  const artistKey = normalizeForSearch(primaryArtist);
  const albumKey = normalizeForSearch(cleanAlbum);
  if (!artistKey || !albumKey) {
    return getArtworkCacheKey(track);
  }
  return `album::${artistKey}::${albumKey}`;
}

function isEntryExpired(entry: UnifiedArtworkCacheEntry, nowMs = Date.now()): boolean {
  const ttl = entry.negative || !entry.url ? NEGATIVE_CACHE_TTL_MS : POSITIVE_CACHE_TTL_MS;
  return nowMs - entry.timestamp > ttl;
}

function setMemoryCacheEntry(key: string, entry: UnifiedArtworkCacheEntry): void {
  if (!key) return;
  if (memoryCache.has(key)) {
    memoryCache.delete(key);
  } else if (memoryCache.size >= MAX_MEMORY_CACHE_SIZE) {
    const oldest = memoryCache.keys().next().value;
    if (oldest !== undefined) memoryCache.delete(oldest);
  }
  memoryCache.set(key, entry);
}

function readSingleKeyFromCache(key: string): UnifiedArtworkCacheEntry | undefined {
  if (!key) return undefined;
  const nowMs = Date.now();

  const mem = memoryCache.get(key);
  if (mem) {
    if (!isEntryExpired(mem, nowMs)) {
      return mem;
    }
    memoryCache.delete(key);
  }

  try {
    // 1. Check unified v2 cache in localStorage
    const rawV2 = localStorage.getItem(`${UNIFIED_CACHE_PREFIX}${key}`);
    if (rawV2) {
      const parsed = JSON.parse(rawV2) as Partial<UnifiedArtworkCacheEntry>;
      if (parsed && typeof parsed.timestamp === "number") {
        const entry: UnifiedArtworkCacheEntry = {
          key,
          artist: parsed.artist ?? "",
          album: parsed.album ?? "",
          releaseGroupMbid: parsed.releaseGroupMbid ?? null,
          releaseMbid: parsed.releaseMbid ?? null,
          url: parsed.url ? sanitizeArtworkUrl(parsed.url) : null,
          provider: parsed.provider ?? (parsed.url ? "itunes" : "none"),
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : parsed.url ? 80 : 0,
          timestamp: parsed.timestamp,
          negative: Boolean(parsed.negative ?? !parsed.url),
        };
        if (!isEntryExpired(entry, nowMs)) {
          setMemoryCacheEntry(key, entry);
          return entry;
        }
        localStorage.removeItem(`${UNIFIED_CACHE_PREFIX}${key}`);
      }
    }

    // 2. Check legacy v1 cache in localStorage for backwards compatibility
    const rawV1 = localStorage.getItem(`${LEGACY_CACHE_PREFIX}${key}`);
    if (rawV1) {
      const parsedV1 = JSON.parse(rawV1) as { url: string | null; timestamp: number };
      if (parsedV1 && typeof parsedV1.timestamp === "number") {
        const sanitizedUrl = parsedV1.url ? sanitizeArtworkUrl(parsedV1.url) ?? parsedV1.url : null;
        const entry: UnifiedArtworkCacheEntry = {
          key,
          artist: "",
          album: "",
          releaseGroupMbid: null,
          releaseMbid: null,
          url: sanitizedUrl,
          provider: sanitizedUrl ? "itunes" : "none",
          confidence: sanitizedUrl ? 80 : 0,
          timestamp: parsedV1.timestamp,
          negative: !sanitizedUrl,
        };
        if (!isEntryExpired(entry, nowMs)) {
          setMemoryCacheEntry(key, entry);
          return entry;
        }
        localStorage.removeItem(`${LEGACY_CACHE_PREFIX}${key}`);
      }
    }
  } catch {
    // Ignore storage read errors
  }

  return undefined;
}

export function getCachedArtworkEntry(track: {
  title: string;
  artist: string;
  album?: string;
}): UnifiedArtworkCacheEntry | undefined {
  const albumKey = getAlbumArtworkCacheKey(track);
  const trackKey = getArtworkCacheKey(track);

  const byAlbum = readSingleKeyFromCache(albumKey);
  if (byAlbum) return byAlbum;
  if (trackKey && trackKey !== albumKey) {
    return readSingleKeyFromCache(trackKey);
  }
  return undefined;
}

function pruneOldestArtworkLocalStorage(): void {
  try {
    const artworkKeys: Array<{ key: string; timestamp: number }> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith(UNIFIED_CACHE_PREFIX) || k.startsWith(LEGACY_CACHE_PREFIX))) {
        try {
          const raw = localStorage.getItem(k);
          if (raw) {
            const parsed = JSON.parse(raw);
            artworkKeys.push({ key: k, timestamp: parsed.timestamp ?? 0 });
          }
        } catch {
          artworkKeys.push({ key: k, timestamp: 0 });
        }
      }
    }
    artworkKeys.sort((a, b) => a.timestamp - b.timestamp);
    const toRemove = Math.max(10, Math.floor(artworkKeys.length * 0.25));
    for (let i = 0; i < toRemove && i < artworkKeys.length; i++) {
      localStorage.removeItem(artworkKeys[i].key);
    }
  } catch {
    // Ignore storage errors
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    pruneOldestArtworkLocalStorage();
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage fully full; silently drop
    }
  }
}

function writeToUnifiedCache(
  keys: string[],
  entry: Omit<UnifiedArtworkCacheEntry, "key" | "timestamp">,
): void {
  const timestamp = Date.now();
  const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));

  for (const key of uniqueKeys) {
    const fullEntry: UnifiedArtworkCacheEntry = {
      ...entry,
      key,
      timestamp,
    };
    setMemoryCacheEntry(key, fullEntry);
    transientBackoffUntil.delete(key);

    safeSetItem(`${UNIFIED_CACHE_PREFIX}${key}`, JSON.stringify(fullEntry));
    safeSetItem(
      `${LEGACY_CACHE_PREFIX}${key}`,
      JSON.stringify({ url: fullEntry.url, timestamp }),
    );
  }
}

/**
 * Evicts a broken or invalidated artwork cache entry for a track.
 */
export function invalidateArtworkCacheForTrack(track: {
  title: string;
  artist: string;
  album?: string;
}): void {
  const norm = normalizeTrackMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album ?? "",
    durationMs: null,
    fileName: "",
  });

  const keys = new Set<string>([
    getAlbumArtworkCacheKey(track),
    getArtworkCacheKey(track),
    getAlbumArtworkCacheKey({ title: norm.title, artist: norm.artist, album: norm.album }),
    getArtworkCacheKey({ title: norm.title, artist: norm.artist }),
  ]);

  for (const key of keys) {
    if (!key) continue;
    memoryCache.delete(key);
    transientBackoffUntil.delete(key);
    try {
      localStorage.removeItem(`${UNIFIED_CACHE_PREFIX}${key}`);
      localStorage.removeItem(`${LEGACY_CACHE_PREFIX}${key}`);
    } catch {
      // Ignore storage errors
    }
  }
}

/**
 * Clears all in-memory artwork caches and in-flight state (used in unit tests).
 */
export function __resetArtworkServiceForTests(): void {
  memoryCache.clear();
  transientBackoffUntil.clear();
  inFlightRequests.clear();
}

interface ProviderDiscoveryOutcome {
  resolution: ArtworkResolution;
  transientFailure: boolean;
}

/**
 * Attempts to resolve Cover Art Archive artwork for a scored Release Group candidate,
 * falling back to inspecting individual releases in that group if release-group artwork returns 404.
 */
async function tryResolveFromReleaseGroupCandidate(
  candidate: ScoredReleaseGroupCandidate,
  query: MusicBrainzTrackQuery,
  size: ArtworkThumbnailSize,
): Promise<{
  url: string | null;
  releaseGroupMbid: string;
  releaseMbid: string | null;
  confidence: number;
  transientError: boolean;
}> {
  // Step 4: Cover Art Archive Release Group lookup
  const rgArt = await fetchReleaseGroupCoverArt(candidate.mbid, { size });
  if (rgArt.status === "ok" && rgArt.url) {
    return {
      url: rgArt.url,
      releaseGroupMbid: candidate.mbid,
      releaseMbid: rgArt.releaseMbid,
      confidence: candidate.confidence,
      transientError: false,
    };
  }

  let sawTransientError = rgArt.status === "transient-error";

  // Step 5a: Inspect individual releases belonging to that Release Group before falling back
  const releaseMbidsToTry: string[] = [...candidate.releaseMbids];
  if (releaseMbidsToTry.length === 0) {
    const releaseLookup = await fetchReleasesForReleaseGroup(candidate.mbid, query);
    if (releaseLookup.status === "transient-error") {
      sawTransientError = true;
    }
    for (const rel of releaseLookup.releases) {
      if (!releaseMbidsToTry.includes(rel.mbid)) {
        releaseMbidsToTry.push(rel.mbid);
      }
    }
  }

  // Probe up to 3 top official releases in the release group
  for (const releaseMbid of releaseMbidsToTry.slice(0, 3)) {
    const relArt = await fetchReleaseCoverArt(releaseMbid, { size });
    if (relArt.status === "ok" && relArt.url) {
      return {
        url: relArt.url,
        releaseGroupMbid: candidate.mbid,
        releaseMbid,
        confidence: candidate.confidence,
        transientError: false,
      };
    }
    if (relArt.status === "transient-error") {
      sawTransientError = true;
    }
  }

  return {
    url: null,
    releaseGroupMbid: candidate.mbid,
    releaseMbid: null,
    confidence: candidate.confidence,
    transientError: sawTransientError,
  };
}

/**
 * Executes the online artwork discovery pipeline (Steps 3 -> 4 -> 5 -> 6):
 *  3. MusicBrainz Release Group lookup
 *  4. Cover Art Archive Release Group artwork retrieval
 *  5. MusicBrainz Release lookup + Cover Art Archive Release fallback
 *  6. Existing iTunes Search API fallback
 *  7. Neutral fallback
 */
async function discoverOnlineArtwork(
  track: ArtworkTrackInput,
  size: ArtworkThumbnailSize = "500",
  alternateQueries?: Array<{ trackName: string; artistName: string }>,
): Promise<ProviderDiscoveryOutcome> {
  const query: MusicBrainzTrackQuery = {
    artist: track.artist,
    album: track.album,
    title: track.title,
    durationMs: track.durationMs,
  };

  let sawTransientError = false;

  // Step 3: MusicBrainz Release Group discovery
  const mbDiscovery = await searchMusicBrainzReleaseGroups(query);
  if (mbDiscovery.status === "transient-error") {
    sawTransientError = true;
  }

  if (mbDiscovery.bestCandidate) {
    const primaryAttempt = await tryResolveFromReleaseGroupCandidate(
      mbDiscovery.bestCandidate,
      query,
      size,
    );
    if (primaryAttempt.url) {
      return {
        resolution: {
          url: primaryAttempt.url,
          source: "musicbrainz-caa",
          releaseGroupMbid: primaryAttempt.releaseGroupMbid,
          releaseMbid: primaryAttempt.releaseMbid,
          confidence: primaryAttempt.confidence,
          album: mbDiscovery.bestCandidate.releaseGroup.title,
        },
        transientFailure: false,
      };
    }
    if (primaryAttempt.transientError) {
      sawTransientError = true;
    }

    // If primary candidate had no CAA artwork (or was medium confidence), try up to 2 secondary candidates
    for (const secondary of mbDiscovery.secondaryCandidates.slice(0, 2)) {
      const secondaryAttempt = await tryResolveFromReleaseGroupCandidate(secondary, query, size);
      if (secondaryAttempt.url) {
        return {
          resolution: {
            url: secondaryAttempt.url,
            source: "musicbrainz-caa",
            releaseGroupMbid: secondaryAttempt.releaseGroupMbid,
            releaseMbid: secondaryAttempt.releaseMbid,
            confidence: secondaryAttempt.confidence,
            album: secondary.releaseGroup.title,
          },
          transientFailure: false,
        };
      }
      if (secondaryAttempt.transientError) {
        sawTransientError = true;
      }
    }
  }

  // Step 5b: Direct MusicBrainz Release search fallback (when Release Group search had no CAA hit)
  if (mbDiscovery.status !== "skipped" && mbDiscovery.status !== "transient-error") {
    const directReleases = await searchMusicBrainzReleases(query);
    if (directReleases.status === "transient-error") {
      sawTransientError = true;
    }
    for (const candidateRel of directReleases.releases.slice(0, 2)) {
      const relArt = await fetchReleaseCoverArt(candidateRel.mbid, { size });
      if (relArt.status === "ok" && relArt.url) {
        return {
          resolution: {
            url: relArt.url,
            source: "musicbrainz-caa",
            releaseGroupMbid: candidateRel.releaseGroupMbid,
            releaseMbid: candidateRel.mbid,
            confidence: candidateRel.confidence,
            album: candidateRel.release.title,
          },
          transientFailure: false,
        };
      }
      if (relArt.status === "transient-error") {
        sawTransientError = true;
      }
    }
  }

  // Step 6: Existing iTunes Search API fallback
  try {
    const itunesMatch = await searchItunesArtworkDetails({
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationMs: track.durationMs,
    });
    if (itunesMatch) {
      const validated = sanitizeArtworkUrl(itunesMatch.artworkUrl) ?? itunesMatch.artworkUrl;
      return {
        resolution: {
          url: validated,
          source: "itunes",
          releaseGroupMbid: mbDiscovery.bestCandidate?.mbid ?? null,
          releaseMbid: null,
          confidence: itunesMatch.score,
          album: itunesMatch.collectionName,
          artist: itunesMatch.artistName,
        },
        transientFailure: false,
      };
    }

    if (!itunesMatch && alternateQueries && alternateQueries.length > 0) {
      for (const alt of alternateQueries.slice(0, 3)) {
        const altMatch = await searchItunesArtworkDetails({
          title: alt.trackName,
          artist: alt.artistName,
          album: track.album,
          durationMs: track.durationMs,
        });
        if (altMatch) {
          const validated = sanitizeArtworkUrl(altMatch.artworkUrl) ?? altMatch.artworkUrl;
          return {
            resolution: {
              url: validated,
              source: "itunes",
              releaseGroupMbid: mbDiscovery.bestCandidate?.mbid ?? null,
              releaseMbid: null,
              confidence: Math.min(altMatch.score, 75),
              album: altMatch.collectionName,
              artist: altMatch.artistName,
            },
            transientFailure: false,
          };
        }
      }
    }
  } catch {
    sawTransientError = true;
  }

  // Step 7: Neutral fallback
  return {
    resolution: {
      url: undefined,
      source: "none",
      releaseGroupMbid: mbDiscovery.bestCandidate?.mbid ?? null,
      releaseMbid: null,
      confidence: 0,
    },
    transientFailure: sawTransientError,
  };
}

/**
 * Resolves artwork for a track following the strict provider priority:
 *  1. Embedded artwork from the imported audio file (IndexedDB)
 *  2. Unified artwork cache (memory + localStorage, album-aware)
 *  3. MusicBrainz Release Group lookup
 *  4. Cover Art Archive artwork retrieval
 *  5. MusicBrainz Release lookup fallback
 *  6. Existing iTunes Search API
 *  7. Neutral artwork fallback (`undefined`)
 */
export async function resolveArtworkForTrack(
  track: ArtworkTrackInput,
  options?: { size?: ArtworkThumbnailSize },
): Promise<ArtworkResolution> {
  // 1. Check local IndexedDB for embedded artwork (always highest priority)
  try {
    const localBlob = await repository.getArtwork(track.id);
    if (localBlob) {
      const url = URL.createObjectURL(localBlob);
      return { url, source: "embedded" };
    }
  } catch {
    // Proceed to cache and online providers
  }

  const albumKey = getAlbumArtworkCacheKey(track);
  const trackKey = getArtworkCacheKey(track);
  const primaryKey = albumKey || trackKey;

  if (!primaryKey) {
    return { url: undefined, source: "none" };
  }

  // 2. Check unified artwork cache
  const cached = getCachedArtworkEntry(track);
  if (cached !== undefined) {
    return {
      url: cached.url ?? undefined,
      source: cached.url ? "cache" : "none",
      releaseGroupMbid: cached.releaseGroupMbid,
      releaseMbid: cached.releaseMbid,
      confidence: cached.confidence,
    };
  }

  // Check short transient failure backoff so offline/503 storms don't hammer APIs
  const backoffUntil = transientBackoffUntil.get(primaryKey);
  if (backoffUntil && Date.now() < backoffUntil) {
    return { url: undefined, source: "none" };
  }

  // 3. Deduplicate concurrent requests for the same album or track
  const existingInFlight =
    inFlightRequests.get(primaryKey) ?? (trackKey ? inFlightRequests.get(trackKey) : undefined);
  if (existingInFlight) {
    return existingInFlight;
  }

  const isOffline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (isOffline) {
    return { url: undefined, source: "none" };
  }

  const norm = normalizeTrackMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album ?? "",
    durationMs: track.durationMs ?? null,
    fileName: "",
  });

  const normalizedTrack: ArtworkTrackInput = {
    ...track,
    title: norm.title || track.title,
    artist: norm.artist || track.artist,
    album: norm.album || track.album,
  };

  const promise = (async (): Promise<ArtworkResolution> => {
    try {
      const { resolution, transientFailure } = await discoverOnlineArtwork(
        normalizedTrack,
        options?.size ?? "500",
        norm.alternateQueries,
      );
      const verifiedAlbum = resolution.album || norm.album || track.album || "";
      const verifiedArtist = resolution.artist || extractPrimaryArtist(norm.artist || track.artist);

      const allKeysToCache = new Set<string>();
      if (trackKey) allKeysToCache.add(trackKey);
      if (albumKey) allKeysToCache.add(albumKey);
      if (hasMeaningfulAlbum(verifiedAlbum)) {
        allKeysToCache.add(
          getAlbumArtworkCacheKey({
            title: norm.title,
            artist: verifiedArtist,
            album: verifiedAlbum,
          }),
        );
      }

      const keysList = Array.from(allKeysToCache);

      if (resolution.url) {
        writeToUnifiedCache(keysList, {
          artist: verifiedArtist,
          album: verifiedAlbum,
          releaseGroupMbid: resolution.releaseGroupMbid ?? null,
          releaseMbid: resolution.releaseMbid ?? null,
          url: resolution.url,
          provider: resolution.source === "musicbrainz-caa" ? "musicbrainz-caa" : "itunes",
          confidence: resolution.confidence ?? 80,
          negative: false,
        });
      } else if (transientFailure) {
        // Transient network/rate-limit failure: apply short in-memory backoff, do NOT write 24h negative cache
        const retryAt = Date.now() + TRANSIENT_BACKOFF_MS;
        for (const k of keysList) {
          if (k) transientBackoffUntil.set(k, retryAt);
        }
      } else {
        // Confirmed negative lookup: cache for 24 hours
        writeToUnifiedCache(keysList, {
          artist: verifiedArtist,
          album: verifiedAlbum,
          releaseGroupMbid: resolution.releaseGroupMbid ?? null,
          releaseMbid: null,
          url: null,
          provider: "none",
          confidence: 0,
          negative: true,
        });
      }

      return resolution;
    } finally {
      inFlightRequests.delete(primaryKey);
      if (trackKey) inFlightRequests.delete(trackKey);
    }
  })();

  inFlightRequests.set(primaryKey, promise);
  if (trackKey && trackKey !== primaryKey) {
    inFlightRequests.set(trackKey, promise);
  }
  return promise;
}

/**
 * Resolves online artwork for a batch of newly imported tracks.
 *
 * Groups tracks by normalized `artist + album` identity so multiple tracks from
 * the same album perform ONLY ONE album-level artwork discovery request, and
 * all tracks sharing that album reuse the resolved artwork immediately.
 */
export async function resolveArtworkForAlbumBatch(
  tracks: ArtworkTrackInput[],
  options?: {
    onTrackArtworkResolved?: (trackId: string, url: string) => void;
    concurrency?: number;
  },
): Promise<void> {
  if (!Array.isArray(tracks) || tracks.length === 0) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;

  // 1. Group tracks without embedded artwork by their album (or track) cache key
  const groups = new Map<string, ArtworkTrackInput[]>();

  for (const track of tracks) {
    try {
      const embedded = await repository.getArtwork(track.id);
      if (embedded) continue; // Embedded artwork already present
    } catch {
      // Continue
    }

    const groupKey = getAlbumArtworkCacheKey(track);
    if (!groupKey) continue;

    const bucket = groups.get(groupKey);
    if (bucket) {
      bucket.push(track);
    } else {
      groups.set(groupKey, [track]);
    }
  }

  if (groups.size === 0) return;

  const entries = Array.from(groups.values());
  const maxConcurrency = Math.max(1, Math.min(options?.concurrency ?? 2, 4));
  let cursor = 0;

  const runWorker = async (): Promise<void> => {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      const groupTracks = entries[index];
      if (!groupTracks || groupTracks.length === 0) continue;

      const representative = groupTracks[0];
      const resolution = await resolveArtworkForTrack(representative);

      if (resolution.url) {
        // Also populate track-level cache entries for every sibling track in the album
        const norm = normalizeTrackMetadata({
          title: representative.title,
          artist: representative.artist,
          album: representative.album ?? "",
          durationMs: representative.durationMs ?? null,
          fileName: "",
        });
        const verifiedAlbum = resolution.album || norm.album || representative.album || "";
        const verifiedArtist = resolution.artist || extractPrimaryArtist(norm.artist || representative.artist);
        const siblingTrackKeys = groupTracks.map((t) => getArtworkCacheKey(t)).filter(Boolean);
        writeToUnifiedCache(siblingTrackKeys, {
          artist: verifiedArtist,
          album: verifiedAlbum,
          releaseGroupMbid: resolution.releaseGroupMbid ?? null,
          releaseMbid: resolution.releaseMbid ?? null,
          url: resolution.url,
          provider: resolution.source === "musicbrainz-caa" ? "musicbrainz-caa" : "itunes",
          confidence: resolution.confidence ?? 80,
          negative: false,
        });

        for (const sibling of groupTracks) {
          options?.onTrackArtworkResolved?.(sibling.id, resolution.url);
        }
      }
    }
  };

  const workers = Array.from({ length: Math.min(maxConcurrency, entries.length) }, () => runWorker());
  await Promise.allSettled(workers);
}
