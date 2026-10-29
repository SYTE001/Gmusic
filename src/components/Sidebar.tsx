import { NavLink, useLocation } from "react-router-dom";
import { useLibraryStore } from "../stores/libraryStore";
import { ImportMusicButtons } from "../features/library/ImportMusic";
import {
  HeartIcon,
  HomeIcon,
  LibraryIcon,
  ClockIcon,
  PlaylistIcon,
  SettingsIcon,
  MusicNoteIcon,
} from "./Icons";

const navClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
    isActive ? "bg-surface-raised text-text-primary font-medium" : "text-text-secondary hover:text-text-primary hover:bg-surface-hover"
  }`;

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const playlists = useLibraryStore((state) => state.playlists);
  const likedCount = useLibraryStore((state) => state.tracks.filter((track) => track.isLiked).length);
  const location = useLocation();

  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-1 overflow-y-auto px-3 pb-4" onClick={onNavigate}>
      <NavLink to="/" className={navClass} end onClick={onNavigate}>
        <HomeIcon size={19} />
        Home
      </NavLink>
      <NavLink to="/library" className={navClass} onClick={onNavigate}>
        <LibraryIcon size={19} />
        Library
      </NavLink>
      <NavLink to="/liked" className={navClass} onClick={onNavigate}>
        <HeartIcon size={19} />
        Liked Songs
        {likedCount > 0 && <span className="ml-auto text-xs text-text-muted tabular-nums">{likedCount}</span>}
      </NavLink>
      <NavLink to="/playlists" className={navClass} onClick={onNavigate}>
        <PlaylistIcon size={19} />
        Playlists
      </NavLink>
      <NavLink to="/recent" className={navClass} onClick={onNavigate}>
        <ClockIcon size={19} />
        Recently Played
      </NavLink>

      <div className="my-2 h-px" style={{ background: "var(--border-subtle)" }} />

      <div className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        Import
      </div>
      <ImportMusicButtons variant="compact" />

      <div className="my-2 h-px" style={{ background: "var(--border-subtle)" }} />

      <div className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        Your playlists
      </div>
      {playlists.length === 0 && <p className="px-3 text-xs text-text-muted">Playlists you create appear here.</p>}
      {playlists.slice(0, 6).map((playlist) => (
        <NavLink
          key={playlist.id}
          to={`/playlist/${playlist.id}`}
          className={() =>
            `flex items-center gap-2.5 truncate rounded-lg px-3 py-1.5 text-sm transition-colors ${
              location.pathname === `/playlist/${playlist.id}`
                ? "bg-surface-raised text-text-primary"
                : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
            }`
          }
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface-raised text-accent" aria-hidden>
            <MusicNoteIcon size={14} />
          </span>
          <span className="truncate">{playlist.name}</span>
        </NavLink>
      ))}

      <div className="mt-auto pt-3">
        <NavLink to="/settings" className={navClass} onClick={onNavigate}>
          <SettingsIcon size={19} />
          Settings
        </NavLink>
      </div>
    </nav>
  );
}
