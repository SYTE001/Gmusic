import { useState } from "react";
import { useLibraryStore } from "../../stores/libraryStore";
import { Modal } from "../../components/Modal";

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
