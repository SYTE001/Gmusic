import { memo, type ReactNode } from "react";
import type { PlaybackContext, Track } from "../types";
import { Artwork } from "./Artwork";
import { CloudCheckIcon, HeartIcon, LinkIcon, WarningIcon } from "./Icons";
import { Menu } from "./Menu";
import { formatClock, formatDate } from "../utils/misc";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlaybackStore } from "../stores/playbackStore";
import { useTrackActions } from "../features/library/useTrackActions";

/**
 * Track list row. Clicking the row plays the track in its context; control
 * buttons stop propagation so they never trigger row playback (PRD §7.3).
 */
export const TrackRow = memo(function TrackRow({
  track,
  contextTrackIds,
  context,
  showAlbum = true,
  showAdded = false,
  index,
  playlistId,
  leading,
  trailing,
}: {
  track: Track;
  contextTrackIds: string[];
  context: PlaybackContext;
  showAlbum?: boolean;
  showAdded?: boolean;
  index?: number;
  playlistId?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const isLiked = track.isLiked;
  const toggleLike = useLibraryStore((state) => state.toggleLike);
  const isCurrent = usePlaybackStore((state) => state.currentTrackId === track.id);
  const { buildMenuItems, dialogs } = useTrackActions();

  const unavailable =
    track.availability === "missing" ||
    track.availability === "permission-required" ||
    track.availability === "offline";
  const cloudReady = track.cloudStatus === "ready" && Boolean(track.objectKey);

  const play = () => {
    usePlaybackStore.getState().playTrackFromContext(track.id, contextTrackIds, context);
  };

  return (
    <>
      <div
        role="listitem"
        className={`group grid h-14 cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg px-2 transition-colors hover:bg-surface-hover sm:px-3 ${
          isCurrent ? "bg-surface-raised" : ""
        }`}
        onClick={play}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.target === event.currentTarget) {
            event.preventDefault();
            play();
          }
        }}
        tabIndex={0}
        aria-label={`Play ${track.title} by ${track.artist || "unknown artist"}`}
      >
        <div className="flex min-w-0 items-center gap-3">
          {leading}
          {index !== undefined && (
            <span className="hidden w-6 shrink-0 text-right text-xs tabular-nums text-text-muted md:block">{index}</span>
          )}
          <Artwork trackId={track.id} alt="" className="size-10 shrink-0" rounded="rounded-md" />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={`truncate text-sm ${isCurrent ? "text-accent" : "text-text-primary"}`}>{track.title}</span>
              {unavailable && (
                <span
                  className="shrink-0 text-text-muted"
                  title={
                    track.availability === "permission-required"
                      ? "File access needed"
                      : track.availability === "offline"
                        ? "Offline — this song is in the cloud"
                        : "File not available"
                  }
                  aria-label={
                    track.availability === "permission-required"
                      ? "File access needed"
                      : track.availability === "offline"
                        ? "Offline — this song is in the cloud"
                        : "File not available"
                  }
                >
                  {track.availability === "permission-required" ? (
                    <LinkIcon size={13} />
                  ) : (
                    <WarningIcon size={13} />
                  )}
                </span>
              )}
              {cloudReady && (
                <span
                  className="shrink-0 text-text-muted"
                  title="Available in cloud storage"
                  aria-label="Available in cloud storage"
                >
                  <CloudCheckIcon size={13} />
                </span>
              )}
            </div>
            <span className="block truncate text-xs text-text-secondary">
              {track.artist || "Unknown artist"}
              {track.metadataFromFilename ? "" : ""}
            </span>
          </div>
        </div>

        <div className="hidden min-w-0 items-center justify-end gap-4 sm:flex">
          {showAlbum && (
            <span className="hidden max-w-48 truncate text-xs text-text-secondary lg:block" title={track.album}>
              {track.album || "—"}
            </span>
          )}
          {showAdded && <span className="hidden w-20 shrink-0 text-right text-xs text-text-muted xl:block">{formatDate(track.addedAt)}</span>}
          <button
            type="button"
            className="icon-btn size-8"
            aria-label={isLiked ? `Remove ${track.title} from liked songs` : `Add ${track.title} to liked songs`}
            aria-pressed={isLiked}
            onClick={(event) => {
              event.stopPropagation();
              void toggleLike(track.id);
            }}
          >
            <HeartIcon size={16} filled={isLiked} className={isLiked ? "text-danger" : ""} />
          </button>
          <span className="w-11 shrink-0 text-right text-xs tabular-nums text-text-muted">
            {track.durationMs !== null ? formatClock(track.durationMs) : "—"}
          </span>
        </div>

        <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
          {trailing}
          <Menu items={buildMenuItems(track, { playlistId })} buttonLabel={`More actions for ${track.title}`} />
        </div>
      </div>
      {dialogs}
    </>
  );
});
