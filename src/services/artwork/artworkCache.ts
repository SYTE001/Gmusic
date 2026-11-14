import { repository } from "../indexeddb/LibraryRepository";
import { invalidateArtworkCacheForTrack, resolveArtworkForTrack } from "./artworkService";
import type { Track } from "../../types";
import { perfMark, perfMeasure } from "../../utils/perf";

/**
 * In-memory artwork URL cache keyed by stable track ID, with bounded object
 * URLs and event listeners. Object URLs are revoked when evicted (delayed, so
 * already-painted images never break); external URLs are never revoked.
 *
 * Remote artwork resolved from providers is additionally materialized into a
 * validated Blob and persisted to IndexedDB (`repository.putArtwork`), so
 * artwork keeps working offline and across refreshes without re-downloading.
 */
const urlCache = new Map<string, string>();
const inFlightLoads = new Map<string, Promise<string | undefined>>();
const MAX_CACHE = 240;
/** Delay before an evicted blob URL is revoked so in-flight paints finish. */
const EVICTED_BLOB_REVOKE_DELAY_MS = 60_000;

type ArtworkListener = (trackId: string, url: string | undefined) => void;
type TrackArtworkListener = (url: string | undefined) => void;

const globalArtworkListeners = new Set<ArtworkListener>();
const trackArtworkListeners = new Map<string, Set<TrackArtworkListener>>();

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

function scheduleRevokeObjectUrl(url: string): void {
  const timer = setTimeout(() => URL.revokeObjectURL(url), EVICTED_BLOB_REVOKE_DELAY_MS);
  const unref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(timer);
}

function evictOldestUrlCacheEntry(): void {
  const oldest = urlCache.keys().next().value;
  if (oldest === undefined) return;
  const evicted = urlCache.get(oldest);
  urlCache.delete(oldest);
  if (evicted && evicted.startsWith("blob:")) {
    scheduleRevokeObjectUrl(evicted);
  }
}

/** Bounded insert: evicts (and delayed-revokes) the oldest entry when full. */
function insertUrlCache(trackId: string, url: string): void {
  if (!trackId || !url) return;
  if (!urlCache.has(trackId) && urlCache.size >= MAX_CACHE) {
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
  return urlCache.get(trackId);
}

// ---- Remote-to-blob materialization (persistent local artwork cache) ----

const MAX_ARTWORK_BLOB_BYTES = 5 * 1024 * 1024;
const MIN_ARTWORK_BLOB_BYTES = 64;
const ARTWORK_DOWNLOAD_TIMEOUT_MS = 10_000;
/** Remember failed downloads briefly so one broken URL is not retried in a loop. */
const FAILED_DOWNLOAD_TTL_MS = 5 * 60_000;

const inFlightBlobDownloads = new Map<string, Promise<Blob | null>>();
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
 * IndexedDB for this track ID. Returns a displayable object URL on success,
 * or `undefined` when the artwork could not be materialized (the caller keeps
 * using the remote URL — never blocks or breaks display).
 */
async function materializeAndPersistArtwork(trackId: string, remoteUrl: string): Promise<string | undefined> {
  const blob = await fetchArtworkBlobDeduped(remoteUrl);
  if (!blob) return undefined;
  try {
    await repository.putArtwork(trackId, blob);
  } catch {
    return undefined; // Quota/IDB failure: honest fallback to the remote URL
  }
  try {
    return URL.createObjectURL(blob);
  } catch {
    return undefined;
  }
}

/**
 * Schedules background persistence of a resolved remote artwork URL for a
 * track. Non-blocking: display keeps the remote URL and is upgraded to the
 * persisted blob (with a listener notification) once the download succeeds.
 */
export function upgradeArtworkToPersisted(trackId: string, remoteUrl: string): void {
  if (!trackId || !remoteUrl || !remoteUrl.startsWith("http")) return;

  void materializeAndPersistArtwork(trackId, remoteUrl)
    .then((blobUrl) => {
      // Only upgrade if the cache entry still points at the same remote URL
      // (a newer resolution or invalidation may have happened meanwhile).
      if (blobUrl && getArtworkUrl(trackId) === remoteUrl) {
        insertUrlCache(trackId, blobUrl);
        notifyArtworkLoaded(trackId, blobUrl);
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

  const cached = urlCache.get(trackId);
  if (cached) return cached;

  const existingPromise = inFlightLoads.get(trackId);
  if (existingPromise) return existingPromise;

  const loadPromise = (async (): Promise<string | undefined> => {
    perfMark(`skip:artwork:start:${trackId}`);
    try {
      // 1. Check persisted artwork blob in IndexedDB (embedded or previously
      //    materialized from a provider) — always works offline.
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
        // IndexedDB error, fall through to online lookup
      }

      // 2. Online artwork lookup for tracks without persisted artwork
      const trackObj =
        typeof trackOrId === "object" && trackOrId !== null
          ? trackOrId
          : customTrackLookup
            ? customTrackLookup(trackId)
            : await repository.getTrack(trackId).catch(() => undefined);

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
 * - Online: if the failed URL is still the current one, invalidate exactly
 *   once (deleting a corrupt persisted blob for blob URLs) and re-resolve.
 *   A cooldown prevents infinite invalidate/retry loops for permanently
 *   broken URLs.
 */
export async function handleArtworkImageError(trackId: string | null | undefined, failedUrl: string): Promise<void> {
  if (!trackId || !failedUrl) return;

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return; // Transient connectivity loss: keep cache, show theme fallback
  }

  const current = getArtworkUrl(trackId);
  if (current && current !== failedUrl) {
    return; // A different URL already replaced the failed one
  }

  const retryKey = `${trackId}::${failedUrl}`;
  const now = Date.now();
  const lastRetry = autoRetryLog.get(retryKey);
  if (lastRetry !== undefined && now - lastRetry < AUTO_RETRY_COOLDOWN_MS) {
    return;
  }
  autoRetryLog.set(retryKey, now);
  pruneMapOldest(autoRetryLog, 300);

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
    scheduleRevokeObjectUrl(evicted);
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

export function clearArtworkCache(): void {
  for (const url of urlCache.values()) {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
  urlCache.clear();
  inFlightLoads.clear();
}

/**
 * Clears all in-memory state (used in unit tests). Does not touch IndexedDB.
 */
export function __resetArtworkCacheForTests(): void {
  urlCache.clear();
  inFlightLoads.clear();
  inFlightBlobDownloads.clear();
  failedDownloadAt.clear();
  autoRetryLog.clear();
  globalArtworkListeners.clear();
  trackArtworkListeners.clear();
}
