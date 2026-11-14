import { repository } from "../indexeddb/LibraryRepository";
import { getPlayUrl } from "../cloud/r2StorageService";
import {
  clearNegativeArtworkCacheForTrack,
  getAlbumArtworkCacheKey,
  hasMeaningfulAlbum,
  invalidateArtworkCacheForTrack,
  isArtworkUrlFailed,
  markArtworkUrlFailed,
  resolveArtworkForTrack,
} from "./artworkService";
import {
  classifyTrackFailure,
  createEmptyCaaDiagnostic,
  createEmptyItunesDiagnostic,
  createEmptyMusicBrainzDiagnostic,
  extractSafeUrlHost,
  isAbortError,
  isProviderFailureReason,
  type ArtworkFailureReason,
  type ImageDecodeDiagnostic,
  type ImageDownloadDiagnostic,
  type TrackArtworkDiagnostic,
  type TrackDiscoveryDiagnostic,
} from "./artworkDiagnostics";
import type { Track } from "../../types";
import { perfMark, perfMeasure } from "../../utils/perf";

/**
 * In-memory artwork URL cache keyed by stable track ID, with bounded LRU object
 * URLs and event listeners. Object URLs are revoked only when no active listener
 * or cache entry references them (delayed, so already-painted images never break);
 * external URLs are never revoked.
 *
 * Remote artwork resolved from providers or cloud R2 storage is materialized into
 * a validated Blob and persisted to IndexedDB (`repository.putArtwork`), so
 * artwork keeps working offline and across refreshes without re-downloading.
 */
const urlCache = new Map<string, string>();
const inFlightLoads = new Map<string, Promise<string | undefined>>();
const revokedBlobUrls = new Set<string>();
const MAX_CACHE = 500;
/** Delay before an evicted blob URL is revoked so in-flight paints finish. */
const EVICTED_BLOB_REVOKE_DELAY_MS = 60_000;
const IMAGE_PROBE_TIMEOUT_MS = 5_000;
const INITIAL_IMAGE_CTOR = typeof Image === "function" ? Image : undefined;

type ArtworkListener = (trackId: string, url: string | undefined) => void;
type TrackArtworkListener = (url: string | undefined) => void;

const globalArtworkListeners = new Set<ArtworkListener>();
const trackArtworkListeners = new Map<string, Set<TrackArtworkListener>>();

function hasActiveTrackListeners(trackId: string): boolean {
  const listeners = trackArtworkListeners.get(trackId);
  return Boolean(listeners && listeners.size > 0);
}

function isBlobUrlInUse(url: string): boolean {
  for (const [trackId, activeUrl] of urlCache.entries()) {
    if (activeUrl === url) return true;
    if (hasActiveTrackListeners(trackId) && activeUrl === url) return true;
  }
  return false;
}

function rememberRevokedBlobUrl(url: string): void {
  if (revokedBlobUrls.size >= 500) {
    const oldest = revokedBlobUrls.values().next().value;
    if (oldest !== undefined) revokedBlobUrls.delete(oldest);
  }
  revokedBlobUrls.add(url);
}

export function subscribeArtwork(listener: ArtworkListener): () => void;
export function subscribeArtwork(trackId: string, listener: TrackArtworkListener): () => void;
export function subscribeArtwork(
  trackIdOrListener: string | ArtworkListener,
  maybeListener?: TrackArtworkListener,
): () => void {
  if (typeof trackIdOrListener === "string" && maybeListener) {
    const trackId = trackIdOrListener;
    const listener = maybeListener;
    let set = trackArtworkListeners.get(trackId);
    if (!set) {
      set = new Set();
      trackArtworkListeners.set(trackId, set);
    }
    set.add(listener);
    return () => {
      const currentSet = trackArtworkListeners.get(trackId);
      if (currentSet) {
        currentSet.delete(listener);
        if (currentSet.size === 0) {
          trackArtworkListeners.delete(trackId);
        }
      }
    };
  }

  const listener = trackIdOrListener as ArtworkListener;
  globalArtworkListeners.add(listener);
  return () => {
    globalArtworkListeners.delete(listener);
  };
}

export function notifyArtworkLoaded(trackId: string, url: string | undefined): void {
  const specific = trackArtworkListeners.get(trackId);
  if (specific && specific.size > 0) {
    for (const listener of specific) {
      try {
        listener(url);
      } catch {
        // Ignore listener errors
      }
    }
  }

  if (globalArtworkListeners.size > 0) {
    for (const listener of globalArtworkListeners) {
      try {
        listener(trackId, url);
      } catch {
        // Ignore listener errors
      }
    }
  }
}

function scheduleRevokeObjectUrl(url: string, trackId?: string): void {
  const timer = setTimeout(() => {
    if (trackId && (urlCache.get(trackId) === url || hasActiveTrackListeners(trackId))) {
      return;
    }
    if (isBlobUrlInUse(url)) {
      return;
    }
    rememberRevokedBlobUrl(url);
    URL.revokeObjectURL(url);
  }, EVICTED_BLOB_REVOKE_DELAY_MS);
  const unref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(timer);
}

function evictOldestUrlCacheEntry(): void {
  let targetKey: string | undefined;
  for (const key of urlCache.keys()) {
    if (!hasActiveTrackListeners(key)) {
      targetKey = key;
      break;
    }
  }
  if (targetKey === undefined) {
    targetKey = urlCache.keys().next().value;
  }
  if (targetKey === undefined) return;
  const evicted = urlCache.get(targetKey);
  urlCache.delete(targetKey);
  if (evicted && evicted.startsWith("blob:")) {
    scheduleRevokeObjectUrl(evicted, targetKey);
  }
}

/** Bounded LRU insert: refreshes recency on update and evicts the oldest inactive entry when full. */
function insertUrlCache(trackId: string, url: string): void {
  if (!trackId || !url) return;
  const existing = urlCache.get(trackId);
  if (existing !== undefined) {
    urlCache.delete(trackId);
    if (existing !== url && existing.startsWith("blob:")) {
      scheduleRevokeObjectUrl(existing, trackId);
    }
  } else if (urlCache.size >= MAX_CACHE) {
    evictOldestUrlCacheEntry();
  }
  urlCache.set(trackId, url);
}

export function setCachedArtworkForTrack(trackId: string, url: string): void {
  if (!trackId || !url) return;
  insertUrlCache(trackId, url);
  notifyArtworkLoaded(trackId, url);
}

function isStaleOrFailedMemoryUrl(url: string): boolean {
  if (url.startsWith("blob:")) {
    return revokedBlobUrls.has(url);
  }
  if (url.startsWith("http")) {
    return typeof isArtworkUrlFailed === "function" && isArtworkUrlFailed(url);
  }
  return false;
}

export function getArtworkUrl(trackId: string): string | undefined {
  const url = urlCache.get(trackId);
  if (url === undefined) return undefined;
  if (isStaleOrFailedMemoryUrl(url)) {
    urlCache.delete(trackId);
    return undefined;
  }
  // Refresh LRU order on read
  urlCache.delete(trackId);
  urlCache.set(trackId, url);
  return url;
}

// ---- Remote-to-blob materialization (persistent local artwork cache) ----

const MAX_ARTWORK_BLOB_BYTES = 5 * 1024 * 1024;
const MIN_ARTWORK_BLOB_BYTES = 64;
const ARTWORK_DOWNLOAD_TIMEOUT_MS = 10_000;
/** Remember failed downloads briefly so one broken URL is not retried in a loop. */
const FAILED_DOWNLOAD_TTL_MS = 5 * 60_000;

