import type {
  AppPreferences,
  LyricsCacheMeta,
  PendingMetadataSync,
  Playlist,
  Track,
  TrackLyrics,
} from "../../types";
import type { PlaybackSession } from "../library/playbackSession";
import { requestToPromise, STORES, toDBError, withTransaction } from "./db";
import { isTauriRuntime } from "../platform/desktop";
import {
  beginDesktopIdbMigration,
  blobToByteArray,
  computeBytesSha256,
  computeSnapshotChecksum,
  failDesktopIdbMigration,
  finalizeDesktopIdbMigration,
  getDesktopPersistenceStatus,
  sqliteClearAllData,
  sqliteClearLibrary,
  sqliteCountStoredAudio,
  sqliteDeleteArtwork,
  sqliteDeleteAudioBlob,
  sqliteDeleteLyrics,
  sqliteDeletePlaylist,
  sqliteDeletePref,
  sqliteDeleteTracks,
  sqliteGetArtwork,
  sqliteGetAudioBlob,
  sqliteGetLyrics,
  sqliteGetLyricsCacheMeta,
  sqliteGetPlaylist,
  sqliteGetPreferences,
  sqliteGetPrefJson,
  sqliteGetTrack,
  sqliteListArtworkTrackIds,
  sqliteListAudioTrackIds,
  sqliteListPendingCloudDeletions,
  sqliteListPendingMetadataSync,
  sqliteListPlaylists,
  sqliteListTracks,
  sqlitePutArtwork,
  sqlitePutAudioBlob,
  sqlitePutLyrics,
  sqlitePutLyricsCacheMeta,
  sqlitePutPendingCloudDeletion,
  sqlitePutPendingMetadataSync,
  sqlitePutPlaylist,
  sqlitePutPreferences,
  sqlitePutPrefJson,
  sqlitePutTracks,
  sqlitePutTrackWithFiles,
  sqliteRemovePendingCloudDeletion,
  sqliteRemovePendingMetadataSync,
  sqliteReplaceLibrary,
  writeDesktopIdbMigrationBatch,
  type BinaryBlobPayload,
  type PersistenceAuthority,
  type PersistenceStatus,
} from "../platform/persistence";

/**
 * LibraryRepository — the single persistence boundary for Gmusic (rules §5).
 * Web runtime uses IndexedDB (`local-music` v2).
 * Desktop runtime (Tauri 2) transparently migrates IndexedDB to native SQLite
 * with integrity verification and falls back to IndexedDB if migration has not
 * completed or requires recovery.
 */

export type ArtworkRecord = { trackId: string; blob: Blob };
export type AudioRecord = { trackId: string; blob: Blob };
export type HandleRecord = { trackId: string; handle: FileSystemFileHandle };
export type PrefsRecord = { name: "app"; prefs: AppPreferences };
export type { PendingMetadataSync, PersistenceAuthority, PersistenceStatus };

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
type PendingMetadataSyncRecord = { name: "pending-metadata-sync"; items: PendingMetadataSync[] };
type RawPrefRecord = { name: string; prefs?: unknown; items?: unknown; session?: unknown };

