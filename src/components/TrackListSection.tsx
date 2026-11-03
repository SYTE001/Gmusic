import { useMemo, useRef, useState, type ReactNode } from "react";
import type { PlaybackContext, Track } from "../types";
import { TrackRow } from "./TrackRow";
import { normalizeForSearch } from "../utils/misc";
import { recordComponentRender } from "../utils/perf";

export type SortKey = "title" | "artist" | "album" | "addedAt" | "duration" | "recentlyPlayed";

const SORT_LABELS: Record<SortKey, string> = {
  title: "Title",
  artist: "Artist",
  album: "Album",
  addedAt: "Date added",
  duration: "Duration",
  recentlyPlayed: "Recently played",
};

const trackSortCollator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function sortTracks(tracks: Track[], key: SortKey): Track[] {
  const copy = [...tracks];
  switch (key) {
    case "title":
      return copy.sort((a, b) => trackSortCollator.compare(a.title, b.title));
    case "artist":
      return copy.sort(
        (a, b) =>
          trackSortCollator.compare(a.artist || "unknown artist", b.artist || "unknown artist") ||
          trackSortCollator.compare(a.title, b.title),
      );
    case "album":
      return copy.sort(
        (a, b) =>
          trackSortCollator.compare(a.album || "unknown album", b.album || "unknown album") ||
          (a.trackNumber ?? 0) - (b.trackNumber ?? 0),
      );
    case "addedAt":
      return copy.sort((a, b) => b.addedAt - a.addedAt);
    case "duration":
      return copy.sort((a, b) => (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity));
    case "recentlyPlayed":
      return copy.sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0));
    default:
      return copy;
  }
}

/**
 * Shared sort control + search filter + rendered track rows. Used by Library,
 * Liked Songs, Recently Played, and Playlist detail so conventions match
 * (PRD §7.5).
 */
function isSortAndRowVisualsUnchanged(prev: Track[], next: Track[]): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (a === b) continue;
    if (
      a.id !== b.id ||
      a.title !== b.title ||
      a.artist !== b.artist ||
      a.album !== b.album ||
      a.fileName !== b.fileName ||
      a.trackNumber !== b.trackNumber ||
      a.durationMs !== b.durationMs ||
      a.addedAt !== b.addedAt ||
      a.isLiked !== b.isLiked ||
      a.availability !== b.availability ||
      a.accessMode !== b.accessMode ||
      a.cloudStatus !== b.cloudStatus ||
      a.objectKey !== b.objectKey
    ) {
      return false;
    }
  }
  return true;
}

export function TrackListSection({
  tracks,
  context,
  showAlbum = true,
  showAdded = true,
  defaultSort = "title",
  searchable = true,
  externalQuery,
  emptyState,
  playlistId,
  headerRight,
  maxRowsWithoutVirtualization = 300,
}: {
  tracks: Track[];
  context: PlaybackContext;
  showAlbum?: boolean;
  showAdded?: boolean;
  defaultSort?: SortKey;
  searchable?: boolean;
  externalQuery?: string;
  emptyState: ReactNode;
  playlistId?: string;
  headerRight?: ReactNode;
  maxRowsWithoutVirtualization?: number;
}) {
  recordComponentRender("TrackListSection");
  const [sortKey, setSortKey] = useState<SortKey>(defaultSort);
  const [localQuery, setLocalQuery] = useState("");
  const query = externalQuery !== undefined ? externalQuery : localQuery;

  const prevFilterInputsRef = useRef<{ tracks: Track[]; query: string; sortKey: SortKey; result: Track[] } | null>(null);
  const filtered = useMemo(() => {
    const prev = prevFilterInputsRef.current;
    if (
      prev &&
      prev.query === query &&
      prev.sortKey === sortKey &&
      sortKey !== "recentlyPlayed" &&
      isSortAndRowVisualsUnchanged(prev.tracks, tracks)
    ) {
      prev.tracks = tracks;
      return prev.result;
    }
    const normalized = normalizeForSearch(query);
    const base = normalized.length > 0
      ? tracks.filter(
          (track) =>
            normalizeForSearch(track.title).includes(normalized) ||
            normalizeForSearch(track.artist).includes(normalized) ||
            normalizeForSearch(track.album).includes(normalized) ||
            normalizeForSearch(track.fileName).includes(normalized),
        )
      : tracks;
    const result = sortTracks(base, sortKey);
    prevFilterInputsRef.current = { tracks, query, sortKey, result };
    return result;
  }, [tracks, query, sortKey]);

  const prevContextIdsRef = useRef<string[]>([]);
  const contextTrackIds = useMemo(() => {
    const prev = prevContextIdsRef.current;
    if (prev.length === filtered.length && filtered.every((item, i) => item.id === prev[i])) {
      return prev;
    }
    const next = filtered.map((item) => item.id);
    prevContextIdsRef.current = next;
    return next;
  }, [filtered]);

  if (tracks.length === 0) {
    return <>{emptyState}</>;
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {searchable && externalQuery === undefined && (
          <input
            type="search"
            value={localQuery}
            onChange={(event) => setLocalQuery(event.target.value)}
            placeholder="Filter these songs…"
            aria-label="Filter songs"
            className="w-56 max-w-full rounded-lg border bg-transparent px-3 py-1.5 text-sm outline-none focus:border-accent"
            style={{ borderColor: "var(--border-subtle)" }}
          />
        )}
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          Sort by
          <select
            value={sortKey}
            onChange={(event) => setSortKey(event.target.value as SortKey)}
            className="rounded-lg border bg-surface px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            {Object.entries(SORT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {headerRight}
        <span className="ml-auto text-xs text-text-muted tabular-nums">
          {filtered.length} song{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-text-muted" style={{ borderColor: "var(--border-subtle)" }}>
          No songs match “{query}”.
        </p>
      ) : (
        <div role="list" aria-label="Songs" className="space-y-0.5">
          {filtered.slice(0, maxRowsWithoutVirtualization).map((track, index) => (
            <TrackRow
              key={track.id}
              track={track}
              index={index + 1}
              contextTrackIds={contextTrackIds}
              context={context}
              showAlbum={showAlbum}
              showAdded={showAdded}
              playlistId={playlistId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
