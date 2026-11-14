import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useLibraryStore, useTrackById } from "../../stores/libraryStore";
import { usePlaybackStore } from "../../stores/playbackStore";
import { toast } from "../../stores/toastStore";
import { recordComponentRender } from "../../utils/perf";
import { Artwork, useArtworkUrl } from "../../components/Artwork";
import { handleArtworkImageError } from "../../services/artwork/artworkCache";
import { Menu, type MenuItemSpec } from "../../components/Menu";
import { QueuePanel } from "../../components/QueuePanel";
import { SeekBar } from "../../components/SeekBar";
import { TransportToggle } from "../../components/TransportToggle";
import { useTrackActionsContext } from "../library/useTrackActions";
import { LyricsView } from "../lyrics/LyricsView";
import { useAdaptiveLyricsPalette } from "../lyrics/useAdaptiveLyricsPalette";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  CopyIcon,
  HeartIcon,
  LyricsIcon,
  MoreIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  QueueIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShareIcon,
  ShuffleIcon,
} from "../../components/Icons";
import type { RepeatMode, Track } from "../../types";

/**
 * Flip to `true` to adopt the adaptive background in Stage 1 (album-only view) as well.
 */
export const ENABLE_STAGE_1_BACKGROUND = false;

export const MOBILE_PLAYER_BREAKPOINT_PX = 768;

function getIsMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.innerWidth === "number" && window.innerWidth > 0) {
    return window.innerWidth < MOBILE_PLAYER_BREAKPOINT_PX;
  }
  if (typeof window.matchMedia === "function") {
    return window.matchMedia(`(max-width: ${MOBILE_PLAYER_BREAKPOINT_PX - 1}px)`).matches;
  }
  return false;
}

export function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(getIsMobileViewport);

  useEffect(() => {
    const update = () => {
      setIsMobile(getIsMobileViewport());
    };
    update();
    window.addEventListener("resize", update);
    const mql =
      typeof window.matchMedia === "function"
        ? window.matchMedia(`(max-width: ${MOBILE_PLAYER_BREAKPOINT_PX - 1}px)`)
        : null;
    mql?.addEventListener?.("change", update);
    return () => {
      window.removeEventListener("resize", update);
      mql?.removeEventListener?.("change", update);
    };
  }, []);

  return isMobile;
}

function copyShareText(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).then(
      () => toast("success", `Copied "${text}"`),
      () => toast("info", text),
    );
  } else {
    toast("info", text);
  }
}

function shareTrackInfo(track: Track) {
  const text = track.artist ? `${track.title} — ${track.artist}` : track.title;
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    void navigator.share({ title: track.title, text }).catch((err: unknown) => {
      if (err instanceof Error && err.name === "AbortError") return;
      copyShareText(text);
    });
    return;
  }
  copyShareText(text);
}

export type PlayerPresentationMode = "now-playing" | "lyrics";

type SharedPlayerProps = {
  track: Track;
  lyricsMode: boolean;
  isPlaying: boolean;
  shuffleEnabled: boolean;
  repeatMode: RepeatMode;
  openLyrics: () => void;
  returnToNowPlaying: () => void;
  closeFullscreenPlayer: () => void;
};

/**
 * Original Desktop Now Playing presentation (>= 768px):
 * - Stage 1 (album only): centered artwork + inline seek bar + transport row.
 * - Stage 2 (album + lyrics side by side): artwork & controls column on the left,
 *   synchronized LyricsView column on the right.
 */
