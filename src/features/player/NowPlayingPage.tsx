import { useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlaybackStore } from "../../stores/playbackStore";
import { Artwork } from "../../components/Artwork";
import { SeekBar } from "../../components/SeekBar";
import LyricsAmbientBackground from "../lyrics/LyricsAmbientBackground";
import { LyricsView } from "../lyrics/LyricsView";
import {
  CloseIcon,
  HeartIcon,
  LyricsIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
} from "../../components/Icons";

/**
 * Immersive Now Playing (PRD §7.8): artwork-led, Apple Music-style layout
 * with the liquid ambient background, centered/stacked controls under the artwork,
 * and side-by-side synchronized lyrics view.
 */
export function NowPlayingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const lyricsMode = searchParams.get("lyrics") === "1";
  const currentTrackId = usePlaybackStore((state) => state.currentTrackId);
  const track = useLibraryStore((state) => state.tracks.find((item) => item.id === currentTrackId) ?? null);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const shuffleEnabled = usePlaybackStore((state) => state.shuffleEnabled);
  const repeatMode = usePlaybackStore((state) => state.repeatMode);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        navigate(-1);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  const setLyricsMode = (on: boolean) => {
    setSearchParams(on ? { lyrics: "1" } : {});
  };

  if (!track) {
    return (
      <div className="fixed inset-0 z-40 grid place-items-center bg-app-bg text-sm text-text-secondary">
        Nothing is playing. <Link to="/library" className="ml-1 text-accent underline underline-offset-2">Pick a song</Link>
      </div>
    );
  }

  return (
    <>
      {/* Liquid ambient background: artwork first, theme-matched fallback
          second; crossfades between songs, sources, and themes. */}
      <LyricsAmbientBackground trackId={track.id} />

      {/* 3. Top UI Container (transparent background, z-10 above the background layer) */}
      <div
        className="fixed inset-0 z-10 flex flex-col overflow-hidden animate-fade-in select-none bg-transparent"
        role="region"
        aria-label="Now playing"
      >

      {/* Top bar: close button on left, song title centered, lyrics toggle button on right */}
      <div className="relative z-10 flex items-center px-4 py-3 md:px-6 shrink-0">
        <button
          type="button"
          className="icon-btn shrink-0"
          aria-label="Close Now Playing"
          onClick={() => navigate(-1)}
        >
          <CloseIcon size={18} />
        </button>
        <span className="min-w-0 flex-1 truncate px-3 text-center text-sm font-medium text-text-secondary">
          {track.title}
        </span>
        <button
          type="button"
          className={`icon-btn shrink-0 ${lyricsMode ? "text-accent" : ""}`}
          aria-label={lyricsMode ? "Hide lyrics" : "Show lyrics"}
          aria-pressed={lyricsMode}
          onClick={() => setLyricsMode(!lyricsMode)}
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
                willChange: "transform",
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
                  <HeartIcon size={19} filled={track.isLiked} className={track.isLiked ? "text-accent" : ""} />
                </button>
              </div>

              {/* 2. SeekBar (reuse existing component as-is) */}
              <SeekBar />

              {/* 3. Transport row, centered */}
              <div className="flex items-center justify-center gap-2 sm:gap-3 w-full">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={shuffleEnabled ? "Disable shuffle" : "Enable shuffle"}
                  aria-pressed={shuffleEnabled}
                  onClick={() => usePlaybackStore.getState().toggleShuffle()}
                >
                  <ShuffleIcon size={18} className={shuffleEnabled ? "text-accent" : ""} />
                </button>
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
                  className="grid size-13 place-items-center rounded-full bg-text-primary text-app-bg hover:scale-105 active:scale-95 shrink-0"
                  style={{
                    width: 52,
                    height: 52,
                    transition: "transform 100ms ease",
                    willChange: "transform",
                  }}
                  aria-label={isPlaying ? "Pause" : "Play"}
                  onClick={() => usePlaybackStore.getState().togglePlay()}
                >
                  {isPlaying ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Next track"
                  onClick={() => usePlaybackStore.getState().next(true)}
                >
                  <NextIcon size={22} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={
                    repeatMode === "off"
                      ? "Enable repeat all"
                      : repeatMode === "all"
                      ? "Enable repeat one"
                      : "Disable repeat"
                  }
                  onClick={() => usePlaybackStore.getState().cycleRepeat()}
                >
                  {repeatMode === "one" ? (
                    <RepeatOneIcon size={18} className="text-accent" />
                  ) : (
                    <RepeatIcon size={18} className={repeatMode === "off" ? "" : "text-accent"} />
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Lyrics column */}
        {lyricsMode && (
          <div className="min-h-0 flex-1 pb-2">
            <LyricsView />
          </div>
        )}
      </div>
    </div>
    </>
  );
}
