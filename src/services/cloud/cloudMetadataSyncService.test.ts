import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import { repository } from "../indexeddb/LibraryRepository";
import { syncTrackMetadata, retryPendingMetadataSync } from "./cloudMetadataSyncService";
import { mergeCloudIntoLocal } from "../../stores/cloudStore";

const auth = vi.hoisted(() => ({
  status: "authenticated" as "anonymous" | "authenticated",
  session: null as unknown,
}));

const backend = vi.hoisted(() => ({
  upsertedTracks: [] as Track[],
  failUpsert: false,
  failError: "Network connection refused",
}));

vi.mock("./cloudAuthService", () => ({
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
  getAuthenticatedUserId: async () => "test-user-id",
}));

vi.mock("./cloudLibraryService", () => ({
  upsertCloudTracks: async (tracks: Track[]) => {
    if (backend.failUpsert) {
      throw new Error(backend.failError);
    }
    backend.upsertedTracks.push(...tracks);
    return tracks.map((t) => ({ objectKey: t.objectKey ?? null, reconciledWith: null }));
  },
}));

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: `track-${Math.random().toString(36).slice(2, 7)}`,
    title: "Original Title",
    artist: "Artist",
    album: "Album",
    trackNumber: 1,
    albumTrackCount: 10,
    durationMs: 180000,
    fileName: "song.mp3",
    fileSize: 5000000,
    mimeType: "audio/mpeg",
    addedAt: 1000,
    lastPlayedAt: null,
    playCount: 0,
    isLiked: false,
    availability: "available",
    accessMode: "stored-copy",
    fingerprint: "fp-1",
    metadataFromFilename: false,
    description: "Initial description",
    updatedAt: 1000,
    cloudStatus: "ready",
    objectKey: "users/u-1/tracks/t-1/audio.mp3",
    ...overrides,
  };
}

