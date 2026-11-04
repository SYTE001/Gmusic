import { repository } from "../indexeddb/LibraryRepository";
import { invalidateArtworkCacheForTrack, resolveArtworkForTrack } from "./artworkService";
import type { Track } from "../../types";
import { perfMark, perfMeasure } from "../../utils/perf";

/**
 * In-memory artwork cache with bounded object URLs and event listeners.
 * Object URLs are revoked when evicted. External URLs are not revoked.
 */
const urlCache = new Map<string, string>();
const inFlightLoads = new Map<string, Promise<string | undefined>>();
const MAX_CACHE = 240;

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

export function setCachedArtworkForTrack(trackId: string, url: string): void {
  if (!trackId || !url) return;
  if (!urlCache.has(trackId) && urlCache.size >= MAX_CACHE) {
    const oldest = urlCache.keys().next().value;
    if (oldest !== undefined) {
      const evicted = urlCache.get(oldest);
      urlCache.delete(oldest);
      if (evicted && evicted.startsWith("blob:")) URL.revokeObjectURL(evicted);
    }
  }
  urlCache.set(trackId, url);
  notifyArtworkLoaded(trackId, url);
}

export function getArtworkUrl(trackId: string): string | undefined {
  return urlCache.get(trackId);
}

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
      // 1. Check embedded artwork in IndexedDB
      try {
        const blob = await repository.getArtwork(trackId);
        if (blob) {
          if (urlCache.size >= MAX_CACHE) {
            const oldest = urlCache.keys().next().value;
            if (oldest !== undefined) {
              const evicted = urlCache.get(oldest);
              urlCache.delete(oldest);
              if (evicted && evicted.startsWith("blob:")) URL.revokeObjectURL(evicted);
            }
          }
          const url = URL.createObjectURL(blob);
          urlCache.set(trackId, url);
          notifyArtworkLoaded(trackId, url);
          perfMeasure("skip:artwork-work", `skip:artwork:start:${trackId}`, `skip:artwork:end:${trackId}`);
          return url;
        }
      } catch {
        // IndexedDB error, fall through to online lookup
      }

      // 2. Online artwork lookup for tracks without embedded artwork
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
            urlCache.set(trackId, res.url);
            notifyArtworkLoaded(trackId, res.url);
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

export async function invalidateArtworkForTrackId(trackId: string): Promise<void> {
  urlCache.delete(trackId);
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
