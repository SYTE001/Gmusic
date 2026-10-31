import { useNavigate } from "react-router-dom";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlaybackStore } from "../stores/playbackStore";
import { Artwork } from "./Artwork";
import { SeekBar } from "./SeekBar";
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
  VolumeMuteIcon,
  WarningIcon,
} from "./Icons";

/**
 * Persistent bottom player bar, docked full-width across all routes (PRD
 * §7.9). Three zones: track info + like on the left, transport and seek in
 * the center, lyrics/queue/volume on the right. Mounted once in the shell so
 * route changes never restart playback; high-frequency time state is
 * isolated to the SeekBar subtree.
 */
export function MiniPlayer({ onToggleQueue, queueOpen }: { onToggleQueue: () => void; queueOpen: boolean }) {
  const navigate = useNavigate();
  const currentTrackId = usePlaybackStore((state) => state.currentTrackId);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const isBuffering = usePlaybackStore((state) => state.isBuffering);
  const status = usePlaybackStore((state) => state.status);
  const error = usePlaybackStore((state) => state.error);
  const autoplayBlocked = usePlaybackStore((state) => state.autoplayBlocked);
  const shuffleEnabled = usePlaybackStore((state) => state.shuffleEnabled);
  const repeatMode = usePlaybackStore((state) => state.repeatMode);
  const volume = usePlaybackStore((state) => state.volume);
  const isMuted = usePlaybackStore((state) => state.isMuted);
  const track = useLibraryStore((state) => state.tracks.find((item) => item.id === currentTrackId) ?? null);
  const toggleLike = useLibraryStore((state) => state.toggleLike);

  if (!track && status === "idle") return null;

  const controlsDisabled = !track;

  return (
    <div className="relative z-20 border-t bg-surface" style={{ borderColor: "var(--border-subtle)" }}>
      {(autoplayBlocked || error) && (
        <div
          className="flex items-center justify-between gap-3 px-4 py-1.5 text-xs"
          style={{ background: "color-mix(in srgb, var(--danger) 16%, transparent)", color: "color-mix(in srgb, var(--danger) 75%, white)" }}
          role="alert"
        >
          <span className="flex items-center gap-1.5 truncate">
            <WarningIcon size={14} />
            {error ? `${error.title} — ${error.detail}` : "The browser blocked playback. Press play to start."}
          </span>
          {error?.action === "grant-permission" && (
            <button
              type="button"
              className="shrink-0 font-medium underline underline-offset-2"
              onClick={() => usePlaybackStore.getState().play()}
            >
              Grant access
            </button>
          )}
          {error?.action === "relink" && (
            <button
              type="button"
              className="shrink-0 underline underline-offset-2"
              onClick={() => navigate("/library")}
            >
              Open Library to re-link
            </button>
          )}
        </div>
      )}

      <div className="mx-auto flex h-[72px] max-w-[1600px] items-center gap-1 px-3 md:h-[84px] md:gap-4 md:px-5">
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
              <span className="block truncate text-sm font-medium text-text-primary">{track?.title ?? "Nothing playing"}</span>
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

        {/* Center zone: transport + seek */}
        <div className="flex flex-none flex-col items-center justify-center gap-0.5 md:flex-1">
          <div className="flex items-center gap-0.5 md:gap-2">
            <button
              type="button"
              className="icon-btn hidden sm:inline-flex"
              title="Shuffle (S)"
              aria-label={shuffleEnabled ? "Disable shuffle" : "Enable shuffle"}
              aria-pressed={shuffleEnabled}
              onClick={() => usePlaybackStore.getState().toggleShuffle()}
            >
              <ShuffleIcon size={17} className={shuffleEnabled ? "text-accent" : ""} />
            </button>
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
              className="grid size-11 place-items-center rounded-full bg-accent text-accent-contrast transition-transform hover:scale-105 active:scale-95 disabled:opacity-40 md:size-12"
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
            <button
              type="button"
              className="icon-btn hidden sm:inline-flex"
              title="Repeat (R)"
              aria-label={repeatMode === "one" ? "Repeat one — click for off" : repeatMode === "all" ? "Repeat all — click for repeat one" : "Enable repeat all"}
              onClick={() => usePlaybackStore.getState().cycleRepeat()}
            >
              {repeatMode === "one" ? (
                <RepeatOneIcon size={17} className="text-accent" />
              ) : (
                <RepeatIcon size={17} className={repeatMode === "off" ? "" : "text-accent"} />
              )}
            </button>
          </div>
          <div className="hidden w-full max-w-xl md:block">
            <SeekBar compact />
          </div>
        </div>

        {/* Right zone: lyrics, queue, volume, expand */}
        <div className="flex min-w-0 flex-1 items-center justify-end gap-0.5 sm:gap-1 md:w-[30%] md:flex-none">
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
          <div className="hidden items-center gap-1.5 lg:flex">
            <button
              type="button"
              className="icon-btn"
              title="Mute (M)"
              aria-label={isMuted || volume === 0 ? "Unmute" : "Mute"}
              onClick={() => usePlaybackStore.getState().toggleMute()}
            >
              {isMuted || volume === 0 ? <VolumeMuteIcon size={17} /> : <VolumeIcon size={17} />}
            </button>
            <input
              type="range"
              className="app-range w-24"
              min={0}
              max={1}
              step={0.02}
              value={isMuted ? 0 : volume}
              aria-label="Volume"
              onChange={(event) => usePlaybackStore.getState().setVolume(Number(event.target.value))}
            />
          </div>
          <button
            type="button"
            className="icon-btn hidden md:inline-flex"
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
      <div className="px-3 pb-2 md:hidden">{track && <SeekBar compact />}</div>
    </div>
  );
}
