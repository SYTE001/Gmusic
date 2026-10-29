import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import { repository } from "../indexeddb/LibraryRepository";

/**
 * MigrationService is mocked at its two external boundaries — the Worker
 * client (r2StorageService) and the Postgres writer (cloudLibraryService) —
 * so tests observe the local data contract: nothing local is ever deleted,
 * failures are recoverable, and concurrency is bounded.
 */
const storage = vi.hoisted(() => ({
  /** When set, the simulated Worker rejects uploads for these track ids. */
  failingTrackIds: new Set<string>(),
  /** When set, the simulated Worker rejects `complete` (verification). */
  verificationFailsFor: new Set<string>(),
  /** Objects the client asked the Worker to delete after a failed upload. */
  cleanedUpObjects: [] as string[],
  uploads: 0,
  concurrencyPeak: 0,
  inFlight: 0,
}));

vi.mock("../cloud/r2StorageService", () => ({
  CloudStorageError: class CloudStorageError extends Error {
    readonly kind: string;
    readonly status: number | null;
    constructor(kind: string, message: string, status: number | null = null) {
      super(message);
      this.name = "CloudStorageError";
      this.kind = kind;
      this.status = status;
    }
  },
  requestUploadUrl: async ({ trackId, sizeBytes }: { trackId: string; fileName: string; mimeType: string; sizeBytes: number }) => {
    if (storage.failingTrackIds.has(trackId)) {
      throw new (class extends Error {})("The upload was rejected (500).");
    }
    storage.uploads += 1;
    return {
      objectKey: `users/u-1/tracks/${trackId}/audio.mp3`,
      uploadUrl: `https://r2/put/${trackId}`,
      expiresIn: 120,
      requiredHeaders: { "content-type": "audio/mpeg" },
      sizeBytes,
    };
  },
  completeUpload: async ({ objectKey, sizeBytes }: { objectKey: string; trackId: string; sizeBytes: number; mimeType: string }) => {
    if (storage.verificationFailsFor.has(objectKey)) {
      throw new (class extends Error {})("verification failed");
    }
    return { objectKey, size: sizeBytes, etag: "etag", contentType: "audio/mpeg" };
  },
  /** Records rejected-object cleanup attempts. */
  deleteCloudObject: async (objectKey: string) => {
    storage.cleanedUpObjects.push(objectKey);
    return [objectKey];
  },
}));

const library = vi.hoisted(() => ({
  upserted: [] as Track[],
}));

vi.mock("../cloud/cloudLibraryService", () => ({
  upsertCloudTracks: async (tracks: Track[]) => {
    library.upserted.push(...tracks);
    return tracks.map((track) => ({ objectKey: track.objectKey ?? null, reconciledWith: null }));
  },
}));

import {
  cancelMigration,
  initialMigrationProgress,
  planMigration,
  retryFailedItems,
  runMigration,
} from "./migrationService";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    title: "Song",
    artist: "Artist",
    album: "",
    trackNumber: null,
    albumTrackCount: null,
    durationMs: 60000,
    fileName: "song.mp3",
    fileSize: 1000,
    mimeType: "audio/mpeg",
    addedAt: Date.now(),
    lastPlayedAt: null,
    playCount: 0,
    isLiked: false,
    availability: "available",
    accessMode: "stored-copy",
    fingerprint: `fp-${Math.random()}`,
    metadataFromFilename: false,
    ...overrides,
  };
}

async function storedTracks(count: number): Promise<Track[]> {
  const tracks: Track[] = [];
  for (let index = 0; index < count; index += 1) {
    const track = makeTrack({ id: `stored-${index}` });
    tracks.push(track);
    await repository.putTracks([track]);
    await repository.putAudioBlob(track.id, new Blob([new Uint8Array(1000)], { type: "audio/mpeg" }));
  }
  return tracks;
}