const inFlightBlobDownloads = new Map<string, Promise<Blob | null>>();
const inFlightPersistBlobs = new Map<string, Promise<Blob | undefined>>();
const failedDownloadAt = new Map<string, number>();

function pruneMapOldest(map: Map<string, number>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function canUseDomImageElement(): boolean {
  if (typeof Image !== "function") return false;
  const isJsdom = typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent ?? "");
  if (isJsdom && Image === INITIAL_IMAGE_CTOR && !("mock" in Image)) {
    return false;
  }
  return true;
}

async function looksLikeHtmlOrJsonPayload(blob: Blob): Promise<boolean> {
  try {
    const headerBuf = await blob.slice(0, 32).arrayBuffer();
    const head = new TextDecoder().decode(headerBuf).trimStart().toLowerCase();
    return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("{");
  } catch {
    return false;
  }
}

async function validateArtworkBlobWithReason(blob: Blob): Promise<{
  valid: boolean;
  reason: NonNullable<ImageDecodeDiagnostic["reason"]>;
}> {
  if (
    !blob ||
    typeof blob.size !== "number" ||
    !Number.isFinite(blob.size) ||
    blob.size < MIN_ARTWORK_BLOB_BYTES
  ) {
    return { valid: false, reason: "undersized" };
  }
  if (blob.size > MAX_ARTWORK_BLOB_BYTES) {
    return { valid: false, reason: "oversized" };
  }
  if (blob.type && !blob.type.startsWith("image/")) {
    return { valid: false, reason: "invalid-mime" };
  }
  if (await looksLikeHtmlOrJsonPayload(blob)) {
    return { valid: false, reason: "html-or-json" };
  }

  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      bitmap.close();
      return { valid: true, reason: "ok" };
    } catch {
      return { valid: false, reason: "decode-failed" };
    }
  }

  if (!canUseDomImageElement()) {
    return !blob.type || blob.type.startsWith("image/")
      ? { valid: true, reason: "ok" }
      : { valid: false, reason: "invalid-mime" };
  }

  // Fallback decode path (environments without createImageBitmap)
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      URL.revokeObjectURL(objectUrl);
      resolve({ valid: ok, reason: ok ? "ok" : "decode-failed" });
    };
    const timer = setTimeout(() => finish(false), 5000);
    img.onload = () => {
      const ok = img.naturalWidth === 0 && img.naturalHeight === 0 ? true : img.naturalWidth > 0;
      finish(ok);
    };
    img.onerror = () => finish(false);
    img.src = objectUrl;
  });
}

/**
 * Validates that a downloaded or persisted blob is a real, decodable image
 * before it is ever persisted or displayed.
 */
export async function validateArtworkBlob(blob: Blob): Promise<boolean> {
  return (await validateArtworkBlobWithReason(blob)).valid;
}

async function probeImageElement(url: string, timeoutMs = IMAGE_PROBE_TIMEOUT_MS): Promise<boolean> {
  if (!canUseDomImageElement()) return false;
  return new Promise((resolve) => {
    const img = new Image();
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    img.onload = () => {
      // If mocked without naturalWidth, default > 0 via truthy naturalWidth !== 0 when explicitly 0
      const valid = typeof img.naturalWidth === "number" && img.naturalWidth === 0 ? false : true;
      finish(valid);
    };
    img.onerror = () => finish(false);
    img.src = url;
  });
}

type RemoteValidationOutcome =
  | { status: "valid-blob"; blob: Blob; httpStatus?: number | null }
  | { status: "valid-cors"; httpStatus?: number | null }
  | {
      status: "broken";
      httpStatus?: number | null;
      downloadClassification?: ImageDownloadDiagnostic["classification"];
      decodeReason?: ImageDecodeDiagnostic["reason"];
    }
  | {
      status: "transient-error";
      httpStatus?: number | null;
      downloadClassification?: ImageDownloadDiagnostic["classification"];
    }
  | { status: "offline"; httpStatus?: number | null };

async function validateRemoteArtworkUrl(
  url: string,
  sessionProbeCache?: Map<string, Promise<RemoteValidationOutcome>>,
): Promise<RemoteValidationOutcome> {
  if (typeof isArtworkUrlFailed === "function" && isArtworkUrlFailed(url)) {
    return { status: "broken", httpStatus: null, downloadClassification: "http-error" };
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { status: "offline", httpStatus: null };
  }

  if (sessionProbeCache) {
    const existing = sessionProbeCache.get(url);
    if (existing) return existing;
  }

  const runProbe = async (): Promise<RemoteValidationOutcome> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ARTWORK_DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal, credentials: "omit", mode: "cors" });
      const httpStatus = typeof response.status === "number" ? response.status : null;
      if (response.ok) {
        const blob = await response.blob();
        const decodeResult = await validateArtworkBlobWithReason(blob);
        if (decodeResult.valid) {
          failedDownloadAt.delete(url);
          return { status: "valid-blob", blob, httpStatus };
        }
        return {
          status: "broken",
          httpStatus,
          downloadClassification: "ok",
          decodeReason: decodeResult.reason,
        };
      }

      if (httpStatus === 429) {
        return { status: "transient-error", httpStatus, downloadClassification: "rate-limited" };
      }
      if (httpStatus === 503 || (httpStatus !== null && httpStatus >= 500)) {
        return { status: "transient-error", httpStatus, downloadClassification: "http-error" };
      }
      return { status: "broken", httpStatus, downloadClassification: "http-error" };
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) {
        return { status: "transient-error", httpStatus: null, downloadClassification: "timeout" };
      }
      // CORS-restricted remote image hosts can block fetch() while allowing <img> loading.
      // Only treat the URL as broken if <img> loading also fails.
      if (canUseDomImageElement()) {
        const displayable = await probeImageElement(url);
        if (displayable) {
          failedDownloadAt.delete(url);
          return { status: "valid-cors", httpStatus: null };
        }
        return { status: "broken", httpStatus: null, downloadClassification: "cors-blocked" };
      }
      return { status: "transient-error", httpStatus: null, downloadClassification: "network-error" };
    } finally {
      clearTimeout(timer);
    }
  };

  if (sessionProbeCache) {
    const promise = runProbe();
    sessionProbeCache.set(url, promise);
    return promise;
  }

  return runProbe();
}

async function downloadArtworkBlob(url: string): Promise<Blob | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ARTWORK_DOWNLOAD_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal, credentials: "omit", mode: "cors" });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return null;
    const blob = await response.blob();
    return (await validateArtworkBlob(blob)) ? blob : null;
  } catch {
    return null;
  }
}

/** Downloads an artwork blob once per URL; concurrent callers share one request. */
async function fetchArtworkBlobDeduped(url: string): Promise<Blob | null> {
  const failedAt = failedDownloadAt.get(url);
  if (failedAt !== undefined && Date.now() - failedAt < FAILED_DOWNLOAD_TTL_MS) return null;

  const existing = inFlightBlobDownloads.get(url);
  if (existing) return existing;

  const promise = (async (): Promise<Blob | null> => {
    const blob = await downloadArtworkBlob(url);
    if (blob) {
      failedDownloadAt.delete(url);
    } else {
      failedDownloadAt.set(url, Date.now());
      pruneMapOldest(failedDownloadAt, 200);
    }
    return blob;
  })().finally(() => {
    inFlightBlobDownloads.delete(url);
  });

  inFlightBlobDownloads.set(url, promise);
  return promise;
}

/**
 * Downloads a resolved remote artwork URL, validates it, and persists it to
 * IndexedDB for this track ID. Deduplicates concurrent writes per (track, URL).
 */
