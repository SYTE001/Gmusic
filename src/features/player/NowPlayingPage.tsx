import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useLibraryStore, useTrackById } from "../../stores/libraryStore";
import { usePlaybackStore } from "../../stores/playbackStore";
import { toast } from "../../stores/toastStore";
import { recordComponentRender } from "../../utils/perf";
import { Artwork } from "../../components/Artwork";
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
import type { Track } from "../../types";

/**
 * Flip to `true` to adopt the adaptive background in Stage 1 (album-only view) as well.
 */
export const ENABLE_STAGE_1_BACKGROUND = false;

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

/**
 * Immersive two-mode player experience:
 * - Mode 1 (Now Playing / Stage 1): Album artwork and essential playback controls.
 * - Mode 2 (Fullscreen Lyrics / Stage 2): Immersive synchronized lyrics with minimal playback controls
 *   on a solid, contrast-verified album-adaptive dark background (`--bg`, `--lyric-active`, `--lyric-inactive`, `--accent`).
 */
export function NowPlayingPage() {
  recordComponentRender("NowPlayingPage");
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const lyricsMode = searchParams.get("lyrics") === "1";
  const showBackground = lyricsMode || ENABLE_STAGE_1_BACKGROUND;
  const [queueOpen, setQueueOpen] = useState(false);

  const currentTrackId = usePlaybackStore((state) => state.currentTrackId);
  const track = useTrackById(currentTrackId);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const shuffleEnabled = usePlaybackStore((state) => state.shuffleEnabled);
  const repeatMode = usePlaybackStore((state) => state.repeatMode);
  const trackActionsContext = useTrackActionsContext();

  const palette = useAdaptiveLyricsPalette(track, showBackground);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (queueOpen) {
          setQueueOpen(false);
          return;
        }
        navigate(-1);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [navigate, queueOpen]);

  const setLyricsMode = useCallback(
    (on: boolean) => {
      if (on) setQueueOpen(false);
      setSearchParams(on ? { lyrics: "1" } : {});
    },
    [setSearchParams],
  );

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
      className="fixed inset-0 z-30 flex flex-col overflow-hidden animate-fade-in select-none bg-app-bg"
      role="region"
      aria-label="Now playing"
      data-stage={showBackground ? "lyrics" : "album"}
      data-theme={showBackground ? "dark" : undefined}
      data-cover-category={showBackground ? palette.category : undefined}
      style={rootStyle}
    >
      {lyricsMode ? (
        /* Mode 2: Fullscreen Lyrics */
        <div className="relative z-10 mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col animate-fade-in">
          {/* Compact Lyrics Header: downward chevron on left, centered title & artist */}
          <header className="flex shrink-0 items-center justify-between px-5 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <button
              type="button"
              className="icon-btn shrink-0 text-text-secondary hover:text-text-primary"
              aria-label="Hide lyrics"
              title="Return to Now Playing"
              onClick={() => setLyricsMode(false)}
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
            <LyricsView />
          </div>

          {/* Minimal Bottom Playback Area: Progress bar + time labels + central Play/Pause */}
          <div className="flex shrink-0 flex-col items-center gap-3 px-6 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
            <SeekBar />
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
        <div className="relative z-10 mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col justify-between animate-fade-in">
          {/* Top Navigation: X button left, truncated song title center, three-dot overflow menu right */}
          <header className="flex shrink-0 items-center justify-between px-5 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <button
              type="button"
              className="icon-btn shrink-0 text-text-secondary hover:text-text-primary"
              aria-label="Close Now Playing"
              onClick={() => navigate(-1)}
            >
              <CloseIcon size={20} />
            </button>
            <span className="min-w-0 flex-1 truncate px-3 text-center text-sm font-medium text-text-secondary">
              {track.title}
            </span>
            <Menu
              buttonLabel="More options"
              trigger={<MoreIcon size={20} />}
              items={buildOverflowMenuItems}
            />
          </header>

          {/* Main Content: Responsive 1:1 Album Artwork + Controls */}
          <div className="flex min-h-0 flex-1 flex-col items-center justify-between px-6 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1">
            {/* Album Artwork */}
            <div className="flex min-h-0 w-full flex-1 items-center justify-center py-2">
              <div className="aspect-square w-full max-w-[min(82vw,calc(100dvh-350px))] sm:max-w-[min(360px,calc(100dvh-350px))] overflow-hidden rounded-[28px]">
                <Artwork
                  trackId={track.id}
                  alt={`${track.title} artwork`}
                  className="size-full object-cover"
                  rounded="rounded-[28px]"
                />
              </div>
            </div>

            {/* Track Info, SeekBar, Transport Controls, and Bottom Actions */}
            <div className="flex w-full shrink-0 flex-col gap-3.5">
              {/* Track Information + Favorite */}
              <div className="flex min-w-0 w-full items-center justify-between gap-3">
                <div className="min-w-0 flex-1 text-left">
                  <h1 className="truncate text-xl font-bold tracking-tight text-text-primary sm:text-2xl">
                    {track.title}
                  </h1>
                  <p className="mt-0.5 truncate text-base font-medium text-text-secondary">
                    {track.artist || "Unknown artist"}
                  </p>
                </div>
                <button
                  type="button"
                  className="icon-btn shrink-0 text-text-secondary hover:text-text-primary transition-transform active:scale-90"
                  title="Like (L)"
                  aria-label={track.isLiked ? "Remove from liked songs" : "Add to liked songs"}
                  aria-pressed={track.isLiked}
                  onClick={() => void useLibraryStore.getState().toggleLike(track.id)}
                >
                  <HeartIcon size={22} filled={track.isLiked} className={track.isLiked ? "text-text-primary" : ""} />
                </button>
              </div>

              {/* Progress Bar */}
              <SeekBar />

              {/* Main Playback Controls: Shuffle | Previous | Play/Pause | Next | Repeat */}
              <div className="flex w-full items-center justify-between px-1 sm:px-3">
                <TransportToggle
                  active={shuffleEnabled}
                  label={shuffleEnabled ? "Disable shuffle" : "Enable shuffle"}
                  title="Shuffle (S)"
                  onClick={() => usePlaybackStore.getState().toggleShuffle()}
                >
                  <ShuffleIcon size={20} />
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
                  className="grid size-[72px] sm:size-20 place-items-center rounded-full bg-accent-strong text-accent-contrast transition-transform hover:scale-105 active:scale-95 shrink-0 disabled:opacity-40"
                  title="Play/Pause (Space)"
                  aria-label={isPlaying ? "Pause" : "Play"}
                  onClick={() => usePlaybackStore.getState().togglePlay()}
                >
                  {isPlaying ? <PauseIcon size={30} /> : <PlayIcon size={30} />}
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
                  {repeatMode === "one" ? <RepeatOneIcon size={20} /> : <RepeatIcon size={20} />}
                </TransportToggle>
              </div>

              {/* Bottom Secondary Actions: Primary Lyrics button bottom-center, Queue icon bottom-right */}
              <div className="grid w-full grid-cols-3 items-center pt-0.5">
                <div aria-hidden="true" />
                <div className="flex justify-center">
                  <button
                    type="button"
                    className="inline-flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-xl px-4 py-1 text-text-secondary transition-colors hover:text-text-primary active:scale-95"
                    aria-label="Show lyrics"
                    onClick={() => setLyricsMode(true)}
                  >
                    <ChevronUpIcon size={16} />
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
                    <QueueIcon size={20} />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <QueuePanel open={queueOpen} onClose={() => setQueueOpen(false)} dockedBottom />
        </div>
      )}
    </div>
  );
}
