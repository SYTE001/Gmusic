import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLibraryStore, useTrackById } from "../stores/libraryStore";
import { usePlaybackStore } from "../stores/playbackStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useLyricsStore } from "../stores/lyricsStore";
import { repository } from "../services/indexeddb/LibraryRepository";
import { findActiveLineIndex } from "../services/lyrics/lyricsService";
import { recordComponentRender } from "../utils/perf";
import { formatClock } from "../utils/misc";
import type { MiniPlayerMode, Track, TrackLyrics } from "../types";
import { Artwork } from "./Artwork";
import { SeekBar } from "./SeekBar";
import { TransportToggle } from "./TransportToggle";
import { Menu, type MenuItemSpec } from "./Menu";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ExpandIcon,
  HeartIcon,
  LyricsIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  QueueIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
  VolumeIcon,
  VolumeLowIcon,
  VolumeMuteIcon,
} from "./Icons";

export const DESKTOP_MINI_PLAYER_BREAKPOINT_PX = 900;

export type ResolvedMiniPlayerMode = "compact" | "standard" | "expanded";

export function resolveMiniPlayerMode(mode: MiniPlayerMode, isDesktop: boolean): ResolvedMiniPlayerMode {
  if (mode === "auto") {
    return isDesktop ? "standard" : "compact";
  }
  if (mode === "expanded" && !isDesktop) {
    return "standard";
  }
  return mode;
}

function getIsDesktopViewport(): boolean {
  if (typeof window === "undefined") return true;
  if (typeof window.innerWidth === "number" && window.innerWidth > 0) {
    return window.innerWidth >= DESKTOP_MINI_PLAYER_BREAKPOINT_PX;
  }
  if (typeof window.matchMedia === "function") {
    return window.matchMedia(`(min-width: ${DESKTOP_MINI_PLAYER_BREAKPOINT_PX}px)`).matches;
  }
  return true;
}

export function useIsDesktopMiniPlayer(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(getIsDesktopViewport);

  useEffect(() => {
    const update = () => setIsDesktop(getIsDesktopViewport());
    update();
    window.addEventListener("resize", update);
    const mql =
      typeof window.matchMedia === "function"
        ? window.matchMedia(`(min-width: ${DESKTOP_MINI_PLAYER_BREAKPOINT_PX}px)`)
        : null;
    mql?.addEventListener?.("change", update);
    return () => {
      window.removeEventListener("resize", update);
      mql?.removeEventListener?.("change", update);
    };
  }, []);

  return isDesktop;
}

/**
 * Isolated thin progress line for Compact mode. Subscribes directly to the
 * playback store's currentTimeMs / durationMs without causing MiniPlayer or
 * AppShell re-renders on every tick.
 */
function CompactProgressLine() {
  const durationMs = usePlaybackStore((state) => state.durationMs);
  const fillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const apply = (currentTimeMs: number) => {
      const dur = durationMs ?? 0;
      const frac = dur > 0 ? Math.min(1, Math.max(0, currentTimeMs / dur)) : 0;
      const safeFrac = Number.isFinite(frac) ? frac : 0;
      if (fillRef.current) {
        fillRef.current.style.transform = `scaleX(${safeFrac})`;
      }
    };
    apply(usePlaybackStore.getState().currentTimeMs);
    return usePlaybackStore.subscribe((state) => {
      apply(state.currentTimeMs);
    });
  }, [durationMs]);

  return (
    <div className="pointer-events-none absolute inset-x-4 bottom-0 h-0.5 overflow-hidden rounded-full bg-surface-hover" aria-hidden="true">
      <div
        ref={fillRef}
        className="h-full w-full origin-left bg-accent transition-transform duration-150 ease-out"
        style={{ transform: "scaleX(0)", willChange: "transform" }}
      />
    </div>
  );
}

/**
 * Isolated 1–2 line lyrics preview for Expanded mode. Reads only already-cached
 * lyrics from the repository and never initiates a network lookup when opened.
 */