describe("CloudMetadataSyncService & Metadata Consistency", () => {
  beforeEach(async () => {
    auth.status = "authenticated";
    backend.upsertedTracks = [];
    backend.failUpsert = false;
    backend.failError = "Network connection refused";
    await repository.clearAllData();
  });

  it("synchronizes metadata to cloud when user is authenticated", async () => {
    const track = makeTrack({ id: "t1", title: "Updated Title", description: "New Notes" });
    await repository.putTracks([track]);

    await syncTrackMetadata(track);

    expect(backend.upsertedTracks).toHaveLength(1);
    expect(backend.upsertedTracks[0].id).toBe("t1");
    expect(backend.upsertedTracks[0].title).toBe("Updated Title");
    expect(backend.upsertedTracks[0].description).toBe("New Notes");
    // Object key and file name are never altered
    expect(backend.upsertedTracks[0].fileName).toBe("song.mp3");
    expect(backend.upsertedTracks[0].objectKey).toBe(track.objectKey);

    const pending = await repository.listPendingMetadataSync();
    expect(pending).toHaveLength(0);
  });

  it("does not attempt cloud sync when user is anonymous", async () => {
    auth.status = "anonymous";
    const track = makeTrack({ id: "t2", title: "Local Only Title" });
    await repository.putTracks([track]);

    await syncTrackMetadata(track);

    expect(backend.upsertedTracks).toHaveLength(0);
    const pending = await repository.listPendingMetadataSync();
    expect(pending).toHaveLength(0);
  });

  it("retains local changes and queues for retry when cloud synchronization fails", async () => {
    backend.failUpsert = true;
    backend.failError = "Supabase connection timeout";

    const track = makeTrack({ id: "t3", title: "Offline Edited Title", description: "Offline notes" });
    await repository.putTracks([track]);

    await expect(syncTrackMetadata(track)).rejects.toThrow(/Supabase connection timeout/);

    // Local track is preserved in IndexedDB
    const local = await repository.getTrack("t3");
    expect(local?.title).toBe("Offline Edited Title");
    expect(local?.description).toBe("Offline notes");
    expect(local?.fileName).toBe("song.mp3");

    // Queued in IndexedDB for retry
    const pending = await repository.listPendingMetadataSync();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      trackId: "t3",
      title: "Offline Edited Title",
      description: "Offline notes",
      lastError: "Supabase connection timeout",
    });
  });

  it("clears pending queue when retry succeeds", async () => {
    const track = makeTrack({ id: "t4", title: "Retried Song", description: "Retried description" });
    await repository.putTracks([track]);

    await repository.putPendingMetadataSync({
      trackId: "t4",
      title: "Retried Song",
      description: "Retried description",
      queuedAt: Date.now(),
      lastError: "Previous network failure",
    });

    expect(await repository.listPendingMetadataSync()).toHaveLength(1);

    backend.failUpsert = false;
    const { cleared, remaining } = await retryPendingMetadataSync();

    expect(cleared).toBe(1);
    expect(remaining).toBe(0);
    expect(backend.upsertedTracks).toHaveLength(1);
    expect(backend.upsertedTracks[0].id).toBe("t4");
    expect(await repository.listPendingMetadataSync()).toHaveLength(0);
  });

  it("retains queue item with updated error when retry fails", async () => {
    const track = makeTrack({ id: "t5", title: "Still Failing Song" });
    await repository.putTracks([track]);

    await repository.putPendingMetadataSync({
      trackId: "t5",
      title: "Still Failing Song",
      description: "Some notes",
      queuedAt: Date.now(),
      lastError: "Initial error",
    });

    backend.failUpsert = true;
    backend.failError = "Still no internet";

    const { cleared, remaining } = await retryPendingMetadataSync();

    expect(cleared).toBe(0);
    expect(remaining).toBe(1);

    const pending = await repository.listPendingMetadataSync();
    expect(pending).toHaveLength(1);
    expect(pending[0].lastError).toBe("Still no internet");
  });

  it("cleans up queue item if the track was deleted locally", async () => {
    await repository.putPendingMetadataSync({
      trackId: "deleted-track",
      title: "Ghost Title",
      description: "Ghost Notes",
      queuedAt: Date.now(),
    });

    const { cleared, remaining } = await retryPendingMetadataSync();
    expect(cleared).toBe(1);
    expect(remaining).toBe(0);
    expect(await repository.listPendingMetadataSync()).toHaveLength(0);
  });

  it("ensures updated metadata becomes visible across devices (mergeCloudIntoLocal)", () => {
    // Device A edited track at t=5000:
    const localTrack = makeTrack({
      id: "shared-1",
      title: "Device A Older Title",
      description: "Device A Notes",
      updatedAt: 5000,
      lastSyncedAt: 5000,
    });

    // Cloud has newer metadata from Device B edited at t=10000:
    const cloudTrack = makeTrack({
      id: "shared-1",
      title: "Device B Newer Title",
      description: "Device B Updated Description",
      updatedAt: 10000,
      lastSyncedAt: 10000,
    });

    const merged = mergeCloudIntoLocal([localTrack], [cloudTrack]);

    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe("Device B Newer Title");
    expect(merged[0].description).toBe("Device B Updated Description");
    expect(merged[0].updatedAt).toBe(10000);
    // Audio file and access mode remain local-safe
    expect(merged[0].fileName).toBe("song.mp3");
    expect(merged[0].accessMode).toBe("stored-copy");
  });

  it("preserves un-synced local edits when local updatedAt is newer than cloud", () => {
    // Local user edited title recently at t=15000 (pending sync or offline):
    const localTrack = makeTrack({
      id: "shared-2",
      title: "Local Fresh Title",
      description: "Local Fresh Notes",
      updatedAt: 15000,
      lastSyncedAt: 5000,
    });

    // Cloud has older metadata at t=10000:
    const cloudTrack = makeTrack({
      id: "shared-2",
      title: "Older Cloud Title",
      description: "Older Cloud Notes",
      updatedAt: 10000,
      lastSyncedAt: 10000,
    });

    const merged = mergeCloudIntoLocal([localTrack], [cloudTrack]);

    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe("Local Fresh Title");
    expect(merged[0].description).toBe("Local Fresh Notes");
  });
});
