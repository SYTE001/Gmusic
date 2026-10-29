import type { AppPreferences, LyricsCacheMeta, Playlist, Track, TrackLyrics } from "../../types";
import { requestToPromise, STORES, toDBError, withTransaction } from "./db";

/**
 * LibraryRepository — the only module that talks to IndexedDB (rules §5).
 * UI components never touch IndexedDB directly.
 */

export type ArtworkRecord = { trackId: string; blob: Blob };
export type AudioRecord = { trackId: string; blob: Blob };
export type HandleRecord = { trackId: string; handle: FileSystemFileHandle };
export type PrefsRecord = { name: "app"; prefs: AppPreferences };

/**
 * A cloud deletion whose object or metadata removal failed midway. Kept here
 * so a later sync can finish it: every entry is retried until BOTH the R2
 * objects and the Postgres rows are gone, which is what makes a partial
 * failure temporary instead of a permanent orphan.
 */
export type PendingCloudDeletion = {
  trackId: string;
  objectKey: string | null;
  firstAttemptedAt: number;
  /** Human-readable reason for the most recent failure. */
  lastError: string;
};

type PendingDeletionsRecord = { name: "cloud-deletions"; items: PendingCloudDeletion[] };

export class LibraryRepository {
  // ---- Tracks ----

  async listTracks(): Promise<Track[]> {
    try {
      return await withTransaction([STORES.tracks], "readonly", (tx) =>
        requestToPromise(tx.objectStore(STORES.tracks).getAll() as IDBRequest<Track[]>),
      );
    } catch (error) {
      throw toDBError(error, "loading your library");
    }
  }

  async getTrack(id: string): Promise<Track | undefined> {
    return withTransaction([STORES.tracks], "readonly", (tx) =>
      requestToPromise(tx.objectStore(STORES.tracks).get(id) as IDBRequest<Track | undefined>),
    );
  }

  async putTracks(tracks: Track[]): Promise<void> {
    await withTransaction([STORES.tracks], "readwrite", (tx) => {
      const store = tx.objectStore(STORES.tracks);
      for (const track of tracks) store.put(track);
    });
  }

  async updateTrack(id: string, patch: Partial<Track>): Promise<void> {
    await withTransaction([STORES.tracks], "readwrite", async (tx) => {
      const store = tx.objectStore(STORES.tracks);
      const existing = await requestToPromise(store.get(id) as IDBRequest<Track | undefined>);
      if (!existing) return;
      store.put({ ...existing, ...patch, id });
    });
  }

  /** Removes track metadata plus every associated record. Never touches source files. */
  async deleteTracks(ids: string[]): Promise<void> {
    await withTransaction(
      [STORES.tracks, STORES.artwork, STORES.audio, STORES.handles, STORES.lyrics, STORES.lyricsMeta],
      "readwrite",
      (tx) => {
        for (const id of ids) {
          tx.objectStore(STORES.tracks).delete(id);
          tx.objectStore(STORES.artwork).delete(id);
          tx.objectStore(STORES.audio).delete(id);
          tx.objectStore(STORES.handles).delete(id);
          tx.objectStore(STORES.lyrics).delete(id);
          tx.objectStore(STORES.lyricsMeta).delete(id);
        }
      },
    );
  }

  // ---- Artwork / audio blobs / file handles ----

  async getArtwork(trackId: string): Promise<Blob | undefined> {
    return withTransaction([STORES.artwork], "readonly", async (tx) => {
      const record = await requestToPromise(
        tx.objectStore(STORES.artwork).get(trackId) as IDBRequest<ArtworkRecord | undefined>,
      );
      return record?.blob;
    });
  }

  async putArtwork(trackId: string, blob: Blob): Promise<void> {
    await withTransaction([STORES.artwork], "readwrite", (tx) => {
      tx.objectStore(STORES.artwork).put({ trackId, blob } satisfies ArtworkRecord);
    });
  }

  async getAudioBlob(trackId: string): Promise<Blob | undefined> {
    return withTransaction([STORES.audio], "readonly", async (tx) => {
      const record = await requestToPromise(
        tx.objectStore(STORES.audio).get(trackId) as IDBRequest<AudioRecord | undefined>,
      );
      return record?.blob;
    });
  }

  async putAudioBlob(trackId: string, blob: Blob): Promise<void> {
    await withTransaction([STORES.audio], "readwrite", (tx) => {
      tx.objectStore(STORES.audio).put({ trackId, blob } satisfies AudioRecord);
    });
  }

  async deleteAudioBlob(trackId: string): Promise<void> {
    await withTransaction([STORES.audio], "readwrite", (tx) => {
      tx.objectStore(STORES.audio).delete(trackId);
    });
  }

  async getHandle(trackId: string): Promise<FileSystemFileHandle | undefined> {
    return withTransaction([STORES.handles], "readonly", async (tx) => {
      const record = await requestToPromise(
        tx.objectStore(STORES.handles).get(trackId) as IDBRequest<HandleRecord | undefined>,
      );
      return record?.handle;
    });
  }

  async putHandle(trackId: string, handle: FileSystemFileHandle): Promise<void> {
    await withTransaction([STORES.handles], "readwrite", (tx) => {
      tx.objectStore(STORES.handles).put({ trackId, handle } satisfies HandleRecord);
    });
  }

  async countStoredAudio(): Promise<number> {
    return withTransaction([STORES.audio], "readonly", (tx) =>
      requestToPromise(tx.objectStore(STORES.audio).count()),
    );
  }

  // ---- Playlists ----

