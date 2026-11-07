import { memo, useState, type ReactNode } from "react";
import type { PlaybackContext, Track } from "../types";
import { Artwork } from "./Artwork";
import { CloudCheckIcon, HeartIcon, ImportIcon, LinkIcon, PlayIcon, WarningIcon } from "./Icons";
import { Menu } from "./Menu";
import { formatClock, formatDate } from "../utils/misc";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlaybackStore } from "../stores/playbackStore";
import { useTrackActionsContext } from "../features/library/useTrackActions";
import { recordComponentRender } from "../utils/perf";

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
type TrackRowProps = {
  track: Track;
  contextTrackIds?: string[];
  context?: PlaybackContext;
  showAlbum?: boolean;
  showAdded?: boolean;
  index?: number;
  playlistId?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
};

function areTrackRowPropsEqual(prev: TrackRowProps, next: TrackRowProps): boolean {
  if (
    prev.index !== next.index ||
    prev.showAlbum !== next.showAlbum ||
    prev.showAdded !== next.showAdded ||
    prev.playlistId !== next.playlistId ||
    prev.leading !== next.leading ||
    prev.trailing !== next.trailing ||
    prev.contextTrackIds !== next.contextTrackIds ||
    prev.context?.type !== next.context?.type ||
    prev.context?.label !== next.context?.label
  ) {
    return false;
  }
  if (prev.track === next.track) return true;
  const a = prev.track;
  const b = next.track;
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.artist === b.artist &&
    a.album === b.album &&
    a.durationMs === b.durationMs &&
    a.addedAt === b.addedAt &&
    a.isLiked === b.isLiked &&
    a.availability === b.availability &&
    a.accessMode === b.accessMode &&
    a.cloudStatus === b.cloudStatus &&
    a.objectKey === b.objectKey
  );
}

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
}: TrackRowProps) {
  recordComponentRender("TrackRow");
  const [menuOpen, setMenuOpen] = useState(false);
  const isLiked = track.isLiked;
  const toggleLike = useLibraryStore((state) => state.toggleLike);
  const isCurrent = usePlaybackStore((state) => state.currentTrackId === track.id);
  const isPlaying = usePlaybackStore((state) => state.currentTrackId === track.id && state.isPlaying);
  const trackActions = useTrackActionsContext();

  const unavailable =
    track.availability === "missing" ||
    track.availability === "permission-required" ||
    track.availability === "offline";
  const sessionOnly = track.accessMode === "session-only" && !unavailable;
  const cloudReady = track.cloudStatus === "ready" && Boolean(track.objectKey);

  const play = () => {
    usePlaybackStore.getState().playTrackFromContext(
      track.id,
      contextTrackIds ?? [track.id],
      context ?? { type: "library", label: "All songs" },
    );
  };

  return (
    <div
      role="listitem"
      className={`group relative flex h-14 cursor-pointer items-center gap-3 rounded-lg px-3 transition-colors hover:bg-surface-hover ${
        menuOpen ? "bg-surface-hover" : isCurrent ? "bg-surface-raised" : ""
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
      {/* Left Column: Leading, Index/Play, Artwork, Title & Artist (Identity - flex-1 min-w-0) */}
      <div className="flex min-w-0 flex-1 items-center gap-2.5 sm:gap-3">
        {leading}
        <div className="relative hidden w-7 shrink-0 items-center justify-center sm:flex" aria-hidden>
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
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={`truncate text-sm font-medium ${isCurrent ? "text-accent" : "text-text-primary"}`}>
              {track.title}
            </span>
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

      {/* Album Column (Optional - fixed width) */}
      {showAlbum && (
        <span
          className="hidden w-44 lg:w-48 xl:w-56 shrink-0 truncate text-xs text-text-secondary md:block"
          title={track.album}
        >
          {track.album || "—"}
        </span>
      )}

      {/* Date Added Column (Optional - fixed width) */}
      {showAdded && (
        <span className="hidden w-24 shrink-0 text-right text-xs text-text-muted xl:block">
          {formatDate(track.addedAt)}
        </span>
      )}

      {/* Trailing Action Cluster (Fixed width items - shrink-0) */}
      <div
        className="flex shrink-0 items-center justify-end gap-1 sm:gap-1.5"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="w-11 shrink-0 text-right text-xs tabular-nums text-text-muted">
          {track.durationMs !== null ? formatClock(track.durationMs) : "—"}
        </span>
        <button
          type="button"
          className="size-8 inline-flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors shrink-0"
          aria-label={isLiked ? `Remove ${track.title} from liked songs` : `Add ${track.title} to liked songs`}
          aria-pressed={isLiked}
          onClick={(event) => {
            event.stopPropagation();
            void toggleLike(track.id);
          }}
        >
          <HeartIcon size={16} filled={isLiked} className={isLiked ? "text-accent" : ""} />
        </button>
        <Menu
          items={() => trackActions?.buildMenuItems(track, { playlistId }) ?? []}
          buttonLabel={`More actions for ${track.title}`}
          onOpenChange={setMenuOpen}
        />
        {trailing}
      </div>
    </div>
  );
}, areTrackRowPropsEqual);
