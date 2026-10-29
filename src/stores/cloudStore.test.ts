import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../types";
import { repository } from "../services/indexeddb/LibraryRepository";
import { useLibraryStore } from "./libraryStore";
import { resetDBConnection } from "../services/indexeddb/db";

/**
 * Security and durability contract for the cloud layer (spec §4/§6):
 *  - a failed sync must never lose or alter local data,
 *  - sign-out leaves the local library intact,
 *  - pre-cloud IndexedDB databases keep loading unchanged.
 */
const auth = vi.hoisted(() => ({
  status: "anonymous" as "anonymous" | "authenticated",
  session: null as unknown,
}));

vi.mock("../services/cloud/cloudAuthService", () => ({
  cloudConfigured: () => true,
  workerConfigured: () => true,
  workerUrl: () => "https://worker.example",
  getAccessToken: async () => (auth.status === "authenticated" ? "token" : null),
  snapshotAuth: (session: unknown) => ({
    status: session ? "authenticated" : "anonymous",
    user: session ? { email: "user@example.com" } : null,
    session,
  }),
  currentAuthState: async () => auth,
  signInWithEmail: async () => undefined,
  signUpWithEmail: async () => undefined,
  signOutCloud: async () => undefined,
  subscribeToAuthChanges: () => () => undefined,
}));

const backend = vi.hoisted(() => ({
  snapshot: { tracks: [] as unknown[], playlists: [], lyrics: [] },
  upsertedTracks: [] as Track[],
  upsertedPlaylists: [] as unknown[],
  failSync: false,
  /** Records metadata deletions so ordering can be asserted. */
  deletedMetadata: [] as string[],
  /** When set, metadata deletion fails. */
  metadataDeleteFailsFor: null as string | null,
}));

const objects = vi.hoisted(() => ({
  deleted: [] as string[],
  failFor: null as string | null,
  /** When set, deleteCloudObject behaves as if the object is already gone. */
  alreadyGone: new Set<string>(),
}));

vi.mock("../services/cloud/r2StorageService", () => ({
  getPlayUrl: async () => "https://r2/get",
  invalidatePlayUrl: () => undefined,
  resetCloudStorageState: () => undefined,
  __resetForTests: () => undefined,
  cachedPlayUrlExpiry: () => null,
  deleteCloudObject: async (objectKey: string) => {
    if (objects.failFor === objectKey) {
      throw new Error("the object could not be reached");
    }
    if (!objects.alreadyGone.has(objectKey)) objects.deleted.push(objectKey);
    return [objectKey];
  },
}));

vi.mock("../services/cloud/cloudLibraryService", () => ({
  fetchCloudLibrary: async () => {
    if (backend.failSync) throw new Error("network failed");
    return backend.snapshot;
  },
  upsertCloudTracks: async (tracks: Track[]) => {
    backend.upsertedTracks.push(...tracks);
    return tracks.map((track) => ({ objectKey: track.objectKey ?? null, reconciledWith: null }));
  },
  upsertCloudPlaylists: async (playlists: unknown[]) => {
    backend.upsertedPlaylists.push(...playlists);
  },
  upsertCloudLyrics: async () => undefined,
  deleteCloudTrackMetadata: async (trackId: string) => {
    if (backend.metadataDeleteFailsFor === trackId) {
      throw new Error("the metadata could not be removed");
    }
    backend.deletedMetadata.push(trackId);
  },
  snapshotToLocalEntities: (snapshot: typeof backend.snapshot) => snapshotToLocalFixture(snapshot),
  rowToTrack: (row: Record<string, unknown>) => row as unknown as Track,
}));

function snapshotToLocalFixture(snapshot: typeof backend.snapshot) {
  return {
    tracks: snapshot.tracks as unknown as Track[],
    playlists: [],
    lyrics: [],
  };
}

