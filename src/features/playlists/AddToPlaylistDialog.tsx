import { useMemo, useState } from "react";
import { Modal } from "../../components/Modal";
import { PlusIcon } from "../../components/Icons";
import { useLibraryStore } from "../../stores/libraryStore";
import { toast } from "../../stores/toastStore";
import { normalizeForSearch } from "../../utils/misc";

/** Pick songs from the library to add to a specific playlist (PRD §7.4). */
export function AddSongsToPlaylistDialog({
  open,
  playlistId,
  playlistName,
  excludedTrackIds,
  onClose,
}: {
  open: boolean;
  playlistId: string;
  playlistName: string;
  excludedTrackIds: string[];
  onClose: () => void;
}) {
  const tracks = useLibraryStore((state) => state.tracks);
  const addToPlaylist = useLibraryStore((state) => state.addToPlaylist);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const excluded = useMemo(() => new Set(excludedTrackIds), [excludedTrackIds]);
  const candidates = useMemo(() => {
    const normalized = normalizeForSearch(query);
    return tracks
      .filter((track) => !excluded.has(track.id))
      .filter(
        (track) =>
          normalized.length === 0 ||
          normalizeForSearch(track.title).includes(normalized) ||
          normalizeForSearch(track.artist).includes(normalized),
      )
      .slice(0, 60);
  }, [tracks, query, excluded]);

  const toggle = (trackId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  };

  const addSelected = async () => {
    if (selected.size === 0) return;
    await addToPlaylist(playlistId, Array.from(selected));
    toast("success", `Added ${selected.size} song${selected.size === 1 ? "" : "s"} to “${playlistName}”.`);
    setSelected(new Set());
    onClose();
  };

  return (
    <Modal open={open} title={`Add songs to “${playlistName}”`} onClose={onClose}>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search your library…"
        aria-label="Search songs to add"
        className="mb-3 w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-accent"
        style={{ borderColor: "var(--border-subtle)" }}
      />
      <div className="max-h-72 space-y-0.5 overflow-y-auto" role="listbox" aria-label="Songs" aria-multiselectable>
        {candidates.length === 0 && <p className="px-1 py-3 text-sm text-text-muted">No songs available to add.</p>}
        {candidates.map((track) => (
          <label
            key={track.id}
            className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-hover"
            onKeyDown={(event) => {
              if (event.key === " " || event.key === "Enter") {
                event.preventDefault();
                toggle(track.id);
              }
            }}
          >
            <input
              type="checkbox"
              checked={selected.has(track.id)}
              onChange={() => toggle(track.id)}
              className="size-4 accent-[var(--accent-strong)]"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-text-primary">{track.title}</span>
              <span className="block truncate text-xs text-text-secondary">{track.artist || "Unknown artist"}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between border-t pt-4" style={{ borderColor: "var(--border-subtle)" }}>
        <span className="text-xs text-text-muted">{selected.size} selected</span>
        <div className="flex gap-2">
          <button type="button" className="rounded-lg px-4 py-2 text-sm text-text-secondary hover:bg-surface-hover" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-accent-contrast disabled:opacity-50"
            onClick={() => void addSelected()}
            disabled={selected.size === 0}
          >
            Add
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Add-to-playlist picker with inline creation (PRD §7.4). */
export function AddToPlaylistDialog({
  open,
  trackIds,
  onClose,
}: {
  open: boolean;
  trackIds: string[];
  onClose: () => void;
}) {
  const playlists = useLibraryStore((state) => state.playlists);
  const createPlaylist = useLibraryStore((state) => state.createPlaylist);
  const addToPlaylist = useLibraryStore((state) => state.addToPlaylist);
  const [newName, setNewName] = useState("");

  const add = async (playlistId: string, playlistName: string) => {
    await addToPlaylist(playlistId, trackIds);
    toast("success", `Added to “${playlistName}”.`);
    onClose();
  };

  const createAndAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    const playlist = await createPlaylist(name);
    setNewName("");
    await add(playlist.id, playlist.name);
  };

  return (
    <Modal open={open} title={`Add ${trackIds.length === 1 ? "song" : `${trackIds.length} songs`} to a playlist`} onClose={onClose}>
      <div className="space-y-1">
        {playlists.length === 0 && <p className="px-1 pb-2 text-sm text-text-secondary">No playlists yet — create one below.</p>}
        {playlists.map((playlist) => (
          <button
            key={playlist.id}
            type="button"
            className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm text-text-primary transition-colors hover:bg-surface-hover"
            onClick={() => void add(playlist.id, playlist.name)}
          >
            <span className="truncate">{playlist.name}</span>
            <span className="text-xs text-text-muted">{playlist.trackIds.length} songs</span>
          </button>
        ))}
      </div>
      <div className="mt-4 flex gap-2 border-t pt-4" style={{ borderColor: "var(--border-subtle)" }}>
        <input
          type="text"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void createAndAdd();
          }}
          placeholder="New playlist name"
          aria-label="New playlist name"
          className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-accent"
          style={{ borderColor: "var(--border-subtle)" }}
        />
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent-strong px-3 py-2 text-sm font-medium text-accent-contrast disabled:opacity-50"
          onClick={() => void createAndAdd()}
          disabled={newName.trim().length === 0}
        >
          <PlusIcon size={16} />
          Create
        </button>
      </div>
    </Modal>
  );
}
