import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlaybackStore } from "../../stores/playbackStore";
import { TrackListSection } from "../../components/TrackListSection";
import { ArtworkCard } from "../../components/ArtworkCard";
import { EmptyState } from "../../components/EmptyState";
import { LibraryEmptyState, ImportMusicButtons } from "./ImportMusic";
import { LibraryIcon, MusicNoteIcon } from "../../components/Icons";
import { formatDurationLong } from "../../utils/misc";
import { useTrackActions } from "./useTrackActions";
import { Menu } from "../../components/Menu";

type ViewMode = "songs" | "albums" | "artists";

/** All Songs / Albums / Artists views of the imported library (PRD §7.3). */
export function LibraryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState<ViewMode>("songs");
  const tracks = useLibraryStore((state) => state.tracks);
  const status = useLibraryStore((state) => state.status);
  const query = searchParams.get("q") ?? undefined;
  const { dialogs } = useTrackActions();

  const albums = useMemo(() => groupAlbums(tracks), [tracks]);
  const artists = useMemo(() => groupArtists(tracks), [tracks]);

  if (status === "error") {
    return (
      <EmptyState
        icon={<LibraryIcon size={28} />}
        title="Library storage problem"
        description="Your library could not be read from this device's storage. Other tabs may be holding the database, or storage may be corrupted. Reloading sometimes helps; your audio files are never affected."
        action={
          <button type="button" className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-accent-contrast" onClick={() => window.location.reload()}>
            Reload app
          </button>
        }
      />
    );
  }

  if (tracks.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
        <LibraryEmptyState />
      </div>
    );
  }

  const filteredAlbums = query
    ? albums.filter((album) => album.name.toLowerCase().includes(query.toLowerCase()) || album.artist.toLowerCase().includes(query.toLowerCase()))
    : albums;
  const filteredArtists = query
    ? artists.filter((artist) => artist.name.toLowerCase().includes(query.toLowerCase()))
    : artists;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
        <ImportMusicButtons />
      </div>

      <div role="tablist" aria-label="Library views" className="flex w-fit rounded-lg border p-0.5" style={{ borderColor: "var(--border-subtle)" }}>
        {(["songs", "albums", "artists"] as ViewMode[]).map((mode) => (
          <button
            key={mode}
            role="tab"
            aria-selected={view === mode}
            type="button"
            className={`rounded-md px-3.5 py-1.5 text-sm capitalize transition-colors ${
              view === mode ? "bg-surface-raised font-medium text-text-primary" : "text-text-secondary hover:text-text-primary"
            }`}
            onClick={() => setView(mode)}
          >
            {mode}
          </button>
        ))}
      </div>

      {view === "songs" && (
        <TrackListSection
          tracks={tracks}
          context={{ type: "library", label: "All songs" }}
          externalQuery={query}
          defaultSort="addedAt"
          emptyState={<LibraryEmptyState />}
        />
      )}

      {view === "albums" && (
        <>
          {filteredAlbums.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-text-muted" style={{ borderColor: "var(--border-subtle)" }}>
              No albums match “{query}”.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {filteredAlbums.map((album) => (
                <div key={album.key} className="relative">
                  <ArtworkCard
                    artworkKey={album.artworkTrackId}
                    title={album.name}
                    subtitle={`${album.trackCount} song${album.trackCount === 1 ? "" : "s"} · ${formatDurationLong(album.totalDurationMs)}`}
                    ariaLabel={`Play album ${album.name} by ${album.artist}`}
                    onOpen={() => playAlbum(album)}
                    onPlay={() => playAlbum(album)}
                  />
                  <div className="absolute right-1 top-1">
                    <Menu
                      items={buildMenuItemsForCollection(album.tracks.map((track) => track.id))}
                      buttonLabel={`More actions for album ${album.name}`}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {view === "artists" && (
        <>
          {filteredArtists.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-text-muted" style={{ borderColor: "var(--border-subtle)" }}>
              No artists match “{query}”.
            </p>
          ) : (
            <div className="space-y-0.5">
              {filteredArtists.map((artist) => (
                <button
                  key={artist.name}
                  type="button"
                  className="flex w-full items-center gap-4 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-surface-hover"
                  onClick={() => {
                    usePlaybackStore.getState().playContext(
                      artist.tracks.map((track) => track.id),
                      0,
                      { type: "artist", label: artist.name },
                    );
                  }}
                >
                  <span className="grid size-11 place-items-center rounded-full bg-surface-raised text-accent" aria-hidden>
                    <MusicNoteIcon size={18} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-text-primary">{artist.name}</span>
                    <span className="block text-xs text-text-secondary">
                      {artist.trackCount} song{artist.trackCount === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {query !== undefined && (
        <button
          type="button"
          className="text-xs text-text-secondary underline underline-offset-2 hover:text-text-primary"
          onClick={() => setSearchParams({})}
        >
          Clear search filter “{query}”
        </button>
      )}
      {dialogs}
    </div>
  );

  function playAlbum(album: AlbumGroup) {
    const ordered = [...album.tracks].sort((a, b) => (a.trackNumber ?? 999) - (b.trackNumber ?? 999));
    usePlaybackStore.getState().playContext(
      ordered.map((track) => track.id),
      0,
      { type: "album", label: album.name },
    );
  }
}

type AlbumGroup = {
  key: string;
  name: string;
  artist: string;
  trackCount: number;
  totalDurationMs: number;
  tracks: import("../../types").Track[];
  artworkTrackId: string | null;
};

function groupAlbums(tracks: import("../../types").Track[]): AlbumGroup[] {
  const map = new Map<string, AlbumGroup>();
  for (const track of tracks) {
    const name = track.album || "Unknown album";
    const artist = track.artist || "Unknown artist";
    const key = `${name}::${artist}`;
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        name,
        artist,
        trackCount: 0,
        totalDurationMs: 0,
        tracks: [],
        artworkTrackId: null,
      };
      map.set(key, group);
    }
    group.tracks.push(track);
    group.trackCount += 1;
    group.totalDurationMs += track.durationMs ?? 0;
    if (!group.artworkTrackId) group.artworkTrackId = track.id;
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function groupArtists(tracks: import("../../types").Track[]): { name: string; trackCount: number; tracks: import("../../types").Track[] }[] {
  const map = new Map<string, { name: string; trackCount: number; tracks: import("../../types").Track[] }>();
  for (const track of tracks) {
    const name = track.artist || "Unknown artist";
    const existing = map.get(name) ?? { name, trackCount: 0, tracks: [] };
    existing.tracks.push(track);
    existing.trackCount += 1;
    map.set(name, existing);
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function buildMenuItemsForCollection(trackIds: string[]) {
  return [
    {
      kind: "action" as const,
      label: `Play all (${trackIds.length} songs)`,
      onSelect: () => usePlaybackStore.getState().playContext(trackIds, 0, { type: "album", label: "Album" }),
    },
    {
      kind: "action" as const,
      label: "Add album to queue",
      onSelect: () => {
        for (const id of trackIds) usePlaybackStore.getState().enqueue(id);
      },
    },
  ];
}
