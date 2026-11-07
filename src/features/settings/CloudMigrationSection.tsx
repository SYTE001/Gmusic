import { useCloudStore } from "../../stores/cloudStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { CloudIcon } from "../../components/Icons";
import type { MigrationProgress } from "../../services/cloud/migrationService";

/**
 * Settings → Storage → Move your library to the cloud (spec §6).
 *
 * Shows exactly which tracks can and cannot be moved, reports per-file
 * progress, and offers retry for failures. Local audio is never deleted here;
 * removing a local copy is a separate explicit action in the track menu.
 */
export function CloudMigrationSection() {
  const cloud = useCloudStore();
  const tracks = useLibraryStore((state) => state.tracks);
  const signedIn = cloud.status === "authenticated";

  const start = () => {
    // The store builds the plan itself so nothing here can get out of sync
    // with the local library.
    void cloud.startMigration();
  };

  const isRunning = cloud.migration.state === "running";
  const progress: MigrationProgress = cloud.migration;
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  if (!signedIn) {
    return (
      <div className="space-y-2 rounded-xl border p-4 text-sm text-text-secondary" style={{ borderColor: "var(--border-subtle)" }}>
        <div className="flex items-center gap-2 text-text-primary">
          <CloudIcon size={16} />
          <span>Move your library to the cloud</span>
        </div>
        <p>Sign in to the Cloud section above first. Nothing is uploaded without an account.</p>
      </div>
    );
  }

  const needsAccess = progress.items.filter((item) => item.status === "needs-access");
  const missing = progress.items.filter((item) => item.status === "missing");
  const failed = progress.items.filter((item) => item.status === "failed");

  return (
    <div className="space-y-3 rounded-xl border p-4 text-sm" style={{ borderColor: "var(--border-subtle)" }}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-text-primary">
          <CloudIcon size={16} />
          <span>Move your library to the cloud</span>
        </div>
        <span className="tabular-nums text-xs text-text-muted">
          {progress.total > 0 ? `${progress.done} / ${progress.total}` : `${tracks.length} tracks local`}
        </span>
      </div>

      {isRunning && (
        <div className="space-y-1.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-hover" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <p className="text-xs text-text-secondary">
            {progress.currentTitle ? `Uploading “${progress.currentTitle}”…` : "Working…"} ({percent}%)
          </p>
        </div>
      )}

      {progress.state === "complete" && (
        <p className="text-xs text-secondary">
          {progress.succeeded} uploaded, {progress.failed} failed, {progress.skipped} not available locally.
        </p>
      )}
      {progress.state === "cancelled" && (
        <p className="text-xs text-text-secondary">
          Migration stopped. {progress.done} finished, {progress.total - progress.done} left for later.
        </p>
      )}

      {failed.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-danger">{failed.length} failed — your local files are untouched.</p>
          <ul className="max-h-32 list-inside list-disc space-y-1 overflow-auto text-xs text-text-secondary">
            {failed.slice(0, 8).map((item) => (
              <li key={item.trackId}>
                “{item.title}”: {item.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(needsAccess.length > 0 || missing.length > 0) && (
        <div className="space-y-1.5">
          {needsAccess.length > 0 && (
            <p className="text-xs text-text-secondary">
              {needsAccess.length} track{needsAccess.length === 1 ? "" : "s"} need file access again — play them once to
              re-grant permission, or use “Locate file” in the track menu.
            </p>
          )}
          {missing.length > 0 && (
            <p className="text-xs text-text-secondary">
              {missing.length} track{missing.length === 1 ? "" : "s"} have no reachable audio on this device — re-link them
              from the track menu to upload.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-accent-contrast disabled:opacity-50"
          disabled={isRunning || cloud.busy}
          onClick={start}
        >
          {isRunning ? "Uploading…" : progress.failed > 0 ? "Retry failed" : "Start upload"}
        </button>
        {isRunning && (
          <button
            type="button"
            className="rounded-lg border px-3.5 py-1.5 text-sm text-text-primary transition-colors hover:bg-surface-hover"
            style={{ borderColor: "var(--border-strong)" }}
            onClick={() => cloud.cancelMigration()}
          >
            Stop after current file
          </button>
        )}
        {progress.state === "complete" && progress.failed > 0 && (
          <button
            type="button"
            className="rounded-lg border px-3.5 py-1.5 text-sm text-text-primary transition-colors hover:bg-surface-hover"
            style={{ borderColor: "var(--border-strong)" }}
            onClick={() => void cloud.retryMigration()}
          >
            Retry {failed.length} failed
          </button>
        )}
      </div>

      <p className="text-xs text-text-muted">
        Files upload a few at a time. Your original files and any local copies in this app are kept; removing them is a
        separate, explicit action you take per track.
      </p>
    </div>
  );
}
