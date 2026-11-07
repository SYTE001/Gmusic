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
  const grantFileAccess = useLibraryStore((state) => state.grantFileAccess);
  const removeTracks = useLibraryStore((state) => state.removeTracks);

  const [trackToDelete, setTrackToDelete] = useState<Track | null>(null);

  const { brokenTracks, missingTracks, permissionTracks, cloudUnavailableTracks } = useMemo(() => {
    const broken: Track[] = [];
    const missing: Track[] = [];
    const permission: Track[] = [];
    const cloudUnavailable: Track[] = [];

    for (const t of tracks) {
      if (t.availability === "permission-required") {
        permission.push(t);
      } else if (
        t.availability === "offline" ||
        (t.accessMode === "cloud" && (t.cloudStatus === "failed" || !t.objectKey))
      ) {
        cloudUnavailable.push(t);
      } else if (t.availability === "missing" || t.broken?.category === "missing") {
        missing.push(t);
      } else if (t.broken?.isBroken || t.availability === "broken") {
        broken.push(t);
      }
    }

    return {
      brokenTracks: broken,
      missingTracks: missing,
      permissionTracks: permission,
      cloudUnavailableTracks: cloudUnavailable,
    };
  }, [tracks]);

  const permanentIssueTracks = useMemo(
    () => [...brokenTracks, ...missingTracks],
    [brokenTracks, missingTracks],
  );
  const allIssueTracks = useMemo(
    () => [...brokenTracks, ...missingTracks, ...permissionTracks, ...cloudUnavailableTracks],
    [brokenTracks, missingTracks, permissionTracks, cloudUnavailableTracks],
  );

  const totalDurationMs = allIssueTracks.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);

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

  const handleGrantAccess = async (track: Track) => {
    const ok = await grantFileAccess(track.id);
    if (ok) {
      toast("success", `Granted file access for “${track.title}”.`);
    } else {
      toast("error", "Grant access to this audio file.");
    }
  };

  const handleGrantAllAccess = async () => {
    let grantedCount = 0;
    for (const track of permissionTracks) {
      const ok = await grantFileAccess(track.id);
      if (ok) grantedCount += 1;
    }
    if (grantedCount > 0) {
      toast("success", `Granted access to ${grantedCount} track${grantedCount === 1 ? "" : "s"}.`);
    } else {
      toast("error", "Grant access to this audio file.");
    }
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
      case "permission":
        return "Permission required";
      case "cloud-unavailable":
        return "Cloud unavailable";
      default:
        return "Playback failed";
    }
  };

  const renderTrackRow = (
    track: Track,
    sectionKind: "broken" | "missing" | "permission" | "cloud",
  ) => {
    const isHighlighted = highlightedId === track.id;
    const badgeText =
      sectionKind === "permission"
        ? "Permission required"
        : sectionKind === "cloud"
          ? "Cloud unavailable"
          : sectionKind === "missing"
            ? categoryLabel(track.broken?.category ?? "missing")
            : categoryLabel(track.broken?.category);

    const displaySummary =
      track.broken?.summary ||
      track.broken?.description ||
      (sectionKind === "permission"
        ? "Grant access to this audio file."
        : sectionKind === "cloud"
          ? "Could not retrieve the cloud audio."
          : sectionKind === "missing"
            ? "Audio file not found. Locate or re-import it."
            : "Audio decoding failed. The file may be corrupted.");

    const isTransient = sectionKind === "permission" || sectionKind === "cloud";

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
              <span
                className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium ${
                  isTransient ? "bg-surface-raised text-text-secondary" : "bg-danger/15 text-danger"
                }`}
              >
                {badgeText}
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
            <p className={`mt-1 text-xs font-medium leading-snug ${isTransient ? "text-text-secondary" : "text-danger/90"}`}>
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

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-2 self-end sm:self-start pt-1">
          {sectionKind === "permission" && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent-strong px-3 py-1.5 text-xs font-medium text-accent-contrast transition-colors"
              onClick={() => void handleGrantAccess(track)}
            >
              Grant access
            </button>
          )}
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-hover"
            title="Attempt playback again"
            onClick={() => handleRetry(track)}
          >
            <PlayIcon size={13} />
            Retry
          </button>
          {(track.broken?.isBroken || track.availability === "broken") && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-hover"
              title="Restore track back to normal library"
              onClick={() => void handleRestore(track)}
            >
              <RefreshIcon size={13} />
              Restore
            </button>
          )}
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
  };

  if (allIssueTracks.length === 0) {
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
          <p className="text-xs font-semibold uppercase tracking-wider text-danger">Library Health</p>
          <h1 className="mt-1 text-[clamp(1.8rem,4vw,2.6rem)] font-bold leading-tight tracking-tight">
            Broken Tracks
          </h1>
          <p className="mt-1.5 text-sm text-text-secondary">
            {permanentIssueTracks.length === 0
              ? `No broken tracks · ${allIssueTracks.length} track${allIssueTracks.length === 1 ? "" : "s"} need temporary access or connectivity`
              : `${allIssueTracks.length} track${allIssueTracks.length === 1 ? "" : "s"} need attention`}
            {totalDurationMs > 0 && ` · ${formatDurationLong(totalDurationMs)}`}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Original files on your disk are preserved. Temporary permission or network issues are separated from corrupted or missing files.
          </p>
        </div>
      </div>

      {/* 1. Broken / Corrupted */}
      {brokenTracks.length > 0 && (
        <section className="space-y-2" aria-label="Broken / corrupted">
          <h2 className="text-sm font-semibold text-text-primary">
            Broken / corrupted ({brokenTracks.length})
          </h2>
          <div className="divide-y rounded-xl border bg-surface" style={{ borderColor: "var(--border-subtle)" }}>
            {brokenTracks.map((track) => renderTrackRow(track, "broken"))}
          </div>
        </section>
      )}

      {/* 2. Missing local files */}
      {missingTracks.length > 0 && (
        <section className="space-y-2" aria-label="Missing local files">
          <h2 className="text-sm font-semibold text-text-primary">
            Missing local files ({missingTracks.length})
          </h2>
          <div className="divide-y rounded-xl border bg-surface" style={{ borderColor: "var(--border-subtle)" }}>
            {missingTracks.map((track) => renderTrackRow(track, "missing"))}
          </div>
        </section>
      )}

      {/* 3. Permission required */}
      {permissionTracks.length > 0 && (
        <section className="space-y-2" aria-label="Permission required">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-text-primary">
                Permission required ({permissionTracks.length})
              </h2>
              <p className="text-xs text-text-secondary">
                These tracks use retained local file handles and are not corrupted. Grant access or press Play to recover them.
              </p>
            </div>
            {permissionTracks.length > 1 && (
              <button
                type="button"
                className="shrink-0 rounded-lg bg-accent-strong px-3 py-1.5 text-xs font-medium text-accent-contrast"
                onClick={() => void handleGrantAllAccess()}
              >
                Grant access to all
              </button>
            )}
          </div>
          <div className="divide-y rounded-xl border bg-surface" style={{ borderColor: "var(--border-subtle)" }}>
            {permissionTracks.map((track) => renderTrackRow(track, "permission"))}
          </div>
        </section>
      )}

      {/* 4. Cloud unavailable */}
      {cloudUnavailableTracks.length > 0 && (
        <section className="space-y-2" aria-label="Cloud unavailable">
          <h2 className="text-sm font-semibold text-text-primary">
            Cloud unavailable ({cloudUnavailableTracks.length})
          </h2>
          <div className="divide-y rounded-xl border bg-surface" style={{ borderColor: "var(--border-subtle)" }}>
            {cloudUnavailableTracks.map((track) => renderTrackRow(track, "cloud"))}
          </div>
        </section>
      )}

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
