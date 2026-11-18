import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LyricsCacheMeta, Playlist, Track, TrackLyrics } from "../../types";
import { repository } from "./LibraryRepository";
import { requestToPromise, STORES, withTransaction } from "./db";
import { buildBackup, restoreBackup, validateBackupText } from "../backup/backupService";
import { DEFAULT_PREFERENCES } from "../../stores/settingsStore";
import { computeSnapshotChecksum, type PersistenceStatus } from "../platform/persistence";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: vi.fn((p: string) => `http://asset.localhost/${encodeURIComponent(p)}`),
}));

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "t1",
    title: "One More Time",
    artist: "Daft Punk",
    album: "Discovery",
    trackNumber: 1,
    albumTrackCount: 14,
    durationMs: 320_000,
    fileName: "01.flac",
    fileSize: 1000,
    mimeType: "audio/flac",
    addedAt: 100,
    lastPlayedAt: null,
    playCount: 2,
    isLiked: true,
    availability: "available",
    accessMode: "desktop-path",
    desktopPath: "C:\\Music\\Daft Punk\\01.flac",
    fingerprint: "fp-1",
    metadataFromFilename: false,
    ...overrides,
  };
}

/**
 * In-memory fake SQLite backend wired to Tauri `invoke` so we can verify end-to-end
 * LibraryRepository migration, checksum verification, authority switching, rollback,
 * and backup round-trips deterministically in Vitest.
 */
