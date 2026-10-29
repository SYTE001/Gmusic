import { useEffect, useRef, useState } from "react";
import { repository } from "../services/indexeddb/LibraryRepository";
import { useLibraryStore } from "../stores/libraryStore";
import { resolveArtworkForTrack } from "../services/artwork/artworkService";
import type { Track } from "../types";
import { MusicNoteIcon } from "./Icons";

/**
 * Artwork rendering with a bounded object-URL cache and iTunes online fallback.
 * Object URLs are revoked when evicted (rules §12: release object URLs, bound decode dimensions).
 * External URLs (such as iTunes Search API art) are never revoked with URL.revokeObjectURL.
 */

const urlCache = new Map<string, string>();
const inFlightLoads = new Map<string, Promise<string | undefined>>();
const MAX_CACHE = 240;
const artworkListeners = new Set<(trackId: string, url: string | undefined) => void>();

export function subscribeArtwork(listener: (trackId: string, url: string | undefined) => void): () => void {
  artworkListeners.add(listener);
  return () => {
    artworkListeners.delete(listener);
  };
}

function notifyArtworkLoaded(trackId: string, url: string | undefined): void {
  for (const listener of artworkListeners) {
    try {
      listener(trackId, url);
    } catch {
      // Ignore listener errors
    }
  }
}

export function getArtworkUrl(trackId: string): string | undefined {
  return urlCache.get(trackId);
}

export async function loadArtworkUrl(trackOrId: string | Track): Promise<string | undefined> {
  const trackId = typeof trackOrId === "string" ? trackOrId : trackOrId?.id;
  if (!trackId) return undefined;

  const cached = urlCache.get(trackId);
  if (cached) return cached;

  const existingPromise = inFlightLoads.get(trackId);
  if (existingPromise) return existingPromise;

  const loadPromise = (async (): Promise<string | undefined> => {
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
          return url;
        }
      } catch {
        // IndexedDB error, fall through to iTunes lookup
      }

      // 2. Online iTunes artwork lookup for tracks without embedded artwork
      const trackObj =
        typeof trackOrId === "object" && trackOrId !== null
          ? trackOrId
          : useLibraryStore.getState().tracks.find((t) => t.id === trackId);

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

export function clearArtworkCache(): void {
  for (const url of urlCache.values()) {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
  urlCache.clear();
  inFlightLoads.clear();
  dominantColors.clear();
}

type ArtworkProps = {
  trackId: string | null | undefined;
  alt: string;
  className?: string;
  rounded?: string;
};

export function useArtworkUrl(trackOrId: Track | string | null | undefined): string | undefined {
  const trackId = typeof trackOrId === "string" ? trackOrId : trackOrId?.id;
  const trackOrIdRef = useRef(trackOrId);
  trackOrIdRef.current = trackOrId;
  const [url, setUrl] = useState<string | undefined>(() => (trackId ? urlCache.get(trackId) : undefined));

  useEffect(() => {
    const currentInput = trackOrIdRef.current;
    if (!trackId || !currentInput) {
      setUrl(undefined);
      return;
    }

    const existing = urlCache.get(trackId);
    if (existing) {
      setUrl(existing);
      return;
    }

    const unsubscribe = subscribeArtwork((id, loadedUrl) => {
      if (id === trackId) {
        setUrl(loadedUrl);
      }
    });

    void loadArtworkUrl(currentInput);

    return () => {
      unsubscribe();
    };
  }, [trackId]);

  return url;
}

export function Artwork({ trackId, alt, className, rounded = "rounded-lg" }: ArtworkProps) {
  const url = useArtworkUrl(trackId);

  if (!url) {
    return (
      <div
        className={`flex items-center justify-center bg-surface-raised text-text-muted ${rounded} ${className ?? ""}`}
        role="img"
        aria-label={`${alt} — no artwork`}
      >
        <MusicNoteIcon size={22} />
      </div>
    );
  }
  return <img src={url} alt={alt} loading="lazy" decoding="async" className={`object-cover ${rounded} ${className ?? ""}`} />;
}

/**
 * Low-saturation dominant colors for artwork-derived tints (PRD §8.2: artwork
 * tints are dynamic accents, never the whole UI). Both theme variants are
 * computed once per track: dark themes get a darkened tint, light themes a
 * lightened pastel — so lyric text keeps its contrast in either theme.
 */
const dominantColors = new Map<string, { dark: string; light: string }>();

export async function getDominantColor(trackId: string, fallbackDark: string, fallbackLight: string): Promise<{ dark: string; light: string }> {
  const cached = dominantColors.get(trackId);
  if (cached) return cached;
  const url = urlCache.get(trackId) ?? (await loadArtworkUrl(trackId));
  if (!url) return { dark: fallbackDark, light: fallbackLight };
  try {
    const image = new Image();
    image.decoding = "async";
    const loaded = new Promise<boolean>((resolve) => {
      image.onload = () => resolve(true);
      image.onerror = () => resolve(false);
    });
    image.src = url;
    if (!(await loaded)) return { dark: fallbackDark, light: fallbackLight };
    const size = 16;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return { dark: fallbackDark, light: fallbackLight };
    context.drawImage(image, 0, 0, size, size);
    const { data } = context.getImageData(0, 0, size, size);
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha < 128) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count += 1;
    }
    if (count === 0) return { dark: fallbackDark, light: fallbackLight };
    r = Math.round(r / count);
    g = Math.round(g / count);
    b = Math.round(b / count);
    // Desaturate toward gray, then adapt per theme: darken for dark themes,
    // lighten toward a pastel for light themes so muted text stays readable.
    const gray = r * 0.299 + g * 0.587 + b * 0.114;
    const desat = (channel: number) => Math.round(channel * 0.45 + gray * 0.55);
    const dark = `rgb(${Math.round(desat(r) * 0.5)}, ${Math.round(desat(g) * 0.5)}, ${Math.round(desat(b) * 0.55)})`;
    const light = `rgb(${Math.round(desat(r) * 0.18 + 255 * 0.82)}, ${Math.round(desat(g) * 0.18 + 255 * 0.82)}, ${Math.round(desat(b) * 0.2 + 255 * 0.8)})`;
    const pair = { dark, light };
    dominantColors.set(trackId, pair);
    return pair;
  } catch {
    return { dark: fallbackDark, light: fallbackLight };
  }
}
