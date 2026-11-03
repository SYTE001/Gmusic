import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlaybackStore } from "../../stores/playbackStore";
import { toast } from "../../stores/toastStore";
import { Artwork } from "../../components/Artwork";
import { EmptyState } from "../../components/EmptyState";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import {
  PlayIcon,
  RefreshIcon,
  TrashIcon,
  WarningIcon,
} from "../../components/Icons";
import { formatDurationLong } from "../../utils/misc";
import type { Track } from "../../types";

export function BrokenPage() {
  const [searchParams] = useSearchParams();
  const targetTrackId = searchParams.get("trackId");
  const [highlightedId, setHighlightedId] = useState<string | null>(targetTrackId);

  const tracks = useLibraryStore((state) => state.tracks);
  const restoreBrokenTrack = useLibraryStore((state) => state.restoreBrokenTrack);
  const removeTracks = useLibraryStore((state) => state.removeTracks);

  const [trackToDelete, setTrackToDelete] = useState<Track | null>(null);

  const brokenTracks = useMemo(
    () => tracks.filter((t) => t.broken?.isBroken || t.availability === "broken"),
    [tracks],
  );

  const totalDurationMs = brokenTracks.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);

  useEffect(() => {
    if (!targetTrackId) return;
    setHighlightedId(targetTrackId);
    const element = document.getElementById(`broken-track-${targetTrackId}`);
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    const timer = setTimeout(() => {
      setHighlightedId(null);
    }, 3000);
    return () => clearTimeout(timer);
  }, [targetTrackId]);

  const handleRetry = (track: Track) => {
    toast("info", `Retrying playback for “${track.title}”…`);
    void usePlaybackStore.getState().startTrack(track.id, { autoplay: true });
  };

  const handleRestore = async (track: Track) => {
    await restoreBrokenTrack(track.id);
    toast("success", `Restored “${track.title}” to your library.`);
  };

  const handleConfirmDelete = async () => {
    if (!trackToDelete) return;
    await removeTracks([trackToDelete.id]);
    toast("info", `Removed “${trackToDelete.title}” from library.`);
    setTrackToDelete(null);
  };

  const categoryLabel = (cat?: string) => {
    switch (cat) {
      case "corrupted":
        return "Corrupted audio";
      case "unsupported":
        return "Unsupported format";
      case "unreadable":
        return "Unreadable file";
      case "missing":
        return "Missing source";
      case "decoding":
        return "Decoding failed";
      default:
        return "Playback failed";
    }
  };

  if (brokenTracks.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Broken Tracks</h1>
        <EmptyState
          icon={<WarningIcon size={28} className="text-text-muted" />}
          title="No broken tracks"
          description={
            <>
              All tracks in your library are healthy and ready to play. Tracks that fail to decode or have missing audio files will appear here.
            </>
          }
          action={
            <Link
              to="/library"
              className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-accent-contrast"
            >
              Go to Library
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end gap-5 md:gap-6">
        <span
          className="grid size-32 shrink-0 place-items-center rounded-[var(--radius-tile)] bg-danger/10 text-danger shadow-sm md:size-40"
          aria-hidden
        >
          <WarningIcon size={48} className="text-danger" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-danger">Library Issue</p>
          <h1 className="mt-1 text-[clamp(1.8rem,4vw,2.6rem)] font-bold leading-tight tracking-tight">
            Broken Tracks
          </h1>
          <p className="mt-1.5 text-sm text-text-secondary">
            {brokenTracks.length} track{brokenTracks.length === 1 ? "" : "s"} cannot be played due to corrupted data, unsupported codecs, or missing files.
            {totalDurationMs > 0 && ` · ${formatDurationLong(totalDurationMs)}`}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Original files on your disk are preserved. You can retry playback, restore healthy tracks, or remove entries from the library.
          </p>
        </div>
      </div>

      {/* Broken tracks list */}
      <div className="divide-y rounded-xl border bg-surface" style={{ borderColor: "var(--border-subtle)" }}>
        {brokenTracks.map((track) => {
          const isHighlighted = highlightedId === track.id;
          const displaySummary = track.broken?.summary || track.broken?.description || "Playback failed";

          return (
            <div
              key={track.id}
              id={`broken-track-${track.id}`}
              data-track-id={track.id}
              role="listitem"
              className={`flex flex-col gap-3 p-3.5 transition-all duration-300 sm:flex-row sm:items-start sm:justify-between sm:gap-4 md:px-4 ${
                isHighlighted ? "ring-2 ring-danger/80 bg-danger/5 dark:bg-danger/10 rounded-lg" : ""
              }`}
            >
              {/* Track info & artwork & error details */}
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <Artwork trackId={track.id} alt="" className="size-12 shrink-0 mt-0.5" rounded="rounded-md" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-text-primary">
                      {track.title}
                    </span>
                    <span className="shrink-0 rounded-md bg-danger/15 px-2 py-0.5 text-[11px] font-medium text-danger">
                      {categoryLabel(track.broken?.category)}
                    </span>
                    {track.broken?.errorCode && (
                      <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-mono text-text-muted">
                        {track.broken.errorCode}
                      </span>
                    )}
                  </div>

                  <p className="truncate text-xs text-text-secondary mt-0.5">
                    {track.artist || "Unknown Artist"}
                    {track.album ? ` · ${track.album}` : ""}
                  </p>

                  {/* Error Summary */}
                  <p className="mt-1 text-xs font-medium text-danger/90 leading-snug">
                    {displaySummary}
                  </p>

                  {/* Verbatim original error message for technical inspection */}
                  {track.broken?.originalMessage && track.broken.originalMessage !== displaySummary && (
                    <div className="mt-1.5 rounded bg-surface-raised/80 px-2.5 py-1.5 text-[11px] font-mono text-text-secondary select-text overflow-x-auto max-w-full">
                      {track.broken.originalMessage}
                    </div>
                  )}

                  {/* Failure time and attempts */}
                  <p className="mt-1 text-[11px] text-text-muted">
                    {track.broken?.failedAt ? `Failed ${new Date(track.broken.failedAt).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""}
                    {track.broken?.retryCount && track.broken.retryCount > 1 ? ` · ${track.broken.retryCount} attempts` : ""}
                  </p>
                </div>
              </div>

              {/* Actions: Retry, Restore, Remove */}
              <div className="flex shrink-0 items-center gap-2 self-end sm:self-start pt-1">
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-hover"
                  title="Attempt playback again"
                  onClick={() => handleRetry(track)}
                >
                  <PlayIcon size={13} />
                  Retry
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-hover"
                  title="Restore track back to normal library"
                  onClick={() => void handleRestore(track)}
                >
                  <RefreshIcon size={13} />
                  Restore
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
                  title="Remove from library (does not delete file from disk)"
                  onClick={() => setTrackToDelete(track)}
                >
                  <TrashIcon size={14} />
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={Boolean(trackToDelete)}
        title="Remove broken track?"
        description={`Are you sure you want to remove “${trackToDelete?.title}” from your library? Your source audio file on disk will not be deleted.`}
        confirmLabel="Remove"
        danger
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setTrackToDelete(null)}
      />
    </div>
  );
}
