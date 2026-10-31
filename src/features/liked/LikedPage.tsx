import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlaybackStore } from "../../stores/playbackStore";
import { TrackListSection } from "../../components/TrackListSection";
import { StickyPageHeader } from "../../components/StickyPageHeader";
import { EmptyState } from "../../components/EmptyState";
import { HeartIcon, PlayIcon, ShuffleIcon } from "../../components/Icons";
import { formatDurationLong } from "../../utils/misc";
import { ImportMusicButtons } from "../library/ImportMusic";

/** Liked Songs (PRD §7.5): same sort/search conventions as Library. */
export function LikedPage() {
  const tracks = useLibraryStore((state) => state.tracks);
  const liked = useMemo(() => tracks.filter((track) => track.isLiked), [tracks]);
  const totalDurationMs = liked.reduce((sum, track) => sum + (track.durationMs ?? 0), 0);

  const playAll = (shuffle: boolean) => {
    if (liked.length === 0) return;
    const playback = usePlaybackStore.getState();
    if (shuffle !== playback.shuffleEnabled) playback.toggleShuffle();
    playback.playContext(
      liked.map((track) => track.id),
      0,
      { type: "liked", label: "Liked Songs" },
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-5 md:gap-6">
        <span
          className="grid size-36 shrink-0 place-items-center rounded-[var(--radius-tile)] bg-accent text-accent-contrast shadow-lg md:size-44"
          aria-hidden
        >
          <HeartIcon size={52} filled />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">Playlist</p>
          <h1 className="mt-1.5 text-[clamp(1.9rem,4.5vw,3rem)] font-bold leading-tight tracking-tight">Liked Songs</h1>
          <p className="mt-2 text-sm text-text-secondary">
            {liked.length} song{liked.length === 1 ? "" : "s"}
            {liked.length > 0 && ` · ${formatDurationLong(totalDurationMs)}`}
          </p>
          {liked.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-accent-contrast transition-transform hover:scale-[1.03]"
                onClick={() => playAll(false)}
              >
                <PlayIcon size={16} />
                Play
              </button>
              <button
                type="button"
                className="icon-btn size-11 rounded-full border"
                title="Shuffle play liked songs"
                style={{ borderColor: "var(--border-strong)" }}
                aria-label="Shuffle play liked songs"
                onClick={() => playAll(true)}
              >
                <ShuffleIcon size={17} />
              </button>
            </div>
          )}
        </div>
      </div>

      {liked.length > 0 && (
        <StickyPageHeader>
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent text-accent-contrast" aria-hidden>
            <HeartIcon size={15} filled />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">Liked Songs</span>
          <button
            type="button"
            className="icon-btn size-9 rounded-full bg-accent text-accent-contrast hover:scale-105"
            style={{ transition: "transform 100ms ease" }}
            aria-label="Play liked songs"
            onClick={() => playAll(false)}
          >
            <PlayIcon size={15} />
          </button>
        </StickyPageHeader>
      )}

      <TrackListSection
        tracks={liked}
        context={{ type: "liked", label: "Liked Songs" }}
        defaultSort="recentlyPlayed"
        emptyState={
          <EmptyState
            icon={<HeartIcon size={28} />}
            title="Songs you like will live here"
            description={
              <>
                Tap the heart on any song in your <Link to="/library" className="text-accent underline underline-offset-2">library</Link> to save it here. Likes are
                stored on this device only.
              </>
            }
            action={tracks.length === 0 ? <ImportMusicButtons /> : undefined}
          />
        }
      />
    </div>
  );
}
