import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useLibraryStore, useTrackById } from "../stores/libraryStore";
import { usePlaybackStore } from "../stores/playbackStore";
import { toast } from "../stores/toastStore";
import { buildCommandCatalog, type CommandDefinition } from "../features/command-palette/commands";
import { searchCommands, searchPlaylists, searchTracks } from "../features/command-palette/search";
import { formatClock } from "../utils/misc";
import type { Playlist, Track } from "../types";
import { Artwork } from "./Artwork";
import {
  ClockIcon,
  CloseIcon,
  ExpandIcon,
  HeartIcon,
  HomeIcon,
  LibraryIcon,
  MusicNoteIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PlaylistIcon,
  PlusIcon,
  PrevIcon,
  QueueIcon,
  RepeatIcon,
  RepeatOneIcon,
  SearchIcon,
  SettingsIcon,
  ShuffleIcon,
  VolumeIcon,
  VolumeMuteIcon,
  WarningIcon,
} from "./Icons";

type PaletteItem =
  | { kind: "command"; id: string; command: CommandDefinition }
  | { kind: "track"; id: string; track: Track }
  | { kind: "playlist"; id: string; playlist: Playlist };

const EMPTY_TRACKS: Track[] = [];
const EMPTY_PLAYLISTS: Playlist[] = [];

function getCommandIcon(cmd: CommandDefinition, isPlaying: boolean, isMuted: boolean, repeatMode: string): ReactNode {
  switch (cmd.id) {
    case "nav-home":
      return <HomeIcon size={16} />;
    case "nav-library":
      return <LibraryIcon size={16} />;
    case "nav-liked":
    case "playback-like-current":
      return <HeartIcon size={16} />;
    case "nav-playlists":
      return <PlaylistIcon size={16} />;
    case "nav-recent":
      return <ClockIcon size={16} />;
    case "nav-broken":
      return <WarningIcon size={16} />;
    case "nav-settings":
      return <SettingsIcon size={16} />;
    case "nav-now-playing":
      return <ExpandIcon size={16} />;
    case "playback-toggle":
      return isPlaying ? <PauseIcon size={16} /> : <PlayIcon size={16} />;
    case "playback-next":
      return <NextIcon size={16} />;
    case "playback-previous":
      return <PrevIcon size={16} />;
    case "playback-shuffle":
    case "playback-random":
      return <ShuffleIcon size={16} />;
    case "playback-repeat":
      return repeatMode === "one" ? <RepeatOneIcon size={16} /> : <RepeatIcon size={16} />;
    case "playback-queue":
      return <QueueIcon size={16} />;
    case "playback-mute":
      return isMuted ? <VolumeMuteIcon size={16} /> : <VolumeIcon size={16} />;
    case "library-create-playlist":
      return <PlusIcon size={16} />;
    default:
      return <MusicNoteIcon size={16} />;
  }
}

