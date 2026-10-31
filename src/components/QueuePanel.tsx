import { useEffect, useRef, useState } from "react";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlaybackStore } from "../stores/playbackStore";
import type { Track } from "../types";
import { Artwork } from "./Artwork";
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, GripIcon, PlayIcon, TrashIcon } from "./Icons";
import { formatClock } from "../utils/misc";

/**
 * Queue drawer: reorder by drag with keyboard-accessible move buttons,
 * remove items, clear upcoming. The current track is clearly distinguished
 * (PRD §7.9). Playback continues while the panel is open.
 */
export function QueuePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tracks = useLibraryStore((state) => state.tracks);
  const queueTrackIds = usePlaybackStore((state) => state.queueTrackIds);
  const queueIndex = usePlaybackStore((state) => state.queueIndex);
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const entries = queueTrackIds.map((id, index) => ({ id, index, track: trackById.get(id) as Track | undefined }));
  const nowPlaying = entries[queueIndex];
  const upcoming = entries.slice(queueIndex + 1);

  const moveInQueue = usePlaybackStore.getState().moveInQueue;

  return (
    <aside
      aria-label="Play queue"
      className="fixed inset-x-0 bottom-[88px] z-30 flex max-h-[70vh] flex-col border-t bg-surface animate-panel-up md:inset-y-0 md:left-auto md:right-0 md:bottom-0 md:w-[360px] md:border-l md:border-t-0 md:animate-panel-right"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      <div className="flex items-center justify-between px-4 py-3.5">
        <h2 className="text-sm font-semibold">Queue</h2>
        <div className="flex items-center gap-1">
          {upcoming.length > 0 && (
            <button
              type="button"
              className="text-xs text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
              onClick={() => usePlaybackStore.getState().clearUpcomingQueue()}
            >
              Clear upcoming
            </button>
          )}
          <button type="button" className="icon-btn size-8" aria-label="Close queue" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {entries.length === 0 && <p className="px-3 py-6 text-sm text-text-muted">The queue is empty. Play something to start one.</p>}

        {nowPlaying?.track && (
          <>
            <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Now playing</div>
            <QueueRow
              track={nowPlaying.track}
              isCurrent
              onPlay={() => usePlaybackStore.getState().startTrack(nowPlaying.id, { autoplay: true })}
            />
          </>
        )}

        {upcoming.length > 0 && (
          <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Next up</div>
        )}
        {upcoming.map(({ id, index, track }) =>
          track ? (
            <QueueRow
              key={`${id}-${index}`}
              track={track}
              onPlay={() => usePlaybackStore.getState().startTrack(id, { autoplay: true })}
              onRemove={() => usePlaybackStore.getState().removeFromQueue(index)}
              onMoveUp={index > queueIndex + 1 ? () => moveInQueue(index, index - 1) : undefined}
              onMoveDown={index < queueTrackIds.length - 1 ? () => moveInQueue(index, index + 1) : undefined}
              draggable
              onDragStart={() => (dragIndexRef.current = index)}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOverIndex(index);
              }}
              onDrop={() => {
                const from = dragIndexRef.current;
                if (from !== null && from !== index) moveInQueue(from, index);
                dragIndexRef.current = null;
                setDragOverIndex(null);
              }}
              isDragOver={dragOverIndex === index}
            />
          ) : (
            <div key={`${id}-${index}-missing`} className="flex items-center justify-between px-3 py-2 text-sm text-text-muted">
              <span className="truncate">Track unavailable</span>
              <button
                type="button"
                className="text-xs text-danger underline underline-offset-2"
                onClick={() => usePlaybackStore.getState().removeFromQueue(index)}
              >
                Remove
              </button>
            </div>
          ),
        )}
      </div>
    </aside>
  );
}

function QueueRow({
  track,
  isCurrent = false,
  onPlay,
  onRemove,
  onMoveUp,
  onMoveDown,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  isDragOver,
}: {
  track: Track;
  isCurrent?: boolean;
  onPlay: () => void;
  onRemove?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragOver?: (event: React.DragEvent) => void;
  onDrop?: () => void;
  isDragOver?: boolean;
}) {
  return (
    <div
      className={`group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors ${
        isCurrent ? "bg-surface-raised" : "hover:bg-surface-hover"
      } ${isDragOver ? "outline outline-2 outline-accent" : ""}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {draggable && (
        <span className="cursor-grab text-text-muted opacity-0 transition-opacity group-hover:opacity-100" aria-hidden>
          <GripIcon size={14} />
        </span>
      )}
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={onPlay}>
        <Artwork trackId={track.id} alt="" className="size-9 shrink-0" rounded="rounded" />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-sm ${isCurrent ? "text-accent" : "text-text-primary"}`}>{track.title}</span>
          <span className="block truncate text-xs text-text-secondary">{track.artist || "Unknown artist"}</span>
        </span>
        <span className="shrink-0 text-xs tabular-nums text-text-muted">{track.durationMs !== null ? formatClock(track.durationMs) : "—"}</span>
      </button>
      <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {onMoveUp && (
          <button type="button" className="icon-btn size-7" aria-label={`Move ${track.title} up in queue`} onClick={onMoveUp}>
            <ChevronUpIcon size={14} />
          </button>
        )}
        {onMoveDown && (
          <button type="button" className="icon-btn size-7" aria-label={`Move ${track.title} down in queue`} onClick={onMoveDown}>
            <ChevronDownIcon size={14} />
          </button>
        )}
        {onRemove && (
          <button type="button" className="icon-btn size-7" aria-label={`Remove ${track.title} from queue`} onClick={onRemove}>
            <TrashIcon size={14} />
          </button>
        )}
        {!onRemove && !isCurrent && <PlayIcon size={14} />}
      </div>
    </div>
  );
}