function ExpandedLyricsPreview({ trackId, onOpenLyrics }: { trackId: string | null; onOpenLyrics: () => void }) {
  const lyricsVersion = useLyricsStore((state) => state.lyricsVersion);
  const [lyrics, setLyrics] = useState<TrackLyrics | null>(null);
  const [loadedForTrackId, setLoadedForTrackId] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState<number>(-1);

  useEffect(() => {
    let cancelled = false;
    if (!trackId) {
      setLyrics(null);
      setLoadedForTrackId(null);
      setActiveIndex(-1);
      return;
    }
    void repository
      .getLyrics(trackId)
      .then((doc) => {
        if (cancelled) return;
        setLyrics(doc ?? null);
        setLoadedForTrackId(trackId);
      })
      .catch(() => {
        if (cancelled) return;
        setLyrics(null);
        setLoadedForTrackId(trackId);
      });
    return () => {
      cancelled = true;
    };
  }, [trackId, lyricsVersion]);

  useEffect(() => {
    if (!lyrics || lyrics.format !== "lrc" || lyrics.lines.length === 0) {
      setActiveIndex(-1);
      return;
    }
    const updateLine = (timeMs: number) => {
      const idx = findActiveLineIndex(lyrics.lines, timeMs, lyrics.offsetMs);
      setActiveIndex((prev) => (prev === idx ? prev : idx));
    };
    updateLine(usePlaybackStore.getState().currentTimeMs);
    return usePlaybackStore.subscribe((state) => {
      updateLine(state.currentTimeMs);
    });
  }, [lyrics]);

  const currentDoc = loadedForTrackId === trackId ? lyrics : null;
  const isInstrumental = currentDoc?.origin?.capability === "instrumental";
  const hasLines = Boolean(currentDoc && currentDoc.lines.length > 0 && !isInstrumental);

  const effectiveActiveIndex =
    activeIndex >= 0
      ? activeIndex
      : currentDoc && currentDoc.format === "lrc" && currentDoc.lines.length > 0
        ? findActiveLineIndex(currentDoc.lines, usePlaybackStore.getState().currentTimeMs, currentDoc.offsetMs)
        : -1;

  let previewLines: string[] = [];
  if (hasLines && currentDoc) {
    if (currentDoc.format === "lrc") {
      const startIdx = effectiveActiveIndex >= 0 ? effectiveActiveIndex : 0;
      previewLines = currentDoc.lines
        .slice(startIdx, startIdx + 2)
        .map((l) => l.text.trim())
        .filter(Boolean);
    } else {
      previewLines = currentDoc.lines
        .slice(0, 2)
        .map((l) => l.text.trim())
        .filter(Boolean);
    }
  }

  return (
    <button
      type="button"
      onClick={onOpenLyrics}
      disabled={!trackId}
      aria-label="Open full lyrics"
      className="group flex min-w-0 flex-1 flex-col justify-center rounded-xl border px-3.5 py-2.5 text-left transition-colors hover:bg-surface-hover disabled:cursor-default disabled:hover:bg-transparent"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          <LyricsIcon size={13} />
          Lyrics
        </span>
        <span className="text-[11px] text-text-muted opacity-0 transition-opacity group-hover:opacity-100">
          Open lyrics
        </span>
      </div>
      {isInstrumental ? (
        <p className="truncate text-xs text-text-muted">Instrumental track</p>
      ) : previewLines.length > 0 ? (
        <div className="space-y-0.5">
          <p className="truncate text-sm font-medium text-text-primary">{previewLines[0]}</p>
          {previewLines[1] && <p className="truncate text-xs text-text-secondary">{previewLines[1]}</p>}
        </div>
      ) : (
        <p className="truncate text-xs text-text-muted">Lyrics not available</p>
      )}
    </button>
  );
}

const EMPTY_TRACKS: Track[] = [];

/**
 * Preview of up to 3 upcoming tracks from the active queue for Expanded mode.
 */
