import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginDesktopIdbMigration,
  blobToByteArray,
  byteArrayToBlob,
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
  sqlitePutTracks,
  sqlitePutTrackWithFiles,
  sqliteRemovePendingCloudDeletion,
  sqliteRemovePendingMetadataSync,
  sqliteReplaceLibrary,
  writeDesktopIdbMigrationBatch,
  type PersistenceStatus,
} from "./persistence";
import type { Track } from "../../types";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: vi.fn((p: string) => `http://asset.localhost/${encodeURIComponent(p)}`),
}));

const sampleStatus: PersistenceStatus = {
  authority: "sqlite",
  schemaVersion: 1,
  integrityOk: true,
  integrityErrors: [],
  trackCount: 2,
  playlistCount: 1,
  lyricsCount: 1,
  lyricsMetaCount: 1,
  prefsCount: 1,
  artworkCount: 1,
  audioCount: 0,
  migrationId: "mig-1",
  lastError: null,
  recoveryGuidance: null,
};

const sampleTrack: Track = {
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
  addedAt: 1,
  lastPlayedAt: null,
  playCount: 0,
  isLiked: true,
  availability: "available",
  accessMode: "desktop-path",
  desktopPath: "C:\\Music\\01.flac",
  fingerprint: "fp1",
  metadataFromFilename: false,
};

beforeEach(() => {
  invoke.mockReset();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
});

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  vi.restoreAllMocks();
});

