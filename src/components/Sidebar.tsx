import { memo, useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useLibraryStore } from "../stores/libraryStore";
import { SearchField } from "./TopBar";
import { Menu, type MenuItemSpec } from "./Menu";
import { Modal } from "./Modal";
import { ConfirmDialog } from "./ConfirmDialog";
import { CreatePlaylistModal } from "../features/playlists/CreatePlaylistModal";
import { handleArtworkImageError, useArtworkUrl } from "./Artwork";
import {
  ClockIcon,
  EditIcon,
  HeartIcon,
  HomeIcon,
  LibraryIcon,
  MusicNoteIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  TrashIcon,
  WarningIcon,
} from "./Icons";
import type { Playlist } from "../types";
import { recordComponentRender } from "../utils/perf";

/**
 * Sidebar navigation (redesign references 2 and 3).
 *
 * Expanded: logo header, search field, primary nav (Home / Search / Your
 * Library), thin divider, then the playlists section — Create Playlist, Liked
 * Songs, and the user's playlists rendered with actual first-track artwork.
 * Collapsed: the same data and actions compressed into an icon rail with
 * native tooltips; every control keeps its accessible name.
 */
const PRIMARY_NAV = [
  { to: "/", label: "Home", icon: HomeIcon, end: true },
  { to: "/library", label: "Your Library", icon: LibraryIcon },
] as const;

const SECONDARY_NAV = [
  { to: "/recent", label: "Recent", icon: ClockIcon },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
] as const;

/** Focuses the search input that is actually visible (sidebar or mobile top bar). */
export function focusVisibleSearch(): void {
  if (typeof document === "undefined") return;
  const inputs = document.querySelectorAll<HTMLInputElement>("input[type='search']");
  let fallback: HTMLInputElement | null = null;
  for (const input of inputs) {
    if (input.offsetParent !== null) {
      input.focus();
      return;
    }
    if (fallback === null) fallback = input;
  }
  // No input reported a layout box (hidden layouts or test environments
  // without layout): fall back to the first candidate rather than none.
  fallback?.focus();
}

/** Tile style shared by Create Playlist, Liked Songs, and playlist rows. */
function navTile(children: ReactNode) {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface-raised text-text-secondary" aria-hidden>
      {children}
    </span>
  );
}

