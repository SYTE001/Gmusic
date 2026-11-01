import { useEffect, useState } from "react";
import { useArtworkUrl } from "../../components/Artwork";
import { useSettingsStore } from "../../stores/settingsStore";
import fallbackLightUrl from "../../assets/lyrics-fallback-light.webp";
import fallbackDarkUrl from "../../assets/lyrics-fallback-dark.webp";

/**
 * Source resolution for the lyrics ambient background (priority order):
 * the playing track's artwork first, theme-matched supplied fallbacks second.
 * Artwork is validated by actually decoding it — a missing, broken, or empty
 * image never reaches the background pipeline.
 */

export type AmbientTheme = "light" | "dark";

export type AmbientSource =
  | { kind: "artwork"; image: HTMLImageElement }
  | { kind: "fallback"; image: HTMLImageElement };

export const FALLBACK_URLS: Record<AmbientTheme, string> = {
  light: fallbackLightUrl,
  dark: fallbackDarkUrl,
};

/**
 * Same semantics as the global reduced-motion handling in base.css: the OS
 * preference applies unless the in-app override on <html data-motion> says
 * otherwise ("on" forces reduction, "off" forces motion).
 */
export function reducedMotionActive(): boolean {
  const override = document.documentElement.dataset.motion;
  if (override === "on") return true;
  if (override === "off") return false;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export type LyricsAmbient = {
  /** Decoded artwork for the current track, or null when unavailable/broken. */
  artworkImage: HTMLImageElement | null;
  /** Decoded fallback for the active theme, or null while it decodes. */
  fallbackImage: HTMLImageElement | null;
  theme: AmbientTheme;
  reducedMotion: boolean;
};

/**
 * Decodes a URL into an HTMLImageElement, resolving to null on failure so a
 * broken source can fall through to the next background priority.
 */
function decodeImage(url: string, onSettled: (image: HTMLImageElement | null) => void): () => void {
  let cancelled = false;
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.decoding = "async";
  const settle = (ok: boolean) => {
    if (!cancelled) onSettled(ok ? image : null);
  };
  image.onload = () => settle(true);
  image.onerror = () => settle(false);
  image.src = url;
  if (image.complete) settle(image.naturalWidth > 0);
  return () => {
    cancelled = true;
  };
}

/**
 * Reads everything the ambient background needs without per-frame React
 * work: the track's artwork URL (existing artwork cache), the decoded
 * fallback asset for the resolved theme, and the live reduced-motion
 * preference (OS setting plus the in-app data-motion override).
 */
export function useLyricsAmbient(trackId: string | null | undefined): LyricsAmbient {
  const artworkUrl = useArtworkUrl(trackId ?? null);
  const theme = useSettingsStore((state) => state.resolvedTheme);
  const [reducedMotion, setReducedMotion] = useState(reducedMotionActive);
  const [artworkImage, setArtworkImage] = useState<HTMLImageElement | null>(null);
  const [fallbackImages, setFallbackImages] = useState<Partial<Record<AmbientTheme, HTMLImageElement>>>({});

  // Follow the OS preference and the in-app override while mounted. The
  // settings page flips data-motion directly, so observe the attribute too.
  useEffect(() => {
    const update = () => setReducedMotion(reducedMotionActive());
    update();
    const media =
      typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    media?.addEventListener("change", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
    return () => {
      media?.removeEventListener("change", update);
      observer.disconnect();
    };
  }, []);

  // Decode the artwork once per URL. While a new URL loads, the previous
  // image is kept so the component can crossfade from it instead of flashing.
  useEffect(() => {
    if (!artworkUrl) {
      setArtworkImage(null);
      return;
    }
    return decodeImage(artworkUrl, setArtworkImage);
  }, [artworkUrl]);

  // The fallbacks are tiny static assets; decode both once and reuse them
  // for every theme switch (no network, no re-decode, no flashing).
  useEffect(() => {
    const cleanups = (Object.keys(FALLBACK_URLS) as AmbientTheme[]).map((key) =>
      decodeImage(FALLBACK_URLS[key], (image) => {
        if (image) setFallbackImages((prev) => ({ ...prev, [key]: image }));
      }),
    );
    return () => cleanups.forEach((cleanup) => cleanup());
  }, []);

  return { artworkImage, fallbackImage: fallbackImages[theme] ?? null, theme, reducedMotion };
}
