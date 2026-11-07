import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLibraryStore, useTrackById } from "../stores/libraryStore";
import { usePlaybackStore } from "../stores/playbackStore";
import { recordComponentRender } from "../utils/perf";
import { Artwork } from "./Artwork";
import { SeekBar } from "./SeekBar";
import { TransportToggle } from "./TransportToggle";
import {
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

/**
 * Persistent bottom player bar, docked across all routes (PRD §7.9) as a
 * floating rounded pill. Three zones: track info + like on the left, transport
 * in the center, time/seek/volume on the right. Mounted once in the shell so
 * route changes never restart playback; high-frequency time state is isolated
 * to the SeekBar subtree.
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
  const track = useTrackById(currentTrackId);
  const toggleLike = useLibraryStore((state) => state.toggleLike);

  if (!track && status === "idle") return null;

  const controlsDisabled = !track;

  return (
    <div className="relative z-20 px-2 pb-2 md:px-3 md:pb-3">
      <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-1 rounded-[28px] bg-surface px-3 shadow-[0_8px_24px_rgba(0,0,0,0.22)] md:h-[72px] md:gap-4 md:px-5">
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
              <Artwork trackId={track?.id} alt="" className="size-11 md:size-12" rounded="rounded-md" />
              {isBuffering && (
                <span className="absolute inset-0 grid place-items-center rounded-md bg-black/40 text-[10px] text-text-primary" aria-hidden>
                  …
                </span>
              )}
            </div>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-text-primary">{track?.title ?? "Nothing playing"}</span>
              <span className="block truncate text-xs text-text-secondary">{track?.artist || (track ? "Unknown artist" : "Pick a song to begin")}</span>
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

        {/* Right zone: lyrics, queue, time/seek, volume, expand */}
        <div className="flex min-w-0 flex-1 items-center justify-end gap-0.5 sm:gap-1 md:w-[32%] md:flex-none md:gap-2">
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
