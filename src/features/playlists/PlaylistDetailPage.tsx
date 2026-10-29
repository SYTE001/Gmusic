import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlaybackStore } from "../../stores/playbackStore";
import { EmptyState } from "../../components/EmptyState";
import { Artwork } from "../../components/Artwork";
import { Menu } from "../../components/Menu";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Modal } from "../../components/Modal";
import { TrackRow } from "../../components/TrackRow";
import { AddSongsToPlaylistDialog } from "./AddToPlaylistDialog";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  EditIcon,
  GripIcon,
  PlayIcon,
  PlaylistIcon,
  PlusIcon,
  ShuffleIcon,
  TrashIcon,
} from "../../components/Icons";
import { formatDurationLong } from "../../utils/misc";
import type { Track } from "../../types";

/**
 * Playlist detail (PRD §7.4): rename/delete, drag reorder with keyboard
 * alternative, add/remove tracks, missing-track relinking.
 */
export function PlaylistDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const playlist = useLibraryStore((state) => state.playlists.find((item) => item.id === id));
  const tracks = useLibraryStore((state) => state.tracks);
  const reorderPlaylist = useLibraryStore((state) => state.reorderPlaylist);
  const deletePlaylist = useLibraryStore((state) => state.deletePlaylist);
  const renamePlaylist = useLibraryStore((state) => state.renamePlaylist);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [addToPlaylistOpen, setAddToPlaylistOpen] = useState(false);

  const resolved: (Track | undefined)[] = useMemo(
    () => (playlist ? playlist.trackIds.map((trackId) => tracks.find((track) => track.id === trackId)) : []),
    [playlist, tracks],
  );
  const available = resolved.filter((track): track is Track => track !== undefined);
  const missingCount = resolved.length - available.length;
  const totalDurationMs = available.reduce((sum, track) => sum + (track.durationMs ?? 0), 0);

  if (!playlist) {
    return (
      <EmptyState
        icon={<PlaylistIcon size={28} />}
        title="Playlist not found"
        description="This playlist doesn't exist on this device. It may have been deleted."
        action={
          <Link to="/playlists" className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-accent-contrast">
            Back to playlists
          </Link>
        }
      />
    );
  }

  const playAll = (shuffle: boolean) => {
    if (available.length === 0) return;
    const playback = usePlaybackStore.getState();
    if (shuffle !== playback.shuffleEnabled) playback.toggleShuffle();
    playback.playContext(
      available.map((track) => track.id),
      0,
      { type: "playlist", id: playlist.id, label: playlist.name },
    );
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end gap-5">
        <Artwork trackId={available[0]?.id ?? null} alt="" className="size-36 shadow-lg md:size-44" rounded="rounded-[var(--radius-tile)]" />
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-wide text-text-muted">Playlist</p>
          <h1 className="mt-0.5 truncate text-2xl font-semibold tracking-tight md:text-[32px]">{playlist.name}</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {available.length} song{available.length === 1 ? "" : "s"}
            {missingCount > 0 && <span className="text-danger"> · {missingCount} unavailable</span>}
            {available.length > 0 && ` · ${formatDurationLong(totalDurationMs)}`}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-full bg-accent-strong px-5 py-2.5 text-sm font-medium text-accent-contrast transition-transform hover:scale-[1.03] disabled:opacity-40"
              onClick={() => playAll(false)}
              disabled={available.length === 0}
            >
              <PlayIcon size={16} />
              Play
            </button>
            <button
              type="button"
              className="icon-btn border"
              style={{ borderColor: "var(--border-subtle)" }}
              aria-label="Shuffle play playlist"
              onClick={() => playAll(true)}
              disabled={available.length === 0}
            >
              <ShuffleIcon size={17} />
            </button>
            <button
              type="button"
              className="icon-btn border"
              style={{ borderColor: "var(--border-subtle)" }}
              aria-label="Add songs to this playlist"
              onClick={() => setAddToPlaylistOpen(true)}
            >
              <PlusIcon size={17} />
            </button>
            <Menu
              buttonLabel={`Playlist actions for ${playlist.name}`}
              items={[
                {
                  kind: "action",
                  label: "Rename",
                  icon: <EditIcon size={16} />,
                  onSelect: () => {
                    setRenameValue(playlist.name);
                    setRenaming(true);
                  },
                },
                {
                  kind: "action",
                  label: "Delete playlist",
                  icon: <TrashIcon size={16} />,
                  danger: true,
                  onSelect: () => setConfirmingDelete(true),
                },
              ]}
            />
          </div>
        </div>
      </div>

      {/* Tracks with drag reorder + keyboard alternative */}
      {available.length === 0 && missingCount === 0 ? (
        <EmptyState
          icon={<PlaylistIcon size={28} />}
          title="This playlist is empty"
          description="Add songs from your library using the ⋯ menu on any track, or the button above."
          action={
            <Link to="/library" className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-accent-contrast">
              Browse library
            </Link>
          }
        />
      ) : (
        <div className="space-y-0.5">
          {resolved.map((track, index) =>
            track ? (
              <PlaylistTrackRow
                key={`${track.id}-${index}`}
                track={track}
                playlistId={playlist.id}
                contextTrackIds={available.map((item) => item.id)}
                canMoveUp={index > 0}
                canMoveDown={index < resolved.length - 1}
                onMoveUp={() => void reorderPlaylist(playlist.id, index, index - 1)}
                onMoveDown={() => void reorderPlaylist(playlist.id, index, index + 1)}
                onDragStart={() => setDragFrom(index)}
                onDragOverItem={(event) => {
                  event.preventDefault();
                  setDragOver(index);
                }}
                onDropItem={() => {
                  if (dragFrom !== null && dragFrom !== index) void reorderPlaylist(playlist.id, dragFrom, index);
                  setDragFrom(null);
                  setDragOver(null);
                }}
                onDragEnd={() => {
                  setDragFrom(null);
                  setDragOver(null);
                }}
                isDragOver={dragOver === index && dragFrom !== null && dragFrom !== index}
              />
            ) : (
              <div
                key={`missing-${index}`}
                className="flex h-14 items-center gap-3 rounded-lg px-3 text-sm text-text-muted"
                style={{ background: "color-mix(in srgb, var(--danger) 6%, transparent)" }}
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-raised" aria-hidden>
                  <PlaylistIcon size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">A track in this playlist is no longer in your library</span>
                  <span className="block text-xs">It was removed from the library. Remove it here to clean up the playlist.</span>
                </span>
                <button
                  type="button"
                  className="text-xs text-danger underline underline-offset-2"
                  onClick={() => void useLibraryStore.getState().removeFromPlaylist(playlist.id, playlist.trackIds[index])}
                >
                  Remove
                </button>
              </div>
            ),
          )}
        </div>
      )}

      {/* Rename modal */}
      <Modal open={renaming} title="Rename playlist" onClose={() => setRenaming(false)} width="max-w-sm">
        <input
          type="text"
          value={renameValue}
          autoFocus
          onChange={(event) => setRenameValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && renameValue.trim()) {
              void renamePlaylist(playlist.id, renameValue);
              setRenaming(false);
            }
          }}
          aria-label="Playlist name"
          className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-accent"
          style={{ borderColor: "var(--border-subtle)" }}
        />
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="rounded-lg px-4 py-2 text-sm text-text-secondary hover:bg-surface-hover" onClick={() => setRenaming(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-accent-contrast disabled:opacity-50"
            disabled={renameValue.trim().length === 0 || renameValue.trim() === playlist.name}
            onClick={() => {
              void renamePlaylist(playlist.id, renameValue);
              setRenaming(false);
            }}
          >
            Save
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmingDelete}
        title="Delete playlist?"
        description={
          <>
            “{playlist.name}” will be deleted from this device. <strong>The songs themselves stay in your library</strong> — only
            this playlist and its order are removed.
          </>
        }
        confirmLabel="Delete playlist"
        onConfirm={() => {
          void deletePlaylist(playlist.id).then(() => navigate("/playlists"));
        }}
        onCancel={() => setConfirmingDelete(false)}
      />

      <AddSongsToPlaylistDialog
        open={addToPlaylistOpen}
        playlistId={playlist.id}
        playlistName={playlist.name}
        excludedTrackIds={playlist.trackIds}
        onClose={() => setAddToPlaylistOpen(false)}
      />
    </div>
  );
}

