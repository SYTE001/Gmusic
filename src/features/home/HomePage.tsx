import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlaybackStore } from "../../stores/playbackStore";
import { ArtworkCard } from "../../components/ArtworkCard";
import { LibraryEmptyState, ImportMusicButtons } from "../library/ImportMusic";
import { HeartIcon, MusicNoteIcon } from "../../components/Icons";
import { greetingForNow } from "../../utils/misc";
import { Link } from "react-router-dom";

/**
 * Home (PRD §7.2): greeting, Liked Songs tile, Recently Played, Your
 * Playlists, Recently Added — all from real local data, never fabricated.
 * Import stays in the header so the primary action is reachable here
 * without opening Settings.
 */
export function HomePage() {
  const navigate = useNavigate();
  const tracks = useLibraryStore((state) => state.tracks);
  const playlists = useLibraryStore((state) => state.playlists);
  const playContext = usePlaybackStore((state) => state.playContext);

  const liked = useMemo(() => tracks.filter((track) => track.isLiked), [tracks]);
  const recent = useMemo(
    () =>
      tracks
        .filter((track) => track.lastPlayedAt !== null)
        .sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))
        .slice(0, 8),
    [tracks],
  );
  const recentlyAdded = useMemo(() => [...tracks].sort((a, b) => b.addedAt - a.addedAt).slice(0, 8), [tracks]);

  if (tracks.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight md:text-[28px]">{greetingForNow()}</h1>
        <LibraryEmptyState />
      </div>
    );
  }

  const playTrackCard = (trackIds: string[], startIndex: number, label: string) => {
    playContext(trackIds, startIndex, { type: "library", label });
  };

  return (
    <div className="space-y-9">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight md:text-[28px]">{greetingForNow()}</h1>
        <ImportMusicButtons />
      </div>

      {/* Feature tiles */}
      <section aria-label="Quick access" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          to="/liked"
          className="group relative flex items-center gap-4 overflow-hidden rounded-[var(--radius-tile)] border p-4 transition-colors hover:bg-surface-hover"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <span className="grid size-14 shrink-0 place-items-center rounded-xl bg-accent text-accent-contrast" aria-hidden>
            <HeartIcon size={24} filled />
          </span>
          <span>
            <span className="block text-base font-semibold">Liked Songs</span>
            <span className="block text-xs text-text-secondary">
              {liked.length} song{liked.length === 1 ? "" : "s"}
            </span>
          </span>
        </Link>
        <button
          type="button"
          className="flex items-center gap-4 rounded-[var(--radius-tile)] border p-4 text-left transition-colors hover:bg-surface-hover"
          style={{ borderColor: "var(--border-subtle)" }}
          onClick={() => playTrackCard(tracks.map((t) => t.id), 0, "All songs")}
        >
          <span className="grid size-14 shrink-0 place-items-center rounded-xl bg-surface-raised text-accent" aria-hidden>
            <MusicNoteIcon size={24} />
          </span>
          <span>
            <span className="block text-base font-semibold">All Songs</span>
            <span className="block text-xs text-text-secondary">
              {tracks.length} song{tracks.length === 1 ? "" : "s"} in your library
            </span>
          </span>
        </button>
      </section>

      {recent.length > 0 && (
        <section aria-label="Recently played">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold tracking-tight">Recently played</h2>
            <Link to="/recent" className="text-xs text-text-secondary underline-offset-2 hover:text-text-primary hover:underline">
              See all
            </Link>
          </div>
          <CardRow>
            {recent.map((track, index) => (
              <ArtworkCard
                key={track.id}
                artworkKey={track.id}
                title={track.title}
                subtitle={track.artist || "Unknown artist"}
                ariaLabel={`Play ${track.title}`}
                onOpen={() => playTrackCard(recent.map((t) => t.id), index, "Recently played")}
                onPlay={() => playTrackCard(recent.map((t) => t.id), index, "Recently played")}
              />
            ))}
          </CardRow>
        </section>
      )}

      {playlists.length > 0 && (
        <section aria-label="Your playlists">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold tracking-tight">Your playlists</h2>
            <Link to="/playlists" className="text-xs text-text-secondary underline-offset-2 hover:text-text-primary hover:underline">
              See all
            </Link>
          </div>
          <CardRow>
            {playlists.map((playlist) => (
              <ArtworkCard
                key={playlist.id}
                artworkKey={playlist.trackIds[0] ?? null}
                title={playlist.name}
                subtitle={`${playlist.trackIds.length} song${playlist.trackIds.length === 1 ? "" : "s"}`}
                ariaLabel={`Open playlist ${playlist.name}`}
                onOpen={() => navigate(`/playlist/${playlist.id}`)}
              />
            ))}
          </CardRow>
        </section>
      )}

      <section aria-label="Recently added">
        <h2 className="mb-3 text-lg font-semibold tracking-tight">Recently added</h2>
        <CardRow>
          {recentlyAdded.map((track, index) => (
            <ArtworkCard
              key={track.id}
              artworkKey={track.id}
              title={track.title}
              subtitle={track.artist || "Unknown artist"}
              ariaLabel={`Play ${track.title}`}
              onOpen={() => playTrackCard(recentlyAdded.map((t) => t.id), index, "Recently added")}
              onPlay={() => playTrackCard(recentlyAdded.map((t) => t.id), index, "Recently added")}
            />
          ))}
        </CardRow>
      </section>
    </div>
  );
}

function CardRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="-mx-3 grid grid-cols-2 overflow-x-auto px-1 pb-1 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {children}
    </div>
  );
}
