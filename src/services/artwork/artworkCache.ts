import { repository } from "../indexeddb/LibraryRepository";
import { getPlayUrl } from "../cloud/r2StorageService";
import {
  clearNegativeArtworkCacheForTrack,
  invalidateArtworkCacheForTrack,
  markArtworkUrlFailed,
  resolveArtworkForTrack,
} from "./artworkService";
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

export function getArtworkUrl(trackId: string): string | undefined {
  const url = urlCache.get(trackId);
  if (url !== undefined) {
    // Refresh LRU order on read
    urlCache.delete(trackId);
    urlCache.set(trackId, url);
  }
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

/**
 * Validates that a downloaded blob is a real, decodable image before it is
 * ever persisted or displayed.
 */
export async function validateArtworkBlob(blob: Blob): Promise<boolean> {
  if (blob.size < MIN_ARTWORK_BLOB_BYTES || blob.size > MAX_ARTWORK_BLOB_BYTES) return false;
  if (blob.type && !blob.type.startsWith("image/")) return false;

  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      bitmap.close();
      return true;
    } catch {
      return false;
    }
  }

  // Fallback decode path (environments without createImageBitmap)
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      URL.revokeObjectURL(objectUrl);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 5000);
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = objectUrl;
  });
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
 * IndexedDB for this track ID. Returns the validated `Blob` on success, or
 * `undefined` when the artwork could not be materialized.
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
 * Only creates an object URL when the track's cache entry still matches,
 * preventing orphaned object URL leaks.
 */
export function upgradeArtworkToPersisted(trackId: string, remoteUrl: string): void {
  if (!trackId || !remoteUrl || !remoteUrl.startsWith("http")) return;

  void persistRemoteArtworkBlob(trackId, remoteUrl)
    .then((blob) => {
      if (!blob) return;
      const current = urlCache.get(trackId);
      // Only mint and upgrade a blob URL if the cache still points at the same
      // remote URL (or was not yet populated for this track).
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
      //    materialized from a provider or cloud) — always works offline.
      try {
        const blob = await repository.getArtwork(trackId);
        if (blob) {
          const url = URL.createObjectURL(blob);
          insertUrlCache(trackId, url);
          notifyArtworkLoaded(trackId, url);
          perfMeasure("skip:artwork-work", `skip:artwork:start:${trackId}`, `skip:artwork:end:${trackId}`);
          return url;
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
      //    Never persist the short-lived signed URL: download, validate, and persist
      //    the image Blob into IndexedDB, then serve the local blob URL.
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
            // Persist a local copy in the background so future sessions and
            // offline playback never depend on the remote URL again.
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
    return; // Transient connectivity loss: keep cache, show theme fallback
  }

  const current = urlCache.get(trackId);
  if (current && current !== failedUrl) {
    return; // A different URL already replaced the failed one
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
      rememberRevokedBlobUrl(url);
      URL.revokeObjectURL(url);
    }
  }
  urlCache.clear();
  inFlightLoads.clear();
}

/**
 * Clears all in-memory state (used in unit tests). Does not touch IndexedDB.
 */
// ---- Missing artwork reload ----

export interface ReloadMissingArtworkProgress {
  done: number;
  total: number;
  restored: number;
}

export interface ReloadMissingArtworkResult {
  totalTracks: number;
  alreadyHaveArtwork: number;
  missingFound: number;
  restored: number;
  stillMissing: number;
  offline: boolean;
}

function clearAutoRetryForTrack(trackId: string): void {
  const prefix = `${trackId}::`;
  for (const key of Array.from(autoRetryLog.keys())) {
    if (key.startsWith(prefix)) autoRetryLog.delete(key);
  }
}

async function reloadSingleMissingTrack(track: Track): Promise<boolean> {
  if (getArtworkUrl(track.id)) return true;

  clearAutoRetryForTrack(track.id);
  if (typeof clearNegativeArtworkCacheForTrack === "function") {
    clearNegativeArtworkCacheForTrack(track);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const resolvedUrl = await loadArtworkUrl(track);
    if (!resolvedUrl) return false;
    if (resolvedUrl.startsWith("blob:")) return true;

    const blob = await persistRemoteArtworkBlob(track.id, resolvedUrl);
    if (blob) {
      const current = urlCache.get(track.id);
      if (current === resolvedUrl || current === undefined) {
        try {
          const blobUrl = URL.createObjectURL(blob);
          insertUrlCache(track.id, blobUrl);
          notifyArtworkLoaded(track.id, blobUrl);
        } catch {
          // Keep existing resolvedUrl if createObjectURL fails
        }
      }
      return true;
    }

    if (resolvedUrl.startsWith("http") && typeof markArtworkUrlFailed === "function") {
      markArtworkUrlFailed(resolvedUrl);
    }
    if (urlCache.get(track.id) === resolvedUrl) {
      urlCache.delete(track.id);
    }
    if (typeof invalidateArtworkCacheForTrack === "function") {
      invalidateArtworkCacheForTrack(track);
    }
    if (typeof clearNegativeArtworkCacheForTrack === "function") {
      clearNegativeArtworkCacheForTrack(track);
    }
  }

  notifyArtworkLoaded(track.id, undefined);
  return false;
}

/**
 * Reloads artwork ONLY for tracks that currently have neither a persisted
 * IndexedDB blob nor a cached in-memory artwork URL. Tracks that already have
 * artwork are left completely untouched.
 */
export async function reloadMissingArtwork(
  tracks: Track[],
  options?: { onProgress?: (progress: ReloadMissingArtworkProgress) => void },
): Promise<ReloadMissingArtworkResult> {
  if (tracks.length === 0) {
    return {
      totalTracks: 0,
      alreadyHaveArtwork: 0,
      missingFound: 0,
      restored: 0,
      stillMissing: 0,
      offline: false,
    };
  }

  let persistedIds: Set<string> | null = null;
  if (typeof repository.listArtworkTrackIds === "function") {
    persistedIds = await repository.listArtworkTrackIds().catch(() => null);
  }

  const missingTracks: Track[] = [];
  for (const track of tracks) {
    if (getArtworkUrl(track.id)) continue;

    if (persistedIds !== null) {
      if (persistedIds.has(track.id)) continue;
      missingTracks.push(track);
      continue;
    }

    const existingBlob = await repository.getArtwork(track.id).catch(() => undefined);
    if (existingBlob) continue;
    missingTracks.push(track);
  }

  const alreadyHaveArtwork = tracks.length - missingTracks.length;
  if (missingTracks.length === 0) {
    return {
      totalTracks: tracks.length,
      alreadyHaveArtwork,
      missingFound: 0,
      restored: 0,
      stillMissing: 0,
      offline: false,
    };
  }

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return {
      totalTracks: tracks.length,
      alreadyHaveArtwork,
      missingFound: missingTracks.length,
      restored: 0,
      stillMissing: missingTracks.length,
      offline: true,
    };
  }

  failedDownloadAt.clear();

  let cursor = 0;
  let done = 0;
  let restored = 0;
  const concurrency = Math.min(2, missingTracks.length);

  const runWorker = async () => {
    while (cursor < missingTracks.length) {
      const idx = cursor++;
      const track = missingTracks[idx];
      if (!track) continue;

      const ok = await reloadSingleMissingTrack(track).catch(() => false);
      if (ok) restored++;
      done++;
      options?.onProgress?.({ done, total: missingTracks.length, restored });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));

  return {
    totalTracks: tracks.length,
    alreadyHaveArtwork,
    missingFound: missingTracks.length,
    restored,
    stillMissing: missingTracks.length - restored,
    offline: false,
  };
}

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
}