function PlaylistTrackRow({
  track,
  playlistId,
  contextTrackIds,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onDragStart,
  onDragOverItem,
  onDropItem,
  onDragEnd,
  isDragOver,
}: {
  track: Track;
  playlistId: string;
  contextTrackIds: string[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDragStart: () => void;
  onDragOverItem: (event: React.DragEvent) => void;
  onDropItem: () => void;
  onDragEnd: () => void;
  isDragOver: boolean;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOverItem}
      onDrop={onDropItem}
      onDragEnd={onDragEnd}
      className={`group relative flex items-center gap-1 rounded-lg ${isDragOver ? "outline outline-2 outline-accent" : ""}`}
    >
      <span className="hidden cursor-grab pl-1 text-text-muted opacity-0 transition-opacity group-hover:opacity-100 sm:block" aria-hidden>
        <GripIcon size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <TrackRow
          track={track}
          contextTrackIds={contextTrackIds}
          context={{ type: "playlist", id: playlistId, label: "Playlist" }}
          playlistId={playlistId}
          showAlbum
          showAdded={false}
        />
      </div>
      <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {canMoveUp && (
          <button type="button" className="icon-btn size-7" aria-label={`Move ${track.title} up`} onClick={onMoveUp}>
            <ChevronUpIcon size={14} />
          </button>
        )}
        {canMoveDown && (
          <button type="button" className="icon-btn size-7" aria-label={`Move ${track.title} down`} onClick={onMoveDown}>
            <ChevronDownIcon size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
