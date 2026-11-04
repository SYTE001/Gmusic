import { useEffect, useRef, useState } from "react";
import type { Track } from "../types";
import { MusicNoteIcon } from "./Icons";
import {
  clearArtworkCache,
  getArtworkUrl,
  invalidateArtworkForTrackId,
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
  const [url, setUrl] = useState<string | undefined>(() => (trackId ? getArtworkUrl(trackId) : undefined));

  useEffect(() => {
    const currentInput = trackOrIdRef.current;
    if (!trackId || !currentInput) {
      setUrl(undefined);
      return;
    }

    const existing = getArtworkUrl(trackId);
    if (existing) {
      setUrl(existing);
      return;
    }

    const unsubscribe = subscribeArtwork(trackId, (loadedUrl) => {
      setUrl(loadedUrl);
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
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

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
          void invalidateArtworkForTrackId(trackId);
        }
      }}
      className={`object-cover ${rounded} ${className ?? ""}`}
    />
  );
}
