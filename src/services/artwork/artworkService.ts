import { repository } from "../indexeddb/LibraryRepository";
import {
  cleanNoiseFromText,
  extractPrimaryArtist,
  isPlaceholderArtist,
  isYearOnly,
  normalizeForMatching,
  normalizeTrackMetadata,
} from "../metadata/normalization";
import { normalizeForSearch } from "../../utils/misc";
import {
  searchItunesArtworkDetails,
  type ItunesSearchOutcomeDiagnostic,
} from "./itunesClient";
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
  type MusicBrainzDiscoveryResult,
  type MusicBrainzTrackQuery,
  type ScoredReleaseGroupCandidate,
} from "./musicbrainzClient";
import {
  createEmptyCaaDiagnostic,
  createEmptyItunesDiagnostic,
  createEmptyMusicBrainzDiagnostic,
  extractSafeUrlHost,
  type ArtworkFailureReason,
  type CaaStageDiagnostic,
  type MusicBrainzStageDiagnostic,
  type TrackDiscoveryDiagnostic,
} from "./artworkDiagnostics";

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
  transientFailure?: boolean;
  diagnostic?: TrackDiscoveryDiagnostic;
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
  fileName?: string;
}

const LEGACY_CACHE_PREFIX = "artwork_cache_v1:";
const UNIFIED_CACHE_PREFIX = "artwork_cache_v2:";

/** Successful artwork mappings expire after 30 days. */
export const POSITIVE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Confirmed negative lookups expire after 24 hours. */
export const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Transient network errors use a short in-memory retry backoff (never persisted as 24h negative cache). */
export const TRANSIENT_BACKOFF_MS = 30 * 1000;
/** Broken remote image URLs are remembered in-memory for 30 minutes so retries fall back to the next provider. */
const FAILED_URL_TTL_MS = 30 * 60 * 1000;

const MAX_MEMORY_CACHE_SIZE = 500;
const memoryCache = new Map<string, UnifiedArtworkCacheEntry>();
const transientBackoffUntil = new Map<string, number>();
const inFlightRequests = new Map<string, Promise<ArtworkResolution>>();
const failedArtworkUrls = new Map<string, number>();

/**
 * Records a remote artwork URL that failed image loading or validation so subsequent
 * resolution attempts skip it and fall through to alternate releases or providers.
 */
export function markArtworkUrlFailed(url: string | null | undefined): void {
  if (!url || typeof url !== "string") return;
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith("blob:")) return;
  const now = Date.now();
  if (failedArtworkUrls.size >= 500) {
    for (const [k, ts] of failedArtworkUrls) {
      if (now - ts > FAILED_URL_TTL_MS) failedArtworkUrls.delete(k);
    }
    if (failedArtworkUrls.size >= 500) {
      const oldest = failedArtworkUrls.keys().next().value;
      if (oldest !== undefined) failedArtworkUrls.delete(oldest);
    }
  }
  failedArtworkUrls.set(trimmed, now);
  const sanitized = sanitizeArtworkUrl(trimmed);
  if (sanitized) {
    failedArtworkUrls.set(sanitized, now);
  }
}

export function isArtworkUrlFailed(url: string | null | undefined): boolean {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  const sanitized = sanitizeArtworkUrl(trimmed);
  const ts = failedArtworkUrls.get(trimmed) ?? (sanitized ? failedArtworkUrls.get(sanitized) : undefined);
  if (ts === undefined) return false;
  if (Date.now() - ts > FAILED_URL_TTL_MS) {
    failedArtworkUrls.delete(trimmed);
    if (sanitized) failedArtworkUrls.delete(sanitized);
    return false;
  }
  return true;
}

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
  "single",
  "singles",
  "ep",
  "album",
  "music",
  "downloads",
  "audio",
  "tracks",
  "various",
  "various artists",
  "youtube",
  "official audio",
  "lyrics",
]);

export function hasMeaningfulAlbum(album: string | undefined | null): boolean {
  if (!album) return false;
  if (isYearOnly(album)) return false;
  const cleaned = normalizeForSearch(cleanNoiseFromText(album).cleaned);
  return Boolean(cleaned && !PLACEHOLDER_ALBUMS.has(cleaned) && !isYearOnly(cleaned));
}