describe("desktop SQLite persistence platform adapter", () => {
  it("never invokes Tauri IPC on web runtime", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    expect(await getDesktopPersistenceStatus()).toBeNull();
    expect(
      await beginDesktopIdbMigration({
        migrationId: "m1",
        expectedTracks: 0,
        expectedPlaylists: 0,
        expectedLyrics: 0,
        expectedLyricsMeta: 0,
        expectedPrefs: 0,
        expectedArtwork: 0,
        expectedAudio: 0,
        expectedChecksum: "abc",
      }),
    ).toBeNull();
    await writeDesktopIdbMigrationBatch({ migrationId: "m1" });
    expect(await finalizeDesktopIdbMigration("m1")).toBeNull();
    expect(await failDesktopIdbMigration("err")).toBeNull();
    expect(await sqliteListTracks()).toEqual([]);
    expect(await sqliteGetTrack("t1")).toBeUndefined();
    await sqlitePutTracks([sampleTrack]);
    await sqlitePutTrackWithFiles(sampleTrack, {});
    await sqliteDeleteTracks(["t1"]);
    expect(await sqliteGetArtwork("t1")).toBeUndefined();
    await sqlitePutArtwork("t1", new Blob(["art"]));
    await sqliteDeleteArtwork("t1");
    expect(await sqliteListArtworkTrackIds()).toEqual(new Set());
    expect(await sqliteGetAudioBlob("t1")).toBeUndefined();
    await sqlitePutAudioBlob("t1", new Blob(["aud"]));
    await sqliteDeleteAudioBlob("t1");
    expect(await sqliteCountStoredAudio()).toBe(0);
    expect(await sqliteListAudioTrackIds()).toEqual(new Set());
    expect(await sqliteListPlaylists()).toEqual([]);
    expect(await sqliteGetPlaylist("p1")).toBeUndefined();
    await sqlitePutPlaylist({ id: "p1", name: "Mix", description: "", trackIds: [], createdAt: 1, updatedAt: 1 });
    await sqliteDeletePlaylist("p1");
    expect(await sqliteGetLyrics("t1")).toBeUndefined();
    await sqlitePutLyrics({ trackId: "t1", format: "txt", lines: [], offsetMs: 0, updatedAt: 1, skippedLines: 0, sourceName: "a.txt" });
    await sqliteDeleteLyrics("t1");
    expect(await sqliteGetLyricsCacheMeta("t1")).toBeUndefined();
    await sqlitePutLyricsCacheMeta({ trackId: "t1", status: "accepted", checkedAt: 1, recordId: 1, schemaVersion: 2 });
    expect(await sqliteGetPreferences()).toBeUndefined();
    await sqliteDeletePref("playback");
    await sqliteClearLibrary();
    await sqliteReplaceLibrary({ tracks: [], playlists: [], lyrics: [] });
    await sqliteClearAllData();

    expect(invoke).not.toHaveBeenCalled();
  });

  it("validates persistence status and rejects malformed IPC responses", async () => {
    invoke.mockResolvedValueOnce(sampleStatus);
    expect(await getDesktopPersistenceStatus()).toEqual(sampleStatus);

    invoke.mockResolvedValueOnce({ authority: "invalid-state" });
    await expect(getDesktopPersistenceStatus()).rejects.toThrow("Invalid desktop persistence status");
  });

  it("computes deterministic SHA-256 snapshot checksum regardless of input array order", async () => {
    const t2: Track = { ...sampleTrack, id: "t2", title: "Aerodynamic" };
    const cs1 = await computeSnapshotChecksum({
      tracks: [sampleTrack, t2],
      playlists: [{ id: "p1", name: "Mix", description: "", trackIds: ["t1", "t2"], createdAt: 1, updatedAt: 1 }],
      lyrics: [],
    });
    const cs2 = await computeSnapshotChecksum({
      tracks: [t2, sampleTrack],
      playlists: [{ id: "p1", name: "Mix", description: "", trackIds: ["t1", "t2"], createdAt: 1, updatedAt: 1 }],
      lyrics: [],
    });
    expect(cs1).toBe(cs2);
    expect(cs1).toHaveLength(64);
  });

  it("converts Blobs and byte arrays losslessly and manages pending sync/deletion queues", async () => {
    const original = new Blob([new Uint8Array([10, 20, 30, 40])], { type: "image/png" });
    const arr = await blobToByteArray(original);
    expect(arr).toEqual([10, 20, 30, 40]);

    const restored = byteArrayToBlob({ mimeType: "image/png", bytes: arr });
    expect(restored).toBeInstanceOf(Blob);
    expect(restored?.type).toBe("image/png");
    expect(await blobToByteArray(restored!)).toEqual([10, 20, 30, 40]);

    // Pending cloud deletions & metadata sync
    let storedDeletions: unknown = [];
    let storedSync: unknown = [];
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "sqlite_get_pref_json") {
        return args?.name === "cloud-deletions" ? storedDeletions : storedSync;
      }
      if (cmd === "sqlite_put_pref_json") {
        if (args?.name === "cloud-deletions") storedDeletions = args.payload;
        if (args?.name === "pending-metadata-sync") storedSync = args.payload;
        return undefined;
      }
      return undefined;
    });

    await sqlitePutPendingCloudDeletion({ trackId: "t1", objectKey: "k1", firstAttemptedAt: 1, lastError: "err" });
    expect(await sqliteListPendingCloudDeletions()).toHaveLength(1);
    await sqliteRemovePendingCloudDeletion("t1");
    expect(await sqliteListPendingCloudDeletions()).toHaveLength(0);

    await sqlitePutPendingMetadataSync({ trackId: "t1", title: "T", description: "D", queuedAt: 1 });
    expect(await sqliteListPendingMetadataSync()).toHaveLength(1);
    await sqliteRemovePendingMetadataSync("t1");
    expect(await sqliteListPendingMetadataSync()).toHaveLength(0);

    await sqlitePutPreferences({
      theme: "dark",
      volume: 0.8,
      shuffle: false,
      repeatMode: "off",
      reducedMotion: "system",
      miniPlayerMode: "auto",
      artworkTint: true,
      lyricsStyle: "line",
      lyricFontSize: "md",
      lyricAlignment: "center",
      lyricLineSpacing: 1.5,
      storeAudioCopies: false,
      autoFetchLyrics: true,
      schemaVersion: 2,
    });
    expect(invoke).toHaveBeenCalledWith("sqlite_put_pref_json", expect.objectContaining({ name: "app" }));
  });

  it("rejects unreadable non-empty blobs with an actionable error instead of fabricating synthetic bytes", async () => {
    const brokenNonEmptyBlob = {
      size: 2048,
      type: "audio/mpeg",
      arrayBuffer: async () => {
        throw new Error("Disk read error");
      },
    };
    await expect(blobToByteArray(brokenNonEmptyBlob)).rejects.toThrow(
      "Blob binary content is unreadable and cannot be migrated without data loss.",
    );

    // Genuinely empty (0-byte) blob returns [] without fabricating bytes
    const emptyBlob = new Blob([], { type: "audio/mpeg" });
    expect(await blobToByteArray(emptyBlob)).toEqual([]);
  });
});
