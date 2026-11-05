import { extractClustersFromPixels, selectDistinctClusters } from "./extraction";
import { enforceLegibility, createFallbackPalette } from "./legibility";
import { selectPreset } from "./presets";
import type { BackgroundTier, LyricsPalette } from "./types";
import { loadArtworkUrl } from "../../../services/artwork/artworkCache";
import type { Track } from "../../../types";

const MEMORY_CACHE = new Map<string, LyricsPalette>();
const MAX_MEMORY_ITEMS = 200;
const STORAGE_KEY = "gmusic_lyrics_palette_cache";
const TIER_STORAGE_KEY = "gmusic_lyrics_bg_tier";
const MAX_STORAGE_ITEMS = 100;
const CANVAS_SIZE = 32;

// Single reused 32x32 canvas to prevent DOM/GPU allocation churn during rapid skips (PRD §7, §8.8)
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
 * Capability detection for the 3-tier system (`full` | `lite` | `static`, PRD §8.1).
 * Degrades by default on low-spec hardware and remembers automatic step-downs.
 */
export function detectInitialTier(): BackgroundTier {
  if (typeof window !== "undefined") {
    try {
      const saved = window.localStorage?.getItem(TIER_STORAGE_KEY);
      if (saved === "full" || saved === "lite" || saved === "static") {
        return saved;
      }
    } catch {
      // Ignore storage access errors
    }

    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return "static";
    }
  }

  if (typeof navigator !== "undefined") {
    const cores = navigator.hardwareConcurrency ?? 8;
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
    if (cores <= 2 || memory <= 2) {
      return "static";
    }
    if (cores <= 4 || memory <= 4) {
      return "lite";
    }
  }

  return "full";
}

/**
 * Steps down one performance tier (`full` -> `lite` -> `static`) and persists the choice (PRD §8.1).
 */
export function stepDownTier(current: BackgroundTier): BackgroundTier {
  const next: BackgroundTier = current === "full" ? "lite" : "static";
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem(TIER_STORAGE_KEY, next);
    } catch {
      // Ignore storage quota/permission errors
    }
  }
  return next;
}

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

  if (!MEMORY_CACHE.has(coverKey) && MEMORY_CACHE.size >= MAX_MEMORY_ITEMS) {
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
 * Runs non-blocking using ImageBitmap or shared 32x32 canvas (PRD §4.1, §8.8).
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
 * Loads image downscaled directly to 32x32 pixels onto a reused canvas,
 * never decoding at full size on the main thread when ImageBitmap resize is supported (PRD §4.1, §8.4, §8.8).
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
              // Fallback to direct drawImage below if resize options unsupported
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
 * Schedules background palette precomputation for the next track during idle time (PRD §4.1).
 */
export function scheduleNextTrackPrecompute(track: Track): void {
  if (!track) return;
  const coverKey = track.album ? `${track.album}-${track.artist}` : track.id;
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