function isPlaceholderTitle(title: string | undefined | null): boolean {
  if (!title) return true;
  if (isYearOnly(title)) return true;
  const cleaned = normalizeForSearch(cleanNoiseFromText(title).cleaned);
  if (!cleaned || cleaned.length < 2) return true;
  if (/^(?:track\s*\d+|audio(?:\s*track)?\s*\d*|untitled|unknown|n\s*a|na|none|null|undefined)$/i.test(cleaned)) {
    return true;
  }
  return false;
}

function isInsufficientMetadataForDiscovery(track: {
  title?: string;
  artist?: string;
  album?: string;
}): boolean {
  const artistMissing = !track.artist?.trim() || isPlaceholderArtist(track.artist);
  const albumMissing = !hasMeaningfulAlbum(track.album);
  const titleMissing = isPlaceholderTitle(track.title);
  if (artistMissing && albumMissing && titleMissing) return true;
  if (!albumMissing && !artistMissing) return false;
  if (artistMissing && !cleanNoiseFromText(track.title ?? "").cleaned.trim()) return true;
  if (titleMissing && albumMissing && artistMissing) return true;
  if (artistMissing && /^track\s*\d+$/i.test(normalizeForSearch(track.title ?? ""))) return true;
  return false;
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
    if (!isEntryExpired(mem, nowMs) && (!mem.url || !isArtworkUrlFailed(mem.url))) {
      // Refresh LRU order
      memoryCache.delete(key);
      memoryCache.set(key, mem);
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
        if (!isEntryExpired(entry, nowMs) && (!entry.url || !isArtworkUrlFailed(entry.url))) {
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
        if (!isEntryExpired(entry, nowMs) && (!entry.url || !isArtworkUrlFailed(entry.url))) {
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
    const mem = memoryCache.get(key);
    if (mem?.url) {
      markArtworkUrlFailed(mem.url);
    }
    memoryCache.delete(key);
    transientBackoffUntil.delete(key);
    try {
      const rawV2 = localStorage.getItem(`${UNIFIED_CACHE_PREFIX}${key}`);
      if (rawV2) {
        try {
          const parsed = JSON.parse(rawV2) as { url?: string | null };
          if (parsed?.url) markArtworkUrlFailed(parsed.url);
        } catch {
          // Ignore parse errors
        }
      }
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
/**
 * Clears only negative/expired retry cache entries for a track so a manual
 * "Reload missing artwork" action can re-query providers without disturbing any
 * track that already has positive artwork cached.
 */
export function clearNegativeArtworkCacheForTrack(track: {
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
    transientBackoffUntil.delete(key);

    const mem = memoryCache.get(key);
    if (mem && (mem.negative || !mem.url)) {
      memoryCache.delete(key);
    }

    try {
      const rawV2 = localStorage.getItem(`${UNIFIED_CACHE_PREFIX}${key}`);
      if (rawV2) {
        try {
          const parsed = JSON.parse(rawV2) as { url?: string | null; negative?: boolean };
          if (parsed?.negative || !parsed?.url) {
            localStorage.removeItem(`${UNIFIED_CACHE_PREFIX}${key}`);
          }
        } catch {
          localStorage.removeItem(`${UNIFIED_CACHE_PREFIX}${key}`);
        }
      }

      const rawV1 = localStorage.getItem(`${LEGACY_CACHE_PREFIX}${key}`);
      if (rawV1) {
        try {
          const parsed = JSON.parse(rawV1) as { url?: string | null };
          if (!parsed?.url) {
            localStorage.removeItem(`${LEGACY_CACHE_PREFIX}${key}`);
          }
        } catch {
          localStorage.removeItem(`${LEGACY_CACHE_PREFIX}${key}`);
        }
      }
    } catch {
      // Ignore storage errors
    }
  }
}

export function __resetArtworkServiceForTests(): void {
  memoryCache.clear();
  transientBackoffUntil.clear();
  inFlightRequests.clear();
  failedArtworkUrls.clear();
}

interface ProviderDiscoveryOutcome {
  resolution: ArtworkResolution;
  transientFailure: boolean;
  diagnostic: TrackDiscoveryDiagnostic;
}

function recordCaaOutcome(
  caaDiag: CaaStageDiagnostic,
  target: "release-group" | "release",
  status: string,
  httpStatus: number | null | undefined,
  classification: CaaStageDiagnostic["releaseGroupClassification"] | undefined,
  failedRequests: number | undefined,
): void {
  caaDiag.queried = true;
  const resolvedClass =
    classification ??
    (status === "ok"
      ? "ok"
      : status === "not-found"
        ? "not-found"
        : status === "transient-error"
          ? "http-error"
          : "skipped");
  const resolvedStatus = httpStatus ?? (status === "not-found" ? 404 : status === "ok" ? 200 : null);
  if (target === "release-group") {
    caaDiag.releaseGroupHttpStatus = resolvedStatus;
    caaDiag.releaseGroupClassification = resolvedClass;
  } else {
    caaDiag.releaseHttpStatus = resolvedStatus;
    caaDiag.releaseClassification = resolvedClass;
  }
  if (typeof failedRequests === "number") {
    caaDiag.failedRequests += failedRequests;
  } else if (status === "transient-error") {
    caaDiag.failedRequests += 1;
  }
}

function recordMbTelemetry(
  mbDiag: MusicBrainzStageDiagnostic,
  result: MusicBrainzDiscoveryResult,
  fallbackSkipReason?: string,
): void {
  if (result.status === "skipped") {
    mbDiag.skipped = true;
    mbDiag.skipReason = fallbackSkipReason ?? "Incomplete or placeholder artist/title metadata";
    mbDiag.classification = "skipped";
    return;
  }
  const tel = result.diagnostic;
  if (tel) {
    mbDiag.httpStatus = tel.httpStatus;
    mbDiag.classification = tel.classification;
    mbDiag.releaseGroupCount = tel.rawCount;
    mbDiag.acceptedCandidateCount = tel.acceptedCount;
    mbDiag.rejectedCandidateCount = tel.rejectedCount;
    mbDiag.candidateScores = tel.candidateScores;
    mbDiag.failedRequests += tel.failedRequests;
  } else {
    mbDiag.classification =
      result.status === "ok"
        ? "ok"
        : result.status === "not-found"
          ? "not-found"
          : "network-error";
    mbDiag.releaseGroupCount = result.candidates.length;
    mbDiag.acceptedCandidateCount = result.candidates.length;
    if (result.status === "transient-error") {
      mbDiag.failedRequests += 1;
    }
  }
}

/**
 * Attempts to resolve Cover Art Archive artwork for a scored Release Group candidate,
 * falling back to inspecting individual releases in that group if release-group artwork returns 404.
 */
async function tryResolveFromReleaseGroupCandidate(
  candidate: ScoredReleaseGroupCandidate,
  query: MusicBrainzTrackQuery,
  size: ArtworkThumbnailSize,
  caaDiag: CaaStageDiagnostic,
  isExcludedUrl: (url: string) => boolean,
  discoveryOptions?: { includeDiagnostics?: boolean; maxRetries?: number },
): Promise<{
  url: string | null;
  releaseGroupMbid: string;
  releaseMbid: string | null;
  confidence: number;
  transientError: boolean;
}> {
  // Step 4: Cover Art Archive Release Group lookup
  const rgArt = await fetchReleaseGroupCoverArt(candidate.mbid, {
    size,
    excludeUrl: isExcludedUrl,
    includeDiagnostics: discoveryOptions?.includeDiagnostics,
    maxRetries: discoveryOptions?.maxRetries,
  });
  recordCaaOutcome(
    caaDiag,
    "release-group",
    rgArt.status,
    rgArt.httpStatus,
    rgArt.classification,
    rgArt.failedRequests,
  );
  if (rgArt.status === "ok" && rgArt.url && !isExcludedUrl(rgArt.url)) {
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
    const releaseLookup = await fetchReleasesForReleaseGroup(candidate.mbid, query, undefined, discoveryOptions);
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
    const relArt = await fetchReleaseCoverArt(releaseMbid, {
      size,
      excludeUrl: isExcludedUrl,
      includeDiagnostics: discoveryOptions?.includeDiagnostics,
      maxRetries: discoveryOptions?.maxRetries,
    });
    recordCaaOutcome(
      caaDiag,
      "release",
      relArt.status,
      relArt.httpStatus,
      relArt.classification,
      relArt.failedRequests,
    );
    if (relArt.status === "ok" && relArt.url && !isExcludedUrl(relArt.url)) {
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
  alternateQueries?: Array<{ trackName: string; artistName: string; q?: string }>,
  options?: {
    includeDiagnostics?: boolean;
    excludeUrls?: string[];
    maxRetries?: number;
    originalTrack?: ArtworkTrackInput;
    forceRefresh?: boolean;
  },
): Promise<ProviderDiscoveryOutcome> {
  const original = options?.originalTrack ?? track;
  const mbDiag = createEmptyMusicBrainzDiagnostic();
  const caaDiag = createEmptyCaaDiagnostic();
  const itunesDiag = createEmptyItunesDiagnostic();
  const observedFailures: ArtworkFailureReason[] = [];

  const isExcludedUrl = (url: string): boolean => {
    if (isArtworkUrlFailed(url)) return true;
    if (!options?.excludeUrls || options.excludeUrls.length === 0) return false;
    const norm = sanitizeArtworkUrl(url) ?? url.trim();
    return options.excludeUrls.some((ex) => ex === url || (sanitizeArtworkUrl(ex) ?? ex.trim()) === norm);
  };

  const buildDiagnostic = (
    selectedProvider: "musicbrainz-caa" | "itunes" | "none",
    selectedUrl: string | undefined,
  ): TrackDiscoveryDiagnostic => ({
    originalTitle: original.title,
    originalArtist: original.artist,
    originalAlbum: original.album ?? "",
    normalizedTitle: track.title,
    normalizedArtist: track.artist,
    normalizedAlbum: track.album,
    musicbrainz: mbDiag,
    caa: caaDiag,
    itunes: itunesDiag,
    selectedProvider,
    selectedArtworkHost: extractSafeUrlHost(selectedUrl),
    failedHttpRequests: mbDiag.failedRequests + caaDiag.failedRequests + itunesDiag.failedRequests,
    observedFailures: Array.from(new Set(observedFailures)),
  });

  const discoveryOpts = {
    includeDiagnostics: options?.includeDiagnostics,
    maxRetries: options?.maxRetries,
  };

  const query: MusicBrainzTrackQuery = {
    artist: track.artist,
    album: track.album,
    title: track.title,
    durationMs: track.durationMs,
  };

  let sawTransientError = false;

  // Step 3: MusicBrainz Release Group discovery
  let mbDiscovery = await searchMusicBrainzReleaseGroups(query, undefined, discoveryOpts);
  recordMbTelemetry(mbDiag, mbDiscovery);

  if (mbDiscovery.status === "skipped" && alternateQueries && alternateQueries.length > 0) {
    for (const alt of alternateQueries.slice(0, 2)) {
      if (!alt.artistName) continue;
      const altDiscovery = await searchMusicBrainzReleaseGroups(
        {
          artist: alt.artistName,
          album: track.album,
          title: alt.trackName,
          durationMs: track.durationMs,
        },
        undefined,
        discoveryOpts,
      );
      if (altDiscovery.status !== "skipped") {
        mbDiscovery = altDiscovery;
        mbDiag.skipped = false;
        mbDiag.skipReason = undefined;
        recordMbTelemetry(mbDiag, altDiscovery);
        break;
      }
    }
  }

  // Wrong/custom album ID3 fallback during recovery: if artist + album had 0 release groups
  // and track has a distinct meaningful title, try artist + track title without the album tag.
  if (
    options?.forceRefresh &&
    mbDiscovery.status === "not-found" &&
    mbDiag.releaseGroupCount === 0 &&
    hasMeaningfulAlbum(track.album) &&
    track.title &&
    normalizeForMatching(track.title) !== normalizeForMatching(track.album!)
  ) {
    const titleOnlyMb = await searchMusicBrainzReleaseGroups(
      {
        artist: track.artist,
        title: track.title,
        durationMs: track.durationMs,
      },
      undefined,
      discoveryOpts,
    );
    if (titleOnlyMb.status === "ok" && titleOnlyMb.bestCandidate) {
      mbDiscovery = titleOnlyMb;
      recordMbTelemetry(mbDiag, titleOnlyMb);
    } else if (titleOnlyMb.status === "transient-error") {
      sawTransientError = true;
      mbDiag.failedRequests += titleOnlyMb.diagnostic?.failedRequests ?? 1;
    }
  }

  if (mbDiscovery.status === "transient-error") {
    sawTransientError = true;
    observedFailures.push(
      mbDiag.classification === "rate-limited"
        ? "PROVIDER_RATE_LIMITED"
        : mbDiag.classification === "timeout"
          ? "PROVIDER_TIMEOUT"
          : "NETWORK_ERROR",
    );
  } else if (mbDiag.classification === "candidates-rejected") {
    observedFailures.push("CANDIDATE_REJECTED");
  } else if (mbDiscovery.status === "not-found") {
    observedFailures.push("MUSICBRAINZ_NOT_FOUND");
  }

  if (mbDiscovery.bestCandidate) {
    const primaryAttempt = await tryResolveFromReleaseGroupCandidate(
      mbDiscovery.bestCandidate,
      query,
      size,
      caaDiag,
      isExcludedUrl,
      discoveryOpts,
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
        diagnostic: buildDiagnostic("musicbrainz-caa", primaryAttempt.url),
      };
    }
    if (primaryAttempt.transientError) {
      sawTransientError = true;
    }

    // If primary candidate had no CAA artwork (or was medium confidence), try up to 2 secondary candidates
    for (const secondary of mbDiscovery.secondaryCandidates.slice(0, 2)) {
      const secondaryAttempt = await tryResolveFromReleaseGroupCandidate(
        secondary,
        query,
        size,
        caaDiag,
        isExcludedUrl,
        discoveryOpts,
      );
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
          diagnostic: buildDiagnostic("musicbrainz-caa", secondaryAttempt.url),
        };
      }
      if (secondaryAttempt.transientError) {
        sawTransientError = true;
      }
    }

    if (caaDiag.queried && !sawTransientError) {
      observedFailures.push("CAA_ARTWORK_NOT_FOUND");
    }
  }

  // Step 5b: Direct MusicBrainz Release search fallback (when Release Group search had no CAA hit)
  if (mbDiscovery.status !== "skipped" && mbDiscovery.status !== "transient-error") {
    const directReleases = await searchMusicBrainzReleases(query, undefined, {
      ...discoveryOpts,
      verifyTracksIfAlbumMissing: !hasMeaningfulAlbum(track.album),
    });
    mbDiag.directReleaseFallback.queried = true;
    if (directReleases.diagnostic) {
      mbDiag.directReleaseFallback.httpStatus = directReleases.diagnostic.httpStatus;
      mbDiag.directReleaseFallback.classification = directReleases.diagnostic.classification;
      mbDiag.directReleaseFallback.releaseCount = directReleases.diagnostic.rawCount;
      mbDiag.directReleaseFallback.acceptedCount = directReleases.diagnostic.acceptedCount;
      mbDiag.directReleaseFallback.rejectedCount = directReleases.diagnostic.rejectedCount;
      mbDiag.directReleaseFallback.topScore = directReleases.diagnostic.candidateScores[0]?.confidence;
      mbDiag.directReleaseFallback.rejectionReason =
        directReleases.diagnostic.candidateScores.find((c) => !c.accepted)?.rejectionReason;
      mbDiag.failedRequests += directReleases.diagnostic.failedRequests;
    } else {
      mbDiag.directReleaseFallback.classification =
        directReleases.status === "ok"
          ? "ok"
          : directReleases.status === "not-found"
            ? "not-found"
            : "network-error";
      mbDiag.directReleaseFallback.releaseCount = directReleases.releases.length;
      mbDiag.directReleaseFallback.acceptedCount = directReleases.releases.length;
    }

    if (directReleases.status === "transient-error") {
      sawTransientError = true;
      if (mbDiag.directReleaseFallback.classification === "rate-limited") {
        observedFailures.push("PROVIDER_RATE_LIMITED");
      } else if (mbDiag.directReleaseFallback.classification === "timeout") {
        observedFailures.push("PROVIDER_TIMEOUT");
      } else {
        observedFailures.push("NETWORK_ERROR");
      }
    } else if (mbDiag.directReleaseFallback.classification === "candidates-rejected") {
      observedFailures.push("CANDIDATE_REJECTED");
    }

    for (const candidateRel of directReleases.releases.slice(0, 2)) {
      const relArt = await fetchReleaseCoverArt(candidateRel.mbid, {
        size,
        excludeUrl: isExcludedUrl,
        includeDiagnostics: discoveryOpts.includeDiagnostics,
        maxRetries: discoveryOpts.maxRetries,
      });
      recordCaaOutcome(
        caaDiag,
        "release",
        relArt.status,
        relArt.httpStatus,
        relArt.classification,
        relArt.failedRequests,
      );
      if (relArt.status === "ok" && relArt.url && !isExcludedUrl(relArt.url)) {
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
          diagnostic: buildDiagnostic("musicbrainz-caa", relArt.url),
        };
      }
      if (relArt.status === "transient-error") {
        sawTransientError = true;
      }
    }
  }

  // Step 6: Existing iTunes Search API fallback
  const artistPresent = Boolean(track.artist?.trim() && !isPlaceholderArtist(track.artist));
  const hasUsableItunesMetadata =
    !isInsufficientMetadataForDiscovery(track) &&
    (!isPlaceholderTitle(track.title) || (artistPresent && hasMeaningfulAlbum(track.album)));

  if (!hasUsableItunesMetadata) {
    itunesDiag.queried = false;
    itunesDiag.classification = "skipped";
    if (mbDiag.skipped) {
      observedFailures.push("METADATA_INSUFFICIENT");
    }
  } else {
    let itunesAbortRestOfQueries = false;
    const applyItunesOutcome = (outcome: ItunesSearchOutcomeDiagnostic) => {
      itunesDiag.queried = true;
      itunesDiag.queriesAttempted += 1;
      itunesDiag.httpStatus = outcome.httpStatus;
      itunesDiag.failedRequests += outcome.failedRequests;
      if (outcome.searchType === "album") {
        itunesDiag.usedAlbumFallback = true;
      }
      if (outcome.classification === "ok") {
        itunesDiag.classification = "ok";
        itunesDiag.resultCount += outcome.resultCount;
        itunesDiag.acceptedCount += outcome.acceptedCount;
        itunesDiag.rejectedCount += outcome.rejectedCount;
        itunesDiag.candidateScores = outcome.candidateScores;
      } else if (
        outcome.classification === "rate-limited" ||
        outcome.classification === "timeout" ||
        outcome.classification === "network-error" ||
        outcome.classification === "http-error"
      ) {
        itunesDiag.classification = outcome.classification;
        itunesAbortRestOfQueries = true;
        if (outcome.classification === "rate-limited") {
          observedFailures.push("PROVIDER_RATE_LIMITED");
        } else if (outcome.classification === "timeout") {
          observedFailures.push("PROVIDER_TIMEOUT");
        } else {
          observedFailures.push("NETWORK_ERROR");
        }
      } else if (outcome.classification === "candidates-rejected") {
        if (itunesDiag.classification !== "ok") {
          itunesDiag.classification = "candidates-rejected";
        }
        itunesDiag.resultCount += outcome.resultCount;
        itunesDiag.rejectedCount += outcome.rejectedCount;
        if (itunesDiag.candidateScores.length === 0) {
          itunesDiag.candidateScores = outcome.candidateScores;
        }
        observedFailures.push("CANDIDATE_REJECTED");
      } else if (outcome.classification === "no-results") {
        if (
          itunesDiag.classification === "not-queried" ||
          itunesDiag.classification === "skipped"
        ) {
          itunesDiag.classification = "no-results";
        }
      }
    };

    const runItunesQuery = async (
      queryTrack: { title: string; artist?: string; album?: string; durationMs?: number | null },
      searchType: "song" | "album" = "song",
    ) => {
      let receivedOutcome = false;
      let sawLocalTransient = false;
      const match = await searchItunesArtworkDetails(queryTrack, {
        excludeUrl: isExcludedUrl,
        searchType,
        maxRetries: options?.maxRetries,
        onTransientError: () => {
          sawLocalTransient = true;
          sawTransientError = true;
        },
        onSearchOutcome: (outcome) => {
          receivedOutcome = true;
          applyItunesOutcome(outcome);
        },
      });
      // Fallback telemetry when searchItunesArtworkDetails is module-mocked in unit tests
      if (!receivedOutcome) {
        itunesDiag.queried = true;
        itunesDiag.queriesAttempted += 1;
        if (searchType === "album") itunesDiag.usedAlbumFallback = true;
        if (match) {
          itunesDiag.classification = "ok";
          itunesDiag.acceptedCount += 1;
          itunesDiag.resultCount += 1;
        } else if (sawLocalTransient) {
          itunesDiag.classification = "network-error";
          itunesDiag.failedRequests += 1;
          observedFailures.push("NETWORK_ERROR");
        } else if (itunesDiag.classification === "not-queried") {
          itunesDiag.classification = "no-results";
        }
      }
      return match;
    };

    try {
      const itunesMatch = await runItunesQuery(
        {
          title: track.title,
          artist: track.artist,
          album: track.album,
          durationMs: track.durationMs,
        },
        "song",
      );
      if (itunesMatch) {
        const validated = sanitizeArtworkUrl(itunesMatch.artworkUrl) ?? itunesMatch.artworkUrl;
        if (!isExcludedUrl(validated)) {
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
            diagnostic: buildDiagnostic("itunes", validated),
          };
        }
      }

      // iTunes Album entity fallback when artist + meaningful album are known and song search missed
      if (
        !itunesAbortRestOfQueries &&
        hasMeaningfulAlbum(track.album) &&
        track.artist?.trim() &&
        !isPlaceholderArtist(track.artist)
      ) {
        const albumMatch = await runItunesQuery(
          {
            title: track.title,
            artist: track.artist,
            album: track.album,
            durationMs: track.durationMs,
          },
          "album",
        );
        if (albumMatch) {
          const validated = sanitizeArtworkUrl(albumMatch.artworkUrl) ?? albumMatch.artworkUrl;
          if (!isExcludedUrl(validated)) {
            return {
              resolution: {
                url: validated,
                source: "itunes",
                releaseGroupMbid: mbDiscovery.bestCandidate?.mbid ?? null,
                releaseMbid: null,
                confidence: Math.min(albumMatch.score, 85),
                album: albumMatch.collectionName,
                artist: albumMatch.artistName,
              },
              transientFailure: false,
              diagnostic: buildDiagnostic("itunes", validated),
            };
          }
        }
      }

      if (!itunesAbortRestOfQueries && alternateQueries && alternateQueries.length > 0) {
        const primaryTrackNorm = normalizeForMatching(track.title);
        const primaryArtistNorm = normalizeForMatching(track.artist);
        const dedupedAlts = alternateQueries.filter(
          (alt) =>
            normalizeForMatching(alt.trackName) !== primaryTrackNorm ||
            normalizeForMatching(alt.artistName) !== primaryArtistNorm,
        );

        for (const alt of dedupedAlts.slice(0, 3)) {
          if (itunesAbortRestOfQueries) break;
          const altMatch = await runItunesQuery(
            {
              title: alt.trackName,
              artist: alt.artistName,
              album: track.album,
              durationMs: track.durationMs,
            },
            "song",
          );
          if (altMatch) {
            const validated = sanitizeArtworkUrl(altMatch.artworkUrl) ?? altMatch.artworkUrl;
            if (!isExcludedUrl(validated)) {
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
                diagnostic: buildDiagnostic("itunes", validated),
              };
            }
          }
        }
      }
    } catch {
      sawTransientError = true;
      itunesDiag.queried = true;
      itunesDiag.classification = "network-error";
      itunesDiag.failedRequests += 1;
      observedFailures.push("NETWORK_ERROR");
    }

    if (itunesDiag.classification === "no-results") {
      observedFailures.push("ITUNES_NO_MATCH");
    }
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
    diagnostic: buildDiagnostic("none", undefined),
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
  options?: {
    size?: ArtworkThumbnailSize;
    forceRefresh?: boolean;
    includeDiagnostics?: boolean;
    excludeUrls?: string[];
    maxRetries?: number;
  },
): Promise<ArtworkResolution> {
  const forceRefresh = Boolean(options?.forceRefresh);
  const includeDiagnostics = Boolean(options?.includeDiagnostics);

  // 1. Check local IndexedDB for embedded artwork (always highest priority unless caller already validated/evicted)
  if (!forceRefresh) {
    try {
      const localBlob = await repository.getArtwork(track.id);
      if (localBlob) {
        const url = URL.createObjectURL(localBlob);
        return { url, source: "embedded" };
      }
    } catch {
      // Proceed to cache and online providers
    }
  }

  const albumKey = getAlbumArtworkCacheKey(track);
  const trackKey = getArtworkCacheKey(track);
  const primaryKey = albumKey || trackKey;

  if (!primaryKey) {
    if (!includeDiagnostics) {
      return { url: undefined, source: "none" };
    }
    const mbSkipped = createEmptyMusicBrainzDiagnostic();
    mbSkipped.skipped = true;
    mbSkipped.skipReason = "Empty track artist and title";
    mbSkipped.classification = "skipped";
    return {
      url: undefined,
      source: "none",
      diagnostic: {
        originalTitle: track.title,
        originalArtist: track.artist,
        originalAlbum: track.album ?? "",
        normalizedTitle: "",
        normalizedArtist: "",
        normalizedAlbum: undefined,
        musicbrainz: mbSkipped,
        caa: createEmptyCaaDiagnostic(),
        itunes: { ...createEmptyItunesDiagnostic(), classification: "skipped" },
        selectedProvider: "none",
        selectedArtworkHost: null,
        failedHttpRequests: 0,
        observedFailures: ["METADATA_INSUFFICIENT"],
      },
    };
  }

  // 2. Check unified artwork cache unless performing explicit force-refresh recovery
  if (!forceRefresh) {
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
  }

  // 3. Deduplicate concurrent requests for the same album or track
  // Include excludeUrls count/signature on forceRefresh so excluded retries don't reuse stale promise
  const excludeSig = options?.excludeUrls?.length ? `:ex${options.excludeUrls.length}` : "";
  const inFlightPrimaryKey = forceRefresh ? `force${excludeSig}::${primaryKey}` : primaryKey;
  const inFlightTrackKey = trackKey ? (forceRefresh ? `force${excludeSig}::${trackKey}` : trackKey) : "";
  const existingInFlight =
    !includeDiagnostics
      ? (inFlightRequests.get(inFlightPrimaryKey) ??
        (inFlightTrackKey ? inFlightRequests.get(inFlightTrackKey) : undefined))
      : undefined;
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
    fileName: track.fileName ?? "",
  });

  // Note: norm.artist can legitimately become "" when rawArtist was "Unknown Artist"
  // and no delimiter existed in title/fileName — keep "" instead of falling back to "Unknown Artist".
  const resolvedArtist =
    norm.artist !== undefined && isPlaceholderArtist(norm.artist)
      ? ""
      : isPlaceholderArtist(track.artist) && !norm.artist
        ? ""
        : (norm.artist || track.artist);

  const normalizedTrack: ArtworkTrackInput = {
    ...track,
    title: norm.title || track.title,
    artist: resolvedArtist,
    album: norm.album || (isYearOnly(track.album) ? undefined : track.album),
  };

  if (isInsufficientMetadataForDiscovery(normalizedTrack)) {
    if (!includeDiagnostics) {
      return { url: undefined, source: "none" };
    }
    const mbSkipped = createEmptyMusicBrainzDiagnostic();
    mbSkipped.skipped = true;
    mbSkipped.skipReason = "Incomplete or placeholder metadata";
    mbSkipped.classification = "skipped";
    return {
      url: undefined,
      source: "none",
      diagnostic: {
        originalTitle: track.title,
        originalArtist: track.artist,
        originalAlbum: track.album ?? "",
        normalizedTitle: normalizedTrack.title,
        normalizedArtist: normalizedTrack.artist,
        normalizedAlbum: normalizedTrack.album,
        musicbrainz: mbSkipped,
        caa: createEmptyCaaDiagnostic(),
        itunes: { ...createEmptyItunesDiagnostic(), classification: "skipped" },
        selectedProvider: "none",
        selectedArtworkHost: null,
        failedHttpRequests: 0,
        observedFailures: ["METADATA_INSUFFICIENT"],
      },
    };
  }

  const promise = (async (): Promise<ArtworkResolution> => {
    try {
      const { resolution, transientFailure, diagnostic } = await discoverOnlineArtwork(
        normalizedTrack,
        options?.size ?? "500",
        norm.alternateQueries,
        {
          includeDiagnostics,
          excludeUrls: options?.excludeUrls,
          maxRetries: options?.maxRetries ?? (forceRefresh ? 1 : 0),
          originalTrack: track,
          forceRefresh,
        },
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
        if (transientBackoffUntil.size >= 500) {
          const nowMs = Date.now();
          for (const [k, until] of transientBackoffUntil) {
            if (until < nowMs) transientBackoffUntil.delete(k);
          }
        }
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

      const baseResolution = transientFailure
        ? { ...resolution, transientFailure: true }
        : resolution;
      return includeDiagnostics ? { ...baseResolution, diagnostic } : baseResolution;
    } finally {
      inFlightRequests.delete(inFlightPrimaryKey);
      if (inFlightTrackKey) inFlightRequests.delete(inFlightTrackKey);
    }
  })();

  if (!includeDiagnostics) {
    inFlightRequests.set(inFlightPrimaryKey, promise);
    if (inFlightTrackKey && inFlightTrackKey !== inFlightPrimaryKey) {
      inFlightRequests.set(inFlightTrackKey, promise);
    }
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