export function DesktopPlayer({
  track,
  lyricsMode,
  isPlaying,
  shuffleEnabled,
  repeatMode,
  openLyrics,
  returnToNowPlaying,
  closeFullscreenPlayer,
}: SharedPlayerProps) {
  return (
    <>
      {/* Top bar: close button on left, song title centered, lyrics toggle button on right */}
      <div className="relative z-10 flex items-center px-4 py-3 md:px-6 shrink-0">
        <button
          type="button"
          className="icon-btn shrink-0"
          aria-label="Close Now Playing"
          onClick={closeFullscreenPlayer}
        >
          <CloseIcon size={18} />
        </button>
        <span className="min-w-0 flex-1 truncate px-3 text-center text-sm font-medium text-text-secondary">
          {track.title}
        </span>
        <button
          type="button"
          className={`icon-btn shrink-0 ${lyricsMode ? "text-text-primary" : ""}`}
          aria-label={lyricsMode ? "Hide lyrics" : "Show lyrics"}
          aria-pressed={lyricsMode}
          onClick={lyricsMode ? returnToNowPlaying : openLyrics}
        >
          <LyricsIcon size={18} />
        </button>
      </div>

      {/* Main content area */}
      <div
        className={`relative z-10 flex min-h-0 flex-1 px-6 pb-6 md:px-10 ${
          lyricsMode
            ? "flex-col lg:flex-row gap-6 lg:gap-10"
            : "flex-col items-center justify-center"
        }`}
      >
        {/* Artwork + Controls column */}
        <div
          className={`flex min-h-0 flex-col items-center justify-center ${
            lyricsMode ? "lg:w-[38%] shrink-0 w-full" : "w-full flex-1"
          }`}
        >
          <div
            className={`flex flex-col items-center w-full ${
              lyricsMode
                ? "max-w-[230px] sm:max-w-[260px] lg:max-w-[min(340px,calc(100dvh-270px))]"
                : "max-w-[min(280px,calc(100dvh-270px))] sm:max-w-[min(340px,calc(100dvh-270px))] md:max-w-[min(380px,calc(100dvh-270px))]"
            }`}
          >
            {/* Artwork container */}
            <div
              className={`aspect-square w-full overflow-hidden rounded-[20px] shadow-2xl ${
                isPlaying ? "scale-100" : "scale-[0.94]"
              }`}
              style={{
                transition: "transform 300ms cubic-bezier(0.22, 1, 0.36, 1)",
                backfaceVisibility: "hidden",
              }}
            >
              <Artwork trackId={track.id} alt={`${track.title} artwork`} className="size-full" rounded="rounded-[20px]" />
            </div>

            {/* Controls under artwork, same width as artwork */}
            <div className="w-full flex flex-col gap-3.5 mt-5">
              {/* 1. Title row: title + artist below it, LEFT-aligned. Like/heart button moves to right end */}
              <div className="flex items-center justify-between gap-3 min-w-0 w-full">
                <div className="min-w-0 flex-1 text-left">
                  <h1 className="truncate text-lg font-semibold tracking-tight sm:text-xl md:text-2xl text-text-primary">
                    {track.title}
                  </h1>
                  <p className="truncate text-xs sm:text-sm text-text-secondary">
                    {track.artist || "Unknown artist"}
                  </p>
                </div>
                <button
                  type="button"
                  className="icon-btn shrink-0"
                  title="Like (L)"
                  aria-label={track.isLiked ? "Remove from liked songs" : "Add to liked songs"}
                  aria-pressed={track.isLiked}
                  onClick={() => void useLibraryStore.getState().toggleLike(track.id)}
                >
                  <HeartIcon size={19} filled={track.isLiked} className={track.isLiked ? "text-text-primary" : ""} />
                </button>
              </div>

              {/* 2. SeekBar */}
              <SeekBar />

              {/* 3. Transport row, centered */}
              <div className="flex items-center justify-center gap-2 sm:gap-3 w-full">
                <TransportToggle
                  active={shuffleEnabled}
                  label={shuffleEnabled ? "Disable shuffle" : "Enable shuffle"}
                  title="Shuffle (S)"
                  onClick={() => usePlaybackStore.getState().toggleShuffle()}
                >
                  <ShuffleIcon size={18} />
                </TransportToggle>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Previous track"
                  onClick={() => usePlaybackStore.getState().previous()}
                >
                  <PrevIcon size={22} />
                </button>
                <button
                  type="button"
                  className="grid size-14 place-items-center rounded-full bg-accent-strong text-accent-contrast transition-transform hover:scale-105 active:scale-95 shrink-0 disabled:opacity-40"
                  title="Play/Pause (Space)"
                  aria-label={isPlaying ? "Pause" : "Play"}
                  onClick={() => usePlaybackStore.getState().togglePlay()}
                >
                  {isPlaying ? <PauseIcon size={24} /> : <PlayIcon size={24} />}
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Next track"
                  onClick={() => usePlaybackStore.getState().next(true)}
                >
                  <NextIcon size={22} />
                </button>
                <TransportToggle
                  active={repeatMode !== "off"}
                  label={
                    repeatMode === "off"
                      ? "Enable repeat all"
                      : repeatMode === "all"
                        ? "Enable repeat one"
                        : "Disable repeat"
                  }
                  title="Repeat (R)"
                  onClick={() => usePlaybackStore.getState().cycleRepeat()}
                >
                  {repeatMode === "one" ? <RepeatOneIcon size={18} /> : <RepeatIcon size={18} />}
                </TransportToggle>
              </div>
            </div>
          </div>
        </div>

        {/* Lyrics column — sits directly on the solid background */}
        {lyricsMode && (
          <div className="min-h-0 flex-1 pb-2">
            <LyricsView />
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Redesigned Mobile Player presentation (< 768px):
 * - Mode 1 (Mobile Now Playing): Fullscreen artwork, stacked seek bar, transport controls,
 *   bottom-center Lyrics button, bottom-right Queue button, and top-right overflow menu.
 * - Mode 2 (Mobile Fullscreen Lyrics): Downward chevron header, immersive mobile LyricsView,
 *   and compact bottom SeekBar + central Play/Pause button.
 */
export function MobilePlayer({
  track,
  lyricsMode,
  isPlaying,
  shuffleEnabled,
  repeatMode,
  openLyrics,
  returnToNowPlaying,
  closeFullscreenPlayer,
  queueOpen,
  setQueueOpen,
  buildOverflowMenuItems,
}: SharedPlayerProps & {
  queueOpen: boolean;
  setQueueOpen: React.Dispatch<React.SetStateAction<boolean>>;
  buildOverflowMenuItems: () => MenuItemSpec[];
}) {
  const artworkUrl = useArtworkUrl(track.id);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  // A failure only applies to the URL that failed; reset when a new URL
  // arrives so retrying the same track through another source can recover.
  useEffect(() => {
    setFailedUrl(null);
  }, [artworkUrl]);
  const hasArtwork = Boolean(artworkUrl && failedUrl !== artworkUrl);

  const artworkThemeVars: CSSProperties | undefined = hasArtwork
    ? ({
        "--text-primary": "#ffffff",
        "--text-secondary": "rgba(255, 255, 255, 0.72)",
        "--text-muted": "rgba(255, 255, 255, 0.54)",
        "--surface-hover": "rgba(255, 255, 255, 0.14)",
        "--accent": "#ffffff",
        "--accent-strong": "#ffffff",
        "--accent-contrast": "#0e1116",
      } as CSSProperties)
    : undefined;

  return lyricsMode ? (
    /* Mode 2: Fullscreen Lyrics */
    <div className="relative z-10 mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col animate-fade-in">
      {/* Compact Lyrics Header: downward chevron on left returns to Now Playing */}
      <header className="flex shrink-0 items-center justify-between px-5 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          className="icon-btn shrink-0 text-text-secondary hover:text-text-primary"
          aria-label="Hide lyrics"
          title="Return to Now Playing"
          onClick={returnToNowPlaying}
        >
          <ChevronDownIcon size={22} />
        </button>
        <div className="min-w-0 flex-1 px-3 text-center">
          <h1 className="truncate text-[15px] font-semibold tracking-tight text-text-primary sm:text-base">
            {track.title}
          </h1>
          <p className="truncate text-xs font-medium text-text-secondary sm:text-[13px]">
            {track.artist || "Unknown artist"}
          </p>
        </div>
        <div className="size-9 shrink-0" aria-hidden="true" />
      </header>

      {/* Immersive Synchronized Lyrics Container */}
      <div className="min-h-0 flex-1 px-6">
        <LyricsView mobile />
      </div>

      {/* Minimal Bottom Playback Area: Progress bar + time labels + central Play/Pause */}
      <div className="flex shrink-0 flex-col items-center gap-3 px-6 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
        <SeekBar stackedLabels />
        <button
          type="button"
          className="grid size-16 sm:size-[72px] place-items-center rounded-full bg-accent-strong text-accent-contrast transition-transform hover:scale-105 active:scale-95 shrink-0 disabled:opacity-40"
          title="Play/Pause (Space)"
          aria-label={isPlaying ? "Pause" : "Play"}
          onClick={() => usePlaybackStore.getState().togglePlay()}
        >
          {isPlaying ? <PauseIcon size={28} /> : <PlayIcon size={28} />}
        </button>
      </div>
    </div>
  ) : (
    /* Mode 1: Now Playing */
    <div
      className={`relative z-10 mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col overflow-hidden animate-fade-in ${
        hasArtwork ? "bg-[#0e1116]" : ""
      }`}
      data-has-artwork={hasArtwork ? "true" : "false"}
      style={artworkThemeVars}
    >
      {hasArtwork && artworkUrl && (
        <>
          {/* Layer 1: Full-width upper artwork (65-75% height) with soft bottom transition */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-[72%] overflow-hidden rounded-t-[24px] mobile-artwork-layer"
            data-mobile-artwork-layer="true"
          >
            <img
              key={artworkUrl}
              src={artworkUrl}
              alt={`${track.title} artwork`}
              decoding="async"
              onError={() => {
                setFailedUrl(artworkUrl);
                void handleArtworkImageError(track.id, artworkUrl);
              }}
              className="size-full object-cover object-center transition-opacity duration-200"
            />
          </div>
          {/* Layer 2: Subtle gradient-free darkening overlay */}
          <div className="pointer-events-none absolute inset-0 bg-black/15" aria-hidden="true" />
        </>
      )}

      {/* Top Navigation: Close button left */}
      <header className="relative z-10 flex shrink-0 items-center justify-between px-5 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          className={`icon-btn shrink-0 ${
            hasArtwork
              ? "rounded-full bg-black/25 text-white hover:bg-black/40 hover:text-white"
              : "text-text-secondary hover:text-text-primary"
          }`}
          aria-label="Close Now Playing"
          title="Close Now Playing"
          onClick={closeFullscreenPlayer}
        >
          <CloseIcon size={20} />
        </button>
        <div className="size-9 shrink-0" aria-hidden="true" />
      </header>

      {/* Layer 3 & 4: Lower Blurred Player Overlay + Controls */}
      <div
        className={`relative z-10 mt-auto flex w-full shrink-0 flex-col gap-3.5 px-6 pb-[max(0.875rem,env(safe-area-inset-bottom))] pt-5 ${
          hasArtwork ? "mobile-player-overlay" : ""
        }`}
        data-mobile-player-overlay={hasArtwork ? "true" : "false"}
      >
        {/* Track Information + Favorite + More options */}
        <div className="flex min-w-0 w-full items-center justify-between gap-3">
          <div className="min-w-0 flex-1 text-left">
            <h1 className="truncate text-xl font-bold tracking-tight text-text-primary sm:text-2xl">
              {track.title}
            </h1>
            <p className="mt-0.5 truncate text-sm font-medium text-text-secondary sm:text-base">
              {track.artist || "Unknown artist"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="icon-btn shrink-0 text-text-secondary hover:text-text-primary transition-transform active:scale-90"
              title="Like (L)"
              aria-label={track.isLiked ? "Remove from liked songs" : "Add to liked songs"}
              aria-pressed={track.isLiked}
              onClick={() => void useLibraryStore.getState().toggleLike(track.id)}
            >
              <HeartIcon size={21} filled={track.isLiked} className={track.isLiked ? "text-text-primary" : ""} />
            </button>
            <Menu
              buttonLabel="More options"
              trigger={<MoreIcon size={20} />}
              items={buildOverflowMenuItems}
            />
          </div>
        </div>

        {/* Progress Bar */}
        <SeekBar stackedLabels />

        {/* Main Playback Controls: Shuffle | Previous | Play/Pause | Next | Repeat */}
        <div className="flex w-full items-center justify-between px-1 sm:px-3">
          <TransportToggle
            active={shuffleEnabled}
            label={shuffleEnabled ? "Disable shuffle" : "Enable shuffle"}
            title="Shuffle (S)"
            onClick={() => usePlaybackStore.getState().toggleShuffle()}
          >
            <ShuffleIcon size={19} />
          </TransportToggle>
          <button
            type="button"
            className="icon-btn text-text-primary"
            aria-label="Previous track"
            onClick={() => usePlaybackStore.getState().previous()}
          >
            <PrevIcon size={26} />
          </button>
          <button
            type="button"
            className="grid size-[68px] sm:size-[72px] place-items-center rounded-full bg-accent-strong text-accent-contrast transition-transform hover:scale-105 active:scale-95 shrink-0 disabled:opacity-40"
            title="Play/Pause (Space)"
            aria-label={isPlaying ? "Pause" : "Play"}
            onClick={() => usePlaybackStore.getState().togglePlay()}
          >
            {isPlaying ? <PauseIcon size={28} /> : <PlayIcon size={28} />}
          </button>
          <button
            type="button"
            className="icon-btn text-text-primary"
            aria-label="Next track"
            onClick={() => usePlaybackStore.getState().next(true)}
          >
            <NextIcon size={26} />
          </button>
          <TransportToggle
            active={repeatMode !== "off"}
            label={
              repeatMode === "off"
                ? "Enable repeat all"
                : repeatMode === "all"
                  ? "Enable repeat one"
                  : "Disable repeat"
            }
            title="Repeat (R)"
            onClick={() => usePlaybackStore.getState().cycleRepeat()}
          >
            {repeatMode === "one" ? <RepeatOneIcon size={19} /> : <RepeatIcon size={19} />}
          </TransportToggle>
        </div>

        {/* Bottom Secondary Actions: Lyrics bottom-center, Queue bottom-right */}
        <div className="grid w-full grid-cols-3 items-center pt-0.5">
          <div aria-hidden="true" />
          <div className="flex justify-center">
            <button
              type="button"
              className="inline-flex min-h-10 flex-col items-center justify-center gap-0.5 rounded-xl px-4 py-1 text-text-secondary transition-colors hover:text-text-primary active:scale-95"
              aria-label="Show lyrics"
              onClick={openLyrics}
            >
              <ChevronUpIcon size={15} />
              <span className="text-xs font-medium tracking-tight">Lyrics</span>
            </button>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              className={`icon-btn ${queueOpen ? "text-text-primary" : "text-text-secondary"}`}
              title="Queue (Q)"
              aria-label={queueOpen ? "Close queue" : "Open queue"}
              aria-pressed={queueOpen}
              onClick={() => setQueueOpen((open) => !open)}
            >
              <QueueIcon size={19} />
            </button>
          </div>
        </div>
      </div>

      <QueuePanel open={queueOpen} onClose={() => setQueueOpen(false)} dockedBottom />
    </div>
  );
}

/**
 * Responsive Now Playing page:
 * - Desktop (>= 768px): Original Gmusic desktop player experience (`DesktopPlayer`).
 * - Mobile (< 768px): Redesigned mobile Now Playing & Fullscreen Lyrics experience (`MobilePlayer`).
 * Both share the single playback engine, Zustand stores, and audio clock.
 */
export function NowPlayingPage() {
  recordComponentRender("NowPlayingPage");
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const isMobile = useIsMobileViewport();

  // Distinct presentation states: "now-playing" vs "lyrics"
  const [mode, setMode] = useState<PlayerPresentationMode>(() =>
    searchParams.get("lyrics") === "1" ? "lyrics" : "now-playing",
  );

  useEffect(() => {
    const desiredMode: PlayerPresentationMode = searchParams.get("lyrics") === "1" ? "lyrics" : "now-playing";
    setMode(desiredMode);
  }, [searchParams]);

  const lyricsMode = mode === "lyrics";
  const showBackground = lyricsMode || ENABLE_STAGE_1_BACKGROUND;
  const [queueOpen, setQueueOpen] = useState(false);

  // Close mobile-only docked queue panel if viewport transitions to desktop
  useEffect(() => {
    if (!isMobile && queueOpen) {
      setQueueOpen(false);
    }
  }, [isMobile, queueOpen]);

  const currentTrackId = usePlaybackStore((state) => state.currentTrackId);
  const track = useTrackById(currentTrackId);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const shuffleEnabled = usePlaybackStore((state) => state.shuffleEnabled);
  const repeatMode = usePlaybackStore((state) => state.repeatMode);
  const trackActionsContext = useTrackActionsContext();

  const palette = useAdaptiveLyricsPalette(track, showBackground);

  // Explicit navigation action: open lyrics presentation state
  const openLyrics = useCallback(() => {
    setQueueOpen(false);
    setMode("lyrics");
    setSearchParams({ lyrics: "1" }, { replace: true });
  }, [setSearchParams]);

  // Explicit navigation action: return to Now Playing mode (artwork + controls).
  // Must NOT close the fullscreen player or push a history entry.
  const returnToNowPlaying = useCallback(() => {
    setMode("now-playing");
    setSearchParams({}, { replace: true });
  }, [setSearchParams]);

  // Explicit navigation action: close fullscreen player to previous application screen.
  // Must NOT navigate to Lyrics mode.
  const closeFullscreenPlayer = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (isMobile) {
          if (queueOpen) {
            setQueueOpen(false);
            return;
          }
          if (mode === "lyrics") {
            returnToNowPlaying();
            return;
          }
        }
        closeFullscreenPlayer();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeFullscreenPlayer, isMobile, mode, queueOpen, returnToNowPlaying]);

  const buildOverflowMenuItems = useCallback((): MenuItemSpec[] => {
    if (!track) return [];
    const shareItem: MenuItemSpec = {
      kind: "action",
      label: "Share",
      icon: <ShareIcon size={16} />,
      onSelect: () => shareTrackInfo(track),
    };
    if (trackActionsContext) {
      return [shareItem, { kind: "separator" }, ...trackActionsContext.buildMenuItems(track)];
    }
    return [
      shareItem,
      { kind: "separator" },
      {
        kind: "action",
        label: "Play next",
        icon: <PlayIcon size={16} />,
        onSelect: () => {
          usePlaybackStore.getState().playNext(track.id);
          toast("success", "Playing next.");
        },
      },
      {
        kind: "action",
        label: "Add to queue",
        icon: <QueueIcon size={16} />,
        onSelect: () => {
          usePlaybackStore.getState().enqueue(track.id);
          toast("success", "Added to queue.");
        },
      },
      {
        kind: "action",
        label: "Copy song info",
        icon: <CopyIcon size={16} />,
        onSelect: () => copyShareText(track.artist ? `${track.artist} - ${track.title}` : track.title),
      },
    ];
  }, [track, trackActionsContext]);

  if (!track) {
    return (
      <div className="fixed inset-0 z-40 grid place-items-center bg-app-bg text-sm text-text-secondary">
        Nothing is playing. <Link to="/library" className="ml-1 text-accent underline underline-offset-2">Pick a song</Link>
      </div>
    );
  }

  const rootStyle: CSSProperties = showBackground
    ? ({
        "--bg": palette.bg,
        "--lyric-active": palette.lyricActive,
        "--lyric-inactive": palette.lyricInactive,
        "--accent": palette.accent,
        "--text-primary": palette.lyricActive,
        "--text-secondary": palette.textSecondary,
        "--text-muted": palette.textMuted,
        backgroundColor: "var(--bg)",
        transition: "background-color 480ms ease-out",
      } as CSSProperties)
    : {
        transition: "background-color 480ms ease-out",
      };

  return (
    <div
      className={`fixed inset-0 ${
        isMobile ? "z-30" : "z-30 min-[900px]:z-10"
      } flex flex-col overflow-hidden animate-fade-in select-none bg-app-bg`}
      role="region"
      aria-label="Now playing"
      data-viewport={isMobile ? "mobile" : "desktop"}
      data-stage={showBackground ? "lyrics" : "album"}
      data-theme={showBackground ? "dark" : undefined}
      data-cover-category={showBackground ? palette.category : undefined}
      style={rootStyle}
    >
      {isMobile ? (
        <MobilePlayer
          track={track}
          lyricsMode={lyricsMode}
          isPlaying={isPlaying}
          shuffleEnabled={shuffleEnabled}
          repeatMode={repeatMode}
          openLyrics={openLyrics}
          returnToNowPlaying={returnToNowPlaying}
          closeFullscreenPlayer={closeFullscreenPlayer}
          queueOpen={queueOpen}
          setQueueOpen={setQueueOpen}
          buildOverflowMenuItems={buildOverflowMenuItems}
        />
      ) : (
        <DesktopPlayer
          track={track}
          lyricsMode={lyricsMode}
          isPlaying={isPlaying}
          shuffleEnabled={shuffleEnabled}
          repeatMode={repeatMode}
          openLyrics={openLyrics}
          returnToNowPlaying={returnToNowPlaying}
          closeFullscreenPlayer={closeFullscreenPlayer}
        />
      )}
    </div>
  );
}
