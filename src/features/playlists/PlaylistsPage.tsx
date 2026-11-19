import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLibraryStore } from "../../stores/libraryStore";
import { ArtworkCard } from "../../components/ArtworkCard";
import { EmptyState } from "../../components/EmptyState";
import { PlaylistIcon, PlusIcon } from "../../components/Icons";
import { formatDurationLong } from "../../utils/misc";

/** Playlist index (PRD §7.4). */
export function PlaylistsPage() {
  const playlists = useLibraryStore((state) => state.playlists);
  const tracks = useLibraryStore((state) => state.tracks);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const playlistSummaries = useMemo(() => {
    const tracksById = new Map(tracks.map((track) => [track.id, track]));
    return playlists.map((playlist) => {
      let durationMs = 0;
      let artworkKey: string | null = null;
      let trackCount = 0;
      for (const trackId of playlist.trackIds) {
        const track = tracksById.get(trackId);
        if (!track) continue;
        artworkKey ??= track.id;
        durationMs += track.durationMs ?? 0;
        trackCount += 1;
      }
      return { playlist, artworkKey, durationMs, trackCount };
    });
  }, [playlists, tracks]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Playlists</h1>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-lg bg-accent-strong px-4 py-2.5 text-sm font-medium text-accent-contrast transition-opacity hover:opacity-90"
          onClick={() => setCreating(true)}
        >
          <PlusIcon size={17} />
          New playlist
        </button>
      </div>

      {playlists.length === 0 ? (
        <EmptyState
          icon={<PlaylistIcon size={28} />}
          title="No playlists yet"
          description="Create a playlist, then add songs from any track menu. Playlists and their order are saved on this device."
          action={
            <button
              type="button"
              className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-accent-contrast"
              onClick={() => setCreating(true)}
            >
              Create your first playlist
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {playlistSummaries.map(({ playlist, artworkKey, durationMs, trackCount }) => (
            <ArtworkCard
              key={playlist.id}
              artworkKey={artworkKey}
              title={playlist.name}
              subtitle={`${trackCount} song${trackCount === 1 ? "" : "s"} · ${formatDurationLong(durationMs)}`}
              ariaLabel={`Open playlist ${playlist.name}`}
              onOpen={() => navigate(`/playlist/${playlist.id}`)}
            />
          ))}
        </div>
      )}

      <CreatePlaylistModal open={creating} onClose={() => setCreating(false)} onCreated={(id) => navigate(`/playlist/${id}`)} />
    </div>
  );
}

import { CreatePlaylistModal } from "./CreatePlaylistModal";
export { CreatePlaylistModal };