async function persistRemoteArtworkBlob(trackId: string, remoteUrl: string): Promise<Blob | undefined> {
  const key = `${trackId}::${remoteUrl}`;
  const existing = inFlightPersistBlobs.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<Blob | undefined> => {
    const blob = await fetchArtworkBlobDeduped(remoteUrl);
    if (!blob) return undefined;
    try {
      await repository.putArtwork(trackId, blob);
      return blob;
    } catch {
      return undefined; // Quota/IDB failure: honest fallback to the remote URL
    }
  })().finally(() => {
    inFlightPersistBlobs.delete(key);
  });

  inFlightPersistBlobs.set(key, promise);
  return promise;
}

/**
 * Schedules background persistence of a resolved remote artwork URL for a
 * track. Non-blocking: display keeps the remote URL and is upgraded to the
 * persisted blob (with a listener notification) once the download succeeds.
 */
export function upgradeArtworkToPersisted(trackId: string, remoteUrl: string): void {
  if (!trackId || !remoteUrl || !remoteUrl.startsWith("http")) return;

  void persistRemoteArtworkBlob(trackId, remoteUrl)
    .then((blob) => {
      if (!blob) return;
      const current = urlCache.get(trackId);
      if (current === remoteUrl || current === undefined) {
        try {
          const blobUrl = URL.createObjectURL(blob);
          insertUrlCache(trackId, blobUrl);
          notifyArtworkLoaded(trackId, blobUrl);
        } catch {
          // Keep existing remote URL if createObjectURL fails
        }
      }
    })
    .catch(() => {
      // Persistence is best-effort; remote URL remains in use.
    });
}

// ---- Load pipeline ----

export async function loadArtworkUrl(
  trackOrId: string | Track,
  customTrackLookup?: (id: string) => Track | undefined,
): Promise<string | undefined> {
  const trackId = typeof trackOrId === "string" ? trackOrId : trackOrId?.id;
  if (!trackId) return undefined;

  const cached = getArtworkUrl(trackId);
  if (cached) return cached;

  const existingPromise = inFlightLoads.get(trackId);
  if (existingPromise) return existingPromise;

  const loadPromise = (async (): Promise<string | undefined> => {
    perfMark(`skip:artwork:start:${trackId}`);
    try {
      // 1. Check persisted artwork blob in IndexedDB (embedded or previously
      //    materialized from a provider or cloud) — always validate before serving.
      try {
        const blob = await repository.getArtwork(trackId);
        if (blob) {
          if (await validateArtworkBlob(blob)) {
            const url = URL.createObjectURL(blob);
            insertUrlCache(trackId, url);
            notifyArtworkLoaded(trackId, url);
            perfMeasure("skip:artwork-work", `skip:artwork:start:${trackId}`, `skip:artwork:end:${trackId}`);
            return url;
          }
          // Confirmed corrupt IndexedDB record: delete so fresh recovery can succeed.
          await repository.deleteArtwork(trackId).catch(() => undefined);
        }
      } catch {
        // IndexedDB error, fall through to track lookup
      }

      const trackObj =
        typeof trackOrId === "object" && trackOrId !== null
          ? trackOrId
          : customTrackLookup
            ? customTrackLookup(trackId)
            : await repository.getTrack(trackId).catch(() => undefined);

      // 2. Check stored cloud artwork reference (`artworkObjectKey`) if present.
      const isOnline = typeof navigator === "undefined" || navigator.onLine !== false;
      if (trackObj?.artworkObjectKey && isOnline) {
        try {
          const signedUrl = await getPlayUrl(trackObj.artworkObjectKey);
          if (signedUrl) {
            const cloudBlob = await persistRemoteArtworkBlob(trackId, signedUrl);
            if (cloudBlob) {
              const blobUrl = URL.createObjectURL(cloudBlob);
              insertUrlCache(trackId, blobUrl);
              notifyArtworkLoaded(trackId, blobUrl);
              perfMeasure("skip:artwork-work", `skip:artwork:start:${trackId}`, `skip:artwork:end:${trackId}`);
              return blobUrl;
            }
          }
        } catch {
          // Fall through to online provider lookup if cloud artwork fetch fails
        }
      }

      // 3. Online artwork lookup for tracks without persisted artwork
      if (trackObj && trackObj.title) {
        try {
          const res = await resolveArtworkForTrack(trackObj);
          if (res.url) {
            insertUrlCache(trackId, res.url);
            notifyArtworkLoaded(trackId, res.url);
            upgradeArtworkToPersisted(trackId, res.url);
            perfMeasure("skip:artwork-work", `skip:artwork:start:${trackId}`, `skip:artwork:end:${trackId}`);
            return res.url;
          }
        } catch {
          // Ignore network errors
        }
      }

      notifyArtworkLoaded(trackId, undefined);
      return undefined;
    } finally {
      inFlightLoads.delete(trackId);
    }
  })();

  inFlightLoads.set(trackId, loadPromise);
  return loadPromise;
}

// ---- Error recovery ----

/** One automatic retry per (track, URL) within the cooldown window. */
const AUTO_RETRY_COOLDOWN_MS = 60_000;
const autoRetryLog = new Map<string, number>();

/**
 * Handles a failed `<img>` load without destroying recoverable state:
 * - Offline: keep every cache entry (the failure is connectivity, not data)
 *   and rely on the theme fallback until a remount retries.
 * - Stale/evicted blob URL with intact IndexedDB blob: mint a fresh blob URL
 *   immediately without deleting the valid persisted artwork.
 * - Online broken remote URL or corrupt blob: mark the broken URL as failed,
 *   invalidate once, and re-resolve (allowing fallback to the next provider).
 */
export async function handleArtworkImageError(trackId: string | null | undefined, failedUrl: string): Promise<void> {
  if (!trackId || !failedUrl) return;

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return;
  }

  const current = urlCache.get(trackId);
  if (current && current !== failedUrl) {
    return;
  }

  if (failedUrl.startsWith("blob:")) {
    const wasRevokedOrEvicted = revokedBlobUrls.has(failedUrl) || !current;
    try {
      const existingBlob = await repository.getArtwork(trackId);
      if (existingBlob && (await validateArtworkBlob(existingBlob))) {
        const freshUrl = URL.createObjectURL(existingBlob);
        insertUrlCache(trackId, freshUrl);
        notifyArtworkLoaded(trackId, freshUrl);
        return;
      }
    } catch {
      // Fall through if IndexedDB read failed
    }
    if (wasRevokedOrEvicted) {
      void loadArtworkUrl(trackId);
      return;
    }
  }

  const retryKey = `${trackId}::${failedUrl}`;
  const now = Date.now();
  const lastRetry = autoRetryLog.get(retryKey);
  if (lastRetry !== undefined && now - lastRetry < AUTO_RETRY_COOLDOWN_MS) {
    return;
  }
  autoRetryLog.set(retryKey, now);
  pruneMapOldest(autoRetryLog, 300);

  if (failedUrl.startsWith("http") && typeof markArtworkUrlFailed === "function") {
    markArtworkUrlFailed(failedUrl);
  }

  await invalidateArtworkForTrackId(trackId, { deletePersistedBlob: failedUrl.startsWith("blob:") });
  void loadArtworkUrl(trackId);
}

export async function invalidateArtworkForTrackId(
  trackId: string,
  options?: { deletePersistedBlob?: boolean },
): Promise<void> {
  const evicted = urlCache.get(trackId);
  urlCache.delete(trackId);
  if (evicted && evicted.startsWith("blob:")) {
    scheduleRevokeObjectUrl(evicted, trackId);
  }
  if (options?.deletePersistedBlob) {
    await repository.deleteArtwork(trackId).catch(() => undefined);
  }
  const trackObj = await repository.getTrack(trackId).catch(() => undefined);
  if (trackObj) {
    invalidateArtworkCacheForTrack(trackObj);
  }
  notifyArtworkLoaded(trackId, undefined);
}