const MIGRATION_RECORD_BATCH_SIZE = 200;
const MIGRATION_ARTWORK_BATCH_SIZE = 25;
const MIGRATION_AUDIO_BATCH_SIZE = 5;

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export class LibraryRepository {
  private activeAuthority: PersistenceAuthority = "indexeddb";
  private lastStatus: PersistenceStatus | null = null;
  private ensurePromise: Promise<PersistenceAuthority> | null = null;

  /**
   * Resets internal authority caching (used by test suites when switching
   * between web and desktop mocks or resetting database state).
   */
  resetDesktopAuthorityForTests(): void {
    this.activeAuthority = "indexeddb";
    this.lastStatus = null;
    this.ensurePromise = null;
  }

  getPersistenceAuthority(): PersistenceAuthority {
    if (!isTauriRuntime()) return "indexeddb";
    return this.activeAuthority;
  }

  getLastPersistenceStatus(): PersistenceStatus | null {
    return this.lastStatus;
  }

  async inspectDesktopPersistence(): Promise<PersistenceStatus | null> {
    if (!isTauriRuntime()) return null;
    const status = await getDesktopPersistenceStatus();
    if (status) {
      this.lastStatus = status;
      this.activeAuthority = status.authority;
    }
    return status;
  }

  /**
   * Ensures the desktop persistence backend is initialized and, if authority
   * is not yet `'sqlite'`, performs a safe, verified IndexedDB → SQLite migration.
   * On web runtime or if migration fails, returns `'indexeddb'` (or `'recovery-required'`)
   * so the user's IndexedDB data remains active and untouched.
   */
  async ensureDesktopPersistence(): Promise<PersistenceAuthority> {
    if (!isTauriRuntime()) {
      this.activeAuthority = "indexeddb";
      return "indexeddb";
    }
    if (this.activeAuthority === "sqlite" && this.lastStatus?.integrityOk) {
      return "sqlite";
    }
    if (this.ensurePromise) {
      return this.ensurePromise;
    }
    this.ensurePromise = (async (): Promise<PersistenceAuthority> => {
      try {
        const status = await getDesktopPersistenceStatus();
        if (!status) {
          this.activeAuthority = "indexeddb";
          return "indexeddb";
        }
        this.lastStatus = status;
        if (status.authority === "sqlite" && status.integrityOk) {
          this.activeAuthority = "sqlite";
          return "sqlite";
        }
        if (!status.integrityOk) {
          this.activeAuthority = "recovery-required";
          return "recovery-required";
        }
        const migrated = await this.migrateIndexedDbToSqlite();
        return migrated.authority;
      } catch (error) {
        console.warn("Desktop SQLite initialization fell back to IndexedDB:", error);
        if (this.activeAuthority !== "recovery-required") {
          this.activeAuthority = "indexeddb";
        }
        return this.activeAuthority;
      } finally {
        this.ensurePromise = null;
      }
    })();
    return this.ensurePromise;
  }

  private async useSqlite(): Promise<boolean> {
    if (!isTauriRuntime()) return false;
    const auth = await this.ensureDesktopPersistence();
    return auth === "sqlite";
  }

  private async computePaginatedBlobDigests(
    storeName: typeof STORES.artwork | typeof STORES.audio,
    trackIds: string[],
    batchSize: number,
    label: "artwork" | "audio",
  ): Promise<Map<string, { sha256: string; size: number; rawMime: string }>> {
    const digests = new Map<string, { sha256: string; size: number; rawMime: string }>();
    for (const idChunk of chunkArray(trackIds, batchSize)) {
      const records = await withTransaction([storeName], "readonly", (tx) => {
        const store = tx.objectStore(storeName);
        return Promise.all(
          idChunk.map((tid) =>
            requestToPromise(
              store.get(tid) as IDBRequest<(ArtworkRecord | AudioRecord) | undefined>,
            ),
          ),
        );
      });
      for (let i = 0; i < idChunk.length; i++) {
        const tid = idChunk[i];
        const rec = records[i];
        if (!rec || !rec.blob) {
          throw new Error(
            `IndexedDB ${label} record for track "${tid}" disappeared during migration (concurrent modification detected).`,
          );
        }
        const bytes = await blobToByteArray(rec.blob);
        if (bytes.length === 0) {
          throw new Error(`IndexedDB ${label} blob for track "${tid}" is empty or unreadable.`);
        }
        const sha256 = await computeBytesSha256(bytes);
        digests.set(tid, {
          sha256,
          size: bytes.length,
          rawMime: (rec.blob as { type?: string }).type || "",
        });
      }
    }
    return digests;
  }

  /**
   * Reads a consistent metadata and key snapshot of IndexedDB in a single readonly
   * transaction, then transfers metadata and binary blobs (artwork/audio) in bounded,
   * memory-safe paginated batches with SHA-256 verification and concurrent-modification detection.
   * Never clears or mutates IndexedDB, and never overwrites authoritative SQLite data unless
   * `options.forceReimport` is explicitly true.
   */
  async migrateIndexedDbToSqlite(options?: { forceReimport?: boolean }): Promise<PersistenceStatus> {
    const forceReimport = options?.forceReimport === true;
    const preStatus = await getDesktopPersistenceStatus();
    if (!preStatus) {
      throw new Error("Desktop SQLite migration unavailable.");
    }
    if (!preStatus.integrityOk) {
      this.lastStatus = preStatus;
      this.activeAuthority = "recovery-required";
      throw new Error(
        preStatus.lastError ??
          "SQLite integrity check failed; database preserved in recovery-required state for diagnosis.",
      );
    }
    if (preStatus.authority === "sqlite" && preStatus.integrityOk && !forceReimport) {
      this.lastStatus = preStatus;
      this.activeAuthority = "sqlite";
      return preStatus;
    }

    this.activeAuthority = "migrating";
    const migrationId = `mig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const snapshot = await withTransaction(
      [
        STORES.tracks,
        STORES.playlists,
        STORES.lyrics,
        STORES.lyricsMeta,
        STORES.prefs,
        STORES.artwork,
        STORES.audio,
      ],
      "readonly",
      async (tx) => {
        const [tracks, playlists, lyrics, lyricsMeta, rawPrefs, artworkKeys, audioKeys] =
          await Promise.all([
            requestToPromise(tx.objectStore(STORES.tracks).getAll() as IDBRequest<Track[]>),
            requestToPromise(tx.objectStore(STORES.playlists).getAll() as IDBRequest<Playlist[]>),
            requestToPromise(tx.objectStore(STORES.lyrics).getAll() as IDBRequest<TrackLyrics[]>),
            requestToPromise(
              tx.objectStore(STORES.lyricsMeta).getAll() as IDBRequest<LyricsCacheMeta[]>,
            ),
            requestToPromise(
              tx.objectStore(STORES.prefs).getAll() as IDBRequest<RawPrefRecord[]>,
            ),
            requestToPromise(tx.objectStore(STORES.artwork).getAllKeys()),
            requestToPromise(tx.objectStore(STORES.audio).getAllKeys()),
          ]);
        return {
          tracks,
          playlists,
          lyrics,
          lyricsMeta,
          rawPrefs,
          artworkTrackIds: artworkKeys.map(String),
          audioTrackIds: audioKeys.map(String),
        };
      },
    );

    // Validate snapshot records & deduplicate by primary key if needed
    const trackById = new Map<string, Track>();
    for (const track of snapshot.tracks) {
      if (!track || typeof track.id !== "string" || !track.id.trim() || typeof track.title !== "string") {
        throw new Error("Malformed track record encountered in IndexedDB snapshot.");
      }
      trackById.set(track.id, track);
    }
    const validTracks = [...trackById.values()];

    const playlistById = new Map<string, Playlist>();
    for (const pl of snapshot.playlists) {
      if (!pl || typeof pl.id !== "string" || !pl.id.trim() || !Array.isArray(pl.trackIds)) {
        throw new Error("Malformed playlist record encountered in IndexedDB snapshot.");
      }
      playlistById.set(pl.id, pl);
    }
    const validPlaylists = [...playlistById.values()];

    const lyricsByTrackId = new Map<string, TrackLyrics>();
    for (const lyr of snapshot.lyrics) {
      if (!lyr || typeof lyr.trackId !== "string" || !lyr.trackId.trim() || !Array.isArray(lyr.lines)) {
        throw new Error("Malformed lyrics record encountered in IndexedDB snapshot.");
      }
      lyricsByTrackId.set(lyr.trackId, lyr);
    }
    const validLyrics = [...lyricsByTrackId.values()];

    const metaByTrackId = new Map<string, LyricsCacheMeta>();
    for (const meta of snapshot.lyricsMeta) {
      if (meta && typeof meta.trackId === "string" && meta.trackId.trim()) {
        metaByTrackId.set(meta.trackId, meta);
      }
    }
    const validLyricsMeta = [...metaByTrackId.values()];

    const prefEntries: Array<{ name: string; payload: unknown }> = [];
    for (const rec of snapshot.rawPrefs) {
      if (!rec || typeof rec.name !== "string" || !rec.name.trim()) continue;
      if (rec.name === "app" && rec.prefs !== undefined) {
        prefEntries.push({ name: "app", payload: rec.prefs });
      } else if (
        (rec.name === "cloud-deletions" || rec.name === "pending-metadata-sync") &&
        rec.items !== undefined
      ) {
        prefEntries.push({ name: rec.name, payload: rec.items });
      } else if (rec.name === "playback" && rec.session !== undefined) {
        prefEntries.push({ name: "playback", payload: rec.session });
      }
    }

    const allArtworkKeys = Array.from(
      new Set(snapshot.artworkTrackIds.filter((id) => id.trim().length > 0)),
    ).sort();
    const allAudioKeys = Array.from(
      new Set(snapshot.audioTrackIds.filter((id) => id.trim().length > 0)),
    ).sort();

    const artworkIdsToMigrate = allArtworkKeys;
    // Do not duplicate audio into SQLite if the track already has an authoritative desktopPath
    const audioIdsToMigrate = allAudioKeys.filter((id) => {
      const ownerTrack = trackById.get(id);
      return !ownerTrack?.desktopPath;
    });

    const expectedChecksum = await computeSnapshotChecksum({
      tracks: validTracks,
      playlists: validPlaylists,
      lyrics: validLyrics,
    });

    try {
      const initialArtworkDigests = await this.computePaginatedBlobDigests(
        STORES.artwork,
        allArtworkKeys,
        MIGRATION_ARTWORK_BATCH_SIZE,
        "artwork",
      );
      const initialAudioDigests = await this.computePaginatedBlobDigests(
        STORES.audio,
        allAudioKeys,
        MIGRATION_AUDIO_BATCH_SIZE,
        "audio",
      );

      const beginStatus = await beginDesktopIdbMigration({
        migrationId,
        expectedTracks: validTracks.length,
        expectedPlaylists: validPlaylists.length,
        expectedLyrics: validLyrics.length,
        expectedLyricsMeta: validLyricsMeta.length,
        expectedPrefs: prefEntries.length,
        expectedArtwork: artworkIdsToMigrate.length,
        expectedAudio: audioIdsToMigrate.length,
        expectedChecksum,
        forceReimport,
      });

      if (!beginStatus) {
        throw new Error("Desktop SQLite migration unavailable.");
      }

      if (!beginStatus.integrityOk) {
        this.lastStatus = beginStatus;
        this.activeAuthority = "recovery-required";
        throw new Error(
          beginStatus.lastError ??
            "SQLite integrity check failed; database preserved in recovery-required state for diagnosis.",
        );
      }

      if (beginStatus.authority === "sqlite" && beginStatus.integrityOk && !forceReimport) {
        this.lastStatus = beginStatus;
        this.activeAuthority = "sqlite";
        return beginStatus;
      }

      for (const chunk of chunkArray(validTracks, MIGRATION_RECORD_BATCH_SIZE)) {
        await writeDesktopIdbMigrationBatch({ migrationId, tracks: chunk });
      }
      for (const chunk of chunkArray(validPlaylists, MIGRATION_RECORD_BATCH_SIZE)) {
        await writeDesktopIdbMigrationBatch({ migrationId, playlists: chunk });
      }
      for (const chunk of chunkArray(validLyrics, MIGRATION_RECORD_BATCH_SIZE)) {
        await writeDesktopIdbMigrationBatch({ migrationId, lyrics: chunk });
      }
      for (const chunk of chunkArray(validLyricsMeta, MIGRATION_RECORD_BATCH_SIZE)) {
        await writeDesktopIdbMigrationBatch({ migrationId, lyricsMeta: chunk });
      }
      if (prefEntries.length > 0) {
        await writeDesktopIdbMigrationBatch({ migrationId, prefs: prefEntries });
      }

      // Paginated artwork migration: read only MIGRATION_ARTWORK_BATCH_SIZE blobs into memory at a time
      for (const idChunk of chunkArray(artworkIdsToMigrate, MIGRATION_ARTWORK_BATCH_SIZE)) {
        const records = await withTransaction([STORES.artwork], "readonly", (tx) => {
          const store = tx.objectStore(STORES.artwork);
          return Promise.all(
            idChunk.map((tid) =>
              requestToPromise(store.get(tid) as IDBRequest<ArtworkRecord | undefined>),
            ),
          );
        });
        const artworkBatch: BinaryBlobPayload[] = [];
        for (let i = 0; i < idChunk.length; i++) {
          const tid = idChunk[i];
          const art = records[i];
          if (!art || !art.blob) {
            throw new Error(
              `IndexedDB artwork record for track "${tid}" disappeared during migration (concurrent modification detected).`,
            );
          }
          const bytes = await blobToByteArray(art.blob);
          if (bytes.length === 0) {
            throw new Error(`IndexedDB artwork blob for track "${tid}" is empty or unreadable.`);
          }
          const sha256 = await computeBytesSha256(bytes);
          const rawMime = (art.blob as { type?: string }).type || "";
          const baseline = initialArtworkDigests.get(tid);
          if (
            !baseline ||
            baseline.sha256 !== sha256 ||
            baseline.size !== bytes.length ||
            baseline.rawMime !== rawMime
          ) {
            throw new Error(
              `IndexedDB artwork record for track "${tid}" was modified concurrently during migration.`,
            );
          }
          artworkBatch.push({
            trackId: tid,
            mimeType: rawMime || "image/jpeg",
            bytes,
            sha256,
          });
        }
        await writeDesktopIdbMigrationBatch({ migrationId, artwork: artworkBatch });
      }

      // Paginated audio migration: read only MIGRATION_AUDIO_BATCH_SIZE blobs into memory at a time
      for (const idChunk of chunkArray(audioIdsToMigrate, MIGRATION_AUDIO_BATCH_SIZE)) {
        const records = await withTransaction([STORES.audio], "readonly", (tx) => {
          const store = tx.objectStore(STORES.audio);
          return Promise.all(
            idChunk.map((tid) =>
              requestToPromise(store.get(tid) as IDBRequest<AudioRecord | undefined>),
            ),
          );
        });
        const audioBatch: BinaryBlobPayload[] = [];
        for (let i = 0; i < idChunk.length; i++) {
          const tid = idChunk[i];
          const aud = records[i];
          if (!aud || !aud.blob) {
            throw new Error(
              `IndexedDB audio record for track "${tid}" disappeared during migration (concurrent modification detected).`,
            );
          }
          const bytes = await blobToByteArray(aud.blob);
          if (bytes.length === 0) {
            throw new Error(`IndexedDB audio blob for track "${tid}" is empty or unreadable.`);
          }
          const sha256 = await computeBytesSha256(bytes);
          const rawMime = (aud.blob as { type?: string }).type || "";
          const baseline = initialAudioDigests.get(tid);
          if (
            !baseline ||
            baseline.sha256 !== sha256 ||
            baseline.size !== bytes.length ||
            baseline.rawMime !== rawMime
          ) {
            throw new Error(
              `IndexedDB audio record for track "${tid}" was modified concurrently during migration.`,
            );
          }
          const ownerTrack = trackById.get(tid);
          audioBatch.push({
            trackId: tid,
            mimeType: rawMime || ownerTrack?.mimeType || "audio/mpeg",
            bytes,
            sha256,
          });
        }
        await writeDesktopIdbMigrationBatch({ migrationId, audio: audioBatch });
      }

      // Verify IndexedDB metadata AND binary artwork/audio records did not mutate concurrently during transfer
      const postMeta = await withTransaction(
        [STORES.tracks, STORES.playlists, STORES.lyrics, STORES.artwork, STORES.audio],
        "readonly",
        async (tx) => {
          const [tracks, playlists, lyrics, artworkKeys, audioKeys] = await Promise.all([
            requestToPromise(tx.objectStore(STORES.tracks).getAll() as IDBRequest<Track[]>),
            requestToPromise(tx.objectStore(STORES.playlists).getAll() as IDBRequest<Playlist[]>),
            requestToPromise(tx.objectStore(STORES.lyrics).getAll() as IDBRequest<TrackLyrics[]>),
            requestToPromise(tx.objectStore(STORES.artwork).getAllKeys()),
            requestToPromise(tx.objectStore(STORES.audio).getAllKeys()),
          ]);
          return {
            tracks,
            playlists,
            lyrics,
            artworkTrackIds: artworkKeys.map(String),
            audioTrackIds: audioKeys.map(String),
          };
        },
      );
      const postChecksum = await computeSnapshotChecksum({
        tracks: [...new Map(postMeta.tracks.map((t) => [t.id, t])).values()],
        playlists: [...new Map(postMeta.playlists.map((p) => [p.id, p])).values()],
        lyrics: [...new Map(postMeta.lyrics.map((l) => [l.trackId, l])).values()],
      });
      if (postChecksum !== expectedChecksum) {
        throw new Error(
          "IndexedDB library was modified concurrently during migration. Rolling back incomplete SQLite migration.",
        );
      }

      const postArtworkKeys = Array.from(
        new Set(postMeta.artworkTrackIds.filter((id) => id.trim().length > 0)),
      ).sort();
      const postAudioKeys = Array.from(
        new Set(postMeta.audioTrackIds.filter((id) => id.trim().length > 0)),
      ).sort();
      if (
        postArtworkKeys.length !== allArtworkKeys.length ||
        postArtworkKeys.some((k, idx) => k !== allArtworkKeys[idx]) ||
        postAudioKeys.length !== allAudioKeys.length ||
        postAudioKeys.some((k, idx) => k !== allAudioKeys[idx])
      ) {
        throw new Error(
          "IndexedDB artwork or audio records were modified concurrently during migration. Rolling back incomplete SQLite migration.",
        );
      }

      const postArtworkDigests = await this.computePaginatedBlobDigests(
        STORES.artwork,
        allArtworkKeys,
        MIGRATION_ARTWORK_BATCH_SIZE,
        "artwork",
      );
      for (const [tid, baseline] of initialArtworkDigests.entries()) {
        const current = postArtworkDigests.get(tid);
        if (
          !current ||
          current.sha256 !== baseline.sha256 ||
          current.size !== baseline.size ||
          current.rawMime !== baseline.rawMime
        ) {
          throw new Error(
            `IndexedDB artwork binary content for track "${tid}" was modified concurrently during migration.`,
          );
        }
      }

      const postAudioDigests = await this.computePaginatedBlobDigests(
        STORES.audio,
        allAudioKeys,
        MIGRATION_AUDIO_BATCH_SIZE,
        "audio",
      );
      for (const [tid, baseline] of initialAudioDigests.entries()) {
        const current = postAudioDigests.get(tid);
        if (
          !current ||
          current.sha256 !== baseline.sha256 ||
          current.size !== baseline.size ||
          current.rawMime !== baseline.rawMime
        ) {
          throw new Error(
            `IndexedDB audio binary content for track "${tid}" was modified concurrently during migration.`,
          );
        }
      }

      const finalStatus = await finalizeDesktopIdbMigration(migrationId);
      if (!finalStatus || finalStatus.authority !== "sqlite" || !finalStatus.integrityOk) {
        throw new Error(finalStatus?.lastError ?? "SQLite migration verification failed.");
      }
      this.lastStatus = finalStatus;
      this.activeAuthority = "sqlite";
      return finalStatus;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failedStatus = await failDesktopIdbMigration(reason).catch(() => null);
      if (failedStatus) {
        this.lastStatus = failedStatus;
        this.activeAuthority = failedStatus.authority;
      } else {
        this.activeAuthority = "recovery-required";
      }
      throw error;
    }
  }

  // ---- Tracks ----

  async listTracks(): Promise<Track[]> {
    try {
      if (await this.useSqlite()) {
        return await sqliteListTracks();
      }
      return await withTransaction([STORES.tracks], "readonly", (tx) =>
        requestToPromise(tx.objectStore(STORES.tracks).getAll() as IDBRequest<Track[]>),
      );
    } catch (error) {
      throw toDBError(error, "loading your library");
    }
  }

  async getTrack(id: string): Promise<Track | undefined> {
    if (await this.useSqlite()) {
      return sqliteGetTrack(id);
    }
    return withTransaction([STORES.tracks], "readonly", (tx) =>
      requestToPromise(tx.objectStore(STORES.tracks).get(id) as IDBRequest<Track | undefined>),
    );
  }

  async putTracks(tracks: Track[]): Promise<void> {
    if (await this.useSqlite()) {
      await sqlitePutTracks(tracks);
      return;
    }
    await withTransaction([STORES.tracks], "readwrite", (tx) => {
      const store = tx.objectStore(STORES.tracks);
      for (const track of tracks) store.put(track);
    });
  }

  /**
   * Writes a track together with its artwork and audio source (handle or stored
   * copy) in ONE transaction, so a failure can never leave orphan blobs without
   * a track, or a track without the source it was imported with.
   */
  async putTrackWithFiles(
    track: Track,
    files: { artwork?: Blob; handle?: FileSystemFileHandle; audio?: Blob },
  ): Promise<void> {
    if (await this.useSqlite()) {
      await sqlitePutTrackWithFiles(track, {
        artwork: files.artwork,
        audio: track.desktopPath ? undefined : files.audio,
      });
      if (files.handle) {
        await withTransaction([STORES.handles], "readwrite", (tx) => {
          tx.objectStore(STORES.handles).put({ trackId: track.id, handle: files.handle! } satisfies HandleRecord);
        }).catch(() => undefined);
      }
      return;
    }
    await withTransaction([STORES.tracks, STORES.artwork, STORES.handles, STORES.audio], "readwrite", (tx) => {
      if (files.artwork) tx.objectStore(STORES.artwork).put({ trackId: track.id, blob: files.artwork } satisfies ArtworkRecord);
      if (files.handle) tx.objectStore(STORES.handles).put({ trackId: track.id, handle: files.handle } satisfies HandleRecord);
      if (files.audio) tx.objectStore(STORES.audio).put({ trackId: track.id, blob: files.audio } satisfies AudioRecord);
      tx.objectStore(STORES.tracks).put(track);
    });
  }

  async updateTrack(id: string, patch: Partial<Track>): Promise<void> {
    if (await this.useSqlite()) {
      const existing = await sqliteGetTrack(id);
      if (!existing) return;
      await sqlitePutTracks([{ ...existing, ...patch, id }]);
      return;
    }
    await withTransaction([STORES.tracks], "readwrite", async (tx) => {
      const store = tx.objectStore(STORES.tracks);
      const existing = await requestToPromise(store.get(id) as IDBRequest<Track | undefined>);
      if (!existing) return;
      store.put({ ...existing, ...patch, id });
    });
  }

  async updateTracksBatch(updates: Array<{ id: string; patch: Partial<Track> }>): Promise<void> {
    if (updates.length === 0) return;
    if (await this.useSqlite()) {
      const all = await sqliteListTracks();
      const byId = new Map(all.map((t) => [t.id, t]));
      const modified: Track[] = [];
      for (const { id, patch } of updates) {
        const existing = byId.get(id);
        if (existing) {
          const next = { ...existing, ...patch, id };
          byId.set(id, next);
          modified.push(next);
        }
      }
      if (modified.length > 0) {
        await sqlitePutTracks(modified);
      }
      return;
    }
    await withTransaction([STORES.tracks], "readwrite", async (tx) => {
      const store = tx.objectStore(STORES.tracks);
      for (const { id, patch } of updates) {
        const existing = await requestToPromise(store.get(id) as IDBRequest<Track | undefined>);
        if (existing) {
          store.put({ ...existing, ...patch, id });
        }
      }
    });
  }

  /** Removes track metadata plus every associated record. Never touches source files. */
  async deleteTracks(ids: string[]): Promise<void> {
    if (await this.useSqlite()) {
      await sqliteDeleteTracks(ids);
      return;
    }
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
    for (const id of ids) {
      await this.removePendingMetadataSync(id).catch(() => undefined);
    }
  }

  // ---- Artwork / audio blobs / file handles ----

  async getArtwork(trackId: string): Promise<Blob | undefined> {
    if (await this.useSqlite()) {
      return sqliteGetArtwork(trackId);
    }
    return withTransaction([STORES.artwork], "readonly", async (tx) => {
      const record = await requestToPromise(
        tx.objectStore(STORES.artwork).get(trackId) as IDBRequest<ArtworkRecord | undefined>,
      );
      return record?.blob;
    });
  }

  async putArtwork(trackId: string, blob: Blob): Promise<void> {
    if (await this.useSqlite()) {
      await sqlitePutArtwork(trackId, blob);
      return;
    }
    await withTransaction([STORES.artwork], "readwrite", (tx) => {
      tx.objectStore(STORES.artwork).put({ trackId, blob } satisfies ArtworkRecord);
    });
  }

  /** Removes a persisted artwork blob (used when a cached image proves corrupt). */
  async deleteArtwork(trackId: string): Promise<void> {
    if (await this.useSqlite()) {
      await sqliteDeleteArtwork(trackId);
      return;
    }
    await withTransaction([STORES.artwork], "readwrite", (tx) => {
      tx.objectStore(STORES.artwork).delete(trackId);
    });
  }

  /** Lists track IDs that already have a persisted artwork record. */
  async listArtworkTrackIds(): Promise<Set<string>> {
    if (await this.useSqlite()) {
      return sqliteListArtworkTrackIds();
    }
    return withTransaction([STORES.artwork], "readonly", async (tx) => {
      const keys = await requestToPromise(tx.objectStore(STORES.artwork).getAllKeys());
      return new Set(keys.map((key) => String(key)));
    });
  }

  async getAudioBlob(trackId: string): Promise<Blob | undefined> {
    if (await this.useSqlite()) {
      return sqliteGetAudioBlob(trackId);
    }
    return withTransaction([STORES.audio], "readonly", async (tx) => {
      const record = await requestToPromise(
        tx.objectStore(STORES.audio).get(trackId) as IDBRequest<AudioRecord | undefined>,
      );
      return record?.blob;
    });
  }

  async putAudioBlob(trackId: string, blob: Blob): Promise<void> {
    if (await this.useSqlite()) {
      await sqlitePutAudioBlob(trackId, blob);
      return;
    }
    await withTransaction([STORES.audio], "readwrite", (tx) => {
      tx.objectStore(STORES.audio).put({ trackId, blob } satisfies AudioRecord);
    });
  }

  async deleteAudioBlob(trackId: string): Promise<void> {
    if (await this.useSqlite()) {
      await sqliteDeleteAudioBlob(trackId);
      return;
    }
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
    if (await this.useSqlite()) {
      return sqliteCountStoredAudio();
    }
    return withTransaction([STORES.audio], "readonly", (tx) =>
      requestToPromise(tx.objectStore(STORES.audio).count()),
    );
  }

  // ---- Playlists ----

  async listPlaylists(): Promise<Playlist[]> {
    if (await this.useSqlite()) {
      return sqliteListPlaylists();
    }
    return withTransaction([STORES.playlists], "readonly", (tx) =>
      requestToPromise(tx.objectStore(STORES.playlists).getAll() as IDBRequest<Playlist[]>),
    );
  }

  async getPlaylist(id: string): Promise<Playlist | undefined> {
    if (await this.useSqlite()) {
      return sqliteGetPlaylist(id);
    }
    return withTransaction([STORES.playlists], "readonly", (tx) =>
      requestToPromise(tx.objectStore(STORES.playlists).get(id) as IDBRequest<Playlist | undefined>),
    );
  }

  async putPlaylist(playlist: Playlist): Promise<void> {
    if (await this.useSqlite()) {
      await sqlitePutPlaylist(playlist);
      return;
    }
    await withTransaction([STORES.playlists], "readwrite", (tx) => {
      tx.objectStore(STORES.playlists).put(playlist);
    });
  }

  async deletePlaylist(id: string): Promise<void> {
    if (await this.useSqlite()) {
      await sqliteDeletePlaylist(id);
      return;
    }
    await withTransaction([STORES.playlists], "readwrite", (tx) => {
      tx.objectStore(STORES.playlists).delete(id);
    });
  }

  // ---- Lyrics ----

  async getLyrics(trackId: string): Promise<TrackLyrics | undefined> {
    if (await this.useSqlite()) {
      return sqliteGetLyrics(trackId);
    }
    return withTransaction([STORES.lyrics], "readonly", (tx) =>
      requestToPromise(tx.objectStore(STORES.lyrics).get(trackId) as IDBRequest<TrackLyrics | undefined>),
    );
  }

  async putLyrics(lyrics: TrackLyrics): Promise<void> {
    if (await this.useSqlite()) {
      await sqlitePutLyrics(lyrics);
      return;
    }
    await withTransaction([STORES.lyrics], "readwrite", (tx) => {
      tx.objectStore(STORES.lyrics).put(lyrics);
    });
  }

  async deleteLyrics(trackId: string): Promise<void> {
    if (await this.useSqlite()) {
      await sqliteDeleteLyrics(trackId);
      return;
    }
    await withTransaction([STORES.lyrics, STORES.lyricsMeta], "readwrite", (tx) => {
      tx.objectStore(STORES.lyrics).delete(trackId);
      tx.objectStore(STORES.lyricsMeta).delete(trackId);
    });
  }

  // ---- Lyrics lookup cache (prevents repeat LRCLIB queries) ----

  async getLyricsCacheMeta(trackId: string): Promise<LyricsCacheMeta | undefined> {
    if (await this.useSqlite()) {
      return sqliteGetLyricsCacheMeta(trackId);
    }
    return withTransaction([STORES.lyricsMeta], "readonly", (tx) =>
      requestToPromise(tx.objectStore(STORES.lyricsMeta).get(trackId) as IDBRequest<LyricsCacheMeta | undefined>),
    );
  }

  async putLyricsCacheMeta(meta: LyricsCacheMeta): Promise<void> {
    if (await this.useSqlite()) {
      await sqlitePutLyricsCacheMeta(meta);
      return;
    }
    await withTransaction([STORES.lyricsMeta], "readwrite", (tx) => {
      tx.objectStore(STORES.lyricsMeta).put(meta);
    });
  }

  // ---- Preferences & Playback Session ----

  async getPreferences(): Promise<AppPreferences | undefined> {
    if (await this.useSqlite()) {
      return sqliteGetPreferences();
    }
    return withTransaction([STORES.prefs], "readonly", async (tx) => {
      const record = await requestToPromise(
        tx.objectStore(STORES.prefs).get("app") as IDBRequest<PrefsRecord | undefined>,
      );
      return record?.prefs;
    });
  }

  async putPreferences(prefs: AppPreferences): Promise<void> {
    if (await this.useSqlite()) {
      await sqlitePutPreferences(prefs);
      return;
    }
    await withTransaction([STORES.prefs], "readwrite", (tx) => {
      tx.objectStore(STORES.prefs).put({ name: "app", prefs } satisfies PrefsRecord);
    });
  }

  async getPlaybackSession(): Promise<PlaybackSession | null> {
    try {
      if (await this.useSqlite()) {
        const session = await sqliteGetPrefJson<PlaybackSession>("playback");
        return session ?? null;
      }
      const record = await withTransaction([STORES.prefs], "readonly", (tx) =>
        requestToPromise(
          tx.objectStore(STORES.prefs).get("playback") as IDBRequest<
            { name: "playback"; session: PlaybackSession } | undefined
          >,
        ),
      );
      return record?.session ?? null;
    } catch {
      return null;
    }
  }

  async putPlaybackSession(session: PlaybackSession): Promise<void> {
    if (await this.useSqlite()) {
      await sqlitePutPrefJson("playback", session);
      return;
    }
    await withTransaction([STORES.prefs], "readwrite", (tx) => {
      tx.objectStore(STORES.prefs).put({ name: "playback", session });
    });
  }

  async clearPlaybackSession(): Promise<void> {
    if (await this.useSqlite()) {
      await sqliteDeletePref("playback");
      return;
    }
    await withTransaction([STORES.prefs], "readwrite", (tx) => {
      tx.objectStore(STORES.prefs).delete("playback");
    });
  }

  // ---- Pending cloud deletions (see PendingCloudDeletion) ----

  async listPendingCloudDeletions(): Promise<PendingCloudDeletion[]> {
    if (await this.useSqlite()) {
      return sqliteListPendingCloudDeletions();
    }
    return withTransaction([STORES.prefs], "readonly", async (tx) => {
      const record = await requestToPromise(
        tx.objectStore(STORES.prefs).get("cloud-deletions") as IDBRequest<PendingDeletionsRecord | undefined>,
      );
      return record?.items ?? [];
    });
  }

  async putPendingCloudDeletion(item: PendingCloudDeletion): Promise<void> {
    if (await this.useSqlite()) {
      await sqlitePutPendingCloudDeletion(item);
      return;
    }
    await withTransaction([STORES.prefs], "readwrite", async (tx) => {
      const store = tx.objectStore(STORES.prefs);
      const record = (await requestToPromise(store.get("cloud-deletions") as IDBRequest<PendingDeletionsRecord | undefined>))
        ?? { name: "cloud-deletions" as const, items: [] };
      const others = record.items.filter((entry) => entry.trackId !== item.trackId);
      store.put({ name: "cloud-deletions", items: [...others, item] });
    });
  }

  async removePendingCloudDeletion(trackId: string): Promise<void> {
    if (await this.useSqlite()) {
      await sqliteRemovePendingCloudDeletion(trackId);
      return;
    }
    await withTransaction([STORES.prefs], "readwrite", async (tx) => {
      const store = tx.objectStore(STORES.prefs);
      const record = await requestToPromise(store.get("cloud-deletions") as IDBRequest<PendingDeletionsRecord | undefined>);
      if (!record) return;
      store.put({ name: "cloud-deletions", items: record.items.filter((entry) => entry.trackId !== trackId) });
    });
  }

  // ---- Pending metadata synchronization ----

  async listPendingMetadataSync(): Promise<PendingMetadataSync[]> {
    if (await this.useSqlite()) {
      return sqliteListPendingMetadataSync();
    }
    return withTransaction([STORES.prefs], "readonly", async (tx) => {
      const record = await requestToPromise(
        tx.objectStore(STORES.prefs).get("pending-metadata-sync") as IDBRequest<PendingMetadataSyncRecord | undefined>,
      );
      return record?.items ?? [];
    });
  }

  async putPendingMetadataSync(item: PendingMetadataSync): Promise<void> {
    if (await this.useSqlite()) {
      await sqlitePutPendingMetadataSync(item);
      return;
    }
    await withTransaction([STORES.prefs], "readwrite", async (tx) => {
      const store = tx.objectStore(STORES.prefs);
      const record = (await requestToPromise(store.get("pending-metadata-sync") as IDBRequest<PendingMetadataSyncRecord | undefined>))
        ?? { name: "pending-metadata-sync" as const, items: [] };
      const others = record.items.filter((entry) => entry.trackId !== item.trackId);
      store.put({ name: "pending-metadata-sync", items: [...others, item] });
    });
  }

  async removePendingMetadataSync(trackId: string): Promise<void> {
    if (await this.useSqlite()) {
      await sqliteRemovePendingMetadataSync(trackId);
      return;
    }
    await withTransaction([STORES.prefs], "readwrite", async (tx) => {
      const store = tx.objectStore(STORES.prefs);
      const record = await requestToPromise(store.get("pending-metadata-sync") as IDBRequest<PendingMetadataSyncRecord | undefined>);
      if (!record) return;
      store.put({ name: "pending-metadata-sync", items: record.items.filter((entry) => entry.trackId !== trackId) });
    });
  }

  // ---- Maintenance ----

  async clearLibrary(): Promise<void> {
    if (await this.useSqlite()) {
      await sqliteClearLibrary();
      return;
    }
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

  /**
   * Atomically replaces library metadata (tracks, playlists, lyrics, optional
   * prefs) in ONE transaction: any failure aborts and the previous library is
   * left untouched. Artwork, stored audio copies and file handles are kept for
   * track IDs that survive the replacement, so restoring a backup never
   * destroys working file links; records of dropped tracks are removed.
   * `resolveTracks` receives the IDs that still own a handle / stored copy so
   * the caller can keep their access mode honest.
   */
  async replaceLibrary(data: {
    tracks: (handleIds: Set<string>, audioIds: Set<string>, desktopPaths?: Map<string, string>) => Track[];
    playlists: (trackIds: Set<string>) => Playlist[];
    lyrics: (trackIds: Set<string>) => TrackLyrics[];
    preferences?: AppPreferences;
  }): Promise<void> {
    if (await this.useSqlite()) {
      const [existingTracks, audioIds] = await Promise.all([
        sqliteListTracks(),
        sqliteListAudioTrackIds(),
      ]);
      const desktopPaths = new Map<string, string>();
      for (const t of existingTracks) {
        if (t.desktopPath) {
          desktopPaths.set(t.id, t.desktopPath);
        }
      }
      const handleIds = new Set<string>();
      const tracks = data.tracks(handleIds, audioIds, desktopPaths);
      const trackIds = new Set(tracks.map((t) => t.id));
      const playlists = data.playlists(trackIds);
      const lyrics = data.lyrics(trackIds);

      // Validate serializability before calling IPC so poisoned objects reject cleanly
      JSON.stringify({ tracks, playlists, lyrics, preferences: data.preferences });
      await sqliteReplaceLibrary({
        tracks,
        playlists,
        lyrics,
        preferences: data.preferences,
      });
      return;
    }

    await withTransaction(
      [STORES.tracks, STORES.artwork, STORES.audio, STORES.handles, STORES.lyrics, STORES.lyricsMeta, STORES.playlists, STORES.prefs],
      "readwrite",
      async (tx) => {
        const [handleKeys, audioKeys, existingTracks] = await Promise.all([
          requestToPromise(tx.objectStore(STORES.handles).getAllKeys()),
          requestToPromise(tx.objectStore(STORES.audio).getAllKeys()),
          requestToPromise(tx.objectStore(STORES.tracks).getAll() as IDBRequest<Track[]>),
        ]);
        const handleIds = new Set(handleKeys.map(String));
        const audioIds = new Set(audioKeys.map(String));
        const desktopPaths = new Map<string, string>();
        for (const t of existingTracks) {
          if (t.desktopPath) {
            desktopPaths.set(t.id, t.desktopPath);
          }
        }
        const tracks = data.tracks(handleIds, audioIds, desktopPaths);
        const trackIds = new Set(tracks.map((track) => track.id));

        for (const name of [STORES.tracks, STORES.playlists, STORES.lyrics, STORES.lyricsMeta]) {
          tx.objectStore(name).clear();
        }
        for (const track of tracks) tx.objectStore(STORES.tracks).put(track);
        for (const playlist of data.playlists(trackIds)) tx.objectStore(STORES.playlists).put(playlist);
        for (const lyrics of data.lyrics(trackIds)) tx.objectStore(STORES.lyrics).put(lyrics);
        if (data.preferences) {
          tx.objectStore(STORES.prefs).put({ name: "app", prefs: data.preferences } satisfies PrefsRecord);
        }

        for (const name of [STORES.artwork, STORES.audio, STORES.handles]) {
          const store = tx.objectStore(name);
          for (const key of await requestToPromise(store.getAllKeys())) {
            if (!trackIds.has(String(key))) store.delete(key);
          }
        }
      },
    );
  }

  async clearAllData(): Promise<void> {
    if (await this.useSqlite()) {
      await sqliteClearAllData();
      return;
    }
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
