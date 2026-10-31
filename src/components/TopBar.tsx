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
 *
 * Rendered once per visible layout region (desktop sidebar / mobile top
 * bar); the global shortcut only focuses the instance that is actually
 * visible, so the two never fight.
 */
export function SearchField({ inTopBar = false }: { inTopBar?: boolean }) {
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
        // Skip instances hidden by the responsive layout swap (display:none
        // subtrees report a null offsetParent).
        const input = inputRef.current;
        if (!input || input.offsetParent === null) return;
        event.preventDefault();
        input.focus();
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
    <div className={`relative ${inTopBar ? "flex-1" : "w-full"}`}>
      <div
        className="flex items-center gap-2.5 rounded-lg border bg-surface-raised px-3 py-2 transition-colors focus-within:border-accent"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <SearchIcon size={16} className="shrink-0 text-text-muted" />
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
          title="Search — press / or Ctrl+K to focus"
          className="w-full bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted [&::-webkit-search-cancel-button]:hidden"
        />
        {!query && (
          <span className="kbd-hint hidden min-[900px]:inline-flex" aria-hidden>
            /
          </span>
        )}
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
  );
}

/**
 * Mobile-only top strip: navigation drawer trigger, library search, and the
 * cloud/offline status badges. Hidden from the 900px breakpoint up, where
 * search and status live in the sidebar.
 */
export function MobileTopBar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  return (
    <header
      className="sticky top-0 z-30 flex min-[900px]:hidden items-center gap-2 border-b bg-app-bg px-3 py-2.5"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      <button type="button" className="icon-btn" aria-label="Open navigation" onClick={onOpenSidebar}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      <SearchField inTopBar />
      <CloudBadge />
      <OfflineBadge />
    </header>
  );
}

/** Cloud status chip. Appears only when signed in to the optional cloud mode. */
export function CloudBadge({ compact = false }: { compact?: boolean }) {
  const status = useCloudStore((state) => state.status);
  const syncStatus = useCloudStore((state) => state.syncStatus);
  if (status !== "authenticated") return null;
  const label =
    syncStatus === "syncing"
      ? "Syncing your library…"
      : syncStatus === "error"
        ? "Cloud sync failed — your local library is unchanged"
        : "Cloud library connected";
  if (compact) {
    return (
      <div className="flex items-center gap-2 px-3 py-1 text-xs text-text-secondary" title={label} aria-label={label}>
        <span
          className={syncStatus === "error" ? "size-1.5 rounded-full bg-danger" : "size-1.5 rounded-full"}
          style={syncStatus === "error" ? undefined : { background: "var(--accent)" }}
          aria-hidden
        />
        {syncStatus === "syncing" ? "Syncing…" : "Cloud connected"}
      </div>
    );
  }
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

/** Offline indicator; shown only while the device is offline. */
export function OfflineBadge({ compact = false }: { compact?: boolean }) {
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
  const label = "Offline — your library still works";
  if (compact) {
    return (
      <div className="flex items-center gap-2 px-3 py-1 text-xs text-text-secondary" title={label} aria-label={label}>
        <span className="size-1.5 rounded-full" style={{ background: "var(--accent)" }} aria-hidden />
        Offline
      </div>
    );
  }
  return (
    <span className="hidden shrink-0 items-center gap-1.5 rounded-full bg-surface-raised px-3 py-1.5 text-xs text-text-secondary sm:flex">
      <span className="size-1.5 rounded-full" style={{ background: "var(--accent)" }} aria-hidden />
      {label}
    </span>
  );
}