export function evictArtworkUrlCache(trackId: string): void {
  const evicted = urlCache.get(trackId);
  urlCache.delete(trackId);
  if (evicted && evicted.startsWith("blob:")) {
    scheduleRevokeObjectUrl(evicted, trackId);
  }
}

export function clearArtworkCache(): void {
  for (const url of urlCache.values()) {
    if (url.startsWith("blob:")) {
      URL.revokeObjectURL(url);
    }
  }
  urlCache.clear();
  revokedBlobUrls.clear();
  inFlightLoads.clear();
}

// ---- Centralized health inspection & intelligent recovery ----

export type ArtworkHealthState = "VALID" | "MISSING" | "CORRUPTED" | "BROKEN_URL" | "STALE";

export type ArtworkRecoveryPhase = "scanning" | "recovering";

export interface ArtworkHealthReport {
  trackId: string;
  state: ArtworkHealthState;
  url?: string;
  blob?: Blob;
  staleMemoryUrl?: string;
  hasCorruptedPersistedBlob?: boolean;
}

export interface ReloadMissingArtworkProgress {
  phase: ArtworkRecoveryPhase;
  done: number;
  total: number;
  restored: number;
}

export interface ArtworkHealthSummary {
  totalTracks: number;
  validPreserved: number;
  missingDetected: number;
  corruptedDetected: number;
  brokenUrlDetected: number;
  staleDetected: number;
  restored: number;
  stillMissing: number;
  /** Number of tracks affected by provider HTTP/network/timeout/rate-limit/download failures. */
  providerFailures: number;
  /** Explicit alias clarifying affected track count vs failed HTTP request count. */
  providerFailedTracks: number;
  /** Total failed HTTP requests across discovery and image downloads. */
  failedHttpRequests: number;
  /** Tracks failing due to metadata insufficiency, rejected candidates, or 404/no catalogue match. */
  noMatchCount: number;
  /** Tracks failing during remote image download validation or image decoding. */
  imageValidationErrorCount: number;
  /** Tracks failing during IndexedDB persistence (`repository.putArtwork`). */
  storageErrorCount: number;
  offline: boolean;
  alreadyHaveArtwork: number;
  missingFound: number;
  /** Per-track diagnostics collected across the recovery session. */
  diagnostics: TrackArtworkDiagnostic[];
  /** Subset of `diagnostics` for tracks that could not be durably restored. */
  failedTracks: TrackArtworkDiagnostic[];
}

/** @deprecated Alias kept for callers referencing the previous name. */
export type ReloadMissingArtworkResult = ArtworkHealthSummary;

function clearAutoRetryForTrack(trackId: string): void {
  const prefix = `${trackId}::`;
  for (const key of Array.from(autoRetryLog.keys())) {
    if (key.startsWith(prefix)) autoRetryLog.delete(key);
  }
}

function getRecoveryAlbumGroupKey(track: Track): string {
  const meaningful =
    typeof hasMeaningfulAlbum === "function"
      ? hasMeaningfulAlbum(track.album)
      : Boolean(track.album && track.album.trim());
  if (!meaningful) return "";
  if (typeof getAlbumArtworkCacheKey === "function") {
    const key = getAlbumArtworkCacheKey(track);
    if (key.startsWith("album::")) return key;
  }
  return `album::${(track.artist ?? "").trim().toLowerCase()}::${(track.album ?? "").trim().toLowerCase()}`;
}

/**
 * Classifies a single track's true artwork health across memory cache,
 * IndexedDB blob storage, and remote HTTP/HTTPS URLs.
 * Does NOT delete corrupted records during read-only inspection, except refreshing
 * a revoked memory blob URL or upgrading a valid remote URL when a valid blob exists.
 */
export async function inspectTrackArtworkHealth(
  track: Track,
  options?: { sessionProbeCache?: Map<string, Promise<RemoteValidationOutcome>> },
): Promise<ArtworkHealthReport> {
  const rawMemUrl = urlCache.get(track.id);
  const memUrlIsRevokedBlob = Boolean(rawMemUrl && rawMemUrl.startsWith("blob:") && revokedBlobUrls.has(rawMemUrl));
  const memUrlIsActiveBlob = Boolean(rawMemUrl && rawMemUrl.startsWith("blob:") && !revokedBlobUrls.has(rawMemUrl));
  const memUrlIsHttp = Boolean(rawMemUrl && rawMemUrl.startsWith("http"));

  // 1. Always inspect & validate persisted IndexedDB blob if one exists
  let persistedBlob: Blob | undefined;
  let hasPersistedBlob = false;
  try {
    persistedBlob = await repository.getArtwork(track.id);
    hasPersistedBlob = persistedBlob !== undefined;
  } catch {
    persistedBlob = undefined;
  }

  if (hasPersistedBlob && persistedBlob) {
    const validBlob = await validateArtworkBlob(persistedBlob);
    if (validBlob) {
      // Valid persisted artwork: preserve it; heal revoked or HTTP-only memory references
      if (memUrlIsActiveBlob && rawMemUrl) {
        return { trackId: track.id, state: "VALID", url: rawMemUrl, blob: persistedBlob };
      }
      if (memUrlIsRevokedBlob || memUrlIsHttp) {
        const freshUrl = URL.createObjectURL(persistedBlob);
        insertUrlCache(track.id, freshUrl);
        notifyArtworkLoaded(track.id, freshUrl);
        return { trackId: track.id, state: "VALID", url: freshUrl, blob: persistedBlob };
      }
      return { trackId: track.id, state: "VALID", blob: persistedBlob };
    }

    // Corrupted IndexedDB blob (regardless of whether memory cache has a stale URL)
    return {
      trackId: track.id,
      state: "CORRUPTED",
      hasCorruptedPersistedBlob: true,
      staleMemoryUrl: rawMemUrl,
    };
  }

  // 2. Active non-revoked in-memory blob URL (e.g., freshly imported or memory-only valid artwork)
  if (memUrlIsActiveBlob && rawMemUrl) {
    return { trackId: track.id, state: "VALID", url: rawMemUrl };
  }

  // 3. Revoked blob URL without valid persisted IndexedDB backing
  if (memUrlIsRevokedBlob) {
    return { trackId: track.id, state: "STALE", staleMemoryUrl: rawMemUrl };
  }

  // 4. Remote HTTP/HTTPS URL in memory cache: validate actual availability / image decodability
  if (memUrlIsHttp && rawMemUrl) {
    const remoteCheck = await validateRemoteArtworkUrl(rawMemUrl, options?.sessionProbeCache);
    if (remoteCheck.status === "valid-blob") {
      try {
        await repository.putArtwork(track.id, remoteCheck.blob);
      } catch {
        // Best-effort persistence
      }
      try {
        const blobUrl = URL.createObjectURL(remoteCheck.blob);
        insertUrlCache(track.id, blobUrl);
        notifyArtworkLoaded(track.id, blobUrl);
        return { trackId: track.id, state: "VALID", url: blobUrl, blob: remoteCheck.blob };
      } catch {
        return { trackId: track.id, state: "VALID", url: rawMemUrl, blob: remoteCheck.blob };
      }
    }
    if (remoteCheck.status === "valid-cors") {
      return { trackId: track.id, state: "VALID", url: rawMemUrl };
    }
    if (remoteCheck.status === "offline") {
      // Offline: cannot verify remote URL, never destroy cached reference
      return { trackId: track.id, state: "MISSING", staleMemoryUrl: undefined };
    }
    return { trackId: track.id, state: "BROKEN_URL", staleMemoryUrl: rawMemUrl };
  }

  // 5. Neither IndexedDB blob nor usable memory URL exists
  return { trackId: track.id, state: "MISSING" };
}