function createMockSqliteBackend() {
  const state = {
    authority: "indexeddb" as PersistenceStatus["authority"],
    schemaVersion: 1,
    integrityOk: true,
    integrityErrors: [] as string[],
    migrationId: null as string | null,
    lastError: null as string | null,
    expectedCounts: {
      tracks: 0,
      playlists: 0,
      lyrics: 0,
      lyricsMeta: 0,
      prefs: 0,
      artwork: 0,
      audio: 0,
    },
    expectedChecksum: "",
    verifiedChecksum: null as string | null,
    tracks: new Map<string, Track>(),
    playlists: new Map<string, Playlist>(),
    lyrics: new Map<string, TrackLyrics>(),
    lyricsMeta: new Map<string, LyricsCacheMeta>(),
    prefs: new Map<string, unknown>(),
    artwork: new Map<string, { mimeType: string; bytes: number[] }>(),
    audio: new Map<string, { mimeType: string; bytes: number[] }>(),
    failOnWriteBatch: false,
    failOnFinalize: false,
  };

  const getStatus = (): PersistenceStatus => ({
    authority: state.authority,
    schemaVersion: state.schemaVersion,
    integrityOk: state.integrityOk,
    integrityErrors: state.integrityErrors,
    trackCount: state.tracks.size,
    playlistCount: state.playlists.size,
    lyricsCount: state.lyrics.size,
    lyricsMetaCount: state.lyricsMeta.size,
    prefsCount: state.prefs.size,
    artworkCount: state.artwork.size,
    audioCount: state.audio.size,
    migrationId: state.migrationId,
    lastError: state.lastError,
    recoveryGuidance:
      state.authority === "recovery-required"
        ? "SQLite migration requires recovery; IndexedDB remains active."
        : null,
  });

  const clearTables = () => {
    state.tracks.clear();
    state.playlists.clear();
    state.lyrics.clear();
    state.lyricsMeta.clear();
    state.prefs.clear();
    state.artwork.clear();
    state.audio.clear();
  };

  const handler = async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case "get_desktop_persistence_status":
        return getStatus();
      case "begin_desktop_idb_migration": {
        const req = args.request as Record<string, unknown>;
        if (
          state.authority === "sqlite" &&
          state.verifiedChecksum === req.expectedChecksum &&
          state.tracks.size === req.expectedTracks
        ) {
          return getStatus();
        }
        clearTables();
        state.authority = "migrating";
        state.migrationId = String(req.migrationId);
        state.expectedCounts = {
          tracks: Number(req.expectedTracks),
          playlists: Number(req.expectedPlaylists),
          lyrics: Number(req.expectedLyrics),
          lyricsMeta: Number(req.expectedLyricsMeta),
          prefs: Number(req.expectedPrefs),
          artwork: Number(req.expectedArtwork),
          audio: Number(req.expectedAudio),
        };
        state.expectedChecksum = String(req.expectedChecksum);
        state.lastError = null;
        return getStatus();
      }
      case "write_desktop_idb_migration_batch": {
        if (state.failOnWriteBatch) {
          clearTables();
          state.authority = "recovery-required";
          state.lastError = "Simulated disk full during batch write";
          throw new Error(state.lastError);
        }
        const batch = args.batch as Record<string, unknown>;
        for (const t of (batch.tracks as Track[]) ?? []) state.tracks.set(t.id, t);
        for (const p of (batch.playlists as Playlist[]) ?? []) state.playlists.set(p.id, p);
        for (const l of (batch.lyrics as TrackLyrics[]) ?? []) state.lyrics.set(l.trackId, l);
        for (const m of (batch.lyricsMeta as LyricsCacheMeta[]) ?? []) state.lyricsMeta.set(m.trackId, m);
        for (const pref of (batch.prefs as Array<{ name: string; payload: unknown }>) ?? []) {
          state.prefs.set(pref.name, pref.payload);
        }
        for (const art of (batch.artwork as Array<{ trackId: string; mimeType: string; bytes: number[] }>) ?? []) {
          state.artwork.set(art.trackId, { mimeType: art.mimeType, bytes: art.bytes });
        }
        for (const aud of (batch.audio as Array<{ trackId: string; mimeType: string; bytes: number[] }>) ?? []) {
          state.audio.set(aud.trackId, { mimeType: aud.mimeType, bytes: aud.bytes });
        }
        return undefined;
      }
      case "finalize_desktop_idb_migration": {
        if (state.failOnFinalize) {
          clearTables();
          state.authority = "recovery-required";
          state.lastError = "Simulated checksum mismatch on finalize";
          throw new Error(state.lastError);
        }
        const actualCs = await computeSnapshotChecksum({
          tracks: [...state.tracks.values()],
          playlists: [...state.playlists.values()],
          lyrics: [...state.lyrics.values()],
        });
        if (
          state.tracks.size !== state.expectedCounts.tracks ||
          state.playlists.size !== state.expectedCounts.playlists ||
          state.lyrics.size !== state.expectedCounts.lyrics ||
          actualCs !== state.expectedChecksum
        ) {
          clearTables();
          state.authority = "recovery-required";
          state.lastError = "Verification failed";
          throw new Error(state.lastError);
        }
        state.authority = "sqlite";
        state.verifiedChecksum = actualCs;
        return getStatus();
      }
      case "fail_desktop_idb_migration": {
        clearTables();
        state.authority = "recovery-required";
        state.lastError = String(args.reason ?? "Migration failed");
        return getStatus();
      }
      case "sqlite_list_tracks":
        return [...state.tracks.values()];
      case "sqlite_get_track":
        return state.tracks.get(String(args.id)) ?? null;
      case "sqlite_put_tracks":
        for (const t of (args.tracks as Track[]) ?? []) state.tracks.set(t.id, t);
        return undefined;
      case "sqlite_put_track_with_files": {
        const t = args.track as Track;
        state.tracks.set(t.id, t);
        if (args.artwork) {
          const art = args.artwork as { mimeType: string; bytes: number[] };
          state.artwork.set(t.id, art);
        }
        if (args.audio) {
          const aud = args.audio as { mimeType: string; bytes: number[] };
          state.audio.set(t.id, aud);
        }
        return undefined;
      }
      case "sqlite_delete_tracks": {
        for (const id of (args.ids as string[]) ?? []) {
          state.tracks.delete(id);
          state.artwork.delete(id);
          state.audio.delete(id);
          state.lyrics.delete(id);
          state.lyricsMeta.delete(id);
        }
        return undefined;
      }
      case "sqlite_get_artwork":
        return state.artwork.get(String(args.trackId)) ?? null;
      case "sqlite_put_artwork":
        state.artwork.set(String(args.trackId), {
          mimeType: "image/jpeg",
          bytes: args.bytes as number[],
        });
        return undefined;
      case "sqlite_delete_artwork":
        state.artwork.delete(String(args.trackId));
        return undefined;
      case "sqlite_list_artwork_track_ids":
        return [...state.artwork.keys()];
      case "sqlite_get_audio_blob":
        return state.audio.get(String(args.trackId)) ?? null;
      case "sqlite_put_audio_blob":
        state.audio.set(String(args.trackId), {
          mimeType: String(args.mimeType),
          bytes: args.bytes as number[],
        });
        return undefined;
      case "sqlite_delete_audio_blob":
        state.audio.delete(String(args.trackId));
        return undefined;
      case "sqlite_count_stored_audio":
        return state.audio.size;
      case "sqlite_list_audio_track_ids":
        return [...state.audio.keys()];
      case "sqlite_list_playlists":
        return [...state.playlists.values()];
      case "sqlite_get_playlist":
        return state.playlists.get(String(args.id)) ?? null;
      case "sqlite_put_playlist": {
        const pl = args.playlist as Playlist;
        state.playlists.set(pl.id, pl);
        return undefined;
      }
      case "sqlite_delete_playlist":
        state.playlists.delete(String(args.id));
        return undefined;
      case "sqlite_get_lyrics":
        return state.lyrics.get(String(args.trackId)) ?? null;
      case "sqlite_put_lyrics": {
        const l = args.lyrics as TrackLyrics;
        state.lyrics.set(l.trackId, l);
        return undefined;
      }
      case "sqlite_delete_lyrics":
        state.lyrics.delete(String(args.trackId));
        state.lyricsMeta.delete(String(args.trackId));
        return undefined;
      case "sqlite_get_lyrics_cache_meta":
        return state.lyricsMeta.get(String(args.trackId)) ?? null;
      case "sqlite_put_lyrics_cache_meta": {
        const m = args.meta as LyricsCacheMeta;
        state.lyricsMeta.set(m.trackId, m);
        return undefined;
      }
      case "sqlite_get_pref_json":
        return state.prefs.get(String(args.name)) ?? null;
      case "sqlite_put_pref_json":
        state.prefs.set(String(args.name), args.payload);
        return undefined;
      case "sqlite_delete_pref":
        state.prefs.delete(String(args.name));
        return undefined;
      case "sqlite_clear_library":
        state.tracks.clear();
        state.playlists.clear();
        state.lyrics.clear();
        state.lyricsMeta.clear();
        state.artwork.clear();
        state.audio.clear();
        return undefined;
      case "sqlite_replace_library": {
        const req = args.request as {
          tracks: Track[];
          playlists: Playlist[];
          lyrics: TrackLyrics[];
          preferences?: unknown;
        };
        const surviving = new Set(req.tracks.map((t) => t.id));
        state.tracks.clear();
        state.playlists.clear();
        state.lyrics.clear();
        state.lyricsMeta.clear();
        for (const t of req.tracks) state.tracks.set(t.id, t);
        for (const p of req.playlists) state.playlists.set(p.id, p);
        for (const l of req.lyrics) state.lyrics.set(l.trackId, l);
        if (req.preferences !== undefined) state.prefs.set("app", req.preferences);
        for (const k of [...state.artwork.keys()]) {
          if (!surviving.has(k)) state.artwork.delete(k);
        }
        for (const k of [...state.audio.keys()]) {
          if (!surviving.has(k)) state.audio.delete(k);
        }
        return undefined;
      }
      case "sqlite_clear_all_data":
        clearTables();
        return undefined;
      default:
        throw new Error(`Unexpected IPC command: ${cmd}`);
    }
  };

  return { state, handler };
}