import { removeTrackFromCloud, retryPendingCloudDeletions, useCloudStore } from "./cloudStore";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: `t${Math.random().toString(36).slice(2, 8)}`,
    title: "Song",
    artist: "Artist",
    album: "",
    trackNumber: null,
    albumTrackCount: null,
    durationMs: 60000,
    fileName: "song.mp3",
    fileSize: 1,
    mimeType: "audio/mpeg",
    addedAt: 1,
    lastPlayedAt: null,
    playCount: 0,
    isLiked: false,
    availability: "available",
    accessMode: "stored-copy",
    fingerprint: null,
    metadataFromFilename: false,
    ...overrides,
  };
}

async function seedLocalLibrary(): Promise<Track> {
  const track = makeTrack({ id: "local-1", title: "Local Song", playCount: 5, lastPlayedAt: 9000 });
  await repository.putTracks([track]);
  await repository.putAudioBlob(track.id, new Blob(["audio"]));
  useLibraryStore.setState({ tracks: [track], playlists: [] });
  return track;
}

describe("cloud sync failure safety", () => {
  beforeEach(async () => {
    auth.status = "anonymous";
    auth.session = null;
    backend.snapshot = { tracks: [], playlists: [], lyrics: [] };
    backend.upsertedTracks = [];
    backend.upsertedPlaylists = [];
    backend.failSync = false;
    backend.deletedMetadata = [];
    backend.metadataDeleteFailsFor = null;
    objects.deleted = [];
    objects.failFor = null;
    objects.alreadyGone.clear();
    await repository.clearAllData();
    useCloudStore.setState({
      ...useCloudStore.getState(),
      status: "anonymous",
      user: null,
      syncStatus: "idle",
      syncError: null,
    });
  });

  it("leaves local data untouched when the cloud cannot be reached", async () => {
    auth.status = "authenticated";
    useCloudStore.setState({ status: "authenticated", user: { email: "user@example.com" } as never });
    const local = await seedLocalLibrary();
    backend.failSync = true;

    await useCloudStore.getState().syncNow();

    expect(useCloudStore.getState().syncStatus).toBe("error");
    expect(useCloudStore.getState().syncError?.message).toMatch(/network failed/);

    // Nothing local was deleted or rewritten.
    const persisted = await repository.getTrack(local.id);
    expect(persisted).toMatchObject({ id: "local-1", title: "Local Song", playCount: 5, accessMode: "stored-copy" });
    expect(await repository.getAudioBlob(local.id)).toBeTruthy();
    expect(useLibraryStore.getState().tracks).toHaveLength(1);
    expect(backend.upsertedTracks).toHaveLength(0);
  });

  it("merges fetched cloud tracks into the local library without dropping any", async () => {
    auth.status = "authenticated";
    useCloudStore.setState({ status: "authenticated", user: { email: "user@example.com" } as never });
    await seedLocalLibrary();
    const cloudTrack = makeTrack({
      id: "cloud-1",
      title: "Cloud Song",
      accessMode: "cloud",
      objectKey: "users/u-1/tracks/cloud-1/audio.mp3",
      cloudStatus: "ready",
      fingerprint: "fp-cloud",
    });
    backend.snapshot = { tracks: [cloudTrack], playlists: [], lyrics: [] };

    await useCloudStore.getState().syncNow();

    expect(useCloudStore.getState().syncStatus).toBe("synced");
    const ids = useLibraryStore.getState().tracks.map((track) => track.id).sort();
    expect(ids).toEqual(["cloud-1", "local-1"]);

    const persistedCloud = await repository.getTrack("cloud-1");
    expect(persistedCloud).toMatchObject({ objectKey: cloudTrack.objectKey, cloudStatus: "ready" });

    // The pull round-trips into a push; both tracks end up in the cloud set.
    expect(backend.upsertedTracks.map((track) => track.id).sort()).toEqual(["cloud-1", "local-1"]);
  });

  it("does not duplicate cloud tracks on a repeated sync", async () => {
    auth.status = "authenticated";
    useCloudStore.setState({ status: "authenticated", user: { email: "user@example.com" } as never });
    const cloudTrack = makeTrack({
      id: "cloud-1",
      accessMode: "cloud",
      objectKey: "users/u-1/tracks/cloud-1/audio.mp3",
      cloudStatus: "ready",
      fingerprint: "fp-cloud",
    });
    backend.snapshot = { tracks: [cloudTrack], playlists: [], lyrics: [] };

    await useCloudStore.getState().syncNow();
    await useCloudStore.getState().syncNow();
    await useCloudStore.getState().syncNow();

    const library = useLibraryStore.getState().tracks;
    expect(library.filter((track) => track.id === "cloud-1")).toHaveLength(1);
  });

  it("signs out without touching the local library", async () => {
    auth.status = "authenticated";
    useCloudStore.setState({ status: "authenticated", user: { email: "user@example.com" } as never });
    const local = await seedLocalLibrary();
    await useCloudStore.getState().signOut();

    expect(useCloudStore.getState().status).toBe("anonymous");
    const stored = await repository.getTrack(local.id);
    expect(stored?.title).toBe("Local Song");
    expect(useLibraryStore.getState().tracks).toHaveLength(1);
  });

  it("refuses to sync while signed out", async () => {
    auth.status = "anonymous";
    await useCloudStore.getState().syncNow();

    expect(useCloudStore.getState().syncStatus).toBe("error");
    expect(useCloudStore.getState().syncError?.message).toMatch(/sign in/i);
    expect(backend.upsertedTracks).toHaveLength(0);
  });
});

