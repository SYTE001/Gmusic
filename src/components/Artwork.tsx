import { useEffect, useRef, useState } from "react";
import type { Track } from "../types";
import { MusicNoteIcon } from "./Icons";
import {
  clearArtworkCache,
  getArtworkUrl,
  handleArtworkImageError,
  loadArtworkUrl,
  notifyArtworkLoaded,
  setCachedArtworkForTrack,
  subscribeArtwork,
} from "../services/artwork/artworkCache";

export {
  clearArtworkCache,
  getArtworkUrl,
  loadArtworkUrl,
  notifyArtworkLoaded,
  setCachedArtworkForTrack,
  subscribeArtwork,
};

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
  const [loaded, setLoaded] = useState<{ trackId: string | undefined; url: string | undefined }>(() => ({
    trackId,
    url: trackId ? getArtworkUrl(trackId) : undefined,
  }));

  useEffect(() => {
    const currentInput = trackOrIdRef.current;
    if (!trackId || !currentInput) {
      setLoaded({ trackId: undefined, url: undefined });
      return;
    }

    const existing = getArtworkUrl(trackId);
    if (existing) {
      setLoaded({ trackId, url: existing });
      return;
    }

    setLoaded({ trackId, url: undefined });

    const unsubscribe = subscribeArtwork(trackId, (loadedUrl) => {
      setLoaded({ trackId, url: loadedUrl });
    });

    void loadArtworkUrl(currentInput);

    return () => {
      unsubscribe();
    };
  }, [trackId]);

  if (!trackId) return undefined;
  if (loaded.trackId === trackId) return loaded.url;
  return getArtworkUrl(trackId);
}

export function Artwork({ trackId, alt, className, rounded = "rounded-lg" }: ArtworkProps) {
  const url = useArtworkUrl(trackId);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  // A failure only applies to the URL that failed; never suppress a new URL
  // (including a retry of the same track through a different source).
  useEffect(() => {
    setFailedUrl(null);
  }, [url]);

  if (!url || failedUrl === url) {
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
  return (
    <img
      src={url}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => {
        setFailedUrl(url);
        if (trackId) {
          void handleArtworkImageError(trackId, url);
        }
      }}
      className={`object-cover ${rounded} ${className ?? ""}`}
    />
  );
}
