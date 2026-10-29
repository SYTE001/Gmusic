import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlaybackStore } from "../../stores/playbackStore";
import { TrackListSection } from "../../components/TrackListSection";
import { EmptyState } from "../../components/EmptyState";
import { HeartIcon } from "../../components/Icons";
import { ImportMusicButtons } from "../library/ImportMusic";

/** Liked Songs (PRD §7.5): same sort/search conventions as Library. */
export function LikedPage() {
  const tracks = useLibraryStore((state) => state.tracks);
  const liked = useMemo(() => tracks.filter((track) => track.isLiked), [tracks]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <span className="hidden size-20 place-items-center rounded-[var(--radius-tile)] text-accent-contrast sm:grid" style={{ background: "var(--accent-strong)" }} aria-hidden>
          <HeartIcon size={34} filled />
        </span>
        <div>
          <p className="text-xs uppercase tracking-wide text-text-muted">Playlist</p>
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Liked Songs</h1>
          <p className="text-sm text-text-secondary">
            {liked.length} song{liked.length === 1 ? "" : "s"}
          </p>
        </div>
        {liked.length > 0 && (
          <button
            type="button"
            className="ml-auto grid size-12 place-items-center rounded-full bg-accent-strong text-accent-contrast transition-transform hover:scale-105"
            aria-label="Play liked songs"
            onClick={() =>
              usePlaybackStore.getState().playContext(
                liked.map((track) => track.id),
                0,
                { type: "liked", label: "Liked Songs" },
              )
            }
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M8 5.5v13l11-6.5z" />
            </svg>
          </button>
        )}
      </div>

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
