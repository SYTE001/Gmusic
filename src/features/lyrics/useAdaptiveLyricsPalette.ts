import { useEffect, useRef, useState } from "react";
import type { Track } from "../../types";
import { useArtworkUrl } from "../../components/Artwork";
import { usePlaybackStore } from "../../stores/playbackStore";
import { useLibraryStore } from "../../stores/libraryStore";
import {
  createFallbackPalette,
  extractPaletteFromImageUrl,
  getCachedPalette,
  getTrackPaletteKey,
  scheduleNextTrackPrecompute,
  type LyricsPalette,
} from "./palette";

/** Debounce delay (ms) when rapidly skipping tracks so only the settled track extracts. */
const SKIP_DEBOUNCE_MS = 150;

/**
 * Resolves a contrast-verified solid album palette for Stage 2 (album + lyrics).
 *
 * - Returns cached album palette synchronously when switching songs on the same album.
 * - Re-runs extraction when async `artworkUrl` finishes loading so the initial
 *   `artworkUrl === undefined` render never permanently locks in the fallback color.
 * - Debounces uncached extraction by 150ms during rapid track skipping.
 * - Precomputes the next queued track's palette in idle time.
 */
export function useAdaptiveLyricsPalette(
  track: Track | null | undefined,
  enabled: boolean,
): LyricsPalette {
  const artworkUrl = useArtworkUrl(track ?? undefined);
  const coverKey = getTrackPaletteKey(track);

  const [palette, setPalette] = useState<LyricsPalette>(() => {
    if (!enabled || !track) return createFallbackPalette(coverKey);
    return getCachedPalette(coverKey) ?? createFallbackPalette(coverKey);
  });

  // Track which coverKey + non-fallback status is currently applied
  const appliedRef = useRef<{ key: string; isFallback: boolean }>({
    key: palette.coverKey,
    isFallback: palette.category === "fallback",
  });

  useEffect(() => {
    if (!enabled || !track) return;

    const cached = getCachedPalette(coverKey);
    if (cached) {
      if (appliedRef.current.key !== coverKey || appliedRef.current.isFallback) {
        appliedRef.current = { key: coverKey, isFallback: false };
        setPalette(cached);
      }
      return;
    }

    // If coverKey changed and we don't have a cached palette yet, show fallback while extracting
    if (appliedRef.current.key !== coverKey) {
      const fb = createFallbackPalette(coverKey);
      appliedRef.current = { key: coverKey, isFallback: true };
      setPalette(fb);
    }

    let cancelled = false;
    const trackId = track.id;

    const timer = setTimeout(() => {
      void extractPaletteFromImageUrl(artworkUrl, coverKey, trackId).then((resolved) => {
        if (cancelled) return;
        appliedRef.current = {
          key: coverKey,
          isFallback: resolved.category === "fallback",
        };
        setPalette(resolved);
      });
    }, SKIP_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, track, coverKey, artworkUrl]);

  // Precompute palette for the next track in queue when idle
  const queueTrackIds = usePlaybackStore((s) => s.queueTrackIds);
  const queueIndex = usePlaybackStore((s) => s.queueIndex);
  const tracks = useLibraryStore((s) => s.tracks);

  useEffect(() => {
    if (!enabled || queueTrackIds.length <= 1) return;
    const nextIdx = (queueIndex + 1) % queueTrackIds.length;
    const nextTrackId = queueTrackIds[nextIdx];
    if (!nextTrackId || nextTrackId === track?.id) return;
    const nextTrack = tracks.find((t) => t.id === nextTrackId);
    if (!nextTrack) return;

    const nextKey = getTrackPaletteKey(nextTrack);
    if (nextKey === coverKey) return; // Same album as current track — skip!

    scheduleNextTrackPrecompute(nextTrack);
  }, [enabled, queueTrackIds, queueIndex, tracks, track?.id, coverKey]);

  return palette;
}