async function applyVerifiedBlobToTracks(
  tracks: Track[],
  blob: Blob,
  fallbackUrl?: string,
): Promise<{ updated: number; durableCount: number; failedTrackIds: Set<string> }> {
  let updated = 0;
  let durableCount = 0;
  const failedTrackIds = new Set<string>();

  for (const track of tracks) {
    let persisted = false;
    try {
      await repository.putArtwork(track.id, blob);
      persisted = true;
      durableCount++;
    } catch {
      failedTrackIds.add(track.id);
    }
    try {
      const blobUrl = URL.createObjectURL(blob);
      insertUrlCache(track.id, blobUrl);
      notifyArtworkLoaded(track.id, blobUrl);
      updated++;
    } catch {
      if (fallbackUrl) {
        insertUrlCache(track.id, fallbackUrl);
        notifyArtworkLoaded(track.id, fallbackUrl);
        updated++;
      } else if (persisted) {
        updated++;
      }
    }
  }
  return { updated, durableCount, failedTrackIds };
}

async function tryRecoverTrackFromCloud(
  track: Track,
  sessionProbeCache: Map<string, Promise<RemoteValidationOutcome>>,
): Promise<Blob | null> {
  if (!track.artworkObjectKey) return null;
  try {
    const signedUrl = await getPlayUrl(track.artworkObjectKey);
    if (!signedUrl) return null;
    const outcome = await validateRemoteArtworkUrl(signedUrl, sessionProbeCache);
    if (outcome.status === "valid-blob") {
      return outcome.blob;
    }
  } catch {
    // Cloud unavailable or object missing -> fall back to online providers
  }
  return null;
}

let activeMissingReload: {
  promise: Promise<ArtworkHealthSummary>;
  listeners: Set<(progress: ReloadMissingArtworkProgress) => void>;
} | null = null;

function emitReloadProgress(progress: ReloadMissingArtworkProgress): void {
  if (!activeMissingReload) return;
  for (const listener of activeMissingReload.listeners) {
    try {
      listener(progress);
    } catch {
      // Ignore UI listener errors
    }
  }
}

