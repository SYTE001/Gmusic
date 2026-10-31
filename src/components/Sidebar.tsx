import { useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useLibraryStore } from "../stores/libraryStore";
import { SearchField } from "./TopBar";
import { Menu, type MenuItemSpec } from "./Menu";
import { Modal } from "./Modal";
import { ConfirmDialog } from "./ConfirmDialog";
import { CreatePlaylistModal } from "../features/playlists/PlaylistsPage";
import {
  ClockIcon,
  EditIcon,
  HeartIcon,
  HomeIcon,
  LibraryIcon,
  MusicNoteIcon,
  PlaylistIcon,
  PlusIcon,
  SettingsIcon,
  TrashIcon,
} from "./Icons";
import type { Playlist } from "../types";

/**
 * Sidebar body (desktop rail and mobile drawer): search field, primary nav
 * with a left accent-bar active indicator, then the user's playlists with a
 * create button and per-playlist hover actions. Import lives on Home/Library
 * so the primary action stays reachable without opening Settings.
 */
export function SidebarContent({ showSearch = true }: { showSearch?: boolean }) {
  const playlists = useLibraryStore((state) => state.playlists);
  const likedCount = useLibraryStore((state) => state.tracks.filter((track) => track.isLiked).length);
  const [creating, setCreating] = useState(false);

  const navClass = ({ isActive }: { isActive: boolean }) =>
    `nav-item relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
      isActive
        ? "font-medium text-text-primary"
        : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
    }`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showSearch && (
        <div className="px-3 pb-3 pt-1">
          <SearchField />
        </div>
      )}

      <nav aria-label="Main" className="flex flex-col gap-0.5 px-3">
        <NavLink to="/" className={navClass} end>
          <HomeIcon size={19} />
          Home
        </NavLink>
        <NavLink to="/library" className={navClass}>
          <LibraryIcon size={19} />
          Library
        </NavLink>
        <NavLink to="/liked" className={navClass}>
          <HeartIcon size={19} />
          Liked
          {likedCount > 0 && <span className="ml-auto text-xs text-text-muted tabular-nums">{likedCount}</span>}
        </NavLink>
        <NavLink to="/playlists" className={navClass}>
          <PlaylistIcon size={19} />
          Playlists
        </NavLink>
        <NavLink to="/recent" className={navClass}>
          <ClockIcon size={19} />
          Recent
        </NavLink>
        <NavLink to="/settings" className={navClass}>
          <SettingsIcon size={19} />
          Settings
        </NavLink>
      </nav>

      <div className="mt-5 flex min-h-0 flex-1 flex-col px-3">
        <div className="flex items-center justify-between px-1 pb-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Playlists</span>
          <button
            type="button"
            className="icon-btn size-7"
            aria-label="Create playlist"
            title="Create playlist"
            onClick={(event) => {
              event.stopPropagation();
              setCreating(true);
            }}
          >
            <PlusIcon size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2" role="list" aria-label="Your playlists">
          {playlists.length === 0 && <p className="px-1 pb-2 text-xs text-text-muted">Playlists you create appear here.</p>}
          {playlists.map((playlist) => (
            <SidebarPlaylistRow key={playlist.id} playlist={playlist} />
          ))}
        </div>
      </div>

      <CreatePlaylistModal
        open={creating}
        onClose={() => setCreating(false)}
      />
    </div>
  );
}

/** One playlist row: navigates, and reveals a "…" menu (rename/delete) on hover. */
function SidebarPlaylistRow({ playlist }: { playlist: Playlist }) {
  const location = useLocation();
  const navigate = useNavigate();
  const renamePlaylist = useLibraryStore((state) => state.renamePlaylist);
  const deletePlaylist = useLibraryStore((state) => state.deletePlaylist);
  const active = location.pathname === `/playlist/${playlist.id}`;
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const menuItems: MenuItemSpec[] = [
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
  ];

  return (
    <div role="listitem" className="group relative flex items-center">
      <NavLink
        to={`/playlist/${playlist.id}`}
        className={`flex min-w-0 flex-1 items-center gap-2.5 truncate rounded-lg py-1.5 pl-2 pr-9 text-sm transition-colors ${
          active
            ? "bg-surface-raised text-text-primary"
            : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
        }`}
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface-raised text-text-secondary" aria-hidden>
          <MusicNoteIcon size={14} />
        </span>
        <span className="min-w-0 flex-1 truncate">{playlist.name}</span>
      </NavLink>
      <div
        className="absolute right-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        onClick={(event) => event.stopPropagation()}
      >
        <Menu items={menuItems} buttonLabel={`Playlist actions for ${playlist.name}`} />
      </div>

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
          void deletePlaylist(playlist.id).then(() => {
            if (location.pathname === `/playlist/${playlist.id}`) navigate("/playlists");
          });
        }}
        onCancel={() => setConfirmingDelete(false)}
      />
    </div>
  );
}