export function SidebarContent({
  showSearch = true,
  collapsed = false,
  onExpand,
  onSearchActivate,
  onOpenCommandPalette,
}: {
  showSearch?: boolean;
  collapsed?: boolean;
  /** Desktop rail: expand to reveal the search field, then focus it. */
  onExpand?: () => void;
  /** Mobile drawer: close the drawer, then focus the top-bar search field. */
  onSearchActivate?: () => void;
  /** Optional trigger to open the global Command Palette. */
  onOpenCommandPalette?: () => void;
}) {
  recordComponentRender("SidebarContent");
  const playlists = useLibraryStore((state) => state.playlists);
  const likedCount = useLibraryStore((state) => state.tracks.filter((track) => track.isLiked).length);
  const brokenCount = useLibraryStore((state) => state.tracks.filter((track) => track.broken?.isBroken || track.availability === "broken").length);
  const [creating, setCreating] = useState(false);

  const activateSearch = () => {
    if (onSearchActivate) {
      onSearchActivate();
      return;
    }
    if (collapsed) {
      onExpand?.();
      // Focus lands once the width transition has revealed the field.
      window.setTimeout(focusVisibleSearch, 230);
    } else {
      focusVisibleSearch();
    }
  };

  const navClass = ({ isActive }: { isActive: boolean }) =>
    collapsed
      ? `nav-item relative flex items-center justify-center rounded-lg py-2 transition-colors ${
          isActive ? "bg-surface-raised text-text-primary" : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
        }`
      : `nav-item relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
          isActive
            ? "font-medium text-text-primary"
            : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
        }`;

  const searchRowClass = collapsed
    ? "nav-item relative flex items-center justify-center rounded-lg py-2 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
    : "nav-item relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showSearch && !collapsed && (
        <div className="px-3 pb-3 pt-1">
          <SearchField />
        </div>
      )}

      <nav aria-label="Main" className={`flex flex-col gap-0.5 ${collapsed ? "px-2" : "px-3"}`}>
        {PRIMARY_NAV.map(({ to, label, icon: Icon, ...rest }) => (
          <NavLink
            key={to}
            to={to}
            end={"end" in rest ? rest.end : undefined}
            className={navClass}
            aria-label={collapsed ? label : undefined}
            title={collapsed ? label : undefined}
          >
            <Icon size={19} />
            {!collapsed && <span>{label}</span>}
          </NavLink>
        ))}
        <NavLink
          to="/broken"
          className={navClass}
          aria-label={collapsed ? `Broken (${brokenCount})` : undefined}
          title={collapsed ? `Broken (${brokenCount})` : undefined}
        >
          {({ isActive }) => (
            <>
              <WarningIcon size={19} className={brokenCount > 0 ? "text-danger" : ""} />
              {!collapsed && (
                <>
                  <span className={isActive ? "font-medium text-text-primary" : "text-text-secondary"}>Broken</span>
                  {brokenCount > 0 && (
                    <span className="ml-auto rounded-full bg-danger/15 px-1.5 py-0.5 text-xs font-medium text-danger tabular-nums">
                      {brokenCount}
                    </span>
                  )}
                </>
              )}
              {collapsed && brokenCount > 0 && (
                <span className="absolute top-1 right-1 size-2 rounded-full bg-danger" />
              )}
            </>
          )}
        </NavLink>
        <button
          type="button"
          onClick={activateSearch}
          className={searchRowClass}
          aria-label="Search"
          title={collapsed ? "Search ( / )" : undefined}
        >
          <SearchIcon size={19} />
          {!collapsed && <span>Search</span>}
        </button>
        {onOpenCommandPalette && (
          <button
            type="button"
            onClick={onOpenCommandPalette}
            className={searchRowClass}
            aria-label="Quick Actions"
            title={collapsed ? "Quick Actions (Ctrl+K)" : "Open Command Palette (Ctrl+K)"}
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z" />
            </svg>
            {!collapsed && (
              <>
                <span className="flex-1 text-left">Quick Actions</span>
                <span className="kbd-hint inline-flex" aria-hidden>
                  Ctrl+K
                </span>
              </>
            )}
          </button>
        )}
      </nav>

      <div className="mx-3 my-3 border-t" style={{ borderColor: "var(--border-subtle)" }} />

      {!collapsed && (
        <div className="flex min-h-0 flex-1 flex-col px-3">
          <div className="px-1 pb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Playlists</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2" role="list" aria-label="Your playlists">
            <div role="listitem" className="contents">
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="nav-item relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
              >
                {navTile(<PlusIcon size={14} />)}
                <span>Create Playlist</span>
              </button>
            </div>
            <div role="listitem" className="contents">
              <NavLink to="/liked" className={navClass}>
                {({ isActive }) => (
                  <>
                    {navTile(<HeartIcon size={14} filled={likedCount > 0} className={likedCount > 0 ? "text-text-primary" : ""} />)}
                    <span className={isActive ? "font-medium text-text-primary" : "text-text-secondary"}>Liked Songs</span>
                    {likedCount > 0 && (
                      <span className="ml-auto text-xs text-text-muted tabular-nums">{likedCount}</span>
                    )}
                  </>
                )}
              </NavLink>
            </div>
            {playlists.length === 0 && (
              <p className="px-3 pb-2 pt-1 text-xs text-text-muted">Playlists you create appear here.</p>
            )}
            {playlists.map((playlist) => (
              <SidebarPlaylistRow key={playlist.id} playlist={playlist} />
            ))}
          </div>
        </div>
      )}

      {collapsed && (
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-2 pb-2">
          <button
            type="button"
            className="icon-btn"
            aria-label="Create playlist"
            title="Create playlist"
            onClick={() => setCreating(true)}
          >
            <PlusIcon size={18} />
          </button>
          <NavLink
            to="/liked"
            className="nav-item relative flex items-center justify-center rounded-lg py-2 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
            aria-label="Liked Songs"
            title="Liked Songs"
          >
            <HeartIcon size={19} filled={likedCount > 0} className={likedCount > 0 ? "text-text-primary" : ""} />
          </NavLink>
          {playlists.map((playlist) => (
            <CollapsedPlaylistThumb key={playlist.id} playlist={playlist} />
          ))}
        </div>
      )}

      <div className="border-t" style={{ borderColor: "var(--border-subtle)" }} />
      <nav
        aria-label="Secondary"
        className={`flex flex-col gap-0.5 py-2 ${collapsed ? "items-center px-2" : "px-3"}`}
      >
        {SECONDARY_NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={navClass}
            aria-label={collapsed ? label : undefined}
            title={collapsed ? label : undefined}
          >
            <Icon size={19} />
            {!collapsed && <span>{label}</span>}
          </NavLink>
        ))}
      </nav>

      <CreatePlaylistModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

/** Actual first-track artwork where available, neutral tile otherwise. */
function PlaylistThumb({ playlist, className }: { playlist: Playlist; className?: string }) {
  recordComponentRender("PlaylistThumb");
  const firstTrackId = useLibraryStore(
    (state) => playlist.trackIds.find((id) => state.tracks.some((track) => track.id === id)) ?? null,
  );
  const url = useArtworkUrl(firstTrackId);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  useEffect(() => {
    setFailedUrl(null);
  }, [url]);

  if (!url || failedUrl === url) {
    return (
      <span
        className={`flex items-center justify-center rounded-md bg-surface-raised text-text-muted ${className ?? ""}`}
        aria-hidden
      >
        <MusicNoteIcon size={13} />
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => {
        setFailedUrl(url);
        if (firstTrackId) {
          void handleArtworkImageError(firstTrackId, url);
        }
      }}
      className={`rounded-md object-cover ${className ?? ""}`}
    />
  );
}

/** Collapsed-rail playlist shortcut: artwork square with tooltip. */
const CollapsedPlaylistThumb = memo(function CollapsedPlaylistThumb({ playlist }: { playlist: Playlist }) {
  return (
    <NavLink
      to={`/playlist/${playlist.id}`}
      className="nav-item relative grid size-9 shrink-0 place-items-center rounded-lg transition-colors hover:bg-surface-hover"
      aria-label={playlist.name}
      title={playlist.name}
    >
      <PlaylistThumb playlist={playlist} className="size-7" />
    </NavLink>
  );
});

/** One playlist row: navigates, and reveals a "…" menu (rename/delete) on hover. */
const SidebarPlaylistRow = memo(function SidebarPlaylistRow({ playlist }: { playlist: Playlist }) {
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
        <PlaylistThumb playlist={playlist} className="size-7" />
        <span className="min-w-0 flex-1 truncate">{playlist.name}</span>
      </NavLink>
      <div
        className="absolute right-0.5 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
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
});
