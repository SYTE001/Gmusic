import { extractClustersFromPixels } from "./extraction";
import { createFallbackPalette, selectSolidPalette } from "./legibility";
import type { LyricsPalette } from "./types";
import { loadArtworkUrl } from "../../../services/artwork/artworkCache";
import { getAlbumArtworkCacheKey } from "../../../services/artwork/artworkService";
import { repository } from "../../../services/indexeddb/LibraryRepository";
import type { Track } from "../../../types";

const MEMORY_CACHE = new Map<string, LyricsPalette>();
const MAX_MEMORY_ITEMS = 200;
const STORAGE_KEY = "gmusic_lyrics_solid_palette_v2";
const MAX_STORAGE_ITEMS = 100;
const CANVAS_SIZE = 32;

// Single reused 32x32 canvas to prevent DOM/GPU allocation churn during rapid skips
let sharedOffscreenCtx: OffscreenCanvasRenderingContext2D | null = null;
let sharedDomCtx: CanvasRenderingContext2D | null = null;

function getShared32x32Context(): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null {
  if (typeof OffscreenCanvas !== "undefined") {
    if (!sharedOffscreenCtx) {
      const offscreen = new OffscreenCanvas(CANVAS_SIZE, CANVAS_SIZE);
      sharedOffscreenCtx = offscreen.getContext("2d", { willReadFrequently: true });
    }
    if (sharedOffscreenCtx) return sharedOffscreenCtx;
  }
  if (typeof document !== "undefined") {
    if (!sharedDomCtx) {
      const canvas = document.createElement("canvas");
      canvas.width = CANVAS_SIZE;
      canvas.height = CANVAS_SIZE;
      sharedDomCtx = canvas.getContext("2d", { willReadFrequently: true });
    }
    return sharedDomCtx;
  }
  return null;
}

/**
 * Computes a collision-free cache key for a track's cover palette.
 * Uses the normalized album-or-track artwork key when available, falling back to `track.id`.
 */
export function getTrackPaletteKey(track: Track | null | undefined): string {
  if (!track) return "none";
  const key = getAlbumArtworkCacheKey({
    title: track.title,
    artist: track.artist,
    album: track.album,
  });
  return key || track.id;
}

function readStorageCache(): Record<string, LyricsPalette> {
  if (typeof window === "undefined" || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, LyricsPalette>) : {};
  } catch {
    return {};
  }
}

function writeStorageCache(cache: Record<string, LyricsPalette>): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore storage quota errors
  }
}

function isValidPersistedPalette(val: unknown): val is LyricsPalette {
  if (!val || typeof val !== "object") return false;
  const p = val as Partial<LyricsPalette>;
  return (
    typeof p.bg === "string" &&
    typeof p.lyricActive === "string" &&
    typeof p.lyricInactive === "string" &&
    typeof p.accent === "string" &&
    p.category !== "fallback"
  );
}

// Hydrate memory cache from storage on startup
try {
  const persisted = readStorageCache();
  for (const [key, val] of Object.entries(persisted)) {
    if (isValidPersistedPalette(val)) {
      MEMORY_CACHE.set(key, val);
    }
  }
} catch {
  // Ignore hydration failures
}

export function getCachedPalette(coverKey: string): LyricsPalette | undefined {
  if (!coverKey) return undefined;
  return MEMORY_CACHE.get(coverKey);
}

export function setCachedPalette(coverKey: string, palette: LyricsPalette): void {
  // Never persist fallback palettes into the cache so transient load delays never poison future plays
  if (!coverKey || !palette || palette.category === "fallback") return;

  if (!MEMORY_CACHE.has(coverKey) && MEMORY_CACHE.size >= MAX_MEMORY_ITEMS) {
    const firstKey = MEMORY_CACHE.keys().next().value;
    if (firstKey !== undefined) MEMORY_CACHE.delete(firstKey);
  }
  MEMORY_CACHE.set(coverKey, palette);

  try {
    const stored = readStorageCache();
    stored[coverKey] = palette;
    const keys = Object.keys(stored);
    if (keys.length > MAX_STORAGE_ITEMS) {
      delete stored[keys[0]];
    }
    writeStorageCache(stored);
  } catch {
    // Ignore storage errors
  }
}