describe("cloud deletion safety", () => {
  beforeEach(async () => {
    auth.status = "authenticated";
    auth.session = null;
    backend.snapshot = { tracks: [], playlists: [], lyrics: [] };
    backend.upsertedTracks = [];
    backend.upsertedPlaylists = [];
    backend.failSync = false;
    backend.deletedMetadata = [];
    backend.metadataDeleteFailsFor = null;
    objects.deleted = [];
    objects.failFor = null;
    objects.alreadyGone.clear();
    await repository.clearAllData();
    useCloudStore.setState({ status: "authenticated", user: { email: "user@example.com" } as never });
  });

  it("deletes the R2 object before the metadata, so a partial failure never leaves unreachable bytes", async () => {
    const track: Track = {
      ...makeTrack({ id: "doomed-1" }),
      objectKey: "users/u-1/tracks/doomed-1/audio.mp3",
    };
    await removeTrackFromCloud(track);

    expect(objects.deleted).toEqual(["users/u-1/tracks/doomed-1/audio.mp3"]);
    expect(backend.deletedMetadata).toEqual(["doomed-1"]);
    // Ordering is the point: the object went first.
    expect((await repository.listPendingCloudDeletions())).toHaveLength(0);
  });

  it("keeps the metadata when the object cannot be removed, and records the unfinished work", async () => {
    const objectKey = "users/u-1/tracks/doomed-2/audio.mp3";
    objects.failFor = objectKey;
    const track: Track = { ...makeTrack({ id: "doomed-2" }), objectKey };

    await expect(removeTrackFromCloud(track)).rejects.toThrow(/object could not be reached/);

    // Nothing was claimed as deleted that was not deleted.
    expect(backend.deletedMetadata).toEqual([]);
    // And the half-finished deletion is durable: a later sync can finish it.
    const pending = await repository.listPendingCloudDeletions();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ trackId: "doomed-2", objectKey });
  });

  it("records the work and fails when the metadata removal fails after the object is gone", async () => {
    const objectKey = "users/u-1/tracks/doomed-3/audio.mp3";
    backend.metadataDeleteFailsFor = "doomed-3";
    const track: Track = { ...makeTrack({ id: "doomed-3" }), objectKey };

    await expect(removeTrackFromCloud(track)).rejects.toThrow(/metadata could not be removed/);

    // The object did get removed; the metadata is still there and retryable.
    expect(objects.deleted).toEqual([objectKey]);
    const pending = await repository.listPendingCloudDeletions();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ trackId: "doomed-3", objectKey });
  });

  it("finishes recorded deletions on the next attempt, then clears the catalog", async () => {
    const objectKey = "users/u-1/tracks/doomed-4/audio.mp3";
    objects.failFor = objectKey;
    const track: Track = { ...makeTrack({ id: "doomed-4" }), objectKey };
    await expect(removeTrackFromCloud(track)).rejects.toThrow();
    expect((await repository.listPendingCloudDeletions())).toHaveLength(1);

    // The transient failure goes away; the sweep must complete the work.
    objects.failFor = null;
    const { cleared, remaining } = await retryPendingCloudDeletions();
    expect(cleared).toBe(1);
    expect(remaining).toBe(0);
    expect(objects.deleted).toEqual([objectKey]);
    expect(backend.deletedMetadata).toEqual(["doomed-4"]);
    expect((await repository.listPendingCloudDeletions())).toHaveLength(0);
  });

  it("keeps a catalog entry while either half is still missing", async () => {
    const objectKey = "users/u-1/tracks/doomed-5/audio.mp3";
    backend.metadataDeleteFailsFor = "doomed-5";
    await repository.putPendingCloudDeletion({
      trackId: "doomed-5",
      objectKey,
      firstAttemptedAt: Date.now(),
      lastError: "interrupted",
    });

    const stillFailing = await retryPendingCloudDeletions();
    expect(stillFailing.cleared).toBe(0);
    expect(stillFailing.remaining).toBe(1);

    backend.metadataDeleteFailsFor = null;
    const clearedNow = await retryPendingCloudDeletions();
    expect(clearedNow.cleared).toBe(1);
    expect(clearedNow.remaining).toBe(0);
    expect((await repository.listPendingCloudDeletions())).toHaveLength(0);
  });

  it("removes a catalog entry whose object is already gone", async () => {
    const objectKey = "users/u-1/tracks/doomed-6/audio.mp3";
    objects.alreadyGone.add(objectKey);
    await repository.putPendingCloudDeletion({
      trackId: "doomed-6",
      objectKey,
      firstAttemptedAt: Date.now(),
      lastError: "half done",
    });

    const result = await retryPendingCloudDeletions();
    expect(result).toEqual({ cleared: 1, remaining: 0 });
    expect(backend.deletedMetadata).toEqual(["doomed-6"]);
  });
});