  async listPlaylists(): Promise<Playlist[]> {
    return withTransaction([STORES.playlists], "readonly", (tx) =>
      requestToPromise(tx.objectStore(STORES.playlists).getAll() as IDBRequest<Playlist[]>),
    );
  }

  async getPlaylist(id: string): Promise<Playlist | undefined> {
    return withTransaction([STORES.playlists], "readonly", (tx) =>
      requestToPromise(tx.objectStore(STORES.playlists).get(id) as IDBRequest<Playlist | undefined>),
    );
  }

  async putPlaylist(playlist: Playlist): Promise<void> {
    await withTransaction([STORES.playlists], "readwrite", (tx) => {
      tx.objectStore(STORES.playlists).put(playlist);
    });
  }

  async deletePlaylist(id: string): Promise<void> {
    await withTransaction([STORES.playlists], "readwrite", (tx) => {
      tx.objectStore(STORES.playlists).delete(id);
    });
  }

  // ---- Lyrics ----

  async getLyrics(trackId: string): Promise<TrackLyrics | undefined> {
    return withTransaction([STORES.lyrics], "readonly", (tx) =>
      requestToPromise(tx.objectStore(STORES.lyrics).get(trackId) as IDBRequest<TrackLyrics | undefined>),
    );
  }

  async putLyrics(lyrics: TrackLyrics): Promise<void> {
    await withTransaction([STORES.lyrics], "readwrite", (tx) => {
      tx.objectStore(STORES.lyrics).put(lyrics);
    });
  }

  async deleteLyrics(trackId: string): Promise<void> {
    await withTransaction([STORES.lyrics, STORES.lyricsMeta], "readwrite", (tx) => {
      tx.objectStore(STORES.lyrics).delete(trackId);
      tx.objectStore(STORES.lyricsMeta).delete(trackId);
    });
  }

  // ---- Lyrics lookup cache (prevents repeat LRCLIB queries) ----

  async getLyricsCacheMeta(trackId: string): Promise<LyricsCacheMeta | undefined> {
    return withTransaction([STORES.lyricsMeta], "readonly", (tx) =>
      requestToPromise(tx.objectStore(STORES.lyricsMeta).get(trackId) as IDBRequest<LyricsCacheMeta | undefined>),
    );
  }

  async putLyricsCacheMeta(meta: LyricsCacheMeta): Promise<void> {
    await withTransaction([STORES.lyricsMeta], "readwrite", (tx) => {
      tx.objectStore(STORES.lyricsMeta).put(meta);
    });
  }

  // ---- Preferences ----

  async getPreferences(): Promise<AppPreferences | undefined> {
    return withTransaction([STORES.prefs], "readonly", async (tx) => {
      const record = await requestToPromise(
        tx.objectStore(STORES.prefs).get("app") as IDBRequest<PrefsRecord | undefined>,
      );
      return record?.prefs;
    });
  }

  async putPreferences(prefs: AppPreferences): Promise<void> {
    await withTransaction([STORES.prefs], "readwrite", (tx) => {
      tx.objectStore(STORES.prefs).put({ name: "app", prefs } satisfies PrefsRecord);
    });
  }

  // ---- Pending cloud deletions (see PendingCloudDeletion) ----

  async listPendingCloudDeletions(): Promise<PendingCloudDeletion[]> {
    return withTransaction([STORES.prefs], "readonly", async (tx) => {
      const record = await requestToPromise(
        tx.objectStore(STORES.prefs).get("cloud-deletions") as IDBRequest<PendingDeletionsRecord | undefined>,
      );
      return record?.items ?? [];
    });
  }

  async putPendingCloudDeletion(item: PendingCloudDeletion): Promise<void> {
    await withTransaction([STORES.prefs], "readwrite", async (tx) => {
      const store = tx.objectStore(STORES.prefs);
      const record = (await requestToPromise(store.get("cloud-deletions") as IDBRequest<PendingDeletionsRecord | undefined>))
        ?? { name: "cloud-deletions" as const, items: [] };
      const others = record.items.filter((entry) => entry.trackId !== item.trackId);
      store.put({ name: "cloud-deletions", items: [...others, item] });
    });
  }

  async removePendingCloudDeletion(trackId: string): Promise<void> {
    await withTransaction([STORES.prefs], "readwrite", async (tx) => {
      const store = tx.objectStore(STORES.prefs);
      const record = await requestToPromise(store.get("cloud-deletions") as IDBRequest<PendingDeletionsRecord | undefined>);
      if (!record) return;
      store.put({ name: "cloud-deletions", items: record.items.filter((entry) => entry.trackId !== trackId) });
    });
  }

  // ---- Maintenance ----

  async clearLibrary(): Promise<void> {
    await withTransaction(
      [STORES.tracks, STORES.artwork, STORES.audio, STORES.handles, STORES.lyrics, STORES.lyricsMeta, STORES.playlists],
      "readwrite",
      (tx) => {
        for (const store of [STORES.tracks, STORES.artwork, STORES.audio, STORES.handles, STORES.lyrics, STORES.lyricsMeta, STORES.playlists]) {
          tx.objectStore(store).clear();
        }
      },
    );
  }

  async clearAllData(): Promise<void> {
    await withTransaction(
      [STORES.tracks, STORES.artwork, STORES.audio, STORES.handles, STORES.lyrics, STORES.lyricsMeta, STORES.playlists, STORES.prefs],
      "readwrite",
      (tx) => {
        for (const store of [STORES.tracks, STORES.artwork, STORES.audio, STORES.handles, STORES.lyrics, STORES.lyricsMeta, STORES.playlists, STORES.prefs]) {
          tx.objectStore(store).clear();
        }
      },
    );
  }
}

export const repository = new LibraryRepository();
