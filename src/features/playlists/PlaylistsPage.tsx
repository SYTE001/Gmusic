import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLibraryStore } from "../../stores/libraryStore";
import { ArtworkCard } from "../../components/ArtworkCard";
import { EmptyState } from "../../components/EmptyState";
import { PlaylistIcon, PlusIcon } from "../../components/Icons";
import { formatDurationLong } from "../../utils/misc";
import type { Track } from "../../types";

/** Playlist index (PRD §7.4). */
export function PlaylistsPage() {
  const playlists = useLibraryStore((state) => state.playlists);
  const tracks = useLibraryStore((state) => state.tracks);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

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
          {playlists.map((playlist) => {
            const playlistTracks = playlist.trackIds
              .map((id) => tracks.find((track) => track.id === id))
              .filter((track): track is Track => Boolean(track));
            const durationMs = playlistTracks.reduce((sum, track) => sum + (track.durationMs ?? 0), 0);
            return (
              <ArtworkCard
                key={playlist.id}
                artworkKey={playlistTracks[0]?.id ?? null}
                title={playlist.name}
                subtitle={`${playlistTracks.length} song${playlistTracks.length === 1 ? "" : "s"} · ${formatDurationLong(durationMs)}`}
                ariaLabel={`Open playlist ${playlist.name}`}
                onOpen={() => navigate(`/playlist/${playlist.id}`)}
              />
            );
          })}
        </div>
      )}

      <CreatePlaylistModal open={creating} onClose={() => setCreating(false)} onCreated={(id) => navigate(`/playlist/${id}`)} />
    </div>
  );
}

import { CreatePlaylistModal } from "./CreatePlaylistModal";
export { CreatePlaylistModal };