export function clearPaletteCache(): void {
  MEMORY_CACHE.clear();
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
  }
}

/**
 * Extracts a 32x32 pixel buffer from a track's embedded artwork Blob or image URL
 * and produces a contrast-verified solid LyricsPalette.
 */
export async function extractPaletteFromImageUrl(
  imageUrl: string | undefined,
  coverKey: string,
  trackId?: string,
): Promise<LyricsPalette> {
  const cached = getCachedPalette(coverKey);
  if (cached) return cached;

  try {
    let pixels: Uint8ClampedArray | null = null;

    // 1. Prefer reading the local embedded Blob directly from IndexedDB when available
    // (avoids CORS canvas taint and unnecessary network/URL roundtrips)
    if (trackId) {
      try {
        const blob = await repository.getArtwork(trackId);
        if (blob) {
          pixels = await load32x32PixelsFromBlob(blob);
        }
      } catch {
        // Proceed to imageUrl extraction
      }
    }

    // 2. Extract from imageUrl if no blob pixels were obtained
    if ((!pixels || pixels.length === 0) && imageUrl) {
      pixels = await load32x32Pixels(imageUrl);
    }

    if (!pixels || pixels.length === 0) {
      return createFallbackPalette(coverKey);
    }

    const clusters = extractClustersFromPixels(pixels);
    if (clusters.length === 0) {
      return createFallbackPalette(coverKey);
    }

    const palette = selectSolidPalette(clusters, coverKey);
    setCachedPalette(coverKey, palette);
    return palette;
  } catch {
    return createFallbackPalette(coverKey);
  }
}

async function load32x32PixelsFromBlob(blob: Blob): Promise<Uint8ClampedArray | null> {
  try {
    const ctx = getShared32x32Context();
    if (!ctx) return null;

    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(blob, {
          resizeWidth: CANVAS_SIZE,
          resizeHeight: CANVAS_SIZE,
          resizeQuality: "low",
        });
        ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
        ctx.drawImage(bitmap, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
        bitmap.close();
        return ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;
      } catch {
        // Fall through to object URL
      }
    }

    if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      const tempUrl = URL.createObjectURL(blob);
      try {
        return await load32x32Pixels(tempUrl);
      } finally {
        URL.revokeObjectURL(tempUrl);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Loads image downscaled directly to 32x32 pixels onto a reused canvas.
 */
async function load32x32Pixels(url: string): Promise<Uint8ClampedArray | null> {
  return new Promise((resolve) => {
    if (!url || typeof Image === "undefined") {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => {
      resolve(null);
    }, 1500);

    const img = new Image();
    if (!url.startsWith("blob:") && !url.startsWith("data:")) {
      img.crossOrigin = "anonymous";
    }
    img.decoding = "async";

    img.onload = () => {
      clearTimeout(timer);
      const drawAndRead = async () => {
        try {
          const ctx = getShared32x32Context();
          if (!ctx) {
            resolve(null);
            return;
          }

          ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

          if (typeof createImageBitmap === "function") {
            try {
              const bitmap = await createImageBitmap(img, {
                resizeWidth: CANVAS_SIZE,
                resizeHeight: CANVAS_SIZE,
                resizeQuality: "low",
              });
              ctx.drawImage(bitmap, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
              bitmap.close();
              resolve(ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data);
              return;
            } catch {
              // Fallback to direct drawImage below
            }
          }

          ctx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
          resolve(ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data);
        } catch {
          resolve(null);
        }
      };

      void drawAndRead();
    };

    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };

    img.src = url;
  });
}

/**
 * Schedules background palette precomputation for the next track in queue during idle time.
 */
export function scheduleNextTrackPrecompute(track: Track): void {
  if (!track) return;
  const coverKey = getTrackPaletteKey(track);
  if (getCachedPalette(coverKey)) return;

  const runTask = () => {
    void loadArtworkUrl(track).then((artworkUrl) => {
      if (artworkUrl) {
        void extractPaletteFromImageUrl(artworkUrl, coverKey, track.id);
      }
    });
  };

  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    (window as Window & { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(runTask);
  } else {
    setTimeout(runTask, 500);
  }
}