describe("migration planning", () => {
  beforeEach(async () => {
    await repository.clearAllData();
    storage.failingTrackIds.clear();
    storage.verificationFailsFor.clear();
    storage.uploads = 0;
    storage.cleanedUpObjects = [];
    storage.concurrencyPeak = 0;
    storage.inFlight = 0;
    library.upserted = [];
    // The presigned PUT goes to the object store, never the test network.
    vi.stubGlobal("fetch", async () => new Response("", { status: 200 }));
  });

  it("classifies tracks whose local audio is reachable as uploadable", async () => {
    const tracks = await storedTracks(2);
    const plan = await planMigration(tracks);
    expect(plan.items.filter((item) => item.status === "pending")).toHaveLength(2);
    expect(plan.needsAccess).toHaveLength(0);
    expect(plan.missing).toHaveLength(0);
  });

  it("marks tracks whose stored handle can no longer be opened as needs-access", async () => {
    const track = makeTrack({ id: "handle-1", accessMode: "handle" });
    // A retained handle whose file can no longer be read (moved, or permission
    // no longer granted silently): opening it fails, so the track is not
    // silently skipped from the migration plan.
    const unusableHandle = { kind: "file", name: "song.mp3" };
    await repository.putHandle(track.id, unusableHandle as unknown as FileSystemFileHandle);
    const plan = await planMigration([track]);
    expect(plan.items[0]!.status).toBe("needs-access");
    expect(plan.needsAccess).toHaveLength(1);
  });

  it("marks tracks with no reachable audio at all as missing", async () => {
    const track = makeTrack({ id: "gone-1", accessMode: "session-only" });
    const plan = await planMigration([track]);
    expect(plan.items[0]!.status).toBe("missing");
    expect(plan.missing).toHaveLength(1);
  });

  it("skips tracks that already have a verified cloud copy", async () => {
    const track = makeTrack({ id: "clouded", cloudStatus: "ready", objectKey: "users/u-1/tracks/clouded/audio.mp3" });
    const plan = await planMigration([track]);
    expect(plan.items[0]!.status).toBe("done");
  });
});