export function CommandPalette({
  open,
  onClose,
  queueOpen,
  onToggleQueue,
  onOpenCreatePlaylist,
}: {
  open: boolean;
  onClose: () => void;
  queueOpen: boolean;
  onToggleQueue: () => void;
  onOpenCreatePlaylist: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const tracks = useLibraryStore((state) => (open ? state.tracks : EMPTY_TRACKS));
  const playlists = useLibraryStore((state) => (open ? state.playlists : EMPTY_PLAYLISTS));
  const toggleLike = useLibraryStore((state) => state.toggleLike);

  const currentTrackId = usePlaybackStore((state) => state.currentTrackId);
  const currentTrack = useTrackById(currentTrackId);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const isMuted = usePlaybackStore((state) => state.isMuted);
  const shuffleEnabled = usePlaybackStore((state) => state.shuffleEnabled);
  const repeatMode = usePlaybackStore((state) => state.repeatMode);

  const catalog = useMemo(
    () =>
      open
        ? buildCommandCatalog({
            navigate: (to) => navigate(to),
            toggleQueue: onToggleQueue,
            openCreatePlaylist: onOpenCreatePlaylist,
            currentTrack: currentTrack ?? null,
            tracks,
            isPlaying,
            isMuted,
            shuffleEnabled,
            repeatMode,
            queueOpen,
            togglePlay: () => usePlaybackStore.getState().togglePlay(),
            nextTrack: () => usePlaybackStore.getState().next(true),
            previousTrack: () => usePlaybackStore.getState().previous(),
            toggleShuffle: () => usePlaybackStore.getState().toggleShuffle(),
            cycleRepeat: () => usePlaybackStore.getState().cycleRepeat(),
            toggleMute: () => usePlaybackStore.getState().toggleMute(),
            toggleLike: (id) => toggleLike(id),
            playTrackFromContext: (trackId, contextIds, ctx) =>
              usePlaybackStore.getState().playTrackFromContext(trackId, contextIds, ctx),
            notifyInfo: (msg) => toast("info", msg),
          })
        : [],
    [
      open,
      navigate,
      onToggleQueue,
      onOpenCreatePlaylist,
      currentTrack,
      tracks,
      isPlaying,
      isMuted,
      shuffleEnabled,
      repeatMode,
      queueOpen,
      toggleLike,
    ],
  );

  const results = useMemo(() => {
    if (!open) return { commands: [] as CommandDefinition[], tracks: [] as Track[], playlists: [] as Playlist[] };
    const matchedCommands = searchCommands(catalog, query);
    const matchedTracks = searchTracks(tracks, query, 8);
    const matchedPlaylists = searchPlaylists(playlists, query, 5);
    return {
      commands: matchedCommands,
      tracks: matchedTracks,
      playlists: matchedPlaylists,
    };
  }, [open, catalog, tracks, playlists, query]);

  const flatItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];
    for (const cmd of results.commands) {
      items.push({ kind: "command", id: `cmd-${cmd.id}`, command: cmd });
    }
    for (const track of results.tracks) {
      items.push({ kind: "track", id: `track-${track.id}`, track });
    }
    for (const playlist of results.playlists) {
      items.push({ kind: "playlist", id: `playlist-${playlist.id}`, playlist });
    }
    return items;
  }, [results]);

  // Reset state and manage focus when opened / closed
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    setQuery("");
    setSelectedIndex(0);
    inputRef.current?.focus();

    return () => {
      const target = restoreFocusRef.current;
      if (target && document.body.contains(target)) {
        target.focus();
      }
    };
  }, [open]);

  // Keep selectedIndex in bounds when results change
  useEffect(() => {
    if (selectedIndex >= flatItems.length) {
      setSelectedIndex(Math.max(0, flatItems.length - 1));
    }
  }, [flatItems.length, selectedIndex]);

  // Scroll active option into view on keyboard navigation
  useEffect(() => {
    if (!open) return;
    const activeItem = flatItems[selectedIndex];
    if (!activeItem || !listRef.current) return;
    const optionEl = listRef.current.querySelector<HTMLElement>(`[data-palette-option="${activeItem.id}"]`);
    if (optionEl && typeof optionEl.scrollIntoView === "function") {
      optionEl.scrollIntoView({ block: "nearest" });
    }
  }, [open, selectedIndex, flatItems]);

  const activateItem = async (item: PaletteItem) => {
    try {
      if (item.kind === "command") {
        if (item.command.disabled) {
          toast("info", item.command.disabledReason ?? "This command is currently unavailable.");
          return;
        }
        const isCreatePlaylist = item.command.id === "library-create-playlist";
        if (isCreatePlaylist) {
          // Close palette first without stealing focus back from the newly opened modal
          restoreFocusRef.current = null;
          onClose();
          await item.command.execute();
          return;
        }
        await item.command.execute();
        onClose();
        return;
      }

      if (item.kind === "track") {
        const contextIds =
          query.trim().length > 0 && results.tracks.length > 0
            ? results.tracks.map((t) => t.id)
            : tracks.length > 0
              ? tracks.map((t) => t.id)
              : [item.track.id];
        const contextLabel = query.trim().length > 0 ? `Search “${query.trim()}”` : "All songs";
        usePlaybackStore.getState().playTrackFromContext(item.track.id, contextIds, {
          type: query.trim().length > 0 ? "search" : "library",
          label: contextLabel,
        });
        onClose();
        return;
      }

      if (item.kind === "playlist") {
        navigate(`/playlist/${item.playlist.id}`);
        onClose();
      }
    } catch {
      toast("error", "Could not run that action.");
    }
  };

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key === "Tab" && dialogRef.current) {
        const focusables = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            "input, button, [href], select, textarea, [tabindex]:not([tabindex='-1'])",
          ),
        ).filter((el) => !el.hasAttribute("disabled"));
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  const activeItem = flatItems[selectedIndex];
  const itemIndexMap = new Map<string, number>();
  flatItems.forEach((entry, idx) => itemIndexMap.set(entry.id, idx));

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-2 pt-4 sm:p-4 sm:pt-[11vh]"
      style={{ background: "var(--scrim)" }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command Palette"
        className="surface-card flex max-h-[88dvh] w-full max-w-[600px] flex-col overflow-hidden rounded-2xl shadow-[var(--shadow-overlay)] animate-fade-in sm:max-h-[72vh]"
        style={{ background: "var(--surface)", borderColor: "var(--border-subtle)" }}
      >
        {/* Top search bar */}
        <div
          className="flex shrink-0 items-center gap-3 border-b px-4 py-3"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <SearchIcon size={18} className="shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-listbox"
            aria-activedescendant={activeItem ? `palette-opt-${activeItem.id}` : undefined}
            aria-autocomplete="list"
            aria-label="Search songs, playlists, or commands"
            placeholder="Search songs, playlists, or type a command…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                if (flatItems.length > 0) {
                  setSelectedIndex((prev) => (prev + 1) % flatItems.length);
                }
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                if (flatItems.length > 0) {
                  setSelectedIndex((prev) => (prev - 1 + flatItems.length) % flatItems.length);
                }
              } else if (event.key === "Enter") {
                event.preventDefault();
                const current = flatItems[selectedIndex];
                if (current) {
                  void activateItem(current);
                }
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted sm:text-[15px]"
          />
          {query && (
            <button
              type="button"
              className="icon-btn size-7 text-text-muted hover:text-text-primary"
              aria-label="Clear query"
              onClick={() => {
                setQuery("");
                setSelectedIndex(0);
                inputRef.current?.focus();
              }}
            >
              <CloseIcon size={15} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn size-8 shrink-0 text-text-secondary hover:text-text-primary"
            aria-label="Close Command Palette"
            title="Close (Esc)"
            onClick={onClose}
          >
            <CloseIcon size={17} />
          </button>
        </div>

        {/* Scrollable results list */}
        <div
          id="command-palette-listbox"
          ref={listRef}
          role="listbox"
          aria-label="Command palette results"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
        >
          {flatItems.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-medium text-text-primary">No results for “{query}”</p>
              <p className="mt-1 text-xs text-text-muted">
                Try searching by song title, artist, album, playlist name, or command like “Play”, “Queue”, or “Settings”.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {results.commands.length > 0 && (
                <div>
                  <div className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    Commands
                  </div>
                  {results.commands.map((cmd) => {
                    const itemId = `cmd-${cmd.id}`;
                    const index = itemIndexMap.get(itemId) ?? 0;
                    const selected = index === selectedIndex;
                    return (
                      <div
                        key={itemId}
                        id={`palette-opt-${itemId}`}
                        data-palette-option={itemId}
                        role="option"
                        aria-selected={selected}
                        aria-disabled={cmd.disabled || undefined}
                        onMouseMove={() => {
                          if (selectedIndex !== index) setSelectedIndex(index);
                        }}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => void activateItem({ kind: "command", id: itemId, command: cmd })}
                        className={`flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors select-none ${
                          selected ? "bg-surface-hover text-text-primary" : "text-text-primary hover:bg-surface-hover/60"
                        } ${cmd.disabled ? "opacity-50" : ""}`}
                      >
                        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-raised text-text-secondary" aria-hidden>
                          {getCommandIcon(cmd, isPlaying, isMuted, repeatMode)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{cmd.label}</span>
                          {cmd.disabled && cmd.disabledReason && (
                            <span className="block truncate text-[11px] text-text-muted">{cmd.disabledReason}</span>
                          )}
                        </span>
                        <span className="shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium text-text-muted" style={{ borderColor: "var(--border-subtle)" }}>
                          {cmd.category}
                        </span>
                        {cmd.shortcut && (
                          <span className="kbd-hint hidden sm:inline-flex" aria-hidden>
                            {cmd.shortcut}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {results.tracks.length > 0 && (
                <div>
                  <div className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    Tracks
                  </div>
                  {results.tracks.map((track) => {
                    const itemId = `track-${track.id}`;
                    const index = itemIndexMap.get(itemId) ?? 0;
                    const selected = index === selectedIndex;
                    return (
                      <div
                        key={itemId}
                        id={`palette-opt-${itemId}`}
                        data-palette-option={itemId}
                        role="option"
                        aria-selected={selected}
                        onMouseMove={() => {
                          if (selectedIndex !== index) setSelectedIndex(index);
                        }}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => void activateItem({ kind: "track", id: itemId, track })}
                        className={`flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors select-none ${
                          selected ? "bg-surface-hover text-text-primary" : "text-text-primary hover:bg-surface-hover/60"
                        }`}
                      >
                        <Artwork trackId={track.id} alt="" className="size-8 shrink-0" rounded="rounded-md" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-text-primary">{track.title}</span>
                          <span className="block truncate text-xs text-text-secondary">
                            {track.artist || "Unknown artist"}
                            {track.album ? ` · ${track.album}` : ""}
                          </span>
                        </span>
                        {track.durationMs !== null && (
                          <span className="shrink-0 text-xs tabular-nums text-text-muted">{formatClock(track.durationMs)}</span>
                        )}
                        <span className="shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium text-text-muted" style={{ borderColor: "var(--border-subtle)" }}>
                          Track
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {results.playlists.length > 0 && (
                <div>
                  <div className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    Playlists
                  </div>
                  {results.playlists.map((playlist) => {
                    const itemId = `playlist-${playlist.id}`;
                    const index = itemIndexMap.get(itemId) ?? 0;
                    const selected = index === selectedIndex;
                    return (
                      <div
                        key={itemId}
                        id={`palette-opt-${itemId}`}
                        data-palette-option={itemId}
                        role="option"
                        aria-selected={selected}
                        onMouseMove={() => {
                          if (selectedIndex !== index) setSelectedIndex(index);
                        }}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => void activateItem({ kind: "playlist", id: itemId, playlist })}
                        className={`flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors select-none ${
                          selected ? "bg-surface-hover text-text-primary" : "text-text-primary hover:bg-surface-hover/60"
                        }`}
                      >
                        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-raised text-text-secondary" aria-hidden>
                          <PlaylistIcon size={16} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-text-primary">{playlist.name}</span>
                          <span className="block truncate text-xs text-text-muted">{playlist.trackIds.length} songs</span>
                        </span>
                        <span className="shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium text-text-muted" style={{ borderColor: "var(--border-subtle)" }}>
                          Playlist
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer hints */}
        <div
          className="hidden shrink-0 items-center justify-between border-t px-4 py-2 text-[11px] text-text-muted sm:flex"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <div className="flex items-center gap-3">
            <span>
              <kbd className="kbd-hint mr-1 inline-flex">↑</kbd>
              <kbd className="kbd-hint mr-1 inline-flex">↓</kbd>
              Navigate
            </span>
            <span>
              <kbd className="kbd-hint mr-1 inline-flex">↵</kbd>
              Run
            </span>
            <span>
              <kbd className="kbd-hint mr-1 inline-flex">Esc</kbd>
              Close
            </span>
          </div>
          <span>Local search & quick actions</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
