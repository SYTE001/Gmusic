import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlaybackStore } from "../stores/playbackStore";
import { normalizeForSearch } from "../utils/misc";
import type { Track } from "../types";
import { Artwork } from "./Artwork";
import { CloseIcon, LibraryIcon, PlaylistIcon, SearchIcon } from "./Icons";
import { useCloudStore } from "../stores/cloudStore";

/**
 * Local-only search over the indexed library and playlists (PRD §7.10).
 * Never issues network requests. `/` or Ctrl/Cmd+K focuses the input.
 */
export function TopBar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const tracks = useLibraryStore((state) => state.tracks);
  const playlists = useLibraryStore((state) => state.playlists);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (typing) return;
      if (event.key === "/" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k")) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const results = useMemo(() => {
    const normalized = normalizeForSearch(query);
    if (normalized.length === 0) return { tracks: [] as Track[], playlists: playlists.slice(0, 3) };
    const matchedTracks = tracks
      .filter(
        (track) =>
          normalizeForSearch(track.title).includes(normalized) ||
          normalizeForSearch(track.artist).includes(normalized) ||
          normalizeForSearch(track.album).includes(normalized) ||
          normalizeForSearch(track.fileName).includes(normalized),
      )
      .slice(0, 8);
    const matchedPlaylists = playlists.filter((playlist) => normalizeForSearch(playlist.name).includes(normalized)).slice(0, 4);
    return { tracks: matchedTracks, playlists: matchedPlaylists };
  }, [query, tracks, playlists]);

  const showResults = focused && query.trim().length > 0;
  const hasAnyResults = results.tracks.length > 0 || results.playlists.length > 0;

  const playTrack = (track: Track) => {
    const contextTracks = results.tracks.length > 0 ? results.tracks.map((item) => item.id) : [track.id];
    usePlaybackStore.getState().playTrackFromContext(track.id, contextTracks, { type: "search", label: `Search “${query}”` });
  };

  return (
    <header className="sticky top-0 z-30 flex items-center gap-2 border-b bg-app-bg px-4 py-3 md:px-7" style={{ borderColor: "var(--border-subtle)" }}>
      {/* Mobile menu button */}
      <button type="button" className="icon-btn lg:hidden" aria-label="Open navigation" onClick={onOpenSidebar}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>

      <div className="relative flex-1 max-w-xl">
        <div className="flex items-center gap-2.5 rounded-full border bg-surface px-3.5 py-2" style={{ borderColor: "var(--border-subtle)" }}>
          <SearchIcon size={17} className="shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && results.tracks[0]) {
                playTrack(results.tracks[0]);
              }
            }}
            placeholder="Search your library…"
            aria-label="Search your library"
            className="w-full bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button type="button" className="text-text-muted hover:text-text-primary" aria-label="Clear search" onClick={() => setQuery("")}>
              <CloseIcon size={15} />
            </button>
          )}
        </div>

        {showResults && (
          <div
            className="surface-card absolute inset-x-0 top-[calc(100%+6px)] z-40 overflow-hidden py-1.5 shadow-[var(--shadow-overlay)] animate-fade-in"
            role="listbox"
            aria-label="Search results"
          >
            {!hasAnyResults && <p className="px-4 py-3 text-sm text-text-muted">No matches in your library for “{query}”.</p>}
            {results.playlists.length > 0 && (
              <div className="px-4 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Playlists</div>
            )}
            {results.playlists.map((playlist) => (
              <button
                key={playlist.id}
                type="button"
                role="option"
                aria-selected={false}
                className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-text-primary hover:bg-surface-hover"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  navigate(`/playlist/${playlist.id}`);
                  setQuery("");
                }}
              >
                <PlaylistIcon size={16} className="text-text-muted" />
                <span className="truncate">{playlist.name}</span>
                <span className="ml-auto text-xs text-text-muted">{playlist.trackIds.length} songs</span>
              </button>
            ))}
            {results.tracks.length > 0 && (
              <div className="px-4 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Songs</div>
            )}
            {results.tracks.map((track) => (
              <button
                key={track.id}
                type="button"
                role="option"
                aria-selected={false}
                className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface-hover"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  playTrack(track);
                  setQuery("");
                }}
              >
                <Artwork trackId={track.id} alt="" className="size-8 shrink-0" rounded="rounded" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-text-primary">{track.title}</span>
                  <span className="block truncate text-xs text-text-secondary">{track.artist || "Unknown artist"}</span>
                </span>
              </button>
            ))}
            {results.tracks.length > 0 && (
              <button
                type="button"
                className="flex w-full items-center gap-2 border-t px-4 py-2.5 text-left text-xs text-accent hover:bg-surface-hover"
                style={{ borderColor: "var(--border-subtle)" }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  navigate(`/library?q=${encodeURIComponent(query)}`);
                  setQuery("");
                }}
              >
                <LibraryIcon size={14} />
                See all songs in Library
              </button>
            )}
          </div>
        )}
      </div>

      <CloudBadge />
      <OfflineBadge />
    </header>
  );
}

function CloudBadge() {
  const status = useCloudStore((state) => state.status);
  const syncStatus = useCloudStore((state) => state.syncStatus);
  if (status !== "authenticated") return null;
  const label =
    syncStatus === "syncing"
      ? "Syncing your library…"
      : syncStatus === "error"
        ? "Cloud sync failed — your local library is unchanged"
        : "Cloud library connected";
  return (
    <span
      className="hidden shrink-0 items-center gap-1.5 rounded-full bg-surface-raised px-3 py-1.5 text-xs text-text-secondary sm:flex"
      title={label}
      aria-label={label}
    >
      <span
        className={syncStatus === "error" ? "size-1.5 rounded-full bg-danger" : "size-1.5 rounded-full"}
        style={syncStatus === "error" ? undefined : { background: "var(--accent)" }}
        aria-hidden
      />
      {syncStatus === "syncing" ? "Syncing…" : "Cloud"}
    </span>
  );
}

function OfflineBadge() {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  if (online) return null;
  return (
    <span className="hidden shrink-0 items-center gap-1.5 rounded-full bg-surface-raised px-3 py-1.5 text-xs text-text-secondary sm:flex">
      <span className="size-1.5 rounded-full bg-warning-or-fallback" style={{ background: "var(--accent)" }} aria-hidden />
      Offline — your library still works
    </span>
  );
}