async function executeArtworkRecovery(tracks: Track[]): Promise<ArtworkHealthSummary> {
  const emptyDiagnosticFields = {
    providerFailedTracks: 0,
    failedHttpRequests: 0,
    noMatchCount: 0,
    imageValidationErrorCount: 0,
    storageErrorCount: 0,
    diagnostics: [] as TrackArtworkDiagnostic[],
    failedTracks: [] as TrackArtworkDiagnostic[],
  };

  if (tracks.length === 0) {
    return {
      totalTracks: 0,
      validPreserved: 0,
      missingDetected: 0,
      corruptedDetected: 0,
      brokenUrlDetected: 0,
      staleDetected: 0,
      restored: 0,
      stillMissing: 0,
      providerFailures: 0,
      offline: false,
      alreadyHaveArtwork: 0,
      missingFound: 0,
      ...emptyDiagnosticFields,
    };
  }

  const sessionProbeCache = new Map<string, Promise<RemoteValidationOutcome>>();
  const validAlbumBlobs = new Map<string, Blob>();
  const reports: Array<{ track: Track; report: ArtworkHealthReport }> = new Array(tracks.length);

  // Phase 1: Scan & validate all tracks with bounded concurrency
  let scanCursor = 0;
  let scanDone = 0;
  const scanConcurrency = Math.min(6, tracks.length);

  const scanWorker = async () => {
    while (scanCursor < tracks.length) {
      const idx = scanCursor++;
      const track = tracks[idx];
      if (!track) continue;

      const report = await inspectTrackArtworkHealth(track, { sessionProbeCache }).catch(
        (): ArtworkHealthReport => ({ trackId: track.id, state: "MISSING" }),
      );
      reports[idx] = { track, report };

      if (report.state === "VALID" && report.blob) {
        const albumKey = getRecoveryAlbumGroupKey(track);
        if (albumKey && !validAlbumBlobs.has(albumKey)) {
          validAlbumBlobs.set(albumKey, report.blob);
        }
      }

      scanDone++;
      emitReloadProgress({ phase: "scanning", done: scanDone, total: tracks.length, restored: 0 });
    }
  };

  await Promise.all(Array.from({ length: scanConcurrency }, () => scanWorker()));

  let validPreserved = 0;
  let missingDetected = 0;
  let corruptedDetected = 0;
  let brokenUrlDetected = 0;
  let staleDetected = 0;
  const needsRecovery: Array<{ track: Track; report: ArtworkHealthReport }> = [];
  const healthBeforeByTrackId = new Map<string, ArtworkHealthState>();

  for (const item of reports) {
    if (!item) continue;
    healthBeforeByTrackId.set(item.track.id, item.report.state);
    switch (item.report.state) {
      case "VALID":
        validPreserved++;
        break;
      case "CORRUPTED":
        corruptedDetected++;
        needsRecovery.push(item);
        break;
      case "BROKEN_URL":
        brokenUrlDetected++;
        needsRecovery.push(item);
        break;
      case "STALE":
        staleDetected++;
        needsRecovery.push(item);
        break;
      case "MISSING":
      default:
        missingDetected++;
        needsRecovery.push(item);
        break;
    }
  }

  const missingFound = needsRecovery.length;
  if (missingFound === 0) {
    return {
      totalTracks: tracks.length,
      validPreserved,
      missingDetected: 0,
      corruptedDetected: 0,
      brokenUrlDetected: 0,
      staleDetected: 0,
      restored: 0,
      stillMissing: 0,
      providerFailures: 0,
      offline: false,
      alreadyHaveArtwork: validPreserved,
      missingFound: 0,
      ...emptyDiagnosticFields,
    };
  }

  // Never destroy local/remote caches when offline; report recovery unavailable honestly.
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    const offlineDiagnostics: TrackArtworkDiagnostic[] = needsRecovery.map(({ track, report }) => ({
      trackId: track.id,
      originalTitle: track.title,
      originalArtist: track.artist,
      originalAlbum: track.album ?? "",
      normalizedTitle: track.title,
      normalizedArtist: track.artist,
      normalizedAlbum: track.album || undefined,
      healthBefore: report.state,
      outcome: "skipped-offline",
      primaryReason: "NETWORK_ERROR",
      secondaryReasons: [],
      selectedProvider: "none",
      selectedArtworkHost: null,
      musicbrainz: { ...createEmptyMusicBrainzDiagnostic(), skipped: true, skipReason: "Device offline" },
      caa: createEmptyCaaDiagnostic(),
      itunes: { ...createEmptyItunesDiagnostic(), classification: "skipped" },
      imageDownload: { attempted: false, httpStatus: null, classification: "offline", failedRequests: 0 },
      imageDecode: { attempted: false, valid: null, reason: "not-attempted" },
      indexedDb: { attempted: false, ok: null, reason: "not-attempted" },
      failedHttpRequests: 0,
    }));

    return {
      totalTracks: tracks.length,
      validPreserved,
      missingDetected,
      corruptedDetected,
      brokenUrlDetected,
      staleDetected,
      restored: 0,
      stillMissing: missingFound,
      providerFailures: 0,
      providerFailedTracks: 0,
      failedHttpRequests: 0,
      noMatchCount: 0,
      imageValidationErrorCount: 0,
      storageErrorCount: 0,
      offline: true,
      alreadyHaveArtwork: validPreserved,
      missingFound,
      diagnostics: offlineDiagnostics,
      failedTracks: offlineDiagnostics,
    };
  }

  // Phase 2: Invalidate ONLY confirmed missing/corrupted/broken/stale entries
  failedDownloadAt.clear();

  for (const { track, report } of needsRecovery) {
    clearAutoRetryForTrack(track.id);

    if (report.staleMemoryUrl?.startsWith("http") && typeof markArtworkUrlFailed === "function") {
      markArtworkUrlFailed(report.staleMemoryUrl);
    }

    if (report.staleMemoryUrl !== undefined || report.state !== "MISSING") {
      const evicted = urlCache.get(track.id);
      urlCache.delete(track.id);
      if (evicted && evicted.startsWith("blob:")) {
        scheduleRevokeObjectUrl(evicted, track.id);
      }
      notifyArtworkLoaded(track.id, undefined);
    }

    if (report.hasCorruptedPersistedBlob) {
      await repository.deleteArtwork(track.id).catch(() => undefined);
    }

    if (typeof invalidateArtworkCacheForTrack === "function") {
      invalidateArtworkCacheForTrack(track);
    }
    if (typeof clearNegativeArtworkCacheForTrack === "function") {
      clearNegativeArtworkCacheForTrack(track);
    }
  }

  // Phase 3: Group affected tracks by normalized artist + album identity
  const groups = new Map<string, Track[]>();
  for (const { track } of needsRecovery) {
    const albumKey = getRecoveryAlbumGroupKey(track);
    const groupKey = albumKey ? `album:${albumKey}` : `track:${track.id}`;
    const bucket = groups.get(groupKey);
    if (bucket) {
      bucket.push(track);
    } else {
      groups.set(groupKey, [track]);
    }
  }

  const groupEntries = Array.from(groups.values());
  let groupCursor = 0;
  let recoveryDone = 0;
  let restored = 0;
  let totalFailedHttpRequests = 0;
  const diagnosticsByTrackId = new Map<string, TrackArtworkDiagnostic>();

  const markGroupProgress = (count: number, newlyRestored: number) => {
    recoveryDone += count;
    restored += newlyRestored;
    emitReloadProgress({
      phase: "recovering",
      done: Math.min(recoveryDone, missingFound),
      total: missingFound,
      restored,
    });
  };

  const makeBaselineDiscovery = (track: Track): TrackDiscoveryDiagnostic => ({
    originalTitle: track.title,
    originalArtist: track.artist,
    originalAlbum: track.album ?? "",
    normalizedTitle: track.title,
    normalizedArtist: track.artist,
    normalizedAlbum: track.album || undefined,
    musicbrainz: createEmptyMusicBrainzDiagnostic(),
    caa: createEmptyCaaDiagnostic(),
    itunes: createEmptyItunesDiagnostic(),
    selectedProvider: "none",
    selectedArtworkHost: null,
    failedHttpRequests: 0,
    observedFailures: [],
  });

  const recordBlobApplyDiagnostics = (
    targetTracks: Track[],
    provider: "sibling-album" | "cloud" | "musicbrainz-caa" | "itunes",
    discoveryDiag: TrackDiscoveryDiagnostic,
    downloadDiag: ImageDownloadDiagnostic,
    decodeDiag: ImageDecodeDiagnostic,
    idbFailedIds: Set<string>,
    selectedHost: string | null,
    groupHttpFailures: number,
  ) => {
    for (const t of targetTracks) {
      const idbFailed = idbFailedIds.has(t.id);
      const idbDiag = idbFailed
        ? ({ attempted: true, ok: false, reason: "write-failed" } as const)
        : ({ attempted: true, ok: true, reason: "ok" } as const);

      if (idbFailed) {
        diagnosticsByTrackId.set(t.id, {
          trackId: t.id,
          originalTitle: t.title,
          originalArtist: t.artist,
          originalAlbum: t.album ?? "",
          normalizedTitle: discoveryDiag.normalizedTitle,
          normalizedArtist: discoveryDiag.normalizedArtist,
          normalizedAlbum: discoveryDiag.normalizedAlbum,
          healthBefore: healthBeforeByTrackId.get(t.id) ?? "MISSING",
          outcome: "failed",
          primaryReason: "INDEXEDDB_WRITE_FAILED",
          secondaryReasons: [],
          selectedProvider: provider,
          selectedArtworkHost: selectedHost,
          musicbrainz: discoveryDiag.musicbrainz,
          caa: discoveryDiag.caa,
          itunes: discoveryDiag.itunes,
          imageDownload: downloadDiag,
          imageDecode: decodeDiag,
          indexedDb: idbDiag,
          failedHttpRequests: groupHttpFailures,
        });
      } else {
        diagnosticsByTrackId.set(t.id, {
          trackId: t.id,
          originalTitle: t.title,
          originalArtist: t.artist,
          originalAlbum: t.album ?? "",
          normalizedTitle: discoveryDiag.normalizedTitle,
          normalizedArtist: discoveryDiag.normalizedArtist,
          normalizedAlbum: discoveryDiag.normalizedAlbum,
          healthBefore: healthBeforeByTrackId.get(t.id) ?? "MISSING",
          outcome: "restored",
          primaryReason: null,
          secondaryReasons: [],
          selectedProvider: provider,
          selectedArtworkHost: selectedHost,
          musicbrainz: discoveryDiag.musicbrainz,
          caa: discoveryDiag.caa,
          itunes: discoveryDiag.itunes,
          imageDownload: downloadDiag,
          imageDecode: decodeDiag,
          indexedDb: idbDiag,
          failedHttpRequests: groupHttpFailures,
        });
      }
    }
  };

  const recoverGroup = async (groupTracks: Track[]): Promise<void> => {
    if (groupTracks.length === 0) return;

    const firstAlbumKey = getRecoveryAlbumGroupKey(groupTracks[0]);

    // 1. Reuse validated sibling album blob if any valid track in the same album already has one
    if (firstAlbumKey && validAlbumBlobs.has(firstAlbumKey)) {
      const siblingBlob = validAlbumBlobs.get(firstAlbumKey)!;
      const applyRes = await applyVerifiedBlobToTracks(groupTracks, siblingBlob);
      recordBlobApplyDiagnostics(
        groupTracks,
        "sibling-album",
        makeBaselineDiscovery(groupTracks[0]),
        { attempted: false, httpStatus: null, classification: "not-attempted", failedRequests: 0 },
        { attempted: true, valid: true, reason: "ok" },
        applyRes.failedTrackIds,
        null,
        0,
      );
      markGroupProgress(groupTracks.length, applyRes.durableCount);
      return;
    }

    // 2. Try cloud artwork references (`artworkObjectKey`) before public providers
    const remainingTracks: Track[] = [];
    let cloudAlbumBlob: Blob | null = null;
    for (const track of groupTracks) {
      if (track.artworkObjectKey) {
        const cloudBlob = await tryRecoverTrackFromCloud(track, sessionProbeCache);
        if (cloudBlob) {
          cloudAlbumBlob = cloudAlbumBlob ?? cloudBlob;
          const applyRes = await applyVerifiedBlobToTracks([track], cloudBlob);
          recordBlobApplyDiagnostics(
            [track],
            "cloud",
            makeBaselineDiscovery(track),
            { attempted: true, httpStatus: 200, classification: "ok", failedRequests: 0 },
            { attempted: true, valid: true, reason: "ok" },
            applyRes.failedTrackIds,
            null,
            0,
          );
          markGroupProgress(1, applyRes.durableCount);
          continue;
        }
      }
      remainingTracks.push(track);
    }

    if (remainingTracks.length === 0) return;

    if (cloudAlbumBlob && firstAlbumKey) {
      validAlbumBlobs.set(firstAlbumKey, cloudAlbumBlob);
      const applyRes = await applyVerifiedBlobToTracks(remainingTracks, cloudAlbumBlob);
      recordBlobApplyDiagnostics(
        remainingTracks,
        "cloud",
        makeBaselineDiscovery(remainingTracks[0]),
        { attempted: true, httpStatus: 200, classification: "ok", failedRequests: 0 },
        { attempted: true, valid: true, reason: "ok" },
        applyRes.failedTrackIds,
        null,
        0,
      );
      markGroupProgress(remainingTracks.length, applyRes.durableCount);
      return;
    }

    // 3. Shared album-level provider discovery with explicit force-refresh, failed-URL exclusion & diagnostics
    const representative = remainingTracks[0];
    let groupRestored = 0;
    const groupExcludedUrls: string[] = [];
    const observedFailures: ArtworkFailureReason[] = [];
    let groupFailedHttpRequests = 0;

    let lastDiscoveryDiag: TrackDiscoveryDiagnostic = makeBaselineDiscovery(representative);
    let lastDownloadDiag: ImageDownloadDiagnostic = {
      attempted: false,
      httpStatus: null,
      classification: "not-attempted",
      failedRequests: 0,
    };
    let lastDecodeDiag: ImageDecodeDiagnostic = {
      attempted: false,
      valid: null,
      reason: "not-attempted",
    };
    let lastSelectedHost: string | null = null;
    let idbWriteFailedForAll = false;

    for (let attempt = 0; attempt < 2; attempt++) {
      let resolution;
      try {
        resolution = await resolveArtworkForTrack(representative, {
          forceRefresh: true,
          includeDiagnostics: true,
          excludeUrls: groupExcludedUrls,
          maxRetries: 1,
        });
      } catch {
        groupFailedHttpRequests += 1;
        totalFailedHttpRequests += 1;
        observedFailures.push("NETWORK_ERROR");
        break;
      }

      if (resolution.diagnostic) {
        // Accumulate failures across retry attempts rather than overwriting attempt 1 telemetry
        const prevObs = lastDiscoveryDiag.observedFailures;
        lastDiscoveryDiag = {
          ...resolution.diagnostic,
          observedFailures: Array.from(
            new Set([...prevObs, ...resolution.diagnostic.observedFailures]),
          ),
        };
        groupFailedHttpRequests += resolution.diagnostic.failedHttpRequests;
        totalFailedHttpRequests += resolution.diagnostic.failedHttpRequests;
      } else if (resolution.transientFailure) {
        groupFailedHttpRequests += 1;
        totalFailedHttpRequests += 1;
        observedFailures.push("NETWORK_ERROR");
        lastDiscoveryDiag.observedFailures = Array.from(
          new Set([...lastDiscoveryDiag.observedFailures, "NETWORK_ERROR"]),
        );
      }

      if (!resolution.url) {
        break;
      }

      const candidateProvider =
        resolution.source === "itunes" ? "itunes" : "musicbrainz-caa";
      lastSelectedHost = extractSafeUrlHost(resolution.url);

      if (resolution.url.startsWith("blob:")) {
        try {
          const idbBlob = await repository.getArtwork(representative.id);
          if (idbBlob) {
            const dec = await validateArtworkBlobWithReason(idbBlob);
            lastDecodeDiag = { attempted: true, valid: dec.valid, reason: dec.reason };
            if (dec.valid) {
              if (firstAlbumKey) validAlbumBlobs.set(firstAlbumKey, idbBlob);
              const applyRes = await applyVerifiedBlobToTracks(remainingTracks, idbBlob);
              groupRestored = applyRes.durableCount;
              recordBlobApplyDiagnostics(
                remainingTracks,
                candidateProvider,
                lastDiscoveryDiag,
                { attempted: true, httpStatus: null, classification: "ok", failedRequests: 0 },
                lastDecodeDiag,
                applyRes.failedTrackIds,
                lastSelectedHost,
                groupFailedHttpRequests,
              );
              break;
            }
          }
        } catch {
          // Fall through
        }
      }

      const validation = await validateRemoteArtworkUrl(resolution.url, sessionProbeCache);
      if (validation.status === "valid-blob") {
        if (firstAlbumKey) validAlbumBlobs.set(firstAlbumKey, validation.blob);
        const applyRes = await applyVerifiedBlobToTracks(
          remainingTracks,
          validation.blob,
          resolution.url,
        );
        groupRestored = applyRes.durableCount;
        lastDownloadDiag = {
          attempted: true,
          httpStatus: validation.httpStatus ?? 200,
          classification: "ok",
          failedRequests: 0,
        };
        lastDecodeDiag = { attempted: true, valid: true, reason: "ok" };
        if (applyRes.failedTrackIds.size === remainingTracks.length) {
          idbWriteFailedForAll = true;
        }
        recordBlobApplyDiagnostics(
          remainingTracks,
          candidateProvider,
          lastDiscoveryDiag,
          lastDownloadDiag,
          lastDecodeDiag,
          applyRes.failedTrackIds,
          lastSelectedHost,
          groupFailedHttpRequests,
        );
        break;
      }

      if (validation.status === "valid-cors") {
        lastDownloadDiag = {
          attempted: true,
          httpStatus: validation.httpStatus ?? null,
          classification: "cors-displayable",
          failedRequests: 0,
        };
        lastDecodeDiag = { attempted: false, valid: true, reason: "cors-displayable" };
        for (const t of remainingTracks) {
          insertUrlCache(t.id, resolution.url);
          notifyArtworkLoaded(t.id, resolution.url);
          groupRestored++;
          diagnosticsByTrackId.set(t.id, {
            trackId: t.id,
            originalTitle: t.title,
            originalArtist: t.artist,
            originalAlbum: t.album ?? "",
            normalizedTitle: lastDiscoveryDiag.normalizedTitle,
            normalizedArtist: lastDiscoveryDiag.normalizedArtist,
            normalizedAlbum: lastDiscoveryDiag.normalizedAlbum,
            healthBefore: healthBeforeByTrackId.get(t.id) ?? "MISSING",
            outcome: "restored",
            primaryReason: null,
            secondaryReasons: [],
            selectedProvider: candidateProvider,
            selectedArtworkHost: lastSelectedHost,
            musicbrainz: lastDiscoveryDiag.musicbrainz,
            caa: lastDiscoveryDiag.caa,
            itunes: lastDiscoveryDiag.itunes,
            imageDownload: lastDownloadDiag,
            imageDecode: lastDecodeDiag,
            indexedDb: { attempted: false, ok: null, reason: "skipped-cors" },
            failedHttpRequests: groupFailedHttpRequests,
          });
        }
        break;
      }

      if (validation.status === "offline") {
        lastDownloadDiag = {
          attempted: true,
          httpStatus: null,
          classification: "offline",
          failedRequests: 0,
        };
        observedFailures.push("NETWORK_ERROR");
        break;
      }

      if (validation.status === "transient-error") {
        groupFailedHttpRequests += 1;
        totalFailedHttpRequests += 1;
        const cls = validation.downloadClassification ?? "network-error";
        lastDownloadDiag = {
          attempted: true,
          httpStatus: validation.httpStatus ?? null,
          classification: cls,
          failedRequests: 1,
        };
        observedFailures.push(
          cls === "timeout"
            ? "PROVIDER_TIMEOUT"
            : cls === "rate-limited"
              ? "PROVIDER_RATE_LIMITED"
              : "IMAGE_DOWNLOAD_FAILED",
        );
        // Exclude timed-out/failing URL so Attempt 2 falls through to alternate release/provider
        if (!groupExcludedUrls.includes(resolution.url)) {
          groupExcludedUrls.push(resolution.url);
        }
        if (typeof invalidateArtworkCacheForTrack === "function") {
          invalidateArtworkCacheForTrack(representative);
        }
        if (typeof clearNegativeArtworkCacheForTrack === "function") {
          clearNegativeArtworkCacheForTrack(representative);
        }
        continue;
      }

      // Confirmed broken URL or undecodable payload
      if (validation.decodeReason && validation.decodeReason !== "ok") {
        lastDownloadDiag = {
          attempted: true,
          httpStatus: validation.httpStatus ?? 200,
          classification: "ok",
          failedRequests: 0,
        };
        lastDecodeDiag = { attempted: true, valid: false, reason: validation.decodeReason };
        observedFailures.push("IMAGE_DECODE_FAILED");
      } else {
        const failedReqInc = 1;
        groupFailedHttpRequests += failedReqInc;
        totalFailedHttpRequests += failedReqInc;
        lastDownloadDiag = {
          attempted: true,
          httpStatus: validation.httpStatus ?? null,
          classification: validation.downloadClassification ?? "http-error",
          failedRequests: failedReqInc,
        };
        observedFailures.push("IMAGE_DOWNLOAD_FAILED");
      }

      if (!groupExcludedUrls.includes(resolution.url)) {
        groupExcludedUrls.push(resolution.url);
      }
      if (resolution.url.startsWith("http") && typeof markArtworkUrlFailed === "function") {
        markArtworkUrlFailed(resolution.url);
      }
      if (typeof invalidateArtworkCacheForTrack === "function") {
        invalidateArtworkCacheForTrack(representative);
      }
      if (typeof clearNegativeArtworkCacheForTrack === "function") {
        clearNegativeArtworkCacheForTrack(representative);
      }
    }

    if (groupRestored === 0 && !idbWriteFailedForAll) {
      const mergedObserved = Array.from(
        new Set([...observedFailures, ...lastDiscoveryDiag.observedFailures]),
      );
      const classified = classifyTrackFailure({
        musicbrainz: lastDiscoveryDiag.musicbrainz,
        caa: lastDiscoveryDiag.caa,
        itunes: lastDiscoveryDiag.itunes,
        imageDownload: lastDownloadDiag,
        imageDecode: lastDecodeDiag,
        indexedDb: { attempted: false, ok: null, reason: "not-attempted" },
        observedFailures: mergedObserved,
      });

      for (const t of remainingTracks) {
        notifyArtworkLoaded(t.id, undefined);
        if (!diagnosticsByTrackId.has(t.id)) {
          diagnosticsByTrackId.set(t.id, {
            trackId: t.id,
            originalTitle: t.title,
            originalArtist: t.artist,
            originalAlbum: t.album ?? "",
            normalizedTitle: lastDiscoveryDiag.normalizedTitle,
            normalizedArtist: lastDiscoveryDiag.normalizedArtist,
            normalizedAlbum: lastDiscoveryDiag.normalizedAlbum,
            healthBefore: healthBeforeByTrackId.get(t.id) ?? "MISSING",
            outcome: "failed",
            primaryReason: classified.primaryReason,
            secondaryReasons: classified.secondaryReasons,
            selectedProvider: lastDiscoveryDiag.selectedProvider,
            selectedArtworkHost: lastSelectedHost,
            musicbrainz: lastDiscoveryDiag.musicbrainz,
            caa: lastDiscoveryDiag.caa,
            itunes: lastDiscoveryDiag.itunes,
            imageDownload: lastDownloadDiag,
            imageDecode: lastDecodeDiag,
            indexedDb: { attempted: false, ok: null, reason: "not-attempted" },
            failedHttpRequests: groupFailedHttpRequests,
          });
        }
      }
    }

    markGroupProgress(remainingTracks.length, groupRestored);
  };

  // Sequential worker (concurrency = 1) prevents bursting iTunes/MusicBrainz rate limits while
  // sharing album-level hits across every track in the same album.
  const recoveryWorker = async () => {
    while (groupCursor < groupEntries.length) {
      const idx = groupCursor++;
      const group = groupEntries[idx];
      if (!group) continue;
      await recoverGroup(group);
    }
  };

  await recoveryWorker();

  const diagnostics: TrackArtworkDiagnostic[] = [];
  for (const { track } of needsRecovery) {
    const entry = diagnosticsByTrackId.get(track.id);
    if (entry) diagnostics.push(entry);
  }
  const failedTracks = diagnostics.filter((d) => d.outcome === "failed");

  const providerFailedTracks = failedTracks.filter(
    (d) =>
      (d.primaryReason && isProviderFailureReason(d.primaryReason)) ||
      d.secondaryReasons.some((r) => isProviderFailureReason(r)),
  ).length;

  const noMatchCount = failedTracks.filter(
    (d) =>
      d.primaryReason === "NO_PROVIDER_MATCH" ||
      d.primaryReason === "MUSICBRAINZ_NOT_FOUND" ||
      d.primaryReason === "CAA_ARTWORK_NOT_FOUND" ||
      d.primaryReason === "ITUNES_NO_MATCH" ||
      d.primaryReason === "METADATA_INSUFFICIENT" ||
      d.primaryReason === "CANDIDATE_REJECTED",
  ).length;

  const imageValidationErrorCount = failedTracks.filter(
    (d) => d.primaryReason === "IMAGE_DECODE_FAILED" || d.primaryReason === "IMAGE_DOWNLOAD_FAILED",
  ).length;

  const storageErrorCount = failedTracks.filter(
    (d) => d.primaryReason === "INDEXEDDB_WRITE_FAILED",
  ).length;

  return {
    totalTracks: tracks.length,
    validPreserved,
    missingDetected,
    corruptedDetected,
    brokenUrlDetected,
    staleDetected,
    restored,
    stillMissing: missingFound - restored,
    providerFailures: providerFailedTracks,
    providerFailedTracks,
    failedHttpRequests: totalFailedHttpRequests,
    noMatchCount,
    imageValidationErrorCount,
    storageErrorCount,
    offline: false,
    alreadyHaveArtwork: validPreserved,
    missingFound,
    diagnostics,
    failedTracks,
  };
}

