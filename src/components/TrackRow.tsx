import { memo, type ReactNode } from "react";
import type { PlaybackContext, Track } from "../types";
import { Artwork } from "./Artwork";
import { CloudCheckIcon, HeartIcon, ImportIcon, LinkIcon, PlayIcon, WarningIcon } from "./Icons";
import { Menu } from "./Menu";
import { formatClock, formatDate } from "../utils/misc";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlaybackStore } from "../stores/playbackStore";
import { useTrackActions } from "../features/library/useTrackActions";

/**
 * Animated equalizer for the currently playing row. Freezes while paused so
 * the animation never claims a state the audio clock disagrees with.
 */
function EqBars({ playing, className = "" }: { playing: boolean; className?: string }) {
  return (
    <span className={`eq ${className}`} data-playing={playing ? "true" : "false"} aria-hidden>
      <i />
      <i />
      <i />
    </span>
  );
}

/** Small, quiet row badge: an icon whose tooltip carries the full state. */
function RowBadge({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="shrink-0 text-text-muted" title={label} aria-label={label}>
      {icon}
    </span>
  );
}

/**
 * Track list row: [index/play-on-hover | artwork | title + artist | album |
 * date added | duration | like | "…" menu]. Clicking the row plays the track
 * in its context; control buttons stop propagation so they never trigger row
 * playback (PRD §7.3). File-access and cloud states appear as small badges
 * with explanatory tooltips.
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
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const { buildMenuItems, dialogs } = useTrackActions();

  const unavailable =
    track.availability === "missing" ||
    track.availability === "permission-required" ||
    track.availability === "offline";
  const sessionOnly = track.accessMode === "session-only" && !unavailable;
  const cloudReady = track.cloudStatus === "ready" && Boolean(track.objectKey);

  const play = () => {
    usePlaybackStore.getState().playTrackFromContext(track.id, contextTrackIds, context);
  };

  return (
    <>
      <div
        role="listitem"
        className={`group grid h-14 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 transition-colors hover:bg-surface-hover sm:gap-3 sm:px-3 [content-visibility:auto] [contain-intrinsic-size:auto_3.5rem] ${
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
        {/* Index (becomes a play affordance on hover) + artwork + title */}
        <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
          {leading}
          <div className="relative hidden w-6 shrink-0 items-center justify-center md:flex" aria-hidden>
            {isCurrent ? (
              <EqBars playing={isPlaying} className="transition-opacity group-hover:opacity-0" />
            ) : (
              <span className="text-xs tabular-nums text-text-muted transition-opacity group-hover:opacity-0">{index ?? ""}</span>
            )}
            <span className="absolute inset-0 grid place-items-center text-text-primary opacity-0 transition-opacity group-hover:opacity-100">
              <PlayIcon size={14} />
            </span>
          </div>
          <Artwork trackId={track.id} alt="" className="size-10 shrink-0" rounded="rounded-md" />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={`truncate text-sm font-medium ${isCurrent ? "text-accent" : "text-text-primary"}`}>{track.title}</span>
              {unavailable && (
                track.availability === "permission-required" ? (
                  <RowBadge icon={<LinkIcon size={13} />} label="File access needed — use “Grant file access” or “Locate file” in the song menu" />
                ) : track.availability === "offline" ? (
                  <RowBadge icon={<WarningIcon size={13} />} label="Cloud-only offline — this song streams from your cloud library once you're back online" />
                ) : (
                  <RowBadge icon={<WarningIcon size={13} />} label="File not available — use “Locate file” in the song menu to re-link it" />
                )
              )}
              {sessionOnly && (
                <RowBadge icon={<ImportIcon size={13} />} label="Re-import required — this file is only borrowed for the current session" />
              )}
              {cloudReady && (
                <RowBadge icon={<CloudCheckIcon size={13} />} label="Stored in your cloud library" />
              )}
            </div>
            <span className="block truncate text-xs text-text-secondary">
              {track.artist || "Unknown artist"}
            </span>
          </div>
        </div>

        {/* Album · date added · duration · like */}
        <div className="hidden min-w-0 items-center justify-end gap-4 sm:flex">
          {showAlbum && (
            <span className="hidden w-44 shrink-0 truncate text-xs text-text-secondary lg:block" title={track.album}>
              {track.album || "—"}
            </span>
          )}
          {showAdded && <span className="hidden w-24 shrink-0 text-right text-xs text-text-muted xl:block">{formatDate(track.addedAt)}</span>}
          <span className="w-11 shrink-0 text-right text-xs tabular-nums text-text-muted">
            {track.durationMs !== null ? formatClock(track.durationMs) : "—"}
          </span>
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
            <HeartIcon size={16} filled={isLiked} className={isLiked ? "text-accent" : ""} />
          </button>
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