function ExpandedQueuePreview({ onOpenQueue }: { onOpenQueue: () => void }) {
  const queueTrackIds = usePlaybackStore((state) => state.queueTrackIds);
  const queueIndex = usePlaybackStore((state) => state.queueIndex);
  const tracks = useLibraryStore((state) => (queueTrackIds.length > 0 ? state.tracks : EMPTY_TRACKS));

  const upcomingTracks = useMemo(() => {
    if (queueTrackIds.length === 0 || queueIndex < 0) return EMPTY_TRACKS;
    const nextIds = queueTrackIds.slice(queueIndex + 1, queueIndex + 4);
    if (nextIds.length === 0) return EMPTY_TRACKS;
    const byId = new Map(tracks.map((t) => [t.id, t]));
    return nextIds.map((id) => byId.get(id)).filter((t): t is Track => Boolean(t));
  }, [queueTrackIds, queueIndex, tracks]);

  return (
    <div
      onClick={onOpenQueue}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenQueue();
        }
      }}
      aria-label="Open queue panel"
      className="group flex min-w-0 flex-1 cursor-pointer flex-col justify-center rounded-xl border px-3.5 py-2.5 text-left transition-colors hover:bg-surface-hover"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          <QueueIcon size={13} />
          Up Next
        </span>
        <span className="text-[11px] text-text-muted opacity-0 transition-opacity group-hover:opacity-100">
          Open queue
        </span>
      </div>
      {upcomingTracks.length === 0 ? (
        <p className="truncate text-xs text-text-muted">No upcoming tracks in queue</p>
      ) : (
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-3 sm:gap-2">
          {upcomingTracks.map((item) => (
            <div key={item.id} className="flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-0.5">
              <Artwork trackId={item.id} alt="" className="size-6 shrink-0" rounded="rounded" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-text-primary">{item.title}</div>
                <div className="truncate text-[11px] text-text-secondary">{item.artist || "Unknown artist"}</div>
              </div>
              {item.durationMs !== null && (
                <span className="shrink-0 text-[10px] tabular-nums text-text-muted">{formatClock(item.durationMs)}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const MODE_LABELS: Record<MiniPlayerMode, string> = {
  auto: "Auto",
  compact: "Compact",
  standard: "Standard",
  expanded: "Expanded",
};

/**
 * Persistent bottom player bar, docked across all routes (PRD §7.9) with
 * adaptive presentation modes: Compact, Standard, and Expanded (desktop dock).
 * Mounted once in the shell so route changes and mode changes never restart
 * playback; high-frequency time state is isolated to the SeekBar / preview subtrees.
 */
export function MiniPlayer({ onToggleQueue, queueOpen }: { onToggleQueue: () => void; queueOpen: boolean }) {
  recordComponentRender("MiniPlayer");
  const navigate = useNavigate();
  const currentTrackId = usePlaybackStore((state) => state.currentTrackId);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const isBuffering = usePlaybackStore((state) => state.isBuffering);
  const status = usePlaybackStore((state) => state.status);
  const shuffleEnabled = usePlaybackStore((state) => state.shuffleEnabled);
  const repeatMode = usePlaybackStore((state) => state.repeatMode);
  const isMuted = usePlaybackStore((state) => state.isMuted);
  const track = useTrackById(currentTrackId);
  const toggleLike = useLibraryStore((state) => state.toggleLike);

  const miniPlayerMode = useSettingsStore((state) => state.prefs.miniPlayerMode ?? "auto");
  const updateSettings = useSettingsStore((state) => state.update);
  const isDesktop = useIsDesktopMiniPlayer();
  const resolvedMode = resolveMiniPlayerMode(miniPlayerMode, isDesktop);

  if (!track && status === "idle") return null;

  const controlsDisabled = !track;

  const setPlayerMode = (nextMode: MiniPlayerMode) => {
    if (nextMode === "expanded" && !isDesktop) {
      navigate("/now-playing");
      return;
    }
    updateSettings({ miniPlayerMode: nextMode });
  };

  const buildModeMenuItems = (includeOverflowControls: boolean): MenuItemSpec[] => {
    const items: MenuItemSpec[] = [];

    if (includeOverflowControls) {
      items.push(
        { kind: "heading", label: "Playback Controls" },
        {
          kind: "action",
          label: track?.isLiked ? "Remove from Liked Songs" : "Add to Liked Songs",
          icon: <HeartIcon size={15} filled={Boolean(track?.isLiked)} />,
          onSelect: () => {
            if (track) void toggleLike(track.id);
          },
        },
        {
          kind: "action",
          label: shuffleEnabled ? "Disable shuffle" : "Enable shuffle",
          icon: <ShuffleIcon size={15} />,
          onSelect: () => usePlaybackStore.getState().toggleShuffle(),
        },
        {
          kind: "action",
          label: `Repeat: ${repeatMode === "one" ? "One" : repeatMode === "all" ? "All" : "Off"}`,
          icon: repeatMode === "one" ? <RepeatOneIcon size={15} /> : <RepeatIcon size={15} />,
          onSelect: () => usePlaybackStore.getState().cycleRepeat(),
        },
        {
          kind: "action",
          label: "Open Lyrics",
          icon: <LyricsIcon size={15} />,
          onSelect: () => {
            if (track) navigate("/now-playing?lyrics=1");
          },
        },
        {
          kind: "action",
          label: queueOpen ? "Close Queue" : "Open Queue",
          icon: <QueueIcon size={15} />,
          onSelect: onToggleQueue,
        },
        {
          kind: "action",
          label: isMuted ? "Unmute" : "Mute",
          icon: isMuted ? <VolumeMuteIcon size={15} /> : <VolumeIcon size={15} />,
          onSelect: () => usePlaybackStore.getState().toggleMute(),
        },
        {
          kind: "action",
          label: "Open Now Playing",
          icon: <ExpandIcon size={15} />,
          onSelect: () => {
            if (track) navigate("/now-playing");
          },
        },
        { kind: "separator" },
      );
    }

    items.push(
      { kind: "heading", label: "Mini Player Mode" },
      ...(["auto", "compact", "standard", "expanded"] as const).map(
        (m): MenuItemSpec => ({
          kind: "action",
          label: m === "auto" ? `Auto (${isDesktop ? "Standard" : "Compact"})` : MODE_LABELS[m],
          icon: miniPlayerMode === m ? <CheckIcon size={15} /> : null,
          onSelect: () => setPlayerMode(m),
        }),
      ),
    );

    return items;
  };

  const activeModeLabel =
    miniPlayerMode === "auto"
      ? `Auto (${MODE_LABELS[resolvedMode]})`
      : MODE_LABELS[miniPlayerMode];

  if (resolvedMode === "compact") {
    return (
      <div
        className="relative z-20 px-2 pb-2 md:px-3 md:pb-2.5"
        data-mini-player-mode="compact"
        data-mini-player-pref={miniPlayerMode}
      >
        <div className="relative mx-auto flex h-13 max-w-[1600px] items-center justify-between gap-2 rounded-[22px] bg-surface px-3 shadow-[0_8px_24px_rgba(0,0,0,0.22)] transition-[height,padding] duration-180 ease-out md:px-4">
          {/* Left: compact artwork + title/artist */}
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
            onClick={() => navigate("/now-playing")}
            aria-label="Open Now Playing"
            disabled={!track}
          >
            <div className="relative shrink-0">
              <Artwork trackId={track?.id} alt="" className="size-9 md:size-10" rounded="rounded-md" />
              {isBuffering && (
                <span className="absolute inset-0 grid place-items-center rounded-md bg-black/40 text-[10px] text-text-primary" aria-hidden>
                  …
                </span>
              )}
            </div>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold text-text-primary sm:text-sm">
                {track?.title ?? "Nothing playing"}
              </span>
              <span className="block truncate text-[11px] text-text-secondary">
                {track?.artist || (track ? "Unknown artist" : "Pick a song to begin")}
              </span>
            </span>
          </button>

          {/* Right: Play/Pause, Next, Open Now Playing, and overflow menu */}
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="grid size-9 place-items-center rounded-full bg-accent text-accent-contrast transition-transform hover:scale-105 active:scale-95 disabled:opacity-40 disabled:hover:scale-100"
              title="Play/Pause (Space)"
              aria-label={isPlaying ? "Pause" : "Play"}
              onClick={() => usePlaybackStore.getState().togglePlay()}
              disabled={controlsDisabled}
            >
              {isPlaying ? <PauseIcon size={17} /> : <PlayIcon size={17} />}
            </button>
            <button
              type="button"
              className="icon-btn size-8"
              title="Next (Shift+→)"
              aria-label="Next track"
              onClick={() => usePlaybackStore.getState().next(true)}
              disabled={controlsDisabled}
            >
              <NextIcon size={17} />
            </button>
            <button
              type="button"
              className="icon-btn hidden size-8 sm:inline-flex"
              title="Expand to full player"
              aria-label="Expand to full player"
              onClick={() => navigate("/now-playing")}
              disabled={!track}
            >
              <ExpandIcon size={16} />
            </button>
            <Menu
              buttonLabel={`Player options and mode (${activeModeLabel})`}
              items={() => buildModeMenuItems(true)}
            />
          </div>

          {track && <CompactProgressLine />}
        </div>
      </div>
    );
  }

  const isExpanded = resolvedMode === "expanded";

  return (
    <div
      className="relative z-20 px-2 pb-2 md:px-3 md:pb-3"
      data-mini-player-mode={resolvedMode}
      data-mini-player-pref={miniPlayerMode}
    >
      <div
        className={`mx-auto flex max-w-[1600px] flex-col rounded-[28px] bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.22)] transition-[padding,border-radius] duration-180 ease-out ${
          isExpanded ? "gap-3 px-4 py-3.5 md:px-6 md:py-4" : "px-3 md:px-5"
        }`}
      >
        {/* Expanded Dock Top Area: Lyrics Preview & Up Next Queue Preview */}
        {isExpanded && (
          <div className="flex flex-col gap-2.5 border-b pb-3 md:flex-row md:items-stretch md:gap-4" style={{ borderColor: "var(--border-subtle)" }}>
            <ExpandedLyricsPreview
              trackId={track?.id ?? null}
              onOpenLyrics={() => navigate("/now-playing?lyrics=1")}
            />
            <ExpandedQueuePreview onOpenQueue={onToggleQueue} />
          </div>
        )}

        {/* Main Transport Row */}
        <div className={`flex items-center gap-1 md:gap-4 ${isExpanded ? "min-h-14" : "h-16 md:h-[72px]"}`}>
          {/* Left zone: artwork + title/artist + like */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 md:w-[30%] md:flex-none md:gap-2">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
              onClick={() => navigate("/now-playing")}
              aria-label="Open Now Playing"
              disabled={!track}
            >
              <div className="relative shrink-0">
                <Artwork
                  trackId={track?.id}
                  alt=""
                  className={isExpanded ? "size-14 md:size-15" : "size-11 md:size-12"}
                  rounded={isExpanded ? "rounded-lg" : "rounded-md"}
                />
                {isBuffering && (
                  <span className="absolute inset-0 grid place-items-center rounded-md bg-black/40 text-[10px] text-text-primary" aria-hidden>
                    …
                  </span>
                )}
              </div>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-text-primary">{track?.title ?? "Nothing playing"}</span>
                <span className="block truncate text-xs text-text-secondary">
                  {track?.artist || (track ? "Unknown artist" : "Pick a song to begin")}
                </span>
                {isExpanded && track?.album && (
                  <span className="block truncate text-[11px] text-text-muted">{track.album}</span>
                )}
              </span>
            </button>
            {track && (
              <button
                type="button"
                className="icon-btn shrink-0"
                title="Like (L)"
                aria-label={track.isLiked ? "Remove from liked songs" : "Add to liked songs"}
                aria-pressed={track.isLiked}
                onClick={() => void toggleLike(track.id)}
              >
                <HeartIcon size={17} filled={track.isLiked} className={track.isLiked ? "text-accent" : ""} />
              </button>
            )}
          </div>

          {/* Center zone: transport */}
          <div className="flex flex-none items-center justify-center gap-0.5 md:flex-1 md:gap-2">
            <TransportToggle
              className="hidden sm:inline-flex"
              active={shuffleEnabled}
              label={shuffleEnabled ? "Disable shuffle" : "Enable shuffle"}
              title="Shuffle (S)"
              onClick={() => usePlaybackStore.getState().toggleShuffle()}
            >
              <ShuffleIcon size={17} />
            </TransportToggle>
            <button
              type="button"
              className="icon-btn"
              title="Previous (Shift+←)"
              aria-label="Previous track"
              onClick={() => usePlaybackStore.getState().previous()}
              disabled={controlsDisabled}
            >
              <PrevIcon size={19} />
            </button>
            <button
              type="button"
              className="grid size-12 place-items-center rounded-full bg-accent text-accent-contrast transition-transform hover:scale-105 active:scale-95 disabled:opacity-40 disabled:hover:scale-100"
              title="Play/Pause (Space)"
              aria-label={isPlaying ? "Pause" : "Play"}
              onClick={() => usePlaybackStore.getState().togglePlay()}
              disabled={controlsDisabled}
            >
              {isPlaying ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Next (Shift+→)"
              aria-label="Next track"
              onClick={() => usePlaybackStore.getState().next(true)}
              disabled={controlsDisabled}
            >
              <NextIcon size={19} />
            </button>
            <TransportToggle
              className="hidden sm:inline-flex"
              active={repeatMode !== "off"}
              label={
                repeatMode === "one"
                  ? "Repeat one — click for off"
                  : repeatMode === "all"
                    ? "Repeat all — click for repeat one"
                    : "Enable repeat all"
              }
              title="Repeat (R)"
              onClick={() => usePlaybackStore.getState().cycleRepeat()}
            >
              {repeatMode === "one" ? <RepeatOneIcon size={17} /> : <RepeatIcon size={17} />}
            </TransportToggle>
          </div>

          {/* Right zone: lyrics, queue, time/seek, volume, expand, mode menu */}
          <div className="flex min-w-0 flex-1 items-center justify-end gap-0.5 sm:gap-1 md:w-[34%] md:flex-none md:gap-1.5">
            <button
              type="button"
              className="icon-btn hidden sm:inline-flex"
              title="Lyrics"
              aria-label="Lyrics"
              onClick={() => navigate("/now-playing?lyrics=1")}
              disabled={!track}
            >
              <LyricsIcon size={17} />
            </button>
            <button
              type="button"
              className={`icon-btn ${queueOpen ? "text-accent" : ""}`}
              title="Queue (Q)"
              aria-label={queueOpen ? "Close queue" : "Open queue"}
              aria-pressed={queueOpen}
              onClick={onToggleQueue}
            >
              <QueueIcon size={17} />
            </button>
            <div className="hidden min-w-0 flex-1 md:block">
              <SeekBar compact />
            </div>
            <VolumeControl />
            {isDesktop && (
              <button
                type="button"
                className="icon-btn hidden min-[900px]:inline-flex"
                title={isExpanded ? "Collapse expanded dock" : "Expand mini player dock"}
                aria-label={isExpanded ? "Collapse expanded dock" : "Expand mini player dock"}
                aria-pressed={isExpanded}
                onClick={() => setPlayerMode(isExpanded ? "standard" : "expanded")}
              >
                {isExpanded ? <ChevronDownIcon size={17} /> : <ChevronUpIcon size={17} />}
              </button>
            )}
            <button
              type="button"
              className="icon-btn hidden xl:inline-flex"
              title="Expand to full player"
              aria-label="Expand to full player"
              onClick={() => navigate("/now-playing")}
              disabled={!track}
            >
              <ExpandIcon size={17} />
            </button>
            <Menu
              buttonLabel={`Player mode (${activeModeLabel})`}
              items={() => buildModeMenuItems(!isDesktop)}
            />
          </div>
        </div>
      </div>

      {/* Mobile progress line */}
      <div className="px-3 pb-2 pt-2 md:hidden">{track && <SeekBar compact />}</div>
    </div>
  );
}

/** Icon reflecting the volume level: muted, low (1–50%) or normal (51–100%). */
function VolumeLevelIcon({ level, size }: { level: "mute" | "low" | "normal"; size: number }) {
  if (level === "mute") return <VolumeMuteIcon size={size} />;
  if (level === "low") return <VolumeLowIcon size={size} />;
  return <VolumeIcon size={size} />;
}

/**
 * Speaker button with a frameless vertical volume slider popping up above it
 * (redesign §3): no card, panel or border — just the level icon and the
 * slider. Volume is owned by the playback store/engine; opening, closing and
 * dragging never touches playback position.
 */
function VolumeControl() {
  const volume = usePlaybackStore((state) => state.volume);
  const isMuted = usePlaybackStore((state) => state.isMuted);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const effectiveVolume = isMuted ? 0 : volume;
  const level: "mute" | "low" | "normal" = effectiveVolume === 0 ? "mute" : effectiveVolume <= 0.5 ? "low" : "normal";

  // Close on outside pointerdown or Escape while open; return focus to the
  // trigger on Escape since the popover (and the slider inside it) unmounts.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (containerRef.current && target && !containerRef.current.contains(target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const percent = Math.round(effectiveVolume * 100);

  return (
    <div ref={containerRef} className="relative hidden lg:block">
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn"
        title="Volume"
        aria-label={open ? "Close volume slider" : "Open volume slider"}
        aria-haspopup="true"
        aria-expanded={open}
        data-volume-level={level}
        onClick={() => setOpen((value) => !value)}
      >
        <VolumeLevelIcon level={level} size={17} />
      </button>
      {open && (
        <div
          role="group"
          aria-label="Volume"
          className="absolute bottom-full right-0 z-30 mb-2 flex animate-fade-in flex-col items-center gap-1.5 p-2"
        >
          <button
            type="button"
            className="icon-btn"
            title="Mute (M)"
            aria-label={isMuted || volume === 0 ? "Unmute" : "Mute"}
            aria-pressed={isMuted}
            onClick={() => usePlaybackStore.getState().toggleMute()}
          >
            <VolumeLevelIcon level={level} size={17} />
          </button>
          <input
            type="range"
            className="app-range-vertical"
            min={0}
            max={1}
            step={0.02}
            value={effectiveVolume}
            aria-label="Volume"
            aria-valuetext={`${percent}%`}
            style={{
              background: `linear-gradient(to top, var(--text-primary) ${percent}%, var(--surface-hover) ${percent}%)`,
            }}
            onChange={(event) => usePlaybackStore.getState().setVolume(Number(event.target.value))}
          />
        </div>
      )}
    </div>
  );
}
