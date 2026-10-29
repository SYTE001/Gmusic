import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLibraryStore } from "../../stores/libraryStore";
import { ArtworkCard } from "../../components/ArtworkCard";
import { EmptyState } from "../../components/EmptyState";
import { Modal } from "../../components/Modal";
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

export function CreatePlaylistModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (playlistId: string) => void;
}) {
  const createPlaylist = useLibraryStore((state) => state.createPlaylist);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const playlist = await createPlaylist(trimmed);
      setName("");
      onClose();
      if (playlist.trackIds.length === 0) {
        // A new empty playlist can be played only after adding songs; nothing to do here.
      }
      onCreated?.(playlist.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title="New playlist" onClose={onClose} width="max-w-sm">
      <label className="block text-sm text-text-secondary" htmlFor="new-playlist-name">
        Name
      </label>
      <input
        id="new-playlist-name"
        type="text"
        value={name}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void create();
        }}
        placeholder="e.g. Evening drive"
        className="mt-1.5 w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-accent"
        style={{ borderColor: "var(--border-subtle)" }}
      />
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="rounded-lg px-4 py-2 text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-accent-contrast disabled:opacity-50"
          onClick={() => void create()}
          disabled={name.trim().length === 0 || busy}
        >
          Create
        </button>
      </div>
    </Modal>
  );
}