describe("migration run", () => {
  beforeEach(async () => {
    await repository.clearAllData();
    storage.failingTrackIds.clear();
    storage.verificationFailsFor.clear();
    storage.uploads = 0;
    storage.cleanedUpObjects = [];
    storage.concurrencyPeak = 0;
    storage.inFlight = 0;
    library.upserted = [];
    // The presigned PUT goes to the object store, never the test network.
    vi.stubGlobal("fetch", async () => new Response("", { status: 200 }));
  });

  it("uploads, verifies, and persists cloud metadata for each reachable track", async () => {
    const tracks = await storedTracks(2);
    const progress = { ...initialMigrationProgress(), items: (await planMigration(tracks)).items };

    await runMigration(tracks, progress);

    expect(progress.state).toBe("complete");
    expect(progress.succeeded).toBe(2);
    expect(progress.failed).toBe(0);
    // Cloud metadata was written only for verified uploads.
    expect(library.upserted).toHaveLength(2);
    expect(library.upserted.every((track) => track.objectKey !== null)).toBe(true);
    // Local records were UPDATED, never deleted: the audio copies are intact.
    for (const track of tracks) {
      expect(await repository.getAudioBlob(track.id)).toBeTruthy();
      const stored = await repository.getTrack(track.id);
      expect(stored?.cloudStatus).toBe("ready");
      expect(stored?.objectKey).toBe(`users/u-1/tracks/${track.id}/audio.mp3`);
      expect(stored?.accessMode).toBe("stored-copy");
    }
  });

  it("keeps local data untouched when the Worker rejects an upload", async () => {
    const tracks = await storedTracks(2);
    storage.failingTrackIds.add(tracks[1]!.id);
    const progress = { ...initialMigrationProgress(), items: (await planMigration(tracks)).items };

    await runMigration(tracks, progress);

    expect(progress.state).toBe("complete");
    expect(progress.succeeded).toBe(1);
    expect(progress.failed).toBe(1);
    expect(progress.items.find((item) => item.status === "failed")?.error).toBeTruthy();
    // The local audio copy survives the failure verbatim.
    expect(await repository.getAudioBlob(tracks[1]!.id)).toBeTruthy();
    const stored = await repository.getTrack(tracks[1]!.id);
    expect(stored?.cloudStatus).toBeUndefined(); // never marked uploaded
  });

  it("re-failing verification leaves the track failed and local data intact", async () => {
    const tracks = await storedTracks(1);
    storage.verificationFailsFor.add(`users/u-1/tracks/${tracks[0]!.id}/audio.mp3`);
    const progress = { ...initialMigrationProgress(), items: (await planMigration(tracks)).items };

    await runMigration(tracks, progress);

    expect(progress.failed).toBe(1);
    expect(library.upserted).toHaveLength(0); // nothing was marked complete
    expect(await repository.getAudioBlob(tracks[0]!.id)).toBeTruthy();
  });

  it("retries only the failed items, and a repeated upload attempt converges", async () => {
    const tracks = await storedTracks(1);
    storage.failingTrackIds.add(tracks[0]!.id);
    const progress = { ...initialMigrationProgress(), items: (await planMigration(tracks)).items };
    await runMigration(tracks, progress);
    expect(progress.failed).toBe(1);

    storage.failingTrackIds.clear();
    retryFailedItems(progress);
    await runMigration(tracks, progress);
    expect(progress.state).toBe("complete");
    expect(progress.succeeded).toBe(1);
    expect(progress.failed).toBe(0);
    // No duplicate cloud metadata: one row per stable id.
    expect(library.upserted.filter((track) => track.id === tracks[0]!.id)).toHaveLength(1);
  });

  it("runs at most `concurrency` uploads at a time", async () => {
    const tracks = await storedTracks(6);
    const originalFetch = globalThis.fetch;
    let active = 0;
    let peak = 0;
    // Observe concurrency through the shared Worker mock by wrapping fetch;
    // the simulated PUT goes through the real fetch on the presigned URL.
    vi.stubGlobal("fetch", async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response("", { status: 200 });
    });
    try {
      const progress = { ...initialMigrationProgress(), items: (await planMigration(tracks)).items };
      await runMigration(tracks, progress, { concurrency: 2 });
      expect(peak).toBeLessThanOrEqual(2);
      expect(progress.succeeded).toBe(6);
    } finally {
      vi.unstubAllGlobals();
      void originalFetch;
    }
  });

  it("removes the unclaimed object when an upload is rejected mid-way", async () => {
    const tracks = await storedTracks(1);
    storage.verificationFailsFor.add(`users/u-1/tracks/${tracks[0]!.id}/audio.mp3`);
    const progress = { ...initialMigrationProgress(), items: (await planMigration(tracks)).items };

    await runMigration(tracks, progress);

    expect(progress.failed).toBe(1);
    // The object was PUT but never verified, so the client asked the Worker
    // to delete it — no audio lingers in R2 without metadata.
    expect(storage.cleanedUpObjects).toEqual([`users/u-1/tracks/${tracks[0]!.id}/audio.mp3`]);
    // And nothing local was marked uploaded.
    const stored = await repository.getTrack(tracks[0]!.id);
    expect(stored?.cloudStatus ?? "local").toBe("local");
  });

  it("cancels between files, leaving pending items and all local data intact", async () => {
    const tracks = await storedTracks(4);
    const progress = { ...initialMigrationProgress(), items: (await planMigration(tracks)).items };

    // One upload at a time; cancel as soon as the first one starts.
    let started = false;
    vi.stubGlobal("fetch", async () => {
      started = true;
      await new Promise((wait) => setTimeout(wait, 20));
      return new Response("", { status: 200 });
    });
    const run = runMigration(tracks, progress, { concurrency: 1 });
    while (!started) await new Promise((wait) => setTimeout(wait, 5));
    cancelMigration();
    await run;

    expect(progress.state).toBe("cancelled");
    const doneCount = progress.items.filter((item) => item.status === "done").length;
    expect(doneCount).toBeLessThan(4);
    expect(doneCount).toBeGreaterThanOrEqual(1);
    expect(progress.items.some((item) => item.status === "pending")).toBe(true);
    // Nothing local was deleted by stopping early, and only the tracks that
    // actually finished were marked uploaded — never the pending ones.
    for (const track of tracks) {
      expect(await repository.getAudioBlob(track.id)).toBeTruthy();
    }
    const pendingIds = new Set(progress.items.filter((item) => item.status === "pending").map((item) => item.trackId));
    for (const trackId of pendingIds) {
      const stored = await repository.getTrack(trackId);
      expect(stored?.cloudStatus ?? "local").toBe("local");
    }
  });

  it("never deletes the local audio copy during a successful migration", async () => {
    const tracks = await storedTracks(1);
    const progress = { ...initialMigrationProgress(), items: (await planMigration(tracks)).items };
    await runMigration(tracks, progress);
    expect(await repository.getAudioBlob(tracks[0]!.id)).toBeTruthy();
    const stored = await repository.getTrack(tracks[0]!.id);
    expect(stored?.availability).toBe("available");
  });
});
