import { useEffect, useMemo, useState } from "react";
import { useLibraryStore } from "../../stores/libraryStore";
import { useCloudStore } from "../../stores/cloudStore";
import { repository, type PendingMetadataSync } from "../../services/indexeddb/LibraryRepository";
import { retryPendingMetadataSync } from "../../services/cloud/cloudMetadataSyncService";
import { toast } from "../../stores/toastStore";
import type { Track } from "../../types";
import {
  CheckIcon,
  CloseIcon,
  CloudCheckIcon,
  EditIcon,
  MusicNoteIcon,
  RefreshIcon,
  SearchIcon,
  WarningIcon,
} from "../../components/Icons";

type SaveFeedback = {
  message: string;
  isError: boolean;
};

/**
 * Settings -> Library Metadata editor (PRD & Agent guidelines):
 * - Exclusively placed inside Settings.
 * - Searchable by track title.
 * - Allows editing Track Title and Description.
 * - Saves using the track's stable ID, never its filename.
 * - Preserves original audio files and embedded tags untouched.
 * - Saves locally in IndexedDB first, syncs to Supabase when connected,
 *   and retains local edits + queues for retry on sync failure.
 */
export function LibraryMetadataSection() {
  const tracks = useLibraryStore((state) => state.tracks);
  const updateTrackMetadata = useLibraryStore((state) => state.updateTrackMetadata);
  const cloud = useCloudStore();

  const [searchQuery, setSearchQuery] = useState("");
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<SaveFeedback | null>(null);
  const [pendingQueue, setPendingQueue] = useState<PendingMetadataSync[]>([]);
  const [isRetryingQueue, setIsRetryingQueue] = useState(false);

  // Refresh pending retry queue from IndexedDB
  const refreshPendingQueue = async () => {
    try {
      const items = await repository.listPendingMetadataSync();
      setPendingQueue(items);
    } catch {
      setPendingQueue([]);
    }
  };

  useEffect(() => {
    void refreshPendingQueue();
  }, [tracks.length, cloud.syncStatus]);

  const filteredTracks = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return tracks;
    return tracks.filter((t) => t.title.toLowerCase().includes(q));
  }, [tracks, searchQuery]);

  const pendingTrackIds = useMemo(() => {
    return new Set(pendingQueue.map((item) => item.trackId));
  }, [pendingQueue]);

  const startEditing = (track: Track) => {
    setEditingTrackId(track.id);
    setDraftTitle(track.title);
    setDraftDescription(track.description ?? "");
    setSaveFeedback(null);
  };

  const cancelEditing = () => {
    setEditingTrackId(null);
    setDraftTitle("");
    setDraftDescription("");
    setSaveFeedback(null);
  };

  const handleSave = async (track: Track) => {
    const trimmedTitle = draftTitle.trim();
    if (!trimmedTitle) {
      setSaveFeedback({ message: "Track title cannot be empty.", isError: true });
      return;
    }

    setIsSaving(true);
    setSaveFeedback(null);

    try {
      const result = await updateTrackMetadata(track.id, {
        title: trimmedTitle,
        description: draftDescription.trim(),
      });

      await refreshPendingQueue();

      if (result.syncStatus === "synced") {
        setSaveFeedback({ message: "Saved locally and synced with cloud.", isError: false });
        toast("success", `Updated metadata for “${trimmedTitle}” (synced).`);
      } else if (result.syncStatus === "queued") {
        setSaveFeedback({
          message: "Saved locally. Cloud sync failed and is queued for retry.",
          isError: true,
        });
        toast("info", `Saved “${trimmedTitle}” locally. Cloud sync queued for retry.`);
      } else {
        setSaveFeedback({ message: "Saved to this device.", isError: false });
        toast("success", `Updated metadata for “${trimmedTitle}”.`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Failed to save metadata.";
      setSaveFeedback({ message: errorMsg, isError: true });
      toast("error", errorMsg);
    } finally {
      setIsSaving(false);
    }
  };

  const handleRetryAll = async () => {
    setIsRetryingQueue(true);
    try {
      const { cleared, remaining } = await retryPendingMetadataSync();
      await refreshPendingQueue();
      if (cleared > 0 && remaining === 0) {
        toast("success", "All queued metadata changes synced to cloud.");
      } else if (cleared > 0 && remaining > 0) {
        toast("info", `${cleared} synced, ${remaining} still queued.`);
      } else if (remaining > 0) {
        toast("error", "Could not sync queued metadata. Will retry when connected.");
      }
    } catch {
      toast("error", "Retry attempt failed.");
    } finally {
      setIsRetryingQueue(false);
    }
  };

  const handleRetrySingle = async (trackId: string) => {
    setIsRetryingQueue(true);
    try {
      const track = tracks.find((t) => t.id === trackId);
      if (track) {
        const result = await updateTrackMetadata(track.id, {
          title: track.title,
          description: track.description ?? "",
        });
        await refreshPendingQueue();
        if (result.syncStatus === "synced") {
          toast("success", "Metadata synced successfully.");
          setSaveFeedback({ message: "Synced with cloud.", isError: false });
        } else {
          toast("error", "Sync attempt failed; retained in retry queue.");
        }
      }
    } finally {
      setIsRetryingQueue(false);
    }
  };

  return (
    <section aria-label="Library Metadata">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-muted">
        Library Metadata
      </h2>
      <p className="px-1 mb-3 text-sm text-text-secondary">
        Edit track titles and custom descriptions. Edits are saved locally in IndexedDB first, then synced with
        your cloud account when connected. The original audio files and their embedded tags are never modified.
      </p>

      {/* Queued retry banner */}
      {pendingQueue.length > 0 && (
        <div
          className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning/10 p-3 text-sm"
          role="status"
        >
          <div className="flex items-center gap-2 text-warning">
            <WarningIcon size={16} />
            <span>
              {pendingQueue.length} {pendingQueue.length === 1 ? "track has" : "tracks have"} metadata edits queued for cloud sync.
            </span>
          </div>
          <button
            type="button"
            disabled={isRetryingQueue}
            onClick={() => void handleRetryAll()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-warning/40 bg-surface-raised px-3 py-1 text-xs font-medium text-text-primary hover:bg-surface-hover disabled:opacity-50"
          >
            <RefreshIcon size={12} className={isRetryingQueue ? "animate-spin" : ""} />
            {isRetryingQueue ? "Retrying…" : "Retry sync"}
          </button>
        </div>
      )}

      {/* Empty library state */}
      {tracks.length === 0 ? (
        <div
          className="rounded-xl border p-6 text-center text-sm text-text-secondary"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <MusicNoteIcon size={24} className="mx-auto mb-2 text-text-muted" />
          <p className="font-medium text-text-primary">Your library is empty</p>
          <p className="mt-1 text-xs text-text-muted">Import audio files to view and edit track metadata.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Search bar */}
          <div className="relative">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-text-muted">
              <SearchIcon size={14} />
            </div>
            <input
              type="text"
              placeholder="Search tracks by title…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg border bg-surface-raised pl-9 pr-8 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
              style={{ borderColor: "var(--border-subtle)" }}
              aria-label="Search tracks by title"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-text-muted hover:text-text-primary"
                aria-label="Clear search"
              >
                <CloseIcon size={14} />
              </button>
            )}
          </div>

          {/* Search count or empty search */}
          {filteredTracks.length === 0 ? (
            <div
              className="rounded-xl border p-6 text-center text-sm text-text-secondary"
              style={{ borderColor: "var(--border-subtle)" }}
            >
              <p className="font-medium text-text-primary">No tracks found</p>
              <p className="mt-1 text-xs text-text-muted">
                No track titles match “{searchQuery}”.
              </p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[30rem] overflow-y-auto pr-1">
              {filteredTracks.map((track) => {
                const isEditing = editingTrackId === track.id;
                const isPending = pendingTrackIds.has(track.id);
                const isCloudSynced = track.cloudStatus === "ready" && !isPending;

                return (
                  <div
                    key={track.id}
                    className="rounded-xl border p-3.5 transition-colors"
                    style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--surface-raised)" }}
                  >
                    {!isEditing ? (
                      /* Collapsed row view */
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-text-primary">
                              {track.title}
                            </span>
                            {/* Sync Status Badge */}
                            {isPending ? (
                              <span
                                className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-warning bg-warning/15"
                                title="Cloud sync pending; queued for retry"
                              >
                                <WarningIcon size={11} />
                                Sync queued
                              </span>
                            ) : isCloudSynced ? (
                              <span
                                className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent bg-accent/15"
                                title="Synchronized with cloud"
                              >
                                <CloudCheckIcon size={11} />
                                Synced
                              </span>
                            ) : (
                              <span
                                className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-text-muted bg-surface-hover"
                                title="Stored on this device"
                              >
                                <CheckIcon size={11} />
                                Local
                              </span>
                            )}
                          </div>

                          <div className="mt-0.5 truncate text-xs text-text-secondary">
                            {track.artist || "Unknown Artist"}
                            {track.album ? ` • ${track.album}` : ""}
                          </div>

                          {track.description && (
                            <p className="mt-1 line-clamp-2 text-xs italic text-text-muted">
                              “{track.description}”
                            </p>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() => startEditing(track)}
                          className="inline-flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium text-text-primary transition-colors hover:bg-surface-hover"
                          style={{ borderColor: "var(--border-strong)" }}
                          aria-label={`Edit metadata for ${track.title}`}
                        >
                          <EditIcon size={12} />
                          Edit
                        </button>
                      </div>
                    ) : (
                      /* Expanded editor view */
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void handleSave(track);
                        }}
                        className="space-y-3"
                      >
                        <div
                          className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 text-xs text-text-muted"
                          style={{ borderColor: "var(--border-subtle)" }}
                        >
                          <div className="flex items-center gap-2">
                            <span>Stable ID:</span>
                            <code className="font-mono text-text-secondary">{track.id}</code>
                          </div>
                          <div className="truncate text-text-muted" title={track.fileName}>
                            File: <span className="text-text-secondary">{track.fileName}</span> (untouched)
                          </div>
                        </div>

                        {/* Title input */}
                        <div>
                          <label
                            htmlFor={`metadata-title-${track.id}`}
                            className="block text-xs font-medium text-text-secondary"
                          >
                            Track Title <span className="text-danger">*</span>
                          </label>
                          <input
                            id={`metadata-title-${track.id}`}
                            type="text"
                            value={draftTitle}
                            onChange={(e) => setDraftTitle(e.target.value)}
                            disabled={isSaving}
                            className="mt-1 w-full rounded-lg border bg-surface px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                            style={{ borderColor: "var(--border-strong)" }}
                            placeholder="Track title"
                            required
                          />
                        </div>

                        {/* Description textarea */}
                        <div>
                          <label
                            htmlFor={`metadata-desc-${track.id}`}
                            className="block text-xs font-medium text-text-secondary"
                          >
                            Description / Notes
                          </label>
                          <textarea
                            id={`metadata-desc-${track.id}`}
                            rows={3}
                            value={draftDescription}
                            onChange={(e) => setDraftDescription(e.target.value)}
                            disabled={isSaving}
                            className="mt-1 w-full rounded-lg border bg-surface px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
                            style={{ borderColor: "var(--border-strong)" }}
                            placeholder="Add personal notes, lyric summaries, or tags…"
                          />
                        </div>

                        {/* Save feedback banner */}
                        {saveFeedback && (
                          <div
                            className={`rounded-lg px-2.5 py-1.5 text-xs ${
                              saveFeedback.isError
                                ? "bg-danger/10 text-danger border border-danger/20"
                                : "bg-accent/10 text-accent border border-accent/20"
                            }`}
                            role="status"
                          >
                            {saveFeedback.message}
                          </div>
                        )}

                        {/* Actions */}
                        <div className="flex items-center justify-between pt-1">
                          <div className="flex items-center gap-2">
                            <button
                              type="submit"
                              disabled={isSaving || !draftTitle.trim()}
                              className="rounded-lg bg-accent-strong px-3.5 py-1.5 text-xs font-medium text-accent-contrast transition-opacity disabled:opacity-50"
                            >
                              {isSaving ? "Saving…" : "Save changes"}
                            </button>
                            <button
                              type="button"
                              disabled={isSaving}
                              onClick={cancelEditing}
                              className="rounded-lg border px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-hover"
                              style={{ borderColor: "var(--border-strong)" }}
                            >
                              Cancel
                            </button>
                          </div>

                          {isPending && (
                            <button
                              type="button"
                              disabled={isSaving || isRetryingQueue}
                              onClick={() => void handleRetrySingle(track.id)}
                              className="inline-flex items-center gap-1 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs font-medium text-warning hover:bg-warning/20 disabled:opacity-50"
                              title="Retry syncing this track's metadata to cloud"
                            >
                              <RefreshIcon size={12} className={isRetryingQueue ? "animate-spin" : ""} />
                              Retry sync
                            </button>
                          )}
                        </div>
                      </form>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
