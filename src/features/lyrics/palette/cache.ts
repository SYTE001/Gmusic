import { extractClustersFromPixels, selectDistinctClusters } from "./extraction";
import { enforceLegibility, createFallbackPalette } from "./legibility";
import { selectPreset } from "./presets";
import type { LyricsPalette } from "./types";
import { loadArtworkUrl } from "../../../services/artwork/artworkCache";
import type { Track } from "../../../types";

const MEMORY_CACHE = new Map<string, LyricsPalette>();
const MAX_MEMORY_ITEMS = 200;
const STORAGE_KEY = "gmusic_lyrics_palette_cache";
const MAX_STORAGE_ITEMS = 100;

// Load persistent cache from localStorage on startup
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

// Hydrate memory cache from storage
try {
  const persisted = readStorageCache();
  for (const [key, val] of Object.entries(persisted)) {
    MEMORY_CACHE.set(key, val);
  }
} catch {
  // Ignore hydration failures
}

export function getCachedPalette(coverKey: string): LyricsPalette | undefined {
  if (!coverKey) return undefined;
  return MEMORY_CACHE.get(coverKey);
}

export function setCachedPalette(coverKey: string, palette: LyricsPalette): void {
  if (!coverKey || !palette) return;

  if (MEMORY_CACHE.size >= MAX_MEMORY_ITEMS) {
    const firstKey = MEMORY_CACHE.keys().next().value;
    if (firstKey !== undefined) MEMORY_CACHE.delete(firstKey);
  }
  MEMORY_CACHE.set(coverKey, palette);

  // Persist asynchronously
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

/**
 * Extracts a 32x32 pixel buffer from an image URL and produces an enforced LyricsPalette.
 * Runs non-blocking using ImageBitmap or OffscreenCanvas/HTMLCanvasElement (PRD §4.1).
 */
export async function extractPaletteFromImageUrl(
  imageUrl: string,
  coverKey: string,
): Promise<LyricsPalette> {
  const cached = getCachedPalette(coverKey);
  if (cached) return cached;

  try {
    const pixels = await load32x32Pixels(imageUrl);
    if (!pixels || pixels.length === 0) {
      const fallback = createFallbackPalette(coverKey);
      setCachedPalette(coverKey, fallback);
      return fallback;
    }

    const rawClusters = extractClustersFromPixels(pixels);
    const distinct = selectDistinctClusters(rawClusters);
    const preset = selectPreset(distinct);
    const palette = enforceLegibility(distinct, preset, coverKey);

    setCachedPalette(coverKey, palette);
    return palette;
  } catch {
    const fallback = createFallbackPalette(coverKey);
    setCachedPalette(coverKey, fallback);
    return fallback;
  }
}

/**
 * Loads image downscaled directly to 32x32 pixels, never decoding at full size on DOM (PRD §4.1).
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
    img.crossOrigin = "anonymous";
    img.decoding = "async";

    img.onload = () => {
      clearTimeout(timer);
      try {
        const size = 32;
        let pixels: Uint8ClampedArray | null = null;

        if (typeof OffscreenCanvas !== "undefined") {
          const offscreen = new OffscreenCanvas(size, size);
          const ctx = offscreen.getContext("2d", { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(img, 0, 0, size, size);
            pixels = ctx.getImageData(0, 0, size, size).data;
          }
        }

        if (!pixels && typeof document !== "undefined") {
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(img, 0, 0, size, size);
            pixels = ctx.getImageData(0, 0, size, size).data;
          }
        }

        resolve(pixels);
      } catch {
        resolve(null);
      }
    };

    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };

    img.src = url;
  });
}

/**
 * Schedules background palette precomputation for the next track during idle time (PRD §4.1).
 */
export function scheduleNextTrackPrecompute(track: Track): void {
  if (!track) return;
  const coverKey = track.id;
  if (getCachedPalette(coverKey)) return;

  const runTask = () => {
    void loadArtworkUrl(track).then((artworkUrl) => {
      if (artworkUrl) {
        void extractPaletteFromImageUrl(artworkUrl, coverKey);
      }
    });
  };

  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    (window as Window & { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(runTask);
  } else {
    setTimeout(runTask, 500);
  }
}