describe("IndexedDB backward compatibility", () => {
  beforeEach(async () => {
    resetDBConnection();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("local-music");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });

  it("loads a pre-cloud library whose records carry no cloud fields", async () => {
    // Exactly the shape a v2 install of the original app wrote.
    const legacy = makeTrack({ id: "legacy-1", title: "Old Song" });
    delete (legacy as Partial<Track>).objectKey;
    delete (legacy as Partial<Track>).cloudStatus;
    delete (legacy as Partial<Track>).storageProvider;
    delete (legacy as Partial<Track>).lastSyncedAt;
    delete (legacy as Partial<Track>).artworkObjectKey;
    await repository.putTracks([legacy]);
    await repository.putAudioBlob(legacy.id, new Blob(["audio"]));
    await repository.putPlaylist({ id: "p-1", name: "Old playlist", description: "", trackIds: [legacy.id], createdAt: 1, updatedAt: 1 });

    await useLibraryStore.getState().init();

    expect(useLibraryStore.getState().status).toBe("ready");
    const tracks = useLibraryStore.getState().tracks;
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.title).toBe("Old Song");
    // Cloud fields stay absent/absent-default: nothing is forced upward.
    expect(tracks[0]?.cloudStatus ?? "local").toBe("local");
    expect(useLibraryStore.getState().playlists[0]?.trackIds).toEqual(["legacy-1"]);
  });

  it("reads a legacy record without rewriting it", async () => {
    const legacy = makeTrack({ id: "legacy-2" });
    await repository.putTracks([legacy]);

    const readBack = await repository.getTrack("legacy-2");
    expect(readBack).toMatchObject({ id: "legacy-2", availability: "available", accessMode: "stored-copy" });
    expect(Object.keys(readBack ?? {}).sort()).not.toContain("cloudStatus");
  });
});
