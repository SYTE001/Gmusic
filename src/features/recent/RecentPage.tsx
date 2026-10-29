import { useMemo, useState } from "react";
import { useLibraryStore } from "../../stores/libraryStore";
import { EmptyState } from "../../components/EmptyState";
import { ClockIcon } from "../../components/Icons";
import { formatDate, formatDurationLong } from "../../utils/misc";
import { TrackRow } from "../../components/TrackRow";
import { useTrackActions } from "../library/useTrackActions";

/** Recently Played (PRD §7.6 lastPlayedAt tracking), ordered by real history. */
export function RecentPage() {
  const tracks = useLibraryStore((state) => state.tracks);
  const [limit, setLimit] = useState(50);
  const { dialogs } = useTrackActions();

  const recent = useMemo(
    () => tracks.filter((track) => track.lastPlayedAt !== null).sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0)),
    [tracks],
  );
  const visible = recent.slice(0, limit);
  const contextTrackIds = useMemo(() => recent.map((track) => track.id), [recent]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Recently Played</h1>
        {recent.length > 0 && (
          <p className="text-sm text-text-secondary">
            {recent.length} song{recent.length === 1 ? "" : "s"} · {formatDurationLong(recent.reduce((sum, track) => sum + (track.durationMs ?? 0), 0))}
          </p>
        )}
      </div>

      {recent.length === 0 ? (
        <EmptyState
          icon={<ClockIcon size={28} />}
          title="Nothing played yet"
          description="Songs you play will show up here with when you last played them. This history stays on this device."
        />
      ) : (
        <>
          <div className="space-y-0.5">
            {visible.map((track, index) => (
              <div key={track.id} className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <TrackRow
                    track={track}
                    contextTrackIds={contextTrackIds}
                    context={{ type: "recent", label: "Recently played" }}
                    index={index + 1}
                    showAlbum
                    showAdded={false}
                  />
                </div>
                <span className="hidden w-24 shrink-0 pb-1 text-right text-xs text-text-muted md:block">
                  {formatDate(track.lastPlayedAt)}
                </span>
              </div>
            ))}
          </div>
          {recent.length > visible.length && (
            <button
              type="button"
              className="rounded-lg border px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
              style={{ borderColor: "var(--border-subtle)" }}
              onClick={() => setLimit((value) => value + 100)}
            >
              Show more ({recent.length - visible.length} remaining)
            </button>
          )}
        </>
      )}
      {dialogs}
    </div>
  );
}