/**
 * Validates artwork health for every track and recovers missing, corrupted,
 * broken, or stale artwork while preserving all confirmed valid artwork.
 * Concurrent calls share the active recovery session without duplicating network requests.
 */
export function reloadMissingArtwork(
  tracks: Track[],
  options?: { onProgress?: (progress: ReloadMissingArtworkProgress) => void },
): Promise<ArtworkHealthSummary> {
  if (activeMissingReload) {
    if (options?.onProgress) {
      activeMissingReload.listeners.add(options.onProgress);
    }
    return activeMissingReload.promise;
  }

  const listeners = new Set<(progress: ReloadMissingArtworkProgress) => void>();
  if (options?.onProgress) {
    listeners.add(options.onProgress);
  }

  const promise = executeArtworkRecovery(tracks).finally(() => {
    activeMissingReload = null;
  });

  activeMissingReload = { promise, listeners };
  return promise;
}

/**
 * Clears all in-memory state (used in unit tests). Does not touch IndexedDB.
 */
export function __resetArtworkCacheForTests(): void {
  urlCache.clear();
  inFlightLoads.clear();
  inFlightBlobDownloads.clear();
  inFlightPersistBlobs.clear();
  failedDownloadAt.clear();
  autoRetryLog.clear();
  revokedBlobUrls.clear();
  globalArtworkListeners.clear();
  trackArtworkListeners.clear();
  activeMissingReload = null;
}