describe("LibraryRepository native SQLite migration & desktop runtime switching", () => {
  beforeEach(async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    repository.resetDesktopAuthorityForTests();
    await repository.clearAllData();
    invoke.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    repository.resetDesktopAuthorityForTests();
    vi.restoreAllMocks();
  });

  it("migrates existing IndexedDB data to SQLite on desktop, preserves IDB intact, and switches authority to sqlite", async () => {
    // 1. Seed IndexedDB while in web mode
    const t1 = makeTrack({ id: "t1", title: "One More Time" });
    const t2 = makeTrack({ id: "t2", title: "Stored Song", desktopPath: undefined, accessMode: "stored-copy" });
    await repository.putTrackWithFiles(t1, { artwork: new Blob(["art-bytes"], { type: "image/png" }) });
    await repository.putTrackWithFiles(t2, { audio: new Blob(["audio-bytes"], { type: "audio/mpeg" }) });
    await repository.putPlaylist({
      id: "pl-1",
      name: "Daft Mix",
      description: "Desc",
      trackIds: ["t2", "t1"],
      createdAt: 10,
      updatedAt: 20,
    });
    await repository.putLyrics({
      trackId: "t1",
      format: "lrc",
      lines: [{ timeMs: 1000, text: "Celebrate" }],
      offsetMs: 250,
      updatedAt: 30,
      skippedLines: 0,
      sourceName: "1.lrc",
    });
    await repository.putPreferences(DEFAULT_PREFERENCES);

    // 2. Enable Tauri desktop runtime and wire mock SQLite backend
    const backend = createMockSqliteBackend();
    invoke.mockImplementation(backend.handler);
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });

    // 3. First repository call triggers automatic IndexedDB -> SQLite migration
    const tracks = await repository.listTracks();
    expect(repository.getPersistenceAuthority()).toBe("sqlite");
    expect(tracks).toHaveLength(2);
    expect(backend.state.tracks.size).toBe(2);
    expect(backend.state.playlists.get("pl-1")?.trackIds).toEqual(["t2", "t1"]);
    expect(backend.state.lyrics.get("t1")?.offsetMs).toBe(250);
    expect(backend.state.artwork.has("t1")).toBe(true);
    // Audio blob for t2 (no desktopPath) is migrated; t1 (has desktopPath) has no duplicated audio blob
    expect(backend.state.audio.has("t2")).toBe(true);
    expect(backend.state.audio.has("t1")).toBe(false);

    // 4. Verify original IndexedDB data was NEVER cleared or destroyed
    const idbTracks = await withTransaction([STORES.tracks], "readonly", (tx) =>
      requestToPromise(tx.objectStore(STORES.tracks).getAll() as IDBRequest<Track[]>),
    );
    expect(idbTracks).toHaveLength(2);

    // 5. Subsequent writes go to SQLite
    const t3 = makeTrack({ id: "t3", title: "Digital Love" });
    await repository.putTracks([t3]);
    expect(backend.state.tracks.has("t3")).toBe(true);
  });

  it("falls back safely to IndexedDB without data loss when SQLite migration fails midway", async () => {
    const t1 = makeTrack({ id: "t1", title: "Safe Track" });
    await repository.putTracks([t1]);

    const backend = createMockSqliteBackend();
    backend.state.failOnWriteBatch = true;
    invoke.mockImplementation(backend.handler);
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });

    // Even though SQLite batch write fails, repository.listTracks() transparently falls back to IndexedDB!
    const tracks = await repository.listTracks();
    expect(tracks).toHaveLength(1);
    expect(tracks[0].title).toBe("Safe Track");
    expect(repository.getPersistenceAuthority()).toBe("recovery-required");
    expect(backend.state.authority).toBe("recovery-required");
    expect(backend.state.tracks.size).toBe(0);

    // Once the underlying issue is resolved, retrying migration recovers and switches to sqlite
    backend.state.failOnWriteBatch = false;
    const status = await repository.migrateIndexedDbToSqlite();
    expect(status.authority).toBe("sqlite");
    expect(repository.getPersistenceAuthority()).toBe("sqlite");
    expect(await repository.listTracks()).toHaveLength(1);
  });

  it("preserves desktopPath links and strips machine paths during portable backup export/restore on SQLite", async () => {
    const backend = createMockSqliteBackend();
    invoke.mockImplementation(backend.handler);
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });

    await repository.ensureDesktopPersistence();
    expect(repository.getPersistenceAuthority()).toBe("sqlite");

    const desktopTrack = makeTrack({
      id: "desk-1",
      title: "Veridis Quo",
      desktopPath: "C:\\Music\\Daft Punk\\Veridis Quo.flac",
      accessMode: "desktop-path",
      availability: "available",
    });
    await repository.putTracks([desktopTrack]);
    await repository.putPlaylist({
      id: "p1",
      name: "Synth",
      description: "",
      trackIds: ["desk-1"],
      createdAt: 1,
      updatedAt: 1,
    });
    await repository.putLyrics({
      trackId: "desk-1",
      format: "txt",
      lines: [{ timeMs: null, text: "Instrumental" }],
      offsetMs: 120,
      updatedAt: 1,
      skippedLines: 0,
      sourceName: "v.txt",
    });

    const backup = await buildBackup();
    const rawJson = JSON.stringify(backup);
    // Portable backup must NEVER contain desktopPath or C:\Music
    expect(rawJson).not.toContain("desktopPath");
    expect(rawJson).not.toContain("C:\\\\Music");
    expect(backup.tracks[0].accessMode).toBe("session-only");
    expect(backup.tracks[0].availability).toBe("missing");

    const validated = validateBackupText(rawJson);
    expect(validated.ok).toBe(true);

    // Restoring on the same desktop device preserves the existing desktopPath for surviving track IDs
    await restoreBackup(backup);
    const restored = await repository.getTrack("desk-1");
    expect(restored?.desktopPath).toBe("C:\\Music\\Daft Punk\\Veridis Quo.flac");
    expect(restored?.accessMode).toBe("desktop-path");
    expect(restored?.availability).toBe("available");
    expect((await repository.getLyrics("desk-1"))?.offsetMs).toBe(120);
  });

  it("handles repeated migration idempotently, rejects malformed IDB records, and migrates large libraries in bounded batches", async () => {
    const backend = createMockSqliteBackend();
    invoke.mockImplementation(backend.handler);

    // Seed 450 tracks in IndexedDB (requires 3 bounded batches of 200)
    const tracks: Track[] = Array.from({ length: 450 }, (_, i) =>
      makeTrack({ id: `large-${i}`, title: `Song ${i}` }),
    );
    await repository.putTracks(tracks);

    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const status1 = await repository.migrateIndexedDbToSqlite();
    expect(status1.authority).toBe("sqlite");
    expect(status1.trackCount).toBe(450);

    // Count how many times write_desktop_idb_migration_batch was called (3 batches of 200/200/50)
    const batchCalls = invoke.mock.calls.filter(
      (call) => call[0] === "write_desktop_idb_migration_batch",
    );
    expect(batchCalls.length).toBe(3);

    // Repeated migration is idempotent and does not re-send batch writes
    invoke.mockClear();
    const status2 = await repository.migrateIndexedDbToSqlite();
    expect(status2.authority).toBe("sqlite");
    expect(status2.trackCount).toBe(450);
    expect(
      invoke.mock.calls.filter((call) => call[0] === "write_desktop_idb_migration_batch"),
    ).toHaveLength(0);

    // Simulate a malformed record in IndexedDB when authority is reset
    backend.state.authority = "indexeddb";
    repository.resetDesktopAuthorityForTests();
    await withTransaction([STORES.tracks], "readwrite", (tx) => {
      tx.objectStore(STORES.tracks).put({ id: "bad-track", title: 12345 });
    });
    await expect(repository.migrateIndexedDbToSqlite()).rejects.toThrow("Malformed track record");
  });
});
